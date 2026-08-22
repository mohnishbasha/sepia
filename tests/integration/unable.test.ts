/**
 * AC-AG9 — the model can report that a goal is unachievable.
 *
 * Before this requirement the agent had only one terminal action, `done`, and
 * it unconditionally set the run outcome to `success`. A model that hit a
 * CAPTCHA, a paywall, or simply judged the goal impossible had no honest way to
 * say so — the run was still reported as a success (issue #5).
 *
 * The typed `abort` action ends the run and maps to `outcome: 'unable'`, with
 * the model's `reason` surfaced as `RunTrace.answer`. Like `done`, `abort` is
 * terminal: it stops the run immediately and is never dispatched to the engine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockEngine, makeConfig, modelReturning } from '../helpers/agent-harness.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

async function runWith(contents: string[]) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  const engine = makeMockEngine();
  vi.mocked(createEngine).mockResolvedValue(engine);
  const create = modelReturning(...contents);
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  const trace = await createAgent(makeConfig()).run(
    'find the answer that is hidden behind a CAPTCHA',
  );
  return { trace, create, engine };
}

describe('AC-AG9 — abort ends the run as `unable`', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports `unable` and surfaces the abort reason as the answer', async () => {
    const { trace } = await runWith([
      JSON.stringify({ action: 'abort', reason: 'Blocked by a CAPTCHA I cannot solve.' }),
    ]);

    expect(trace.outcome).toBe('unable');
    expect(trace.answer).toBe('Blocked by a CAPTCHA I cannot solve.');
  });

  it('stops immediately: no further model call and no action dispatched', async () => {
    const { trace, create, engine } = await runWith([
      JSON.stringify({ action: 'abort', reason: 'Goal is impossible.' }),
      // A second reply would only be requested if abort were not terminal.
      JSON.stringify({ action: 'done', summary: 'should never be asked' }),
    ]);

    expect(trace.outcome).toBe('unable');
    expect(trace.totalSteps).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    // abort is terminal — it must never reach the engine.
    expect(engine.click).not.toHaveBeenCalled();
    expect(engine.type).not.toHaveBeenCalled();
    expect(engine.open).not.toHaveBeenCalled();
  });

  it('reports `unable` with no answer when abort carries no reason', async () => {
    const { trace } = await runWith([JSON.stringify({ action: 'abort' })]);

    expect(trace.outcome).toBe('unable');
    expect(trace.answer).toBeUndefined();
  });

  it('treats a whitespace-only reason as absent', async () => {
    const { trace } = await runWith([JSON.stringify({ action: 'abort', reason: '   ' })]);

    expect(trace.outcome).toBe('unable');
    expect(trace.answer).toBeUndefined();
  });

  it('a non-terminal reply still runs as before; abort still reports unable', async () => {
    // A valid dispatchable action first, then an abort: the run dispatches the
    // action, then ends as unable. Confirms abort is honoured, not ignored.
    const { trace } = await runWith([
      JSON.stringify({ action: 'observe' }),
      JSON.stringify({ action: 'abort', reason: 'page requires login' }),
    ]);

    expect(trace.outcome).toBe('unable');
    expect(trace.answer).toBe('page requires login');
    expect(trace.totalSteps).toBe(1);
  });
});
