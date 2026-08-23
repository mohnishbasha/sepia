import { existsSync, mkdirSync } from 'node:fs';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
} from 'playwright';
import { serialize } from '../serializer/index.js';
import type { AXSnapshot } from '../serializer/index.js';
import {
  createHandleMap,
  clearHandleMap,
  gateHandle,
  processCompactView,
  pruneHandleMap,
} from '../resolver/index.js';
import type { SemanticFingerprint } from '../resolver/index.js';
import type {
  CompactView,
  ActionResult,
  ReadResult,
  WaitResult,
  TabInfo,
  WaitConditionType,
  ScreenshotResult,
  StableAttrs,
  TextResult,
} from '../types/index.js';
import type { HandleMap } from '../resolver/index.js';
import {
  createRateLimiter,
  createRobotsCache,
  hostnameOf,
  isDomainAllowed,
} from '../security/index.js';
import type { RateLimiter, RobotsCache } from '../security/index.js';
import { getPreset, validateAndStart } from '../fingerprint/index.js';

export type {
  CompactView,
  ActionResult,
  ReadResult,
  WaitResult,
  TabInfo,
  ScreenshotResult,
  TextResult,
};

export interface EngineOptions {
  executablePath?: string;
  headless?: boolean;
  profileDir?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  /**
   * Minimum resolver confidence required before an action is performed.
   * Below this the engine refuses rather than acting on a guess (AC-AG6).
   */
  confidenceThreshold?: number;
  /** Cap on each settle wait. Pages that never go network-idle stop dominating run cost. */
  settleTimeoutMs?: number;
  /** Upper bound on retained handle records; least-recently-touched are evicted. */
  maxHandles?: number;
  /** Fingerprint preset id. When set, the profile is applied and validated before use. */
  profile?: string;
  /**
   * A pooled browser to borrow rather than launching one (AC-H1).
   *
   * The engine creates its own `BrowserContext` inside it, so cookies, storage
   * and cache stay per-session exactly as with a private browser, and `close()`
   * disposes only that context — the browser goes back to whoever owns it.
   * Ignored when `profileDir` is set: a persistent profile *is* the browser, so
   * there is nothing to share.
   */
  browser?: Browser;
  security?: {
    rateLimitMs?: number;
    robotsAwareness?: boolean;
    /**
     * Hostnames navigation is restricted to, matched exact-or-subdomain. Empty
     * or absent means unrestricted (SR-13).
     */
    allowedDomains?: string[];
  };
}

export interface SepiaEngine {
  open: (url: string) => Promise<ActionResult>;
  observe: (opts?: {
    verbosity?: 'minimal' | 'standard' | 'full';
    /** Cap the returned view at this many tokens; it says so when it trims (AC-S11). */
    maxTokens?: number;
  }) => Promise<CompactView>;
  click: (handle: string) => Promise<ActionResult>;
  type: (handle: string, text: string, opts?: { submit?: boolean }) => Promise<ActionResult>;
  select: (handle: string, option: string) => Promise<ActionResult>;
  check: (handle: string, checked: boolean) => Promise<ActionResult>;
  hover: (handle: string) => Promise<ActionResult>;
  scroll: (target: 'up' | 'down' | string, distance?: number) => Promise<ActionResult>;
  press: (key: string) => Promise<ActionResult>;
  read: (handle: string) => Promise<ReadResult>;
  text: (opts?: { maxChars?: number }) => Promise<TextResult>;
  screenshot: (opts?: { path?: string; fullPage?: boolean }) => Promise<ScreenshotResult>;
  wait: (condition: WaitConditionType, timeoutMs?: number) => Promise<WaitResult>;
  back: () => Promise<ActionResult>;
  forward: () => Promise<ActionResult>;
  tabs: {
    new: (url?: string) => Promise<{ ok: boolean; tabId?: string }>;
    close: (id?: string) => Promise<{ ok: boolean }>;
    list: () => Promise<TabInfo[]>;
    switch: (id: string) => Promise<{ ok: boolean }>;
  };
  close: () => Promise<void>;
}

// CDP Accessibility node types (page.accessibility was removed in Playwright 1.61).
interface CDPAXValue {
  type: string;
  value?: string | boolean | number;
}
interface CDPAXProperty {
  name: string;
  value: CDPAXValue;
}
interface CDPAXNode {
  nodeId: string;
  backendDOMNodeId?: number;
  parentId?: string;
  childIds?: string[];
  role?: CDPAXValue;
  name?: CDPAXValue;
  value?: CDPAXValue;
  description?: CDPAXValue;
  properties?: CDPAXProperty[];
  ignored?: boolean;
}

/** A DOM node as returned by `DOM.getDocument`. */
interface CDPDOMNode {
  backendNodeId?: number;
  /** Flat [name, value, name, value, ...] pairs. */
  attributes?: string[];
  children?: CDPDOMNode[];
  shadowRoots?: CDPDOMNode[];
  contentDocument?: CDPDOMNode;
}

