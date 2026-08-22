/**
 * SR-12 — createAgent normalizes whatever config it is handed.
 *
 * createAgent accepted a caller-built SepiaConfig verbatim, so the SDK path
 * bypassed every bound that mergeConfig and the HTTP allowlist apply. A hostile
 * or simply careless value became a timer duration or a loop count directly.
 *
 * maxSteps is the fast proxy for this: with a model that never says `done`, a
 * normalized agent must stop at the clamped ceiling instead of honouring an
 * absurd request.
 *
 * Note: the mocked model cycles through different handles each step so the run
 * reaches the step budget rather than being stopped first by loop detection
 * (AC-AG10), which this test is not trying to exercise.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockEngine, makeConfig } from '../helpers/agent-harness.js';
import { CONFIG_BOUNDS } from '../../config/index.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

async function runWithAgentConfig(overrides: Record<string, unknown>) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  vi.mocked(createEngine).mockResolvedValue(makeMockEngine());
  // Cycle through distinct handles so the (action, handle) key changes every
  // step; a constant action would be stopped by loop detection first.
  let call = 0;
  const create = vi.fn().mockImplementation(() => {
    call += 1;
    return Promise.resolve({
      choices: [
        { message: { content: JSON.stringify({ action: 'click', handle: `h${call % 5}` }) } },
      ],
      usage: { total_tokens: 50 },
    });
  });
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  const config = makeConfig({ maxRetries: 0, retryBackoffMs: 0 });
  Object.assign(config.agent, overrides);
  return createAgent(config).run('loop forever');
}

describe('SR-12 — createAgent bounds a hostile config', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops at the clamped maxSteps rather than honouring an absurd one', async () => {
    const trace = await runWithAgentConfig({ maxSteps: 10_000_000 });

    expect(trace.totalSteps).toBeLessThanOrEqual(CONFIG_BOUNDS.maxSteps.max);
    expect(trace.outcome).toBe('budget_exceeded');
  }, 60_000);

  it('treats a non-finite maxSteps as the default rather than looping forever', async () => {
    const trace = await runWithAgentConfig({ maxSteps: Number.POSITIVE_INFINITY });

    expect(trace.totalSteps).toBeLessThanOrEqual(CONFIG_BOUNDS.maxSteps.max);
  }, 60_000);

  it('still honours a modest maxSteps exactly', async () => {
    const trace = await runWithAgentConfig({ maxSteps: 3 });

    expect(trace.totalSteps).toBe(3);
  }, 30_000);
});
