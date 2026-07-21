import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { serialize } from '../serializer/index.js';
import type { AXSnapshot } from '../serializer/index.js';
import { createHandleMap, resolveHandle, processCompactView } from '../resolver/index.js';
import type {
  CompactView,
  ActionResult,
  ReadResult,
  WaitResult,
  TabInfo,
  WaitConditionType,
} from '../types/index.js';
import type { HandleMap } from '../resolver/index.js';

export type { CompactView, ActionResult, ReadResult, WaitResult, TabInfo };

export interface EngineOptions {
  executablePath?: string;
  headless?: boolean;
  profileDir?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  humanTiming?: boolean;
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
async function getAXSnapshot(page: Page): Promise<AXSnapshot | null> {
  const client = await page.context().newCDPSession(page);
  try {
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
        if (prop.name === 'checked') result.checked = v === true || v === 'true' ? true : v === 'mixed' ? 'mixed' : false;
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
  } finally {
    await client.detach();
  }
}

// Engine factory — Phase 2 M3
export async function createEngine(opts?: EngineOptions): Promise<SepiaEngine> {
  const launchOpts: Parameters<typeof chromium.launch>[0] = {
    headless: opts?.headless ?? true,
  };
  if (opts?.executablePath !== undefined) {
    launchOpts.executablePath = opts.executablePath;
  }
  // Chromium's sandbox requires SYS_ADMIN or user namespaces, which are
  // unavailable in most container runtimes. Detect container via /.dockerenv
  // or the explicit opt-out env var and add the required flags.
  const inContainer = existsSync('/.dockerenv') || process.env['SEPIA_NO_SANDBOX'] === '1';
  if (inContainer) {
    launchOpts.args = ['--no-sandbox', '--disable-setuid-sandbox'];
  }

  const browser: Browser = await chromium.launch(launchOpts);

  const contextOpts: Parameters<Browser['newContext']>[0] = {};
  if (opts?.userAgent !== undefined) {
    contextOpts.userAgent = opts.userAgent;
  }
  if (opts?.viewport !== undefined) {
    contextOpts.viewport = opts.viewport;
  }

  const context: BrowserContext = await browser.newContext(contextOpts);
  const page: Page = await context.newPage();

  // Per-engine handle map — reset on navigation to new origin
  const handleMap: HandleMap = createHandleMap();
  let lastOrigin = '';

  async function settle(): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  }

  function maybeResetHandles(url: string): void {
    try {
      const origin = new URL(url).origin;
      if (origin !== lastOrigin) {
        handleMap.clear();
        lastOrigin = origin;
      }
    } catch {
      // invalid url — don't reset
    }
  }

  async function getView(): Promise<{ view: CompactView; snap: AXSnapshot | null }> {
    const snap = await getAXSnapshot(page);
    const view = serialize(snap, null, { url: page.url(), title: await page.title() });
    return { view: processCompactView(view, handleMap), snap };
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
      const snap = await getAXSnapshot(page);
      const serOpts: { verbosity?: 'minimal' | 'standard' | 'full'; url: string; title: string } = {
        url: page.url(),
        title: await page.title(),
      };
      if (observeOpts?.verbosity !== undefined) {
        serOpts.verbosity = observeOpts.verbosity;
      }
      const view = serialize(snap, null, serOpts);
      return processCompactView(view, handleMap);
    },

