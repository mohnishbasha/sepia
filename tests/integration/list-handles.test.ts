/**
 * AC-R6 / AC-R7 — identical elements are individually addressable.
 *
 * AC-R6: N elements sharing a role and accessible name must receive N distinct
 *        handles. Collapsing them means the model cannot express "the third
 *        one" at all.
 * AC-R7: acting on a handle must hit the element that handle denotes, not the
 *        first role+name match on the page.
 *
 * Runs against a real Chromium via createEngine().
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
    res.end(readFileSync(join(dir, 'list.html'), 'utf-8'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function deleteButtons(nodes: CompactNode[]): CompactNode[] {
  return nodes.filter((n) => n.role === 'button' && n.name.trim() === 'Delete');
}

describe('AC-R6 — identical elements get distinct handles', () => {
  it('assigns one distinct handle per Delete button', async () => {
    const engine = await createEngine({ headless: true, confidenceThreshold: 0.7 });
    try {
      await engine.open(`${baseUrl}/list.html`);
      const view = await engine.observe();

      const buttons = deleteButtons(view.nodes);
      expect(buttons).toHaveLength(5);

      const handles = buttons.map((b) => b.handle);
      expect(handles.every((h) => h !== undefined)).toBe(true);
      expect(new Set(handles).size).toBe(5);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('keeps handles stable when the same page is observed again', async () => {
    const engine = await createEngine({ headless: true, confidenceThreshold: 0.7 });
    try {
      await engine.open(`${baseUrl}/list.html`);
      const first = deleteButtons((await engine.observe()).nodes).map((b) => b.handle);
      const second = deleteButtons((await engine.observe()).nodes).map((b) => b.handle);

      expect(second).toEqual(first);
    } finally {
      await engine.close();
    }
  }, 30000);
});

describe('AC-R7 — the acted-on element is the one the handle denotes', () => {
  it('clicking the third Delete handle deletes the third item', async () => {
    const engine = await createEngine({ headless: true, confidenceThreshold: 0.7 });
    try {
      await engine.open(`${baseUrl}/list.html`);
      const view = await engine.observe();

      const third = deleteButtons(view.nodes)[2];
      expect(third?.handle).toBeDefined();

      const result = await engine.click(third!.handle!);
      expect(result.ok).toBe(true);

      const after = await engine.observe();
      const names = after.nodes.map((n) => n.name);
      expect(names).toContain('Deleted item 3');
    } finally {
      await engine.close();
    }
  }, 30000);

  it('clicking the fifth Delete handle deletes the fifth item', async () => {
    const engine = await createEngine({ headless: true, confidenceThreshold: 0.7 });
    try {
      await engine.open(`${baseUrl}/list.html`);
      const view = await engine.observe();

      const fifth = deleteButtons(view.nodes)[4];
      const result = await engine.click(fifth!.handle!);
      expect(result.ok).toBe(true);

      const after = await engine.observe();
      expect(after.nodes.map((n) => n.name)).toContain('Deleted item 5');
    } finally {
      await engine.close();
    }
  }, 30000);
});
