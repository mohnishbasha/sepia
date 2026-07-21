import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

import type { CompactNode } from '../../types/index.js';
import {
  createHandleMap,
  processNodes,
  resolveHandle,
  assignHandle,
  deriveFingerprint,
} from '../../resolver/index.js';

// ── Fixture loader ────────────────────────────────────────────────────────────

interface MutationFixture {
  description: string;
  before: CompactNode[];
  after: CompactNode[];
  expectations: Record<string, 'stable' | 'stale'>;
}

function loadFixture(name: string): MutationFixture {
  const fixturePath = resolve(process.cwd(), 'fixtures', 'mutation', `${name}.json`);
  const raw = readFileSync(fixturePath, 'utf-8');
  return JSON.parse(raw) as MutationFixture;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Given a fixture, assigns handles to `before` nodes and returns a map of
 * node name → assigned handle.
 */
function assignHandlesAndBuildNameMap(fixture: MutationFixture): {
  nameToHandle: Map<string, string>;
  map: ReturnType<typeof createHandleMap>;
} {
  const map = createHandleMap();
  const processedBefore = processNodes(fixture.before, map);

  const nameToHandle = new Map<string, string>();
  for (const node of processedBefore) {
    if (node.handle !== undefined) {
      nameToHandle.set(node.name, node.handle);
    }
  }

  return { nameToHandle, map };
}

// ── AC-R1: reorder fixture ────────────────────────────────────────────────────

describe('AC-R1 — handle survives DOM reorder with confidence ≥ 0.8', () => {
  it('all buttons remain stable after reordering', () => {
    const fixture = loadFixture('reorder');
    const { nameToHandle, map } = assignHandlesAndBuildNameMap(fixture);

    for (const [name, expectation] of Object.entries(fixture.expectations)) {
      const handle = nameToHandle.get(name);
      expect(handle, `handle for "${name}" should be assigned`).toBeDefined();

      const result = resolveHandle(handle!, fixture.after, map);

      if (expectation === 'stable') {
        expect(result.stale, `"${name}" should not be stale`).toBe(false);
        expect(
          result.confidence,
          `"${name}" confidence should be ≥ 0.8 but was ${result.confidence}`,
        ).toBeGreaterThanOrEqual(0.8);
      } else {
        expect(result.stale, `"${name}" should be stale`).toBe(true);
      }
    }
  });
});

// ── AC-R2: class-swap fixture ─────────────────────────────────────────────────

describe('AC-R2 — handle survives class-name / style swap', () => {
  it('button is stable even when moved to a different ordinal position', () => {
    const fixture = loadFixture('class-swap');
    const { nameToHandle, map } = assignHandlesAndBuildNameMap(fixture);

    for (const [name, expectation] of Object.entries(fixture.expectations)) {
      const handle = nameToHandle.get(name);
      expect(handle, `handle for "${name}" should be assigned`).toBeDefined();

      const result = resolveHandle(handle!, fixture.after, map);

      if (expectation === 'stable') {
        expect(result.stale, `"${name}" should not be stale`).toBe(false);
        expect(
          result.confidence,
          `"${name}" confidence should be ≥ 0.8 but was ${result.confidence}`,
        ).toBeGreaterThanOrEqual(0.8);
      } else {
        expect(result.stale, `"${name}" should be stale`).toBe(true);
      }
    }
  });
});

// ── AC-R3: removal fixture ────────────────────────────────────────────────────

describe('AC-R3 — removed element returns stale:true', () => {
  it('removed element is stale; remaining elements are stable', () => {
    const fixture = loadFixture('removal');
    const { nameToHandle, map } = assignHandlesAndBuildNameMap(fixture);

    for (const [name, expectation] of Object.entries(fixture.expectations)) {
      const handle = nameToHandle.get(name);
      expect(handle, `handle for "${name}" should be assigned`).toBeDefined();

      const result = resolveHandle(handle!, fixture.after, map);

      if (expectation === 'stable') {
        expect(result.stale, `"${name}" should not be stale`).toBe(false);
        expect(
          result.confidence,
          `"${name}" confidence should be ≥ 0.8 but was ${result.confidence}`,
        ).toBeGreaterThanOrEqual(0.8);
      } else {
        expect(result.stale, `"${name}" should be stale`).toBe(true);
      }
    }
  });
});

// ── AC-R4: determinism ────────────────────────────────────────────────────────

describe('AC-R4 — resolution is deterministic', () => {
  it('calling resolveHandle twice with same args returns identical confidence', () => {
    const fixture = loadFixture('reorder');
    const { nameToHandle, map } = assignHandlesAndBuildNameMap(fixture);

    // Pick the first node
    const firstName = Object.keys(fixture.expectations)[0]!;
    const handle = nameToHandle.get(firstName)!;
    expect(handle).toBeDefined();

    const result1 = resolveHandle(handle, fixture.after, map);
    const result2 = resolveHandle(handle, fixture.after, map);

    expect(result1.confidence).toBe(result2.confidence);
    expect(result1.stale).toBe(result2.stale);
  });
});

// ── AC-R5: icon-only button (empty accessible name) ──────────────────────────

describe('AC-R5 — icon-only button handled gracefully', () => {
  it('icon-only buttons with empty name get handles without crash', () => {
    const iconNodes: CompactNode[] = [
      { handle: 'x', role: 'button', name: '', indent: 0 },
      { handle: 'x', role: 'button', name: '', indent: 0 },
      { handle: 'x', role: 'button', name: '', indent: 0 },
    ];

    const map = createHandleMap();
    expect(() => processNodes(iconNodes, map)).not.toThrow();

    const processed = processNodes(iconNodes, map);
    for (const node of processed) {
      expect(node.handle).toBeDefined();
      expect(typeof node.handle).toBe('string');
    }
  });

  it('icon-only button resolves with ordinal-based confidence and no crash', () => {
    const before: CompactNode[] = [
      { handle: 'x', role: 'button', name: '', indent: 0 },
      { handle: 'x', role: 'button', name: '', indent: 0 },
    ];

    const after: CompactNode[] = [
      { handle: 'x', role: 'button', name: '', indent: 0 },
      { handle: 'x', role: 'button', name: '', indent: 0 },
    ];

    const map = createHandleMap();
    const processed = processNodes(before, map);

    expect(processed.length).toBe(2);

    // Each processed node must have a handle
    const handle0 = processed[0]!.handle!;
    const handle1 = processed[1]!.handle!;
    expect(handle0).toBeDefined();
    expect(handle1).toBeDefined();

    // Resolution should not throw and should return a result
    expect(() => resolveHandle(handle0, after, map)).not.toThrow();
    const result = resolveHandle(handle0, after, map);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('assignHandle with empty name fingerprint succeeds and returns a valid handle', () => {
    const map = createHandleMap();

    const node: CompactNode = { handle: 'x', role: 'button', name: '', indent: 0 };
    const fingerprint = deriveFingerprint(node, [node]);

    expect(() => assignHandle(fingerprint, map)).not.toThrow();
    const handle = assignHandle(fingerprint, map);
    expect(typeof handle).toBe('string');
    expect(handle.length).toBeGreaterThan(0);
    expect(map.has(handle)).toBe(true);
  });
});
