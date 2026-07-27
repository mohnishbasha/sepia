/**
 * AC-AG8 — a rejected model response is retried WITH corrective feedback.
 *
 * The retry loop previously re-sent a byte-identical request, so a model that
 * produced unparseable output had no reason to produce anything different.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeMockEngine, makeConfig, doneAction } from '../helpers/agent-harness.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

interface CallParams {
  messages: Array<{ role: string; content: string }>;
}

async function runWith(contents: string[]) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  vi.mocked(createEngine).mockResolvedValue(makeMockEngine());

  let i = 0;
  const create = vi.fn().mockImplementation(() => {
    const content = contents[Math.min(i, contents.length - 1)] ?? '';
    i++;
    return Promise.resolve({
      choices: [{ message: { content } }],
      usage: { total_tokens: 20 },
    });
  });

  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  const trace = await createAgent(makeConfig({ maxRetries: 2, maxSteps: 3 })).run('do the thing');
  return { trace, create };
}

function lastUserContent(call: CallParams): string {
  const userMsgs = call.messages.filter((m) => m.role === 'user');
  return userMsgs[userMsgs.length - 1]?.content ?? '';
}

describe('AC-AG8 — retry carries corrective feedback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('second attempt differs from the first', async () => {
    const { create } = await runWith(['this is not json', doneAction('ok')]);

    const first = create.mock.calls[0]![0] as CallParams;
    const second = create.mock.calls[1]![0] as CallParams;

    expect(JSON.stringify(second.messages)).not.toBe(JSON.stringify(first.messages));
  });

  it('second attempt tells the model what was wrong with its output', async () => {
    const { create } = await runWith(['this is not json', doneAction('ok')]);

    const second = create.mock.calls[1]![0] as CallParams;
    expect(lastUserContent(second)).toMatch(/valid JSON/i);
  });

  it('feedback names the offending action when validation fails', async () => {
    // Well-formed JSON, but click is missing its required handle.
    const { create } = await runWith([JSON.stringify({ action: 'click' }), doneAction('ok')]);

    const second = create.mock.calls[1]![0] as CallParams;
    expect(lastUserContent(second)).toMatch(/click requires handle/i);
  });

  it('recovers and succeeds once the model corrects itself', async () => {
    const { trace } = await runWith(['garbage', doneAction('recovered')]);

    expect(trace.outcome).toBe('success');
    expect(trace.answer).toBe('recovered');
  });

  it('records a step describing the failure when all retries are exhausted', async () => {
    const { trace } = await runWith(['still not json']);

    expect(trace.outcome).toBe('error');
    expect(trace.steps.some((s) => s.result.error?.code === 'INVALID_ACTION')).toBe(true);
  });
});
