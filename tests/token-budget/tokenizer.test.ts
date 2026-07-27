/**
 * AC-S7 — token counts come from a real tokenizer.
 *
 * estimateTokens() approximated tokens as `characters / 4`. Every published
 * token-budget figure rested on that approximation, which undercounts real
 * compact-view lines (punctuation and short bracketed handles tokenize poorly).
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../serializer/index.js';

describe('AC-S7 — cl100k_base token counts', () => {
  it.each([
    ['', 0],
    ['hello', 1],
    ['hello world', 2],
    ['button "Sign in"', 5],
    ['[e12] button "Sign in" (enabled)', 11],
  ])('counts %j as %i tokens', (text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });

  it('disagrees with the old characters/4 approximation', () => {
    const line = '[e12] button "Sign in" (enabled)';
    expect(estimateTokens(line)).not.toBe(Math.ceil(line.length / 4));
  });

  it('is deterministic across repeated calls', () => {
    const line = '[e7] textbox "Email address" value="alice@example.com"';
    expect(estimateTokens(line)).toBe(estimateTokens(line));
  });

  it('grows monotonically as text is appended', () => {
    const short = estimateTokens('button');
    const long = estimateTokens('button "Sign in" (enabled, required)');
    expect(long).toBeGreaterThan(short);
  });

  it('handles multi-byte characters without throwing', () => {
    expect(() => estimateTokens('日本語のボタン — Sign in')).not.toThrow();
    expect(estimateTokens('日本語のボタン — Sign in')).toBeGreaterThan(0);
  });
});
