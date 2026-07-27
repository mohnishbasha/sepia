/**
 * AC-AG7 — the run reports `stale_bail` when stale-handle retries are exhausted.
 *
 * The `stale_bail` outcome existed in the Outcome union but no code path ever
 * produced it; an exhausted retry loop silently fell through to `error` or
 * `budget_exceeded`, hiding the real cause from the caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockEngine, makeConfig, modelReturning } from '../helpers/agent-harness.js';
import type { ActionResult } from '../../types/index.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

const STALE: ActionResult = {
  ok: false,
  confidence: 0,
  error: { code: 'STALE_HANDLE', message: 'handle e2 is stale', handle: 'e2' },
};

const LOW_CONF: ActionResult = {
  ok: false,
  confidence: 0.62,
  error: { code: 'LOW_CONFIDENCE', message: 'handle e2 below threshold', handle: 'e2' },
};

async function runWithClickResult(result: ActionResult, maxRetries: number) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  const click = vi.fn().mockResolvedValue(result);
  vi.mocked(createEngine).mockResolvedValue(makeMockEngine({ click }));

  const create = modelReturning(JSON.stringify({ action: 'click', handle: 'e2' }));
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  const trace = await createAgent(makeConfig({ maxRetries, maxSteps: 6 })).run('click sign in');
  return { trace, click };
}

describe('AC-AG7 — stale_bail outcome', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports stale_bail once stale retries are exhausted', async () => {
    const { trace } = await runWithClickResult(STALE, 2);

    expect(trace.outcome).toBe('stale_bail');
  });

  it('retries exactly maxRetries times before bailing', async () => {
    const { click } = await runWithClickResult(STALE, 2);

    // 1 initial attempt + 2 retries
    expect(click).toHaveBeenCalledTimes(3);
  });

  it('bails immediately when maxRetries is 0', async () => {
    const { trace, click } = await runWithClickResult(STALE, 0);

    expect(click).toHaveBeenCalledTimes(1);
    expect(trace.outcome).toBe('stale_bail');
  });

  it('bails on a low-confidence refusal rather than continuing to act', async () => {
    const { trace } = await runWithClickResult(LOW_CONF, 2);

    expect(trace.outcome).toBe('stale_bail');
  });
});
