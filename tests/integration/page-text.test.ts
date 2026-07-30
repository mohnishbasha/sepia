/**
 * AC-S9 / AC-A7 — page prose is reachable.
 *
 * Two defects, one symptom (issue #27):
 *
 *  - `full` verbosity is documented as "everything except explicitly excluded
 *    nodes", but its branch emits *and recurses* only when a node has a non-empty
 *    accessible name. A `<p>` has none, so the element and all its text were
 *    dropped. Body prose appeared at no verbosity at all.
 *  - `read(handle)` cannot substitute, because handles are assigned only to
 *    interactive roles and prose never gets one. The tool whose description says
 *    "use this when the outline truncated something you need in full" could not
 *    address the content that gets truncated.
 *
 * Net effect before this: a browser tool built for extraction could not extract.
 */

import { createServer } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { serialize } from '../../serializer/index.js';
import type { AXSnapshot } from '../../serializer/index.js';
import { createEngine } from '../../engine/index.js';

// ── the serializer bug, in isolation ─────────────────────────────────────────

const DOC: AXSnapshot = {
  role: 'WebArea',
  name: 'Doc',
  children: [
    { role: 'heading', name: 'Title' },
    {
      role: 'paragraph',
      name: '',
      children: [{ role: 'StaticText', name: 'The body text a user actually wants.' }],
    },
    {
      role: 'article',
      name: '',
      children: [
        { role: 'paragraph', name: '', children: [{ role: 'StaticText', name: 'Nested prose.' }] },
      ],
    },
  ],
};

function names(verbosity: 'minimal' | 'standard' | 'full'): string[] {
  return serialize(DOC, null, { verbosity }).nodes.map((n) => n.name);
}

describe('AC-S9 — full verbosity includes prose', () => {
  it('surfaces text inside an unnamed paragraph', () => {
    expect(names('full').join(' ')).toContain('The body text a user actually wants.');
  });

  it('descends through unnamed containers to reach nested prose', () => {
    expect(names('full').join(' ')).toContain('Nested prose.');
  });

  it('still leaves prose out of standard, which is the point of standard', () => {
    expect(names('standard').join(' ')).not.toContain('The body text');
  });

  it('keeps minimal free of prose too', () => {
    expect(names('minimal').join(' ')).not.toContain('The body text');
  });
});

// ── the missing capability, against a real page ──────────────────────────────

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Article</title></head>
<body>
  <h1>An Article</h1>
  <p>FIRST-PARAGRAPH about the accessibility tree and why it matters.</p>
  <p>SECOND-PARAGRAPH with more detail that no tool could previously retrieve.</p>
  <button>Not prose</button>
</body></html>`;

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('AC-A7 — the page text is retrievable', () => {
  it('returns the article prose', async () => {
    const engine = await createEngine({ headless: true });
    try {
      await engine.open(`${baseUrl}/`);
      const result = await engine.text();

      expect(result.ok).toBe(true);
      expect(result.text).toContain('FIRST-PARAGRAPH');
      expect(result.text).toContain('SECOND-PARAGRAPH');
    } finally {
      await engine.close();
    }
  }, 30000);

  it('caps output and says so, rather than truncating silently', async () => {
    const engine = await createEngine({ headless: true });
    try {
      await engine.open(`${baseUrl}/`);
      const result = await engine.text({ maxChars: 40 });

      expect(result.ok).toBe(true);
      expect((result.text ?? '').length).toBeLessThanOrEqual(40);
      expect(result.truncated).toBe(true);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('reports not truncated when everything fits', async () => {
    const engine = await createEngine({ headless: true });
    try {
      await engine.open(`${baseUrl}/`);
      const result = await engine.text({ maxChars: 100_000 });

      expect(result.truncated).toBe(false);
    } finally {
      await engine.close();
    }
  }, 30000);
});