    async click(handle: string): Promise<ActionResult> {
      const { view } = await getView();
      const resolveResult = resolveHandle(handle, view.nodes, handleMap);
      if (resolveResult.stale) {
        return {
          ok: false,
          confidence: resolveResult.confidence,
          error: {
            code: 'STALE_HANDLE',
            message: `Handle ${handle} is stale or not found`,
            handle,
          },
        };
      }

      const record = resolveResult.record;
      const fp = record.fingerprint;

      try {
        const locator = page.getByRole(fp.role as Parameters<Page['getByRole']>[0], {
          name: fp.accessibleName,
        });
        await locator.first().click({ timeout: 10000 });
        await settle();
        return { ok: true, confidence: resolveResult.confidence };
      } catch (err) {
        try {
          await page
            .locator(`[aria-label="${fp.accessibleName}"]`)
            .first()
            .click({ timeout: 5000 });
          return { ok: true, confidence: resolveResult.confidence * 0.8 };
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
      const { view } = await getView();
      const resolveResult = resolveHandle(handle, view.nodes, handleMap);
      if (resolveResult.stale) {
        return {
          ok: false,
          confidence: resolveResult.confidence,
          error: {
            code: 'STALE_HANDLE',
            message: `Handle ${handle} is stale or not found`,
            handle,
          },
        };
      }

      const fp = resolveResult.record.fingerprint;

      try {
        const locator = page.getByRole(fp.role as Parameters<Page['getByRole']>[0], {
          name: fp.accessibleName,
        });
        const el = locator.first();
        await el.clear({ timeout: 5000 });
        await el.fill(text, { timeout: 5000 });
        if (typeOpts?.submit === true) {
          await el.press('Enter');
          await settle();
        }
        return { ok: true, confidence: resolveResult.confidence };
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
      const { view } = await getView();
      const resolveResult = resolveHandle(handle, view.nodes, handleMap);
      if (resolveResult.stale) {
        return {
          ok: false,
          confidence: resolveResult.confidence,
          error: { code: 'STALE_HANDLE', message: `Handle ${handle} is stale`, handle },
        };
      }

      const fp = resolveResult.record.fingerprint;

      try {
        const locator = page.getByRole(fp.role as Parameters<Page['getByRole']>[0], {
          name: fp.accessibleName,
        });
        await locator.first().selectOption(option, { timeout: 5000 });
        return { ok: true, confidence: resolveResult.confidence };
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
      const { view } = await getView();
      const resolveResult = resolveHandle(handle, view.nodes, handleMap);
      if (resolveResult.stale) {
        return {
          ok: false,
          confidence: resolveResult.confidence,
          error: { code: 'STALE_HANDLE', message: `Handle ${handle} is stale`, handle },
        };
      }

      const fp = resolveResult.record.fingerprint;

      try {
        const locator = page.getByRole(fp.role as Parameters<Page['getByRole']>[0], {
          name: fp.accessibleName,
        });
        if (checked) {
          await locator.first().check({ timeout: 5000 });
        } else {
          await locator.first().uncheck({ timeout: 5000 });
        }
        return { ok: true, confidence: resolveResult.confidence };
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
      const { view } = await getView();
      const resolveResult = resolveHandle(handle, view.nodes, handleMap);
      if (resolveResult.stale) {
        return {
          ok: false,
          confidence: resolveResult.confidence,
          error: { code: 'STALE_HANDLE', message: `Handle ${handle} is stale`, handle },
        };
      }

      const fp = resolveResult.record.fingerprint;

      try {
        const locator = page.getByRole(fp.role as Parameters<Page['getByRole']>[0], {
          name: fp.accessibleName,
        });
        await locator.first().hover({ timeout: 5000 });
        return { ok: true, confidence: resolveResult.confidence };
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
          const { view } = await getView();
          const resolveResult = resolveHandle(target, view.nodes, handleMap);
          if (resolveResult.stale) {
            return {
              ok: false,
              confidence: resolveResult.confidence,
              error: {
                code: 'STALE_HANDLE',
                message: `Handle ${target} is stale`,
                handle: target,
              },
            };
          }
          const fp = resolveResult.record.fingerprint;
          const locator = page.getByRole(fp.role as Parameters<Page['getByRole']>[0], {
            name: fp.accessibleName,
          });
          await locator.first().scrollIntoViewIfNeeded({ timeout: 5000 });
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
      const { view } = await getView();
      const resolveResult = resolveHandle(handle, view.nodes, handleMap);
      if (resolveResult.stale) {
        return {
          ok: false,
          error: {
            code: 'STALE_HANDLE',
            message: `Handle ${handle} is stale`,
            handle,
          },
        };
      }

      const fp = resolveResult.record.fingerprint;

      try {
        const locator = page.getByRole(fp.role as Parameters<Page['getByRole']>[0], {
          name: fp.accessibleName,
        });
        const text = await locator.first().innerText({ timeout: 5000 });
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
            const { view } = await getView();
            const resolveResult = resolveHandle(condition.handle, view.nodes, handleMap);
            if (!resolveResult.stale) {
              return { ok: true, timedOut: false };
            }
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
      await browser.close();
    },
  };
}
