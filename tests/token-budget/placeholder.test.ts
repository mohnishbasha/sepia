import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { serialize, estimateTokens } from '../../serializer/index.js';
import type { AXSnapshot, SerializerOptions } from '../../serializer/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(new URL('.', import.meta.url).pathname, '../../fixtures/corpus');

interface CorpusFixture {
  title: string;
  url: string;
  axSnapshot: AXSnapshot;
  groundTruth: string[];
}

function loadFixture(filename: string): CorpusFixture {
  const raw = readFileSync(join(FIXTURES_DIR, filename), 'utf-8');
  return JSON.parse(raw) as CorpusFixture;
}

const FIXTURE_FILES = [
  'login-page.json',
  'search-results.json',
  'dashboard.json',
  'checkout.json',
  'settings.json',
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

// ---------------------------------------------------------------------------
// AC-S1: Median tokenCount ≤ 900 across all 5 fixtures (standard verbosity)
// ---------------------------------------------------------------------------

describe('token-budget', () => {
  it('AC-S1: median tokenCount ≤ 900 across corpus (standard verbosity)', () => {
    const tokenCounts = FIXTURE_FILES.map((file) => {
      const fixture = loadFixture(file);
      const opts: SerializerOptions = {
        url: fixture.url,
        title: fixture.title,
        verbosity: 'standard',
      };
      const view = serialize(fixture.axSnapshot, null, opts);
      return view.tokenCount;
    });

    const med = median(tokenCounts);
    expect(med).toBeLessThanOrEqual(900);
  });

  // -------------------------------------------------------------------------
  // AC-S2: Max tokenCount ≤ 1500 across all 5 fixtures (standard verbosity)
  // -------------------------------------------------------------------------

  it('AC-S2: max tokenCount ≤ 1500 across corpus (standard verbosity)', () => {
    const tokenCounts = FIXTURE_FILES.map((file) => {
      const fixture = loadFixture(file);
      const opts: SerializerOptions = {
        url: fixture.url,
        title: fixture.title,
        verbosity: 'standard',
      };
      const view = serialize(fixture.axSnapshot, null, opts);
      return view.tokenCount;
    });

    const p95 = percentile(tokenCounts, 95);
    const max = Math.max(...tokenCounts);
    // Use max as proxy for p95 since we have 5 fixtures
    expect(Math.max(p95, max)).toBeLessThanOrEqual(1500);
  });

  // -------------------------------------------------------------------------
  // AC-S3: ≥ 95% of groundTruth names appear in compact view (case-insensitive)
  // -------------------------------------------------------------------------

  it('AC-S3: ≥ 95% of ground-truth names appear in compact view', () => {
    for (const file of FIXTURE_FILES) {
      const fixture = loadFixture(file);
      const opts: SerializerOptions = {
        url: fixture.url,
        title: fixture.title,
        verbosity: 'standard',
      };
      const view = serialize(fixture.axSnapshot, null, opts);

      const nodeNames = view.nodes.map((n) => n.name.toLowerCase());

      let covered = 0;
      for (const expected of fixture.groundTruth) {
        const found = nodeNames.some((name) =>
          name.includes(expected.toLowerCase()),
        );
        if (found) covered++;
      }

      const coverage = covered / fixture.groundTruth.length;
      expect(coverage, `Coverage for ${file}: ${covered}/${fixture.groundTruth.length}`).toBeGreaterThanOrEqual(0.95);
    }
  });

  // -------------------------------------------------------------------------
  // AC-S4: Serializer output is deterministic (same input → same JSON)
  // -------------------------------------------------------------------------

  it('AC-S4: serializer output is deterministic for same input', () => {
    for (const file of FIXTURE_FILES) {
      const fixture = loadFixture(file);
      const opts: SerializerOptions = {
        url: fixture.url,
        title: fixture.title,
        verbosity: 'standard',
      };

      const view1 = serialize(fixture.axSnapshot, null, opts);
      const view2 = serialize(fixture.axSnapshot, null, opts);

      // Compare everything except timestampMs (which is Date.now())
      const { timestampMs: _t1, ...rest1 } = view1;
      const { timestampMs: _t2, ...rest2 } = view2;

      expect(JSON.stringify(rest1)).toEqual(JSON.stringify(rest2));
    }
  });

  // -------------------------------------------------------------------------
  // AC-S5: DOM fallback activates when AX tree has < 5 interactive nodes
  // -------------------------------------------------------------------------

  it('AC-S5: DOM-fallback activates on sparse AX tree and includes generic nodes with names', () => {
    // Synthetic snapshot with only 2 interactive nodes
    const sparseSnapshot: AXSnapshot = {
      role: 'WebArea',
      name: 'Sparse page',
      children: [
        {
          role: 'button',
          name: 'Cancel',
          children: [],
        },
        {
          role: 'link',
          name: 'Help',
          children: [],
        },
        // A generic node that would normally be skipped but should appear via DOM fallback
        {
          role: 'generic',
          name: 'Submit',
          children: [],
        },
      ],
    };

    const view = serialize(sparseSnapshot, null, { verbosity: 'standard' });

    // DOM fallback should have kicked in (< 5 interactive nodes)
    const submitNode = view.nodes.find(
      (n) => n.name.toLowerCase() === 'submit',
    );
    expect(submitNode).toBeDefined();
    expect(submitNode?.handle).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-S6 (bonus): minimal verbosity produces fewer nodes than standard
  // -------------------------------------------------------------------------

  it('AC-S6: minimal verbosity produces fewer or equal nodes than standard on dashboard fixture', () => {
    const fixture = loadFixture('dashboard.json');

    const standardView = serialize(fixture.axSnapshot, null, {
      url: fixture.url,
      title: fixture.title,
      verbosity: 'standard',
    });

    const minimalView = serialize(fixture.axSnapshot, null, {
      url: fixture.url,
      title: fixture.title,
      verbosity: 'minimal',
    });

    expect(minimalView.nodes.length).toBeLessThanOrEqual(standardView.nodes.length);
  });

  // -------------------------------------------------------------------------
  // Extra: estimateTokens formula
  // -------------------------------------------------------------------------

  it('estimateTokens uses Math.ceil(text.length / 4)', () => {
    expect(estimateTokens('hello')).toBe(Math.ceil(5 / 4));
    expect(estimateTokens('hello world!')).toBe(Math.ceil(12 / 4));
    expect(estimateTokens('')).toBe(0);
  });
});
