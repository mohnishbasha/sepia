/**
 * CLI-1 — the `sepia` binary finds its configuration.
 *
 * Installed globally, the CLI runs from arbitrary directories where none of the
 * SEPIA_* variables are exported. Without this it fell back to the default
 * Anthropic endpoint with no key and printed nothing at all.
 */

import { describe, it, expect } from 'vitest';
import { parseDotEnv } from '../../cli/dotenv.js';

describe('CLI-1 — parseDotEnv', () => {
  it('parses simple key=value pairs', () => {
    expect(parseDotEnv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });

  it('ignores comments and blank lines', () => {
    expect(parseDotEnv('# note\n\nA=1\n   # indented\nB=2\n')).toEqual({ A: '1', B: '2' });
  });

  it('keeps "=" that appear inside the value', () => {
    expect(parseDotEnv('URL=https://x.example/a?b=c&d=e')).toEqual({
      URL: 'https://x.example/a?b=c&d=e',
    });
  });

  it('strips matching single or double quotes', () => {
    expect(parseDotEnv(`A="quoted"\nB='single'`)).toEqual({ A: 'quoted', B: 'single' });
  });

  it('does not strip mismatched quotes', () => {
    expect(parseDotEnv(`A="oops'`)).toEqual({ A: `"oops'` });
  });

  it('trims surrounding whitespace on key and value', () => {
    expect(parseDotEnv('  A  =  1  ')).toEqual({ A: '1' });
  });

  it('supports an optional export prefix', () => {
    expect(parseDotEnv('export A=1')).toEqual({ A: '1' });
  });

  it('skips lines with no "="', () => {
    expect(parseDotEnv('JUST_A_WORD\nA=1')).toEqual({ A: '1' });
  });

  it('allows an empty value', () => {
    expect(parseDotEnv('A=')).toEqual({ A: '' });
  });

  it('handles CRLF line endings', () => {
    expect(parseDotEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('returns nothing for empty input', () => {
    expect(parseDotEnv('')).toEqual({});
  });
});
