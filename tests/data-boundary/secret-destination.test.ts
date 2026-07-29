/**
 * AC-P6 — a credential is marked by where it went, not by what it looked like
 * (issue #10).
 *
 * `redactSecrets()` matches JSON key/value pairs, Bearer tokens and `sk-`
 * prefixes. A bare password matches none of them, so typing `hunter2` into a
 * password field produced `secretsRedacted: []` on every step — the flag meant
 * to mark "a credential passed through here" read false while one demonstrably
 * had.
 *
 * That flag is not decoration. `training/` uses it to decide which steps to
 * exclude from exported fine-tuning data, so a plain password was exported.
 *
 * Shape-matching cannot be made complete — no pattern recognises `hunter2` as a
 * secret, because nothing about it is secret-shaped. The destination is what
 * carries the meaning: text typed into a field named "Password" is a credential
 * whatever it looks like.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isSecretFieldName } from '../../privacy/index.js';
import {
  makeMockEngine,
  makeConfig,
  makeView,
  modelReturning,
  doneAction,
} from '../helpers/agent-harness.js';
import type { CompactNode } from '../../types/index.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

/** Run the agent against a fixed page and a fixed sequence of model replies. */
async function runWith(nodes: CompactNode[], contents: string[]) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  vi.mocked(createEngine).mockResolvedValue(
    makeMockEngine({ observe: vi.fn().mockResolvedValue(makeView(nodes)) }),
  );
  const create = modelReturning(...contents);
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  return createAgent(makeConfig()).run('sign in');
}

beforeEach(() => vi.clearAllMocks());

describe('AC-P6 — a field name marks its destination as secret', () => {
  it('recognises the obvious names', () => {
    expect(isSecretFieldName('Password')).toBe(true);
    expect(isSecretFieldName('password')).toBe(true);
    expect(isSecretFieldName('Confirm password')).toBe(true);
    expect(isSecretFieldName('API key')).toBe(true);
    expect(isSecretFieldName('CVV')).toBe(true);
  });

  it('leaves ordinary fields alone', () => {
    expect(isSecretFieldName('Email')).toBe(false);
    expect(isSecretFieldName('First name')).toBe(false);
    expect(isSecretFieldName('Search')).toBe(false);
  });

  it('does not treat an empty name as secret', () => {
    expect(isSecretFieldName('')).toBe(false);
  });
});

describe('AC-P6 — the step trace marks a credential typed into a password field', () => {
  it('flags a plain password that no shape pattern would catch', async () => {
    const trace = await runWith(
      [
        { handle: 'e1', role: 'textbox', name: 'Password', indent: 0 },
        { handle: 'e2', role: 'button', name: 'Sign in', indent: 0 },
      ],
      [JSON.stringify({ action: 'type', handle: 'e1', text: 'hunter2' }), doneAction('signed in')],
    );
    const typeStep = trace.steps.find((s) => s.action === 'type');

    // `hunter2` matches no credential pattern: it is only a secret because of
    // the field it was typed into.
    expect(typeStep?.secretsRedacted).toBe(true);
  });

  it('does not flag ordinary text typed into an ordinary field', async () => {
    const trace = await runWith(
      [{ handle: 'e1', role: 'textbox', name: 'Search', indent: 0 }],
      [
        JSON.stringify({ action: 'type', handle: 'e1', text: 'typescript generics' }),
        doneAction('searched'),
      ],
    );
    const typeStep = trace.steps.find((s) => s.action === 'type');

    expect(typeStep?.secretsRedacted).toBe(false);
  });

  it('still flags credential-shaped text in a field with an innocent name', async () => {
    const trace = await runWith(
      [{ handle: 'e1', role: 'textbox', name: 'Notes', indent: 0 }],
      [
        JSON.stringify({ action: 'type', handle: 'e1', text: 'sk-abc123def456' }),
        doneAction('noted'),
      ],
    );
    const typeStep = trace.steps.find((s) => s.action === 'type');

    // The shape check still earns its keep — the two rules are complementary.
    expect(typeStep?.secretsRedacted).toBe(true);
  });
});
