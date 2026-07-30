/**
 * AC-S8 — the disambiguation works on a real page, not just a synthetic tree.
 *
 * The page under test is the shape that actually caused wrong destructive
 * actions in practice: a bulk "Delete" in a toolbar followed by per-row deletes
 * spelled identically. Before this, a model asked to delete Item 3 had five
 * indistinguishable lines to choose from, one of which deleted everything.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import type { CompactNode } from '../../types/index.js';

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  const dir = new URL('../../fixtures/pages', import.meta.url).pathname;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(dir, 'list-ambiguous.html'), 'utf-8'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function deleteButtons(): Promise<CompactNode[]> {
  const engine = await createEngine({ headless: true, confidenceThreshold: 0.7 });
  try {
    await engine.open(`${baseUrl}/list-ambiguous.html`);
    const view = await engine.observe();
    return view.nodes.filter((n) => n.role === 'button' && n.name.trim() === 'Delete');
  } finally {
    await engine.close();
  }
}

describe('AC-S8 — a model can now tell the buttons apart', () => {
  it('finds all five identically-named buttons', async () => {
    expect(await deleteButtons()).toHaveLength(5);
  }, 30000);

  it('gives each one distinguishing context', async () => {
    const buttons = await deleteButtons();

    const contexts = buttons.map((b) => b.context);
    expect(contexts.every((c) => c !== undefined)).toBe(true);
    expect(new Set(contexts).size).toBe(5);
  }, 30000);

  it('names the row for each per-row delete', async () => {
    const buttons = await deleteButtons();

    // Rows follow the toolbar button in document order.
    expect(buttons[1]?.context).toContain('Item 1');
    expect(buttons[2]?.context).toContain('Item 2');
    expect(buttons[3]?.context).toContain('Item 3');
    expect(buttons[4]?.context).toContain('Item 4');
  }, 30000);

  it('marks the bulk delete as belonging to the toolbar, not a row', async () => {
    const buttons = await deleteButtons();

    // This is the one that deletes everything. It must not read like a row.
    expect(buttons[0]?.context).toContain('Toolbar');
    expect(buttons[0]?.context).not.toContain('Item');
  }, 30000);

  it('acting on the labelled handle still hits the right row', async () => {
    const engine = await createEngine({ headless: true, confidenceThreshold: 0.7 });
    try {
      await engine.open(`${baseUrl}/list-ambiguous.html`);
      const view = await engine.observe();
      const target = view.nodes.find(
        (n) => n.role === 'button' && n.context?.includes('Item 3') === true,
      );
      expect(target?.handle).toBeDefined();

      const result = await engine.click(target!.handle!);
      expect(result.ok).toBe(true);

      const after = await engine.observe();
      expect(after.nodes.map((n) => n.name)).toContain('Deleted item 3');
    } finally {
      await engine.close();
    }
  }, 30000);
});
