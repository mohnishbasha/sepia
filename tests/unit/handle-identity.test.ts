/**
 * AC-R6 — handle identity at scale, plus the supporting primitives.
 */

import { describe, it, expect } from 'vitest';
import { createHandleMap, clearHandleMap, processNodes } from '../../resolver/index.js';
import { cssQuote } from '../../engine/index.js';
import type { CompactNode } from '../../types/index.js';

function identicalButtons(n: number): CompactNode[] {
  return Array.from({ length: n }, () => ({
    handle: 'x',
    role: 'button',
    name: 'Delete',
    indent: 0,
  }));
}

describe('AC-R6 — distinct handles at scale', () => {
  it.each([5, 10, 20, 50])('gives %i identical buttons that many distinct handles', (n) => {
    const map = createHandleMap();
    const handles = processNodes(identicalButtons(n), map).map((node) => node.handle);

    expect(new Set(handles).size).toBe(n);
  });

  it('is idempotent — re-processing the same page reuses the same handles', () => {
    const map = createHandleMap();
    const nodes = identicalButtons(6);

    const first = processNodes(nodes, map).map((n) => n.handle);
    const second = processNodes(nodes, map).map((n) => n.handle);

    expect(second).toEqual(first);
    expect(map.size).toBe(6);
  });

  it('separates elements that share a name but not a role', () => {
    const map = createHandleMap();
    const nodes: CompactNode[] = [
      { handle: 'x', role: 'button', name: 'Open', indent: 0 },
      { handle: 'x', role: 'link', name: 'Open', indent: 0 },
    ];

    const handles = processNodes(nodes, map).map((n) => n.handle);
    expect(new Set(handles).size).toBe(2);
  });

  it('separates elements distinguished only by stable attributes', () => {
    const map = createHandleMap();
    const nodes: CompactNode[] = [
      { handle: 'x', role: 'button', name: '', indent: 0, attrs: { dataTestId: 'save' } },
      { handle: 'x', role: 'button', name: '', indent: 0, attrs: { dataTestId: 'discard' } },
    ];

    const handles = processNodes(nodes, map).map((n) => n.handle);
    expect(new Set(handles).size).toBe(2);
  });
});

describe('clearHandleMap', () => {
  it('drops every record', () => {
    const map = createHandleMap();
    processNodes(identicalButtons(3), map);
    expect(map.size).toBe(3);

    clearHandleMap(map);
    expect(map.size).toBe(0);
  });

  it('never reissues a handle string used before the clear', () => {
    const map = createHandleMap();
    const before = processNodes(identicalButtons(2), map).map((n) => n.handle);

    clearHandleMap(map);
    const after = processNodes(identicalButtons(2), map).map((n) => n.handle);

    // A model still holding "e1" from the previous page must not have it
    // silently rebound to a different element.
    expect(after.some((h) => before.includes(h))).toBe(false);
  });

  it('leaves a handle from the previous page unresolvable rather than aliased', () => {
    const map = createHandleMap();
    const before = processNodes(identicalButtons(2), map).map((n) => n.handle);

    clearHandleMap(map);
    processNodes([{ handle: 'x', role: 'link', name: 'Home', indent: 0 }], map);

    expect(map.has(before[0]!)).toBe(false);
  });

  it('re-registers identities after a clear instead of reusing dead handles', () => {
    const map = createHandleMap();
    processNodes(identicalButtons(2), map);
    clearHandleMap(map);

    const handles = processNodes(identicalButtons(2), map).map((n) => n.handle);
    expect(new Set(handles).size).toBe(2);
    expect(map.size).toBe(2);
  });
});

describe('cssQuote — attribute selector injection', () => {
  it('quotes a plain value', () => {
    expect(cssQuote('Sign in')).toBe('"Sign in"');
  });

  it('escapes a double quote so page text cannot terminate the selector', () => {
    expect(cssQuote('a" ] , [onclick^="x')).toBe('"a\\" ] , [onclick^=\\"x"');
  });

  it('escapes backslashes before quotes', () => {
    expect(cssQuote('back\\slash')).toBe('"back\\\\slash"');
  });

  it('leaves the value otherwise intact', () => {
    expect(cssQuote("it's fine")).toBe('"it\'s fine"');
  });
});
