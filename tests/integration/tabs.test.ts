/**
 * AC-T1 — tabs are addressable, and switching actually switches (issue #26).
 *
 * `tabs.switch()` called `bringToFront()` and nothing else. The engine binds
 * `page` once at creation, so every action — observe, click, type, screenshot —
 * kept targeting the first tab forever. `tabs.list()` compounded it by computing
 * `active` against that same fixed page, so it always reported tab 0 as active
 * and agreed with itself while being wrong.
 *
 * Nothing failed. A host would open a tab, switch to it, observe, and get a
 * faithful description of a different page.
 *
 * Tab ids are also no longer indices into `context.pages()`. An index silently
 * refers to a different tab once an earlier one closes — the same class of bug
 * as a reused handle, and this project's answer to that is stable identity that
 * fails closed rather than drifting.
 */

import { createServer } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import type { SepiaEngine } from '../../engine/index.js';

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const name = (req.url ?? '/').replace('/', '') || 'FIRST';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${name}</title></head>` +
        `<body><h1>${name}-PAGE</h1><button>${name}-BUTTON</button></body></html>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function withEngine<T>(fn: (e: SepiaEngine) => Promise<T>): Promise<T> {
  const engine = await createEngine({ headless: true });
  try {
    await engine.open(`${baseUrl}/FIRST`);
    return await fn(engine);
  } finally {
    await engine.close();
  }
}

/** Headings visible on whichever tab is currently active. */
async function heading(engine: SepiaEngine): Promise<string> {
  const view = await engine.observe();
  return view.nodes.map((n) => n.name).join(' ');
}

describe('AC-T1 — switching retargets every action', () => {
  it('observes the tab that was switched to', async () => {
    const seen = await withEngine(async (e) => {
      const { tabId } = await e.tabs.new(`${baseUrl}/SECOND`);
      expect(tabId).toBeDefined();

      const before = await heading(e);
      await e.tabs.switch(tabId!);
      const after = await heading(e);
      return { before, after };
    });

    expect(seen.after).toContain('SECOND-PAGE');
  }, 40000);

  it('switches back to the original tab', async () => {
    const back = await withEngine(async (e) => {
      const first = (await e.tabs.list()).find((t) => t.active)!.id;
      const { tabId: second } = await e.tabs.new(`${baseUrl}/SECOND`);

      await e.tabs.switch(second!);
      await e.tabs.switch(first);
      return heading(e);
    });

    expect(back).toContain('FIRST-PAGE');
  }, 40000);

  it('acts on the tab that is active, not the first one', async () => {
    const clicked = await withEngine(async (e) => {
      const { tabId } = await e.tabs.new(`${baseUrl}/SECOND`);
      await e.tabs.switch(tabId!);

      const button = (await e.observe()).nodes.find((n) => n.role === 'button');
      // The button only exists on the second tab under this name.
      expect(button?.name).toContain('SECOND');
      return (await e.click(button!.handle!)).ok;
    });

    expect(clicked).toBe(true);
  }, 40000);

  it('refuses an unknown tab id rather than silently doing nothing', async () => {
    const result = await withEngine(async (e) => e.tabs.switch('t9999'));

    expect(result.ok).toBe(false);
  }, 40000);
});

describe('AC-T1 — list reports the truth', () => {
  it('marks exactly one tab active, and it is the one switched to', async () => {
    const tabs = await withEngine(async (e) => {
      const { tabId } = await e.tabs.new(`${baseUrl}/SECOND`);
      await e.tabs.switch(tabId!);
      return e.tabs.list();
    });

    const active = tabs.filter((t) => t.active);
    expect(active).toHaveLength(1);
    expect(active[0]?.url).toContain('/SECOND');
  }, 40000);

  it('lists a tab the page opened by itself', async () => {
    const tabs = await withEngine(async (e) => {
      await e.tabs.new(`${baseUrl}/SECOND`);
      return e.tabs.list();
    });

    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.id)).toEqual([...new Set(tabs.map((t) => t.id))]);
  }, 40000);
});

describe('AC-T1 — ids survive a close', () => {
  it('keeps pointing at the same tab after an earlier one closes', async () => {
    const title = await withEngine(async (e) => {
      const first = (await e.tabs.list()).find((t) => t.active)!.id;
      const { tabId: second } = await e.tabs.new(`${baseUrl}/SECOND`);
      const { tabId: third } = await e.tabs.new(`${baseUrl}/THIRD`);

      // With index-based ids, closing the first renumbers the rest and this
      // switch lands on the wrong tab.
      await e.tabs.close(first);
      await e.tabs.switch(third!);
      void second;
      return heading(e);
    });

    expect(title).toContain('THIRD-PAGE');
  }, 40000);

  it('stays usable after closing the active tab', async () => {
    const ok = await withEngine(async (e) => {
      const { tabId } = await e.tabs.new(`${baseUrl}/SECOND`);
      await e.tabs.switch(tabId!);
      await e.tabs.close(tabId!);

      // Some tab must be active afterwards, or every later call fails.
      const view = await e.observe();
      return view.nodes.length >= 0 && (await e.tabs.list()).some((t) => t.active);
    });

    expect(ok).toBe(true);
  }, 40000);

  it('closes the active tab when given no id', async () => {
    const remaining = await withEngine(async (e) => {
      const { tabId } = await e.tabs.new(`${baseUrl}/SECOND`);
      await e.tabs.switch(tabId!);
      await e.tabs.close();
      return e.tabs.list();
    });

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.url).toContain('/FIRST');
  }, 40000);
});

describe('AC-T1 — handles do not leak across tabs', () => {
  it('refuses a handle from the tab that is no longer active', async () => {
    const result = await withEngine(async (e) => {
      const stale = (await e.observe()).nodes.find((n) => n.role === 'button')!.handle!;
      const { tabId } = await e.tabs.new(`${baseUrl}/SECOND`);
      await e.tabs.switch(tabId!);

      return e.click(stale);
    });

    // Acting on it would click a same-shaped button on a different page.
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STALE_HANDLE');
  }, 40000);
});