/** Attributes worth keeping: the ones that identify an element across changes. */
function pickAttrs(flat: string[] | undefined): StableAttrs | undefined {
  if (flat === undefined) return undefined;
  const out: StableAttrs = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const name = flat[i];
    const value = flat[i + 1];
    if (value === undefined || value === '') continue;
    if (name === 'id') out.id = value;
    else if (name === 'name') out.name = value;
    else if (name === 'data-testid' || name === 'data-test-id') out.dataTestId = value;
    else if (name === 'aria-label') out.ariaLabel = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map every DOM node's `backendNodeId` to its identifying attributes.
 *
 * The accessibility tree carries semantics but no attributes, so this is the
 * other half of the join that lets a handle survive a reorder rather than
 * relying on position (issue #16). Walks shadow roots and iframe documents too,
 * since `pierce` returns them inline.
 */
function collectAttrs(root: CDPDOMNode, into: Map<number, StableAttrs>): void {
  const stack: CDPDOMNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) continue;
    const attrs = pickAttrs(node.attributes);
    if (attrs !== undefined && node.backendNodeId !== undefined) {
      into.set(node.backendNodeId, attrs);
    }
    if (node.children) stack.push(...node.children);
    if (node.shadowRoots) stack.push(...node.shadowRoots);
    if (node.contentDocument) stack.push(node.contentDocument);
  }
}

/** A frame as returned by `Page.getFrameTree`. */
interface CDPFrameTree {
  frame: { id: string; url: string };
  childFrames?: CDPFrameTree[];
}

/**
 * Flatten a CDP frame tree in document order, root first.
 *
 * Playwright's `page.frames()` is breadth-first, so the two orderings disagree
 * once a frame nests. Both trees are walked depth-first here and in
 * `dfsFrames()` so the pairing between a CDP frame id and a Playwright `Frame`
 * is positional in the same sense on both sides.
 */
function dfsFrameTree(node: CDPFrameTree): { id: string; url: string }[] {
  return [
    { id: node.frame.id, url: node.frame.url },
    ...(node.childFrames ?? []).flatMap(dfsFrameTree),
  ];
}

/** Flatten Playwright's frame tree in the same depth-first order. */
function dfsFrames(frame: Frame): Frame[] {
  return [frame, ...frame.childFrames().flatMap(dfsFrames)];
}

/**
 * Bounds on frame merging.
 *
 * Ad-heavy pages carry dozens of tracking iframes — one measured page had 61
 * frames, of which the content frame was 40th. Capping by frame count in
 * document order therefore truncates exactly the wrong end, and it buys nothing:
 * reading all 61 took 22 ms, because these are pipe-local protocol calls issued
 * in parallel. So the frame cap is only a runaway guard, and what is actually
 * rationed is the number of nodes those frames may contribute to the view.
 */
const MAX_FRAMES = 64;
const MAX_FRAME_NODES = 2000;

