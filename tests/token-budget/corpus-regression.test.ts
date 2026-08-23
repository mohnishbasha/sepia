/**
 * AC-S13 — the corpus can actually detect a regression (issue #22).
 *
 * `fixtures/corpus/` held five hand-written fixtures. Measured under
 * cl100k: 51, 72, 80, 99, 111 tokens, against gates of median ≤ 900 and
 * max ≤ 1500 — eleven times the headroom, so no plausible serializer change
 * could ever trip them. A budget suite that cannot fail is decoration.
 *
 * Twenty real pages are now captured alongside them (`scripts/capture-corpus.mts`),
 * spanning 13 to 79,328 tokens: link lists, long articles, forms, specs, docs
 * and app pages.
 *
 * The gate is per page, not aggregate. A fixture is a frozen snapshot, so its
 * token count can only move when the serializer moves — which is exactly the
 * regression worth catching, and an aggregate threshold would let a doubling on
 * one page hide behind nineteen that did not change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { serialize } from '../../serializer/index.js';
import type { AXSnapshot } from '../../serializer/index.js';

const CORPUS_DIR = join(new URL('.', import.meta.url).pathname, '../../fixtures/corpus');

interface CapturedPage {
  title: string;
  url: string;
  capturedAt: string;
  baselineTokens: number;
  axSnapshot: AXSnapshot;
}

function capturedPages(): Array<{ file: string; page: CapturedPage }> {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json.gz'))
    .sort()
    .map((file) => ({
      file,
      page: JSON.parse(
        gunzipSync(readFileSync(join(CORPUS_DIR, file))).toString('utf8'),
      ) as CapturedPage,
    }));
}

/**
 * How far a page may grow before the suite complains.
 *
 * Deliberate growth is allowed — it just has to be *declared*, by re-running
 * the capture script so the new number is committed and shows up in review.
 * That is the whole mechanism: a serializer change that inflates every page by
 * a quarter should be a visible line in a diff, not a silent cost.
 */
const GROWTH_TOLERANCE = 1.15;

describe('AC-S13 — real pages hold their measured size', () => {
  const pages = capturedPages();

  it('has a corpus worth measuring', () => {
    // Guards against the corpus quietly reverting to toy fixtures: if this
    // count or scale collapses, the per-page gates below stop meaning anything.
    expect(pages.length).toBeGreaterThanOrEqual(15);

    const tokens = pages.map((p) => p.page.baselineTokens).sort((a, b) => a - b);
    expect(Math.max(...tokens)).toBeGreaterThan(5_000);
    expect(tokens[Math.floor(tokens.length / 2)]).toBeGreaterThan(300);
  });

  it.each(capturedPages())('$file stays within tolerance of its baseline', ({ page }) => {
    const view = serialize(page.axSnapshot, null, { url: page.url, title: page.title });

    expect(view.tokenCount).toBeLessThanOrEqual(Math.ceil(page.baselineTokens * GROWTH_TOLERANCE));
  });

  it('is reproducible: serializing twice gives the same size', () => {
    const first = pages[0]!;
    const a = serialize(first.page.axSnapshot, null, { url: first.page.url });
    const b = serialize(first.page.axSnapshot, null, { url: first.page.url });

    expect(a.tokenCount).toBe(b.tokenCount);
  });

  it('keeps minimal no larger than standard on every real page', () => {
    for (const { file, page } of pages) {
      const minimal = serialize(page.axSnapshot, null, { verbosity: 'minimal', url: page.url });
      const standard = serialize(page.axSnapshot, null, { verbosity: 'standard', url: page.url });

      expect(minimal.tokenCount, file).toBeLessThanOrEqual(standard.tokenCount);
    }
  });

  it('honours a token budget on the largest page in the corpus', () => {
    // The corpus now contains a page far past any host's output limit, which is
    // what makes this worth asserting on real data rather than a fixture.
    const largest = pages.reduce((a, b) => (a.page.baselineTokens > b.page.baselineTokens ? a : b));
    const capped = serialize(largest.page.axSnapshot, null, {
      url: largest.page.url,
      maxTokens: 2_000,
    });

    expect(largest.page.baselineTokens).toBeGreaterThan(10_000);
    expect(capped.tokenCount).toBeLessThanOrEqual(2_000);
    expect(capped.truncated).toBe(true);
  });
});
