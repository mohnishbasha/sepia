/**
 * AC-S11 — `observe` can be given a token budget (issue #28).
 *
 * A single observe on an ordinary Wikipedia article returned 10,051 tokens.
 * Claude Code warns at 10,000 tokens of MCP tool output and hard-limits at
 * 25,000, so a routine article sits exactly at the warning line and a search
 * page or dashboard crosses it. Other hosts have their own ceilings.
 *
 * There was no recourse: `observe` took only `verbosity`, and `minimal` saved
 * 1.3% (#18) because on a page that is mostly links nearly every node is
 * interactive and minimal keeps them all. So the host could be handed more than
 * it could accept, and the call failed or was truncated somewhere outside
 * Sepia's control — which is the part that matters. Truncation done elsewhere is
 * silent and arbitrary; done here it is deterministic and announced.
 */

import { describe, it, expect } from 'vitest';
import { serialize, estimateTokens } from '../../serializer/index.js';
import type { AXSnapshot } from '../../serializer/index.js';

/** A page with enough controls to blow any small budget. */
function bigPage(links: number): AXSnapshot {
  return {
    role: 'WebArea',
    name: 'Reference',
    children: Array.from({ length: links }, (_, i) => ({
      role: 'link',
      name: `Reference entry number ${String(i)} about accessibility`,
    })),
  };
}

const TRUNCATION_MARKER = /omitted/i;

describe('AC-S11 — the view honours a token budget', () => {
  it('comes in under the cap', () => {
    const view = serialize(bigPage(400), null, { maxTokens: 500 });

    expect(view.tokenCount).toBeLessThanOrEqual(500);
  });

  it('says how much it dropped rather than truncating silently', () => {
    const full = serialize(bigPage(400), null, {});
    const view = serialize(bigPage(400), null, { maxTokens: 500 });

    expect(view.truncated).toBe(true);
    expect(view.nodes.length).toBeLessThan(full.nodes.length);

    // The model reads the outline, not the metadata, so the notice has to be a
    // node — otherwise a truncated page is indistinguishable from a short one.
    const last = view.nodes[view.nodes.length - 1];
    expect(last?.name).toMatch(TRUNCATION_MARKER);
    expect(last?.handle).toBeUndefined();
  });

  it('keeps the start of the document, in order', () => {
    const view = serialize(bigPage(400), null, { maxTokens: 500 });
    const kept = view.nodes.filter((n) => n.role === 'link').map((n) => n.name);

    expect(kept[0]).toContain('number 0');
    // Document order preserved: entry 5 must not appear before entry 1.
    const sorted = [...kept].sort(
      (a, b) => Number(/number (\d+)/.exec(a)?.[1]) - Number(/number (\d+)/.exec(b)?.[1]),
    );
    expect(kept).toEqual(sorted);
  });

  it('leaves a view that already fits completely alone', () => {
    const small = bigPage(3);
    const capped = serialize(small, null, { maxTokens: 10_000 });
    const uncapped = serialize(small, null, {});

    expect(capped.truncated).toBe(false);
    expect(capped.nodes).toHaveLength(uncapped.nodes.length);
    expect(capped.nodes.some((n) => TRUNCATION_MARKER.test(n.name))).toBe(false);
  });

  it('applies no budget when none is asked for', () => {
    const view = serialize(bigPage(400), null, {});

    expect(view.truncated).toBe(false);
    expect(view.tokenCount).toBeGreaterThan(500);
  });

  it('reports a token count that matches what it actually returns', () => {
    const view = serialize(bigPage(400), null, { maxTokens: 500 });

    // A count computed before truncation would understate nothing and overstate
    // everything — the number is what a host budgets against.
    const rendered = view.nodes
      .map(
        (n) => `${'  '.repeat(n.indent)}${n.handle ? `[${n.handle}] ` : ''}${n.role} "${n.name}"`,
      )
      .join('\n');
    expect(view.tokenCount).toBe(estimateTokens(rendered));
  });

  it('survives a budget too small for even the notice', () => {
    const view = serialize(bigPage(400), null, { maxTokens: 1 });

    // Nothing useful fits, but it must not throw or return a lie.
    expect(view.truncated).toBe(true);
    expect(view.nodes.length).toBeLessThanOrEqual(1);
  });

  it('ignores a nonsensical budget rather than emptying the view', () => {
    for (const bad of [0, -100, Number.NaN]) {
      const view = serialize(bigPage(10), null, { maxTokens: bad });
      expect(view.nodes.length).toBeGreaterThan(1);
    }
  });
});