/** Size of a converted subtree, for spending against the node budget. */
function countNodes(node: AXSnapshot): number {
  return 1 + (node.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

// Fetch the full AX tree via CDP and convert directly to AXSnapshot.
// The caller owns the session lifetime — attaching and detaching per call cost
// a round trip on every observation.
export async function getAXSnapshot(
  client: CDPSession,
  frameOptions?: { frames: Frame[]; register: (frameId: string, frame: Frame) => void },
): Promise<AXSnapshot | null> {
  {
    // Both trees in parallel: semantics from the AX tree, identity from the DOM.
    const [axResult, domResult] = await Promise.all([
      client.send('Accessibility.getFullAXTree') as Promise<{ nodes: CDPAXNode[] }>,
      (
        client.send('DOM.getDocument', { depth: -1, pierce: true }) as Promise<{
          root: CDPDOMNode;
        }>
      ).catch(() => null),
    ]);
    const { nodes } = axResult;

    const attrsByBackendId = new Map<number, StableAttrs>();
    if (domResult !== null) collectAttrs(domResult.root, attrsByBackendId);

    // Every converted node that owns a DOM node, so a child frame's tree can be
    // spliced under the exact `<iframe>` element that hosts it.
    const byBackendId = new Map<number, AXSnapshot>();

    /**
     * Convert one frame's flat CDP node list into a tree.
     *
     * `frameId` is stamped on every node so the resolver can tell two identically
     * named buttons in different frames apart, and so execution knows which frame
     * to root its locator in. It is undefined for the top-level document.
     */
    function buildTree(flat: CDPAXNode[], frameId?: string): AXSnapshot | null {
      const nodeMap = new Map<string, CDPAXNode>();
      for (const n of flat) nodeMap.set(n.nodeId, n);

      const rootNode = flat.find((n) => !n.parentId || !nodeMap.has(n.parentId));
      if (!rootNode) return null;

      // Recursively collect non-ignored descendants, flattening any ignored layers.
      function collectVisible(childIds: string[]): CDPAXNode[] {
        const result: CDPAXNode[] = [];
        for (const id of childIds) {
          const child = nodeMap.get(id);
          if (!child) continue;
          if (child.ignored) {
            result.push(...collectVisible(child.childIds ?? []));
          } else {
            result.push(child);
          }
        }
        return result;
      }

      function convert(node: CDPAXNode): AXSnapshot {
        const role = String(node.role?.value ?? 'none');
        const name = String(node.name?.value ?? '');
        const result: AXSnapshot = { role, name };
        if (frameId !== undefined) result.frameId = frameId;

        const rawVal = node.value?.value;
        if (rawVal !== undefined && rawVal !== null) result.value = String(rawVal);

        const rawDesc = node.description?.value;
        if (rawDesc !== undefined && rawDesc !== null) result.description = String(rawDesc);

        const attrs =
          node.backendDOMNodeId !== undefined
            ? attrsByBackendId.get(node.backendDOMNodeId)
            : undefined;
        if (attrs !== undefined) result.attrs = attrs;

        for (const prop of node.properties ?? []) {
          const v = prop.value?.value;
          if (prop.name === 'checked')
            result.checked = v === true || v === 'true' ? true : v === 'mixed' ? 'mixed' : false;
          else if (prop.name === 'disabled') result.disabled = v === true || v === 'true';
          else if (prop.name === 'required') result.required = v === true || v === 'true';
          else if (prop.name === 'expanded') result.expanded = v === true || v === 'true';
          else if (prop.name === 'selected') result.selected = v === true || v === 'true';
        }

        if (node.backendDOMNodeId !== undefined) byBackendId.set(node.backendDOMNodeId, result);

        // Ignored nodes are collapsed: skip the node but promote its children.
        // This mirrors the old page.accessibility.snapshot() behaviour.
        const visibleChildren = collectVisible(node.childIds ?? []);
        if (visibleChildren.length > 0) {
          result.children = visibleChildren.map(convert);
        }

        return result;
      }

      return convert(rootNode);
    }

    const root = buildTree(nodes);
    if (root === null) return null;
    if (frameOptions === undefined) return root;

    await mergeFrames(client, root, byBackendId, buildTree, frameOptions);
    return root;
  }
}

/**
 * Splice every child frame's accessibility tree into the page's.
 *
 * `getFullAXTree` returns one document, so iframe content was simply absent from
 * the view (issue #11). Attaching a CDP session to the frame is not an option —
 * same-process iframes do not get one — but the page's own session accepts
 * `getFullAXTree({frameId})`, and `DOM.getFrameOwner({frameId})` identifies the
 * `<iframe>` element to hang the result under.
 *
 * Best-effort throughout: a frame that fails to read is left out, and the page's
 * own tree is returned as it was.
 */
async function mergeFrames(
  client: CDPSession,
  root: AXSnapshot,
  byBackendId: Map<number, AXSnapshot>,
  buildTree: (flat: CDPAXNode[], frameId?: string) => AXSnapshot | null,
  opts: { frames: Frame[]; register: (frameId: string, frame: Frame) => void },
): Promise<void> {
  let tree: CDPFrameTree;
  try {
    ({ frameTree: tree } = (await client.send('Page.getFrameTree')) as { frameTree: CDPFrameTree });
  } catch {
    return;
  }

  const cdpFrames = dfsFrameTree(tree);
  const pwFrames = opts.frames;

  // Child frames only; the first entry on both sides is the main frame.
  const pending: { id: string; frame: Frame | undefined }[] = [];
  for (let i = 1; i < cdpFrames.length; i++) {
    if (pending.length >= MAX_FRAMES) break;
    const cdp = cdpFrames[i];
    if (cdp === undefined) continue;
    const candidate = pwFrames[i];
    // Positional pairing, confirmed by URL. A mismatch means the two trees moved
    // apart mid-read; the frame is still merged into the view, just not
    // actionable, which is better than acting in the wrong frame.
    pending.push({ id: cdp.id, frame: candidate?.url() === cdp.url ? candidate : undefined });
  }

  const subtrees = await Promise.all(
    pending.map(async ({ id }) => {
      try {
        const [ax, owner] = await Promise.all([
          client.send('Accessibility.getFullAXTree', { frameId: id }) as Promise<{
            nodes: CDPAXNode[];
          }>,
          client.send('DOM.getFrameOwner', { frameId: id }) as Promise<{ backendNodeId: number }>,
        ]);
        return { id, nodes: ax.nodes, ownerBackendId: owner.backendNodeId };
      } catch {
        return null;
      }
    }),
  );

  // Build every subtree before splicing any: a nested frame's `<iframe>` element
  // lives in its parent frame's tree, which may itself still be unbuilt.
  const built = subtrees.map((s) => (s === null ? null : { ...s, tree: buildTree(s.nodes, s.id) }));

  let budget = MAX_FRAME_NODES;
  for (const entry of built) {
    if (entry === null || entry.tree === null) continue;

    const size = countNodes(entry.tree);
    if (size > budget) continue;
    budget = budget - size;

    const host = byBackendId.get(entry.ownerBackendId);
    // The document's children hang directly off the `<iframe>` node; its own
    // RootWebArea would only add a layer of nesting the model has no use for.
    const children = entry.tree.children ?? [];
    if (host !== undefined) {
      host.children = [...(host.children ?? []), ...children];
    } else {
      // No matching `<iframe>` node in the AX tree (it can be ignored while its
      // document is not). Attaching at the root keeps the content reachable.
      root.children = [...(root.children ?? []), ...children];
    }
  }

  for (const { id, frame } of pending) {
    if (frame !== undefined) opts.register(id, frame);
  }
}

/**
 * Quote a string for safe use as a CSS attribute-selector value.
 *
 * Accessible names come from page content, which is attacker-controlled; an
 * unescaped quote would otherwise terminate the selector and let page text
 * alter which element is matched.
 */
/** Default cap on `text()`, chosen to stay well inside host output limits. */
const DEFAULT_TEXT_CHARS = 20_000;

export function cssQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * A pool of warm browser processes (AC-H1).
 *
 * `serve` launched a Chromium per request and closed it in a `finally`, so
 * every request paid full process startup and throughput was bounded by
 * launches rather than by the model (issue #13).
 *
 * What is pooled is the *process*, not the session. Each borrower makes its own
 * `BrowserContext`, which is what carries cookies, storage and cache — so
 * requests stay as isolated from one another as they were when each got its own
 * process, and the cross-profile guarantees still hold. Pooling the context
 * instead would amortise a little more and leak everything that matters.
 *
 * Note this is unrelated to `createSessionPool()` in `privacy/`, which is a
 * counting semaphore and amortises nothing.
 */
export interface BrowserPool {
  /** Borrow a browser, launching one if the pool is below its ceiling. */
  acquire: () => Promise<Browser>;
  /** Return a browser. A closed or crashed one is discarded rather than reused. */
  release: (browser: Browser) => void;
  /** Close every pooled browser. Safe to call more than once. */
  close: () => Promise<void>;
  /** How many processes are currently held. Exposed for tests and /metrics. */
  size: () => number;
}

export function createBrowserPool(opts?: {
  maxSize?: number;
  headless?: boolean;
  executablePath?: string;
}): BrowserPool {
  const maxSize = opts?.maxSize !== undefined && opts.maxSize > 0 ? opts.maxSize : 1;
  const idle: Browser[] = [];
  let live = 0;
  let closed = false;

  return {
    async acquire(): Promise<Browser> {
      if (closed) throw new Error('browser pool is closed');

      // Skip any that died while idle — a crashed browser is not a warm one.
      while (idle.length > 0) {
        const candidate = idle.pop();
        if (candidate !== undefined && candidate.isConnected()) return candidate;
        live = Math.max(0, live - 1);
      }

      const inContainer = existsSync('/.dockerenv') || process.env['SEPIA_NO_SANDBOX'] === '1';
      const launchOpts: Parameters<typeof chromium.launch>[0] = {
        headless: opts?.headless ?? true,
        args: inContainer ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
      };
      if (opts?.executablePath !== undefined) launchOpts.executablePath = opts.executablePath;
      const browser = await chromium.launch(launchOpts);
      live++;
      return browser;
    },

    release(browser: Browser): void {
      if (closed || !browser.isConnected()) {
        void browser.close().catch(() => {});
        live = Math.max(0, live - 1);
        return;
      }
      // Above the ceiling the process is closed rather than kept: the cap is
      // what stops a burst of concurrent requests leaving a pile of idle
      // Chromiums behind for the rest of the server's life.
      if (idle.length >= maxSize) {
        void browser.close().catch(() => {});
        live = Math.max(0, live - 1);
        return;
      }
      idle.push(browser);
    },

    async close(): Promise<void> {
      closed = true;
      const pending = idle.splice(0);
      live = 0;
      await Promise.all(pending.map((b) => b.close().catch(() => {})));
    },

    size(): number {
      return live;
    },
  };
}

// Engine factory — Phase 2 M3
export async function createEngine(opts?: EngineOptions): Promise<SepiaEngine> {
  const headless = opts?.headless ?? true;
  const inContainer = existsSync('/.dockerenv') || process.env['SEPIA_NO_SANDBOX'] === '1';
  const sandboxArgs = inContainer ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];

  // Resolve the preset before launching anything, so an unknown id fails
  // without leaking a browser process (AC-F6).
  const preset = opts?.profile !== undefined ? getPreset(opts.profile) : null;

  const contextOpts: Parameters<Browser['newContext']>[0] = {};
  if (preset !== null) {
    contextOpts.userAgent = preset.userAgent;
    contextOpts.locale = preset.locale;
    contextOpts.timezoneId = preset.timezone;
    contextOpts.viewport = { width: preset.screenWidth, height: preset.screenHeight };
    contextOpts.deviceScaleFactor = preset.deviceScaleFactor;
  }
  // Explicit overrides win over the preset.
  if (opts?.userAgent !== undefined) contextOpts.userAgent = opts.userAgent;
  if (opts?.viewport !== undefined) contextOpts.viewport = opts.viewport;

  let browser: Browser | undefined;
  let context: BrowserContext;

  if (opts?.profileDir !== undefined) {
    // Persistent context: cookies, localStorage, and IndexedDB survive across runs.
    mkdirSync(opts.profileDir, { recursive: true });
    context = await chromium.launchPersistentContext(opts.profileDir, {
      headless,
      args: sandboxArgs,
      ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
      ...contextOpts,
    });
  } else if (opts?.browser !== undefined) {
    // Borrowed: a fresh context gives this session its own cookie jar and
    // storage, while the expensive part — the browser process — is already
    // running. `browser` stays undefined on purpose so `close()` disposes the
    // context and leaves the process to its owner.
    context = await opts.browser.newContext(contextOpts);
  } else {
    const launchOpts: Parameters<typeof chromium.launch>[0] = { headless, args: sandboxArgs };
    if (opts?.executablePath !== undefined) launchOpts.executablePath = opts.executablePath;
    browser = await chromium.launch(launchOpts);
    context = await browser.newContext(contextOpts);
  }

  if (preset !== null) {
    // Applied before any page exists so it runs on every document, including
    // the first navigation.
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
      if (typeof window.chrome === 'undefined') {
        window.chrome = { runtime: {} };
      }
    `);
  }

  const allowedDomains = opts?.security?.allowedDomains;

  /**
   * SR-13 — enforce the allowlist where every navigation passes, not only where
   * `open()` does.
   *
   * A click on a link navigates without going near `open()`, and a link injected
   * into page content is the attack the allowlist exists to stop. Blocking at the
   * request layer covers redirects and script-driven navigation too.
   *
   * Scoped to main-frame document requests: blocking subresources would break
   * any page loading a script or image from a CDN, which is not what an operator
   * asks for by naming the sites the agent may visit. Installed only when an
   * allowlist is configured, so unrestricted sessions pay no interception cost.
   *
   * That scoping has a consequence worth stating plainly. Child frames are not
   * blocked, and their accessibility trees are merged into the view (#11), so
   * content from a domain outside the allowlist can still reach the model when an
   * allowed page embeds it. Blocking embeds instead would break the payment
   * fields and editors that merging exists to reach. The allowlist bounds where
   * the agent *navigates*, not what an allowed page is allowed to contain.
   */
  if (allowedDomains !== undefined && allowedDomains.length > 0) {
    await context.route('**/*', async (route, request) => {
      if (!request.isNavigationRequest() || request.frame().parentFrame() !== null) {
        return route.continue();
      }
      const host = hostnameOf(request.url());
      // about:blank and similar have no hostname and are not navigation off-site.
      if (host === null || host === '') return route.continue();
      return isDomainAllowed(host, allowedDomains)
        ? route.continue()
        : route.abort('blockedbyclient');
    });
  }

  // Mutable: this is the *active* tab, and `tabs.switch()` changes it. Every
  // closure below reads it through this binding, which is what makes switching
  // retarget observe, click, screenshot and the rest (AC-T1).
  let page: Page = await context.newPage();

  if (preset !== null) {
    // Coherence is checked before the session is handed out: a profile whose
    // signals contradict each other is worse than no profile at all.
    try {
      await page.goto('about:blank');
      await validateAndStart(preset, page);
    } catch (err) {
      if (browser !== undefined) await browser.close().catch(() => {});
      else await context.close().catch(() => {});
      throw err;
    }
  }

  // SR-10: rate limiter and robots cache — created only when the feature is enabled.
  const rateLimiter: RateLimiter | null =
    opts?.security?.rateLimitMs !== undefined || opts?.security?.robotsAwareness === true
      ? createRateLimiter()
      : null;
  const robotsCache: RobotsCache | null =
    opts?.security?.robotsAwareness === true ? createRobotsCache() : null;

  // Per-engine handle map — reset on navigation to new origin
  const handleMap: HandleMap = createHandleMap();
  let lastOrigin = '';

  const settleTimeoutMs = opts?.settleTimeoutMs ?? 1_500;
  const maxHandles = opts?.maxHandles ?? 2_000;

  /**
   * Wait for the page to be worth observing.
   *
   * Network-idle is only ever best-effort: pages with long-polling, SSE,
   * websockets, or analytics beacons never reach it, and waiting out a long
   * timeout on every observation dominated the cost of a run (AC-R8). The DOM
   * is settled enough to serialize well before the network is.
   */
  async function settle(): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: settleTimeoutMs }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: settleTimeoutMs }).catch(() => {});
  }

  // One CDP session for the page's lifetime, recreated only if it drops.
  let cdp: CDPSession | null = null;

  // ── tab identity ──
  // Ids are stable per page, not indices into `context.pages()`. An index
  // silently means a different tab once an earlier one closes — the same defect
  // as a reused handle, and worth refusing in the same way.
  const tabIds = new Map<Page, string>();
  let tabCounter = 0;

  function idFor(target: Page): string {
    const existing = tabIds.get(target);
    if (existing !== undefined) return existing;
    tabCounter++;
    const id = `t${String(tabCounter)}`;
    tabIds.set(target, id);
    return id;
  }

  /**
   * Make a page the active one.
   *
   * The CDP session belongs to the page it was attached to, and handles belong
   * to the document that issued them — both have to go, or the next observation
   * describes one page while actions land on another.
   */
  function activate(target: Page): void {
    page = target;
    cdp = null;
    clearHandleMap(handleMap);
    // Frames belong to the page that owns them. Nothing can reach a stale entry
    // today — the handles that would name one are gone with the map — but a
    // locator rooted in a dead frame is not a failure worth leaving available.
    framesById = new Map<string, Frame>();
    try {
      lastOrigin = new URL(target.url()).origin;
    } catch {
      lastOrigin = '';
    }
  }
  async function cdpSession(): Promise<CDPSession> {
    if (cdp === null) cdp = await page.context().newCDPSession(page);
    return cdp;
  }

  /**
   * Frames seen in the last snapshot, by CDP frame id.
   *
   * Rebuilt on every observation, and every action re-observes through the gate
   * immediately before executing, so the entry an action looks up is at most one
   * snapshot old. A frame that has since gone away resolves to nothing and the
   * action falls back to the page rather than acting somewhere unintended.
   */
  let framesById = new Map<string, Frame>();

  async function axSnapshot(): Promise<AXSnapshot | null> {
    const next = new Map<string, Frame>();
    const frameOptions = {
      frames: dfsFrames(page.mainFrame()),
      register: (frameId: string, frame: Frame) => next.set(frameId, frame),
    };
    try {
      return await getAXSnapshot(await cdpSession(), frameOptions);
    } catch {
      // Session can be torn down by a cross-document navigation; reattach once.
      cdp = null;
      return await getAXSnapshot(await cdpSession(), frameOptions);
    } finally {
      framesById = next;
    }
  }

  function maybeResetHandles(url: string): void {
    try {
      const origin = new URL(url).origin;
      if (origin !== lastOrigin) {
        clearHandleMap(handleMap);
        lastOrigin = origin;
      }
    } catch {
      // invalid url — don't reset
    }
  }

  async function getView(): Promise<{ view: CompactView; snap: AXSnapshot | null }> {
    const snap = await axSnapshot();
    const view = serialize(snap, null, { url: page.url(), title: await page.title() });
    const processed = processCompactView(view, handleMap);
    pruneHandleMap(handleMap, maxHandles);
    return { view: processed, snap };
  }

  const confidenceThreshold = opts?.confidenceThreshold ?? 0;

  type Gated =
    | { ok: true; fp: SemanticFingerprint; confidence: number }
    | {
        ok: false;
        confidence: number;
        error: { code: 'STALE_HANDLE' | 'LOW_CONFIDENCE'; message: string; handle: string };
      };

  /**
   * Observe, then decide whether the handle may be acted on at all.
   * Fails closed: a stale handle or one below the confidence threshold never
   * reaches the page (AC-AG6).
   */
  async function gate(handle: string): Promise<Gated> {
    const { view } = await getView();
    const decision = gateHandle(handle, view.nodes, handleMap, confidenceThreshold);

    if (!decision.allowed) {
      return decision.reason === 'stale'
        ? {
            ok: false,
            confidence: decision.confidence,
            error: {
              code: 'STALE_HANDLE',
              message: `Handle ${handle} is stale or not found`,
              handle,
            },
          }
        : {
            ok: false,
            confidence: decision.confidence,
            error: {
              code: 'LOW_CONFIDENCE',
              message:
                `Handle ${handle} resolved at confidence ${decision.confidence.toFixed(2)}, ` +
                `below threshold ${String(confidenceThreshold)} — refusing to act`,
              handle,
            },
          };
    }

    return { ok: true, fp: decision.target, confidence: decision.confidence };
  }

  /**
   * Resolve a fingerprint to the Playwright locator the action will run against.
   *
   * Uses the ordinal among identically-named same-role elements, so a handle
   * denoting the third "Delete" button acts on the third one. `.first()` would
   * silently act on the first match regardless of which handle was requested
   * (AC-R7).
   */
  function locate(fp: SemanticFingerprint) {
    // A locator built on the page never crosses into a frame, so an element that
    // came from one is addressed through that frame (issue #11).
    const scope = fp.frameId !== undefined ? (framesById.get(fp.frameId) ?? page) : page;
    return scope
      .getByRole(fp.role as Parameters<Page['getByRole']>[0], { name: fp.accessibleName })
      .nth(fp.ordinalAmongSameRoleAndName);
  }

  return {
    async open(url: string): Promise<ActionResult> {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return {
          ok: false,
          confidence: 0,
          error: {
            code: 'INVALID_URL',
            message: `URL must start with http:// or https://. Got: ${url}`,
          },
        };
      }

      // SR-13: the allowlist, checked here so the caller gets a distinct code
      // rather than a navigation failure. This is not the only enforcement
      // point — see the route below, which catches navigations `open()` never
      // sees, such as a click on an injected link.
      const host = hostnameOf(url);
      if (host === null || !isDomainAllowed(host, allowedDomains)) {
        return {
          ok: false,
          confidence: 0,
          error: {
            code: 'DOMAIN_NOT_ALLOWED',
            message: `Navigation to ${host ?? url} is outside security.allowedDomains`,
          },
        };
      }

      // SR-10: robots.txt check before any navigation
      if (robotsCache !== null) {
        const allowed = await robotsCache.isAllowed(url);
        if (!allowed) {
          return {
            ok: false,
            confidence: 0,
            error: {
              code: 'ROBOTS_DISALLOWED',
              message: `Blocked by robots.txt: ${url}`,
            },
          };
        }
      }

      // SR-10: rate limiting — honour robots.txt Crawl-delay as a floor
      if (rateLimiter !== null) {
        try {
          const hostname = new URL(url).hostname;
          const crawlDelay = robotsCache !== null ? await robotsCache.crawlDelayMs(url) : null;
          const effectiveMs = Math.max(opts?.security?.rateLimitMs ?? 0, crawlDelay ?? 0);
          if (effectiveMs > 0) await rateLimiter.enforce(hostname, effectiveMs);
        } catch {
          // invalid URL already caught above
        }
      }

      try {
        maybeResetHandles(url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        lastOrigin = new URL(url).origin;
        return { ok: true, confidence: 1 };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: {
            code: 'NAVIGATION_FAILED',
            message: String(err),
          },
        };
      }
    },

    async observe(observeOpts?: {
      verbosity?: 'minimal' | 'standard' | 'full';
      maxTokens?: number;
    }): Promise<CompactView> {
      await settle();
      const snap = await axSnapshot();
      const serOpts: {
        verbosity?: 'minimal' | 'standard' | 'full';
        maxTokens?: number;
        url: string;
        title: string;
      } = {
        url: page.url(),
        title: await page.title(),
      };
      if (observeOpts?.verbosity !== undefined) {
        serOpts.verbosity = observeOpts.verbosity;
      }
      if (observeOpts?.maxTokens !== undefined) {
        serOpts.maxTokens = observeOpts.maxTokens;
      }
      const view = serialize(snap, null, serOpts);
      const processed = processCompactView(view, handleMap);
      pruneHandleMap(handleMap, maxHandles);
      return processed;
    },

    async click(handle: string): Promise<ActionResult> {
      const g = await gate(handle);
      if (!g.ok) return { ok: false, confidence: g.confidence, error: g.error };
      const fp = g.fp;

      try {
        await locate(fp).click({ timeout: 10000 });
        await settle();
        return { ok: true, confidence: g.confidence };
      } catch (err) {
        try {
          await page
            .locator(`[aria-label=${cssQuote(fp.accessibleName)}]`)
            .nth(fp.ordinalAmongSameRole)
            .click({ timeout: 5000 });
          return { ok: true, confidence: g.confidence * 0.8 };
        } catch {
          return {
            ok: false,
            confidence: 0,
            error: {
              code: 'ELEMENT_NOT_FOUND',
              message: `Could not click handle ${handle}: ${String(err)}`,
              handle,
            },
          };
        }
      }
    },

    async type(
      handle: string,
      text: string,
      typeOpts?: { submit?: boolean },
    ): Promise<ActionResult> {
      const g = await gate(handle);
      if (!g.ok) return { ok: false, confidence: g.confidence, error: g.error };
      const fp = g.fp;

      try {
        const el = locate(fp);
        await el.fill(text, { timeout: 5000 });
        if (typeOpts?.submit === true) {
          await el.press('Enter');
          await settle();
        }
        return { ok: true, confidence: g.confidence };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            message: `Could not type into handle ${handle}: ${String(err)}`,
            handle,
          },
        };
      }
    },

    async select(handle: string, option: string): Promise<ActionResult> {
      const g = await gate(handle);
      if (!g.ok) return { ok: false, confidence: g.confidence, error: g.error };
      const fp = g.fp;

      try {
        await locate(fp).selectOption(option, { timeout: 5000 });
        return { ok: true, confidence: g.confidence };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            message: `Could not select option for handle ${handle}: ${String(err)}`,
            handle,
          },
        };
      }
    },

    async check(handle: string, checked: boolean): Promise<ActionResult> {
      const g = await gate(handle);
      if (!g.ok) return { ok: false, confidence: g.confidence, error: g.error };
      const fp = g.fp;

      try {
        const el = locate(fp);
        if (checked) {
          await el.check({ timeout: 5000 });
        } else {
          await el.uncheck({ timeout: 5000 });
        }
        return { ok: true, confidence: g.confidence };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            message: `Could not check handle ${handle}: ${String(err)}`,
            handle,
          },
        };
      }
    },

    async hover(handle: string): Promise<ActionResult> {
      const g = await gate(handle);
      if (!g.ok) return { ok: false, confidence: g.confidence, error: g.error };
      const fp = g.fp;

      try {
        await locate(fp).hover({ timeout: 5000 });
        return { ok: true, confidence: g.confidence };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            message: `Could not hover handle ${handle}: ${String(err)}`,
            handle,
          },
        };
      }
    },

    async scroll(target: 'up' | 'down' | string, distance?: number): Promise<ActionResult> {
      const delta = distance ?? 300;
      try {
        if (target === 'up') {
          await page.evaluate((d: number) => {
            (globalThis as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy(0, -d);
          }, delta);
        } else if (target === 'down') {
          await page.evaluate((d: number) => {
            (globalThis as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy(0, d);
          }, delta);
        } else {
          const g = await gate(target);
          if (!g.ok) return { ok: false, confidence: g.confidence, error: g.error };
          await locate(g.fp).scrollIntoViewIfNeeded({ timeout: 5000 });
        }
        return { ok: true, confidence: 1 };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: { code: 'UNKNOWN', message: String(err) },
        };
      }
    },

    async press(key: string): Promise<ActionResult> {
      try {
        await page.keyboard.press(key);
        return { ok: true, confidence: 1 };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: { code: 'UNKNOWN', message: String(err) },
        };
      }
    },

    async read(handle: string): Promise<ReadResult> {
      const g = await gate(handle);
      if (!g.ok) return { ok: false, error: g.error };

      try {
        const text = await locate(g.fp).innerText({ timeout: 5000 });
        return { ok: true, text };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'ELEMENT_NOT_FOUND',
            message: String(err),
            handle,
          },
        };
      }
    },

    /**
     * The page's readable text.
     *
     * The compact view deliberately omits prose, and `read` needs a handle,
     * which only interactive elements get — so without this there is no way to
     * retrieve article text at all (issue #27). Capped, and honest about it:
     * silent truncation would let a caller quote a sentence that was cut.
     */
    async text(textOpts?: { maxChars?: number }): Promise<TextResult> {
      const cap = textOpts?.maxChars ?? DEFAULT_TEXT_CHARS;
      try {
        await settle();
        // Per frame, not per page: `innerText` stops at the frame boundary, so a
        // page whose content is an embed would otherwise read as empty (#11).
        const perFrame = await Promise.all(
          dfsFrames(page.mainFrame())
            .slice(0, MAX_FRAMES)
            .map((f) =>
              f
                .evaluate(
                  () =>
                    (globalThis as unknown as { document: { body?: { innerText?: string } } })
                      .document.body?.innerText ?? '',
                )
                .catch(() => ''),
            ),
        );
        const raw = perFrame.filter((t) => t.trim() !== '').join('\n\n');
        const tidied = raw
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        return tidied.length > cap
          ? { ok: true, text: tidied.slice(0, cap), truncated: true }
          : { ok: true, text: tidied, truncated: false };
      } catch (err) {
        return { ok: false, error: { code: 'UNKNOWN', message: String(err) } };
      }
    },

    async screenshot(shotOpts?: { path?: string; fullPage?: boolean }): Promise<ScreenshotResult> {
      try {
        const buffer = await page.screenshot({
          fullPage: shotOpts?.fullPage ?? false,
          ...(shotOpts?.path !== undefined ? { path: shotOpts.path } : {}),
        });
        // A path means the caller wants an artefact on disk; otherwise hand back
        // the bytes. Either way this never enters the model context.
        return shotOpts?.path !== undefined
          ? { ok: true, path: shotOpts.path }
          : { ok: true, base64: buffer.toString('base64') };
      } catch (err) {
        return { ok: false, error: { code: 'UNKNOWN', message: String(err) } };
      }
    },

    async wait(condition: WaitConditionType, timeoutMs?: number): Promise<WaitResult> {
      const timeout = timeoutMs ?? 10000;
      try {
        if (condition.type === 'networkIdle') {
          await page.waitForLoadState('networkidle', { timeout });
          return { ok: true, timedOut: false };
        } else if (condition.type === 'url') {
          await page.waitForURL(condition.pattern, { timeout });
          return { ok: true, timedOut: false };
        } else if (condition.type === 'element') {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const g = await gate(condition.handle);
            if (g.ok) return { ok: true, timedOut: false };
            await new Promise<void>((r) => setTimeout(r, 500));
          }
          return { ok: false, timedOut: true };
        }
        return { ok: true, timedOut: false };
      } catch {
        return { ok: false, timedOut: true };
      }
    },

    async back(): Promise<ActionResult> {
      try {
        await page.goBack({ timeout: 10000 });
        await settle();
        return { ok: true, confidence: 1 };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: { code: 'NAVIGATION_FAILED', message: String(err) },
        };
      }
    },

    async forward(): Promise<ActionResult> {
      try {
        await page.goForward({ timeout: 10000 });
        await settle();
        return { ok: true, confidence: 1 };
      } catch (err) {
        return {
          ok: false,
          confidence: 0,
          error: { code: 'NAVIGATION_FAILED', message: String(err) },
        };
      }
    },

    tabs: {
      async new(url?: string): Promise<{ ok: boolean; tabId?: string }> {
        try {
          const newPage = await context.newPage();
          const tabId = idFor(newPage);
          if (url !== undefined) {
            await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
          // Deliberately does NOT become active. Focus moves only when asked
          // for, so a caller that opens a tab to come back to later does not
          // find its next action landing somewhere it did not choose.
          return { ok: true, tabId };
        } catch {
          return { ok: false };
        }
      },

      async close(id?: string): Promise<{ ok: boolean }> {
        try {
          const target = id !== undefined ? context.pages().find((p) => idFor(p) === id) : page;
          if (target === undefined) return { ok: false };

          const wasActive = target === page;
          await target.close();
          tabIds.delete(target);

          if (wasActive) {
            // Closing the active tab used to leave `page` pointing at a closed
            // page, and every later call died on it. A session always has an
            // active tab; if that meant closing the last one, open a blank
            // replacement rather than leaving the engine unusable.
            const remaining = context.pages();
            activate(remaining[remaining.length - 1] ?? (await context.newPage()));
          }
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      async list(): Promise<TabInfo[]> {
        const pages = context.pages();
        const results: TabInfo[] = [];
        for (const p of pages) {
          results.push({
            id: idFor(p),
            url: p.url(),
            title: await p.title(),
            active: p === page,
          });
        }
        return results;
      },

      async switch(id: string): Promise<{ ok: boolean }> {
        try {
          const target = context.pages().find((p) => idFor(p) === id);
          if (target === undefined) return { ok: false };
          await target.bringToFront();
          // `bringToFront` alone was the whole of the old implementation, which
          // is why switching appeared to work and changed nothing: the engine
          // kept acting on the page it was constructed with (AC-T1).
          activate(target);
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
    },

    async close(): Promise<void> {
      if (cdp !== null) {
        await cdp.detach().catch(() => {});
        cdp = null;
      }
      // Persistent context has no separate Browser object; closing the context is enough.
      if (browser !== undefined) {
        await browser.close();
      } else {
        await context.close();
      }
    },
  };
}
