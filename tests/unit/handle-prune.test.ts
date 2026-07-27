/**
 * AC-R8 — the handle map stays bounded.
 *
 * A long single-origin session (an SPA, or many in-page navigations) kept
 * accumulating handle records forever, since the map was only ever cleared on
 * an origin change.
 */

import { describe, it, expect } from 'vitest';
import {
  createHandleMap,
  processNodes,
  pruneHandleMap,
  resolveHandle,
} from '../../resolver/index.js';
import type { CompactNode } from '../../types/index.js';

function distinctButtons(from: number, to: number): CompactNode[] {
  const nodes: CompactNode[] = [];
  for (let i = from; i < to; i++) {
    nodes.push({ handle: 'x', role: 'button', name: `Action ${String(i)}`, indent: 0 });
  }
  return nodes;
}

describe('AC-R8 — pruneHandleMap', () => {
  it('caps the map at the requested size', () => {
    const map = createHandleMap();
    processNodes(distinctButtons(0, 100), map);
    expect(map.size).toBe(100);

    pruneHandleMap(map, 40);
    expect(map.size).toBe(40);
  });

  it('keeps the most recently seen records', () => {
    const map = createHandleMap();
    processNodes(distinctButtons(0, 10), map);

    // Re-observe only the last three, refreshing their lastSeenMs.
    const recent = distinctButtons(7, 10);
    processNodes(recent, map);

    pruneHandleMap(map, 3);

    const survivingNames = [...map.values()].map((r) => r.fingerprint.accessibleName).sort();
    expect(survivingNames).toEqual(['action 7', 'action 8', 'action 9']);
  });

  it('is a no-op when the map is already under the cap', () => {
    const map = createHandleMap();
    processNodes(distinctButtons(0, 5), map);

    pruneHandleMap(map, 50);
    expect(map.size).toBe(5);
  });

  it('leaves an evicted handle unresolvable rather than dangling', () => {
    const map = createHandleMap();
    const nodes = distinctButtons(0, 10);
    const handles = processNodes(nodes, map).map((n) => n.handle!);

    pruneHandleMap(map, 2);

    const evicted = handles[0]!;
    expect(map.has(evicted)).toBe(false);
    expect(resolveHandle(evicted, nodes, map).stale).toBe(true);
  });

  it('lets a pruned element be re-registered with a fresh handle', () => {
    const map = createHandleMap();
    const nodes = distinctButtons(0, 4);
    const original = processNodes(nodes, map).map((n) => n.handle!);

    pruneHandleMap(map, 1);
    const reassigned = processNodes(nodes, map).map((n) => n.handle!);

    // The identity index must not hand back handles that were evicted.
    expect(new Set(reassigned).size).toBe(4);
    for (const handle of reassigned) {
      expect(map.has(handle)).toBe(true);
    }
    expect(reassigned[0]).not.toBe(original[0]);
  });
});
