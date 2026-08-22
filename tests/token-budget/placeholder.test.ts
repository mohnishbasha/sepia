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
        const found = nodeNames.some((name) => name.includes(expected.toLowerCase()));
        if (found) covered++;
      }

      const coverage = covered / fixture.groundTruth.length;
      expect(
        coverage,
        `Coverage for ${file}: ${covered}/${fixture.groundTruth.length}`,
      ).toBeGreaterThanOrEqual(0.95);
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
    const submitNode = view.nodes.find((n) => n.name.toLowerCase() === 'submit');
    expect(submitNode).toBeDefined();
    expect(submitNode?.handle).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-S6: minimal verbosity is strictly smaller than standard wherever a
  // reduction is possible, and its cuts are defined.
  //
  // Issue #18: the old filter kept "nodes with a handle plus headings", which
  // on many pages is exactly what standard already keeps — both levels produced
  // byte-identical output on a list page, and the old `<=` assertion passed by
  // equality without noticing the knob did nothing.
  //
  // minimal now keeps handle-bearing nodes only:
  //   - every content-only node is dropped (headings, labels, cells,
  //     statuses…). This cannot break disambiguation: a control's `context`
  //     label is captured during the walk and attached after this filter runs,
  //     so the surrounding prose node goes while the control's label stays.
  //   - state that only restates the implicit default (`{enabled: true}`) is
  //     dropped; non-default state (disabled / checked / required / expanded /
  //     selected) survives, because it changes what an action means.
  //   - `value` survives: it is what a user or the model already typed into a
  //     field; hiding it invites blind re-typing.
  //   - `context` survives: dropping it reintroduces issue #3 (four identical
  //     "Delete" buttons become indistinguishable).
  // -------------------------------------------------------------------------

  it('AC-S6: minimal strictly reduces the list page where the knob previously did nothing (issue #18)', () => {
    const fixture = loadFixture('search-results.json');

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

    // Before the fix these were byte-identical (8 nodes, 72 tokens each):
    // every node the page had was either interactive or a heading, so minimal
    // kept everything standard kept.
    expect(minimalView.nodes.length).toBeLessThan(standardView.nodes.length);
    expect(minimalView.tokenCount).toBeLessThan(standardView.tokenCount);
  });

  it('AC-S6: minimal never exceeds standard anywhere in the corpus', () => {
    for (const file of FIXTURE_FILES) {
      const fixture = loadFixture(file);

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

      expect(minimalView.nodes.length, file).toBeLessThanOrEqual(standardView.nodes.length);
      expect(minimalView.tokenCount, file).toBeLessThanOrEqual(standardView.tokenCount);
    }
  });

  it('AC-S6: minimal emits handle-bearing nodes only', () => {
    for (const file of FIXTURE_FILES) {
      const fixture = loadFixture(file);
      const minimalView = serialize(fixture.axSnapshot, null, {
        url: fixture.url,
        title: fixture.title,
        verbosity: 'minimal',
      });
      const bare = minimalView.nodes.filter((n) => n.handle === undefined);
      expect(
        bare.map((n) => `${n.role} "${n.name}"`),
        file,
      ).toEqual([]);
    }
  });

  it('AC-S6: minimal drops headings and default state but keeps values and meaningful state', () => {
    const formPage: AXSnapshot = {
      role: 'WebArea',
      name: 'Checkout',
      children: [
        { role: 'heading', name: 'Checkout' },
        { role: 'textbox', name: 'Email', value: 'alice@example.com' },
        { role: 'checkbox', name: 'Save details', checked: true },
        { role: 'button', name: 'Pay', disabled: true },
      ],
    };

    const view = serialize(formPage, null, { verbosity: 'minimal' });
    const byName = new Map(view.nodes.map((n) => [n.name, n]));

    // Content-only node: gone.
    expect(byName.has('Checkout')).toBe(false);

    // Typed value survives — hiding it would invite blind re-typing.
    expect(byName.get('Email')?.value).toBe('alice@example.com');

    // Default-only state (`{enabled: true}`) is stripped…
    expect(byName.get('Email')?.state).toBeUndefined();

    // …but non-default state survives, because it changes what an action means.
    expect(byName.get('Save details')?.state).toMatchObject({ checked: true });
    expect(byName.get('Pay')?.state).toMatchObject({ enabled: false });
  });

  it('AC-S6: minimal still disambiguates identically-named controls via context', () => {
    const rows: AXSnapshot = {
      role: 'WebArea',
      name: 'Rows',
      children: [
        {
          role: 'list',
          name: '',
          children: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((label) => ({
            role: 'listitem',
            name: '',
            children: [
              { role: 'StaticText', name: label },
              { role: 'button', name: 'Delete' },
            ],
          })),
        },
      ],
    };

    // Both levels must tell the four Delete buttons apart (AC-S8): minimal
    // drops the prose *nodes*, not the labels attached to the controls.
    for (const verbosity of ['standard', 'minimal'] as const) {
      const view = serialize(rows, null, { verbosity });
      const contexts = view.nodes.filter((n) => n.handle !== undefined).map((n) => n.context);
      expect(contexts.sort(), verbosity).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma']);
    }
  });

  // -------------------------------------------------------------------------
  // Extra: estimateTokens formula
  // -------------------------------------------------------------------------

  // Superseded by AC-S7: counts now come from cl100k_base rather than
  // characters/4. Full contract in tests/token-budget/tokenizer.test.ts.
  it('estimateTokens returns real tokenizer counts', () => {
    expect(estimateTokens('hello')).toBe(1);
    expect(estimateTokens('hello world!')).toBe(3);
    expect(estimateTokens('')).toBe(0);
  });
});
