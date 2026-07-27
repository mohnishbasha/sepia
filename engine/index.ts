import { existsSync, mkdirSync } from 'node:fs';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
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
} from '../types/index.js';
import type { HandleMap } from '../resolver/index.js';
import { createRateLimiter, createRobotsCache } from '../security/index.js';
import type { RateLimiter, RobotsCache } from '../security/index.js';
import { getPreset, validateAndStart } from '../fingerprint/index.js';

export type { CompactView, ActionResult, ReadResult, WaitResult, TabInfo };

export interface EngineOptions {
  executablePath?: string;
  headless?: boolean;
  profileDir?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  humanTiming?: boolean;
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
  security?: {
    rateLimitMs?: number;
    robotsAwareness?: boolean;
  };
}

export interface SepiaEngine {
  open: (url: string) => Promise<ActionResult>;
  observe: (opts?: { verbosity?: 'minimal' | 'standard' | 'full' }) => Promise<CompactView>;
  click: (handle: string) => Promise<ActionResult>;
  type: (handle: string, text: string, opts?: { submit?: boolean }) => Promise<ActionResult>;
  select: (handle: string, option: string) => Promise<ActionResult>;
  check: (handle: string, checked: boolean) => Promise<ActionResult>;
  hover: (handle: string) => Promise<ActionResult>;
  scroll: (target: 'up' | 'down' | string, distance?: number) => Promise<ActionResult>;
  press: (key: string) => Promise<ActionResult>;
  read: (handle: string) => Promise<ReadResult>;
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
  parentId?: string;
  childIds?: string[];
  role?: CDPAXValue;
  name?: CDPAXValue;
  value?: CDPAXValue;
  description?: CDPAXValue;
  properties?: CDPAXProperty[];
  ignored?: boolean;
}

// Fetch the full AX tree via CDP and convert directly to AXSnapshot.
// The caller owns the session lifetime — attaching and detaching per call cost
// a round trip on every observation.
async function getAXSnapshot(client: CDPSession): Promise<AXSnapshot | null> {
  {
    const { nodes } = (await client.send('Accessibility.getFullAXTree')) as {
      nodes: CDPAXNode[];
    };

    const nodeMap = new Map<string, CDPAXNode>();
    for (const n of nodes) nodeMap.set(n.nodeId, n);

    const root = nodes.find((n) => !n.parentId || !nodeMap.has(n.parentId));
    if (!root) return null;

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

      const rawVal = node.value?.value;
      if (rawVal !== undefined && rawVal !== null) result.value = String(rawVal);

      const rawDesc = node.description?.value;
      if (rawDesc !== undefined && rawDesc !== null) result.description = String(rawDesc);

      for (const prop of node.properties ?? []) {
        const v = prop.value?.value;
        if (prop.name === 'checked')
          result.checked = v === true || v === 'true' ? true : v === 'mixed' ? 'mixed' : false;
        else if (prop.name === 'disabled') result.disabled = v === true || v === 'true';
        else if (prop.name === 'required') result.required = v === true || v === 'true';
        else if (prop.name === 'expanded') result.expanded = v === true || v === 'true';
        else if (prop.name === 'selected') result.selected = v === true || v === 'true';
      }

      // Ignored nodes are collapsed: skip the node but promote its children.
      // This mirrors the old page.accessibility.snapshot() behaviour.
      const visibleChildren = collectVisible(node.childIds ?? []);
      if (visibleChildren.length > 0) {
        result.children = visibleChildren.map(convert);
      }

      return result;
    }

    return convert(root);
  }
}

/**
 * Quote a string for safe use as a CSS attribute-selector value.
 *
 * Accessible names come from page content, which is attacker-controlled; an
 * unescaped quote would otherwise terminate the selector and let page text
 * alter which element is matched.
 */
export function cssQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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

  const page: Page = await context.newPage();

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
  async function cdpSession(): Promise<CDPSession> {
    if (cdp === null) cdp = await page.context().newCDPSession(page);
    return cdp;
  }

  async function axSnapshot(): Promise<AXSnapshot | null> {
    try {
      return await getAXSnapshot(await cdpSession());
    } catch {
      // Session can be torn down by a cross-document navigation; reattach once.
      cdp = null;
      return getAXSnapshot(await cdpSession());
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
    return page
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
    }): Promise<CompactView> {
      await settle();
      const snap = await axSnapshot();
      const serOpts: { verbosity?: 'minimal' | 'standard' | 'full'; url: string; title: string } = {
        url: page.url(),
        title: await page.title(),
      };
      if (observeOpts?.verbosity !== undefined) {
        serOpts.verbosity = observeOpts.verbosity;
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
          const tabId = String(context.pages().indexOf(newPage));
          if (url !== undefined) {
            await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          }
          return { ok: true, tabId };
        } catch {
          return { ok: false };
        }
      },

      async close(id?: string): Promise<{ ok: boolean }> {
        try {
          const pages = context.pages();
          if (id !== undefined) {
            const idx = parseInt(id, 10);
            const target = pages[idx];
            if (target !== undefined) {
              await target.close();
            }
          } else {
            const last = pages[pages.length - 1];
            if (last !== undefined) {
              await last.close();
            }
          }
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },

      async list(): Promise<TabInfo[]> {
        const pages = context.pages();
        const results: TabInfo[] = [];
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          if (p === undefined) continue;
          results.push({
            id: String(i),
            url: p.url(),
            title: await p.title(),
            active: p === page,
          });
        }
        return results;
      },

      async switch(id: string): Promise<{ ok: boolean }> {
        try {
          const pages = context.pages();
          const idx = parseInt(id, 10);
          const target = pages[idx];
          if (target === undefined) return { ok: false };
          await target.bringToFront();
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
