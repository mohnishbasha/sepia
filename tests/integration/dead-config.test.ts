/**
 * AC-C1 — declared config actually reaches the thing it configures (issue #20).
 *
 * `model.maxTokensPerStep` was declared, defaulted, bounded by `mergeConfig`
 * and documented — and the agent hardcoded `max_tokens: 1024` on every call, so
 * setting it did nothing. 1024 is also tight for a reasoning model, which
 * spends part of that budget before it writes any JSON, so the run fails in a
 * way the operator cannot configure their way out of.
 *
 * `browser.humanTiming` was the same shape of lie with no behaviour behind it
 * at all; it is gone rather than invented (see the PR).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeMockEngine,
  makeConfig,
  modelReturning,
  doneAction,
} from '../helpers/agent-harness.js';
import { mergeConfig, defaultConfig } from '../../config/index.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

async function callParamsFor(maxTokensPerStep?: number) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  vi.mocked(createEngine).mockResolvedValue(makeMockEngine());
  const create = modelReturning(doneAction('done'));
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  const config = makeConfig();
  if (maxTokensPerStep !== undefined) config.model.maxTokensPerStep = maxTokensPerStep;
  await createAgent(config).run('anything');
  return create.mock.calls[0]![0] as { max_tokens?: number };
}

describe('AC-C1 — maxTokensPerStep reaches the model call', () => {
  it('uses the configured value', async () => {
    expect((await callParamsFor(7777)).max_tokens).toBe(7777);
  });

  it('is not the old hardcoded 1024', async () => {
    const params = await callParamsFor(4096);

    expect(params.max_tokens).not.toBe(1024);
    expect(params.max_tokens).toBe(4096);
  });

  it('ships a default a reasoning model can actually use', async () => {
    // The old default of 100,000 was never sent anywhere; sending it would be
    // rejected outright by providers that cap max_tokens well below it.
    expect(defaultConfig.model.maxTokensPerStep).toBeGreaterThanOrEqual(2048);
    expect(defaultConfig.model.maxTokensPerStep).toBeLessThanOrEqual(32_000);
  });

  it('still clamps a nonsense value rather than forwarding it', async () => {
    const merged = mergeConfig({ model: { maxTokensPerStep: -5 } });

    expect(merged.model.maxTokensPerStep).toBeGreaterThan(0);
  });
});

describe('AC-C1 — humanTiming is gone rather than declared and dead', () => {
  it('is not part of the browser config', () => {
    expect('humanTiming' in defaultConfig.browser).toBe(false);
  });
});
