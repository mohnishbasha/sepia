/**
 * AC-R9 — handle identity uses real DOM attributes, not just position.
 *
 * `SemanticFingerprint.stableAttrs` (id, name, data-testid, aria-label) has
 * always existed and carried 15% of the similarity score, but nothing ever
 * populated it: the engine reads only `Accessibility.getFullAXTree`, and an AX
 * node carries no `id` or `data-testid`. Identity therefore leaned entirely on
 * `ordinalAmongSameRoleAndName`, which is positional — two identically-named
 * buttons swap identity the moment they are reordered.
 *
 * Joining the AX tree against `DOM.getDocument` on `backendNodeId` supplies the
 * missing half. Issue #16.
 */

import { createServer } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import type { CompactNode } from '../../types/index.js';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Attrs</title></head>
<body>
  <h1>Attrs</h1>
  <button id="save-btn" data-testid="save" name="saveField">Go</button>
  <button data-testid="discard" aria-label="Discard changes">Go</button>
  <button>Go</button>
  <input id="email-field" name="email" aria-label="Email address" />
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

async function nodes(): Promise<CompactNode[]> {
  const engine = await createEngine({ headless: true });
  try {
    await engine.open(`${baseUrl}/`);
    return (await engine.observe()).nodes;
  } finally {
    await engine.close();
  }
}

describe('AC-R9 — attributes reach the compact view', () => {
  it('picks up id, name and data-testid', async () => {
    const first = (await nodes()).find((n) => n.role === 'button');

    expect(first?.attrs).toBeDefined();
    expect(first?.attrs?.id).toBe('save-btn');
    expect(first?.attrs?.dataTestId).toBe('save');
    expect(first?.attrs?.name).toBe('saveField');
  }, 30000);

  it('picks up aria-label', async () => {
    const withAria = (await nodes()).find((n) => n.attrs?.dataTestId === 'discard');

    expect(withAria?.attrs?.ariaLabel).toBe('Discard changes');
  }, 30000);

  it('leaves attrs absent on an element that has none', async () => {
    const bare = (await nodes()).filter((n) => n.role === 'button')[2];

    // Three buttons all named "Go"; the third carries no identifying attributes.
    expect(bare?.attrs?.id).toBeUndefined();
    expect(bare?.attrs?.dataTestId).toBeUndefined();
  }, 30000);

  it('reads attributes on inputs too, not only buttons', async () => {
    const input = (await nodes()).find((n) => n.role === 'textbox');

    expect(input?.attrs?.id).toBe('email-field');
    expect(input?.attrs?.name).toBe('email');
  }, 30000);
});

describe('AC-R9 — identity follows the attribute, not the position', () => {
  it('re-resolves a moved element by its data-testid', async () => {
    const { createHandleMap, processNodes, resolveHandle } =
      await import('../../resolver/index.js');

    const before: CompactNode[] = [
      { handle: 'x', role: 'button', name: 'Go', indent: 0, attrs: { dataTestId: 'save' } },
      { handle: 'x', role: 'button', name: 'Go', indent: 0, attrs: { dataTestId: 'discard' } },
    ];
    const map = createHandleMap();
    const discard = processNodes(before, map)[1]!.handle!;

    // Same names, swapped positions. Ordinal alone would now point at the other
    // button; the attribute is what keeps the handle on the right element.
    const after: CompactNode[] = [
      { handle: 'x', role: 'button', name: 'Go', indent: 0, attrs: { dataTestId: 'discard' } },
      { handle: 'x', role: 'button', name: 'Go', indent: 0, attrs: { dataTestId: 'save' } },
    ];

    const resolved = resolveHandle(discard, after, map);

    expect(resolved.stale).toBe(false);
    expect(resolved.matched?.stableAttrs.dataTestId).toBe('discard');
  });

  it('scores a matching attribute above a mismatching one', async () => {
    const { scoreFingerprints } = await import('../../resolver/index.js');

    const base = {
      role: 'button',
      accessibleName: 'go',
      ordinalAmongSameRole: 0,
      ordinalAmongSameRoleAndName: 0,
    };

    const same = scoreFingerprints(
      { ...base, stableAttrs: { dataTestId: 'save' } },
      { ...base, stableAttrs: { dataTestId: 'save' } },
    );
    const different = scoreFingerprints(
      { ...base, stableAttrs: { dataTestId: 'save' } },
      { ...base, stableAttrs: { dataTestId: 'discard' } },
    );

    expect(same).toBeGreaterThan(different);
  });
});
