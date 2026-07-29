/**
 * AC-S10 / AC-R10 — iframe content is visible, and actionable (issue #11).
 *
 * `Accessibility.getFullAXTree` returns the tree for one frame's document only.
 * Everything inside an `<iframe>` was therefore absent from the compact view:
 * checkout forms, payment fields, embedded editors. The agent did not error on
 * them — it confidently described the empty shell around them.
 *
 * The frame's own CDP session is not an option: same-process iframes do not get
 * one ("This frame does not have a separate CDP session"). The page session does
 * accept `getFullAXTree({frameId})`, and `DOM.getFrameOwner({frameId})` names the
 * exact `<iframe>` element to splice the result under.
 *
 * Acting is the other half. `page.getByRole()` never descends into a frame, so a
 * fingerprint carries the frame it came from and the locator is rooted there.
 */

import { createServer } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import type { SepiaEngine } from '../../engine/index.js';
import type { CompactNode } from '../../types/index.js';

const INNER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Inner</title></head>
<body>
  <h1>Inner heading</h1>
  <p>INNER-PROSE inside the frame.</p>
  <button onclick="this.textContent='CLICKED-INNER'">Inner button</button>
  <iframe src="/deep" width="200" height="100"></iframe>
</body></html>`;

const DEEP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Deep</title></head>
<body><button>Deep button</button></body></html>`;

const OUTER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Outer</title></head>
<body>
  <h1>Outer heading</h1>
  <button>Outer button</button>
  <iframe src="/inner" width="400" height="300"></iframe>
</body></html>`;

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/inner' ? INNER : req.url === '/deep' ? DEEP : OUTER);
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
    await engine.open(`${baseUrl}/`);
    return await fn(engine);
  } finally {
    await engine.close();
  }
}

function named(nodes: CompactNode[], name: string): CompactNode | undefined {
  return nodes.find((n) => n.name === name);
}

describe('AC-S10 — frame content reaches the compact view', () => {
  it('includes a control that lives inside an iframe', async () => {
    const nodes = await withEngine(async (e) => (await e.observe()).nodes);

    expect(named(nodes, 'Outer button')).toBeDefined();
    expect(named(nodes, 'Inner button')).toBeDefined();
  }, 30000);

  it('descends into a frame nested inside a frame', async () => {
    const nodes = await withEngine(async (e) => (await e.observe()).nodes);

    expect(named(nodes, 'Deep button')).toBeDefined();
  }, 30000);

  it('gives frame elements their own handles', async () => {
    const nodes = await withEngine(async (e) => (await e.observe()).nodes);

    const outer = named(nodes, 'Outer button')?.handle;
    const inner = named(nodes, 'Inner button')?.handle;

    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(inner).not.toBe(outer);
  }, 30000);

  it('reaches prose inside a frame at full verbosity', async () => {
    const nodes = await withEngine(async (e) => (await e.observe({ verbosity: 'full' })).nodes);

    expect(nodes.map((n) => n.name).join(' ')).toContain('INNER-PROSE');
  }, 30000);
});

describe('AC-R10 — a frame handle acts inside its frame', () => {
  it('clicks the button in the iframe, not the one in the page', async () => {
    const result = await withEngine(async (e) => {
      const handle = named((await e.observe()).nodes, 'Inner button')?.handle;
      expect(handle).toBeDefined();

      const clicked = await e.click(handle!);
      expect(clicked.ok).toBe(true);

      // The button relabels itself, so the next observation proves the click
      // landed inside the frame rather than on some same-named element outside.
      const after = (await e.observe()).nodes;
      return after.map((n) => n.name).join(' ');
    });

    expect(result).toContain('CLICKED-INNER');
  }, 30000);

  it('returns the text inside frames too, not just the outer document', async () => {
    const text = await withEngine(async (e) => (await e.text()).text ?? '');

    // `document.body.innerText` stops at the frame boundary, so a page whose
    // whole content is an embed used to read as empty.
    expect(text).toContain('Outer heading');
    expect(text).toContain('INNER-PROSE');
  }, 30000);

  it('still acts on the top-level page when the handle came from it', async () => {
    const ok = await withEngine(async (e) => {
      const handle = named((await e.observe()).nodes, 'Outer button')?.handle;
      return (await e.click(handle!)).ok;
    });

    expect(ok).toBe(true);
  }, 30000);
});
