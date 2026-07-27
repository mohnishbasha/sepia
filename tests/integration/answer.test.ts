/**
 * AC-AG5 — the agent surfaces a final answer.
 *
 * The `done` action carries a `summary`. Before this requirement the summary
 * was parsed and discarded, so a run could never return anything to its caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeMockEngine,
  makeConfig,
  modelReturning,
  doneAction,
} from '../helpers/agent-harness.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

async function runWith(contents: string[]) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  vi.mocked(createEngine).mockResolvedValue(makeMockEngine());
  const create = modelReturning(...contents);
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  return createAgent(makeConfig()).run('what is the node lts version?');
}

describe('AC-AG5 — agent returns an answer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries the done summary through to trace.answer', async () => {
    const trace = await runWith([doneAction('Node.js LTS is 22.11.0')]);

    expect(trace.outcome).toBe('success');
    expect(trace.answer).toBe('Node.js LTS is 22.11.0');
  });

  it('leaves answer undefined when the run never reaches done', async () => {
    const trace = await runWith([JSON.stringify({ action: 'click', handle: 'e2' })]);

    expect(trace.outcome).toBe('budget_exceeded');
    expect(trace.answer).toBeUndefined();
  });

  it('accepts a done action with no summary without failing the run', async () => {
    const trace = await runWith([JSON.stringify({ action: 'done' })]);

    expect(trace.outcome).toBe('success');
    expect(trace.answer).toBeUndefined();
  });
});
