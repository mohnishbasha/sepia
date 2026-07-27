/**
 * AC-AG6 — fail closed on ambiguity.
 *
 * `config.agent.confidenceThreshold` was previously declared but never read by
 * any code path, so a low-confidence handle was acted on regardless. The gate
 * is a pure resolver function so the decision can be tested exhaustively
 * without a browser.
 */

import { describe, it, expect } from 'vitest';
import { createHandleMap, processNodes, gateHandle } from '../../resolver/index.js';
import type { CompactNode } from '../../types/index.js';

function seed(nodes: CompactNode[]) {
  const map = createHandleMap();
  const processed = processNodes(nodes, map);
  return { map, processed };
}

describe('AC-AG6 — gateHandle', () => {
  it('allows a handle that resolves at or above the threshold', () => {
    const before: CompactNode[] = [{ handle: 'x', role: 'button', name: 'Sign in', indent: 0 }];
    const { map, processed } = seed(before);

    const gate = gateHandle(processed[0]!.handle!, before, map, 0.7);

    expect(gate.allowed).toBe(true);
    expect(gate.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('refuses a handle whose element is gone (stale)', () => {
    const before: CompactNode[] = [
      { handle: 'x', role: 'button', name: 'Confirm purchase', indent: 0 },
    ];
    const { map, processed } = seed(before);

    // Page now has a completely unrelated control.
    const after: CompactNode[] = [{ handle: 'x', role: 'link', name: 'Home', indent: 0 }];
    const gate = gateHandle(processed[0]!.handle!, after, map, 0.7);

    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toBe('stale');
  });

  it('refuses a handle that resolves below the threshold but above staleness', () => {
    const before: CompactNode[] = [
      { handle: 'x', role: 'button', name: 'Delete account permanently', indent: 0 },
    ];
    const { map, processed } = seed(before);

    // Same role, partially overlapping name → mid-band confidence.
    const after: CompactNode[] = [{ handle: 'x', role: 'button', name: 'Delete draft', indent: 0 }];
    const gate = gateHandle(processed[0]!.handle!, after, map, 0.95);

    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toBe('low_confidence');
  });

  it('refuses an unknown handle', () => {
    const map = createHandleMap();
    const gate = gateHandle('e999', [], map, 0.7);

    expect(gate.allowed).toBe(false);
    expect(gate.allowed === false && gate.reason).toBe('stale');
  });

  it('threshold of 0 still refuses a stale handle', () => {
    const map = createHandleMap();
    const gate = gateHandle('e999', [], map, 0);

    expect(gate.allowed).toBe(false);
  });
});
