/**
 * AC-AG11 — history keeps prior actions but stubs prior outlines (issue #7).
 *
 * Each history entry used to be `Goal + entire page outline`, so turn n
 * re-sent everything from turns 1..n-1: on a 10-field registration form the
 * prompt grew 16.7x across 13 calls (~24k tokens total) for a page whose
 * structure never changed. Prior turns now keep the model's action verbatim
 * while their outline collapses to `[page state at step N]`; only the current
 * turn carries the full compact view. Composed with `maxHistorySteps`
 * windowing, prompt growth is bounded: count-bounded turns × non-repeating
 * outlines.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeMockEngine,
  makeConfig,
  modelReturning,
  makeView,
  doneAction,
} from '../helpers/agent-harness.js';
import { estimateTokens } from '../../serializer/index.js';
import type { CompactNode } from '../../types/index.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

interface CallParams {
  messages: Array<{ role: string; content: string }>;
}

async function runWith(
  contents: string[],
  opts: {
    maxHistorySteps?: number;
    goal?: string;
    viewNodes?: CompactNode[];
    engineOverrides?: Parameters<typeof makeMockEngine>[0];
  } = {},
) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  const engine = makeMockEngine({
    ...(opts.viewNodes !== undefined
      ? { observe: vi.fn().mockResolvedValue(makeView(opts.viewNodes)) }
      : {}),
    ...(opts.engineOverrides ?? {}),
  });
  vi.mocked(createEngine).mockResolvedValue(engine);
  const create = modelReturning(...contents);
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  const overrides =
    opts.maxHistorySteps !== undefined ? { maxHistorySteps: opts.maxHistorySteps } : {};
  const goal = opts.goal ?? 'fill the registration form';
  const trace = await createAgent(makeConfig(overrides)).run(goal);
  return { trace, create };
}

function callMessages(
  create: ReturnType<typeof modelReturning>,
  i: number,
): CallParams['messages'] {
  return (create.mock.calls[i]![0] as CallParams).messages;
}

function joined(messages: CallParams['messages']): string {
  return messages.map((m) => m.content).join('\n');
}

const STEP0 = JSON.stringify({ action: 'click', handle: 'e1' });
const STEP1 = JSON.stringify({ action: 'type', handle: 'e2', text: 'a@b.co', submit: true });
/** click e1 → type e2 → done: three calls, two dispatched steps. */
const THREE_CALLS = [STEP0, STEP1, doneAction('form filled')];

describe('AC-AG11 — prior turns keep actions, not outlines', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces each prior outline with a stub naming its step', async () => {
    const { create } = await runWith(THREE_CALLS);

    // Third call: system + [stub0, act0, stub1, act1] + current turn.
    const userMsgs = callMessages(create, 2).filter((m) => m.role === 'user');
    // Step 0 has nothing before it, so its stub is bare. Later stubs also
    // carry how the previous step turned out (AC-AG12).
    expect(userMsgs[0]!.content).toBe('[page state at step 0]');
    expect(userMsgs[1]!.content).toMatch(/^\[page state at step 1\]/);
    expect(userMsgs[1]!.content).not.toContain('Current page:');
  });

  it('keeps the current turn’s full outline intact', async () => {
    const { create } = await runWith(THREE_CALLS);

    const userMsgs = callMessages(create, 2).filter((m) => m.role === 'user');
    const current = userMsgs[userMsgs.length - 1]!.content;
    expect(current).toContain('Goal: fill the registration form');
    expect(current).toContain('Current page:');
    expect(current).toContain('URL: https://example.com');
    expect(current).toContain('"Email"');
    expect(current).toContain('"Sign in"');
  });

  it('retains prior assistant actions verbatim', async () => {
    const { create } = await runWith(THREE_CALLS);

    const assistantContents = callMessages(create, 2)
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content);
    expect(assistantContents).toEqual([STEP0, STEP1]);
  });

  it('never sends more than one full outline per call', async () => {
    // Before the fix, call k carried k+1 copies of the unchanged page.
    const { create } = await runWith(THREE_CALLS);

    for (let i = 0; i < create.mock.calls.length; i++) {
      const messages = callMessages(create, i);
      const withOutline = messages.filter((m) => m.content.includes('URL: https://example.com'));
      expect(withOutline).toHaveLength(1);
      // The single copy is always the CURRENT turn's message — the last one.
      const lastUser = messages.filter((m) => m.role === 'user').at(-1)!.content;
      expect(withOutline[0]!.content).toBe(lastUser);
    }
  });
});

describe('AC-AG11 — prompt growth stays flat on an unchanged page', () => {
  beforeEach(() => vi.clearAllMocks());

  /** A page whose structure never changes, big enough that outlines dominate. */
  const fatForm = Array.from({ length: 24 }, (_, i): CompactNode => ({
    handle: `e${i + 1}`,
    role: 'textbox',
    name: `Registration field number ${i + 1} with a fairly long accessible label`,
    indent: 0,
    state: { enabled: true },
  }));

  it('the last call costs about as much as the second, not k× more', async () => {
    // Ten distinct clicks so loop detection (AC-AG10) stays out of the way.
    const contents = [
      ...Array.from({ length: 9 }, (_, i) =>
        JSON.stringify({ action: 'click', handle: `e${i + 1}` }),
      ),
      doneAction('form filled'),
    ];

    const { create } = await runWith(contents, { viewNodes: fatForm });

    const tokensOf = (i: number) => estimateTokens(joined(callMessages(create, i)));
    const second = tokensOf(1);
    const last = tokensOf(9);

    // Sanity: stubs and actions still accumulate.
    expect(last).toBeGreaterThan(second);
    // Under full-outline history the ratio for 10 steps is ~5x (10T vs 2T).
    expect(last).toBeLessThan(second * 1.5);
  });
});

describe('AC-AG11 — maxHistorySteps still bounds the window', () => {
  beforeEach(() => vi.clearAllMocks());

  it('truncates stubbed turns to the last maxHistorySteps pairs', async () => {
    // Five alternating clicks: distinct consecutive keys, so AC-AG10 never fires.
    const contents = [
      JSON.stringify({ action: 'click', handle: 'e1' }),
      JSON.stringify({ action: 'hover', handle: 'e2' }),
      JSON.stringify({ action: 'click', handle: 'e1' }),
      JSON.stringify({ action: 'hover', handle: 'e2' }),
      doneAction('done'),
    ];

    const { trace, create } = await runWith(contents, { maxHistorySteps: 2 });

    expect(trace.outcome).toBe('success');
    // Last call: system + last 2 pairs + current turn.
    const messages = callMessages(create, 4);
    expect(messages).toHaveLength(2 * 2 + 2);
    const text = joined(messages);
    expect(text).toContain('[page state at step 3]');
    expect(text).not.toContain('[page state at step 0]');
    expect(text).toContain('Current page:');
  });
});

describe('AC-AG11 — retained history stays inside the data boundary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('carries the secret placeholder forward, never the literal (AC-P7)', async () => {
    const placeholderAction = JSON.stringify({
      action: 'type',
      handle: 'e1',
      text: '{{sepia:secret:1}}',
    });

    const { create } = await runWith([placeholderAction, doneAction('signed in')], {
      goal: 'sign in with password s3cret-hunter2',
    });

    for (let i = 0; i < create.mock.calls.length; i++) {
      expect(joined(callMessages(create, i))).not.toContain('s3cret-hunter2');
    }
    // The prior action IS retained — in placeholder form only.
    expect(joined(callMessages(create, 1))).toContain('{{sepia:secret:1}}');
  });
});

describe('AC-AG12 — the stub says how the previous step turned out', () => {
  beforeEach(() => vi.clearAllMocks());

  /** The stub messages, in order, excluding the current turn's full outline. */
  function stubs(create: ReturnType<typeof modelReturning>, i: number): string[] {
    return callMessages(create, i)
      .filter((m) => m.role === 'user' && m.content.startsWith('[page state at step'))
      .map((m) => m.content);
  }

  it('reports the error code of a failed action', async () => {
    const { create } = await runWith(THREE_CALLS, {
      engineOverrides: {
        click: vi.fn().mockResolvedValue({
          ok: false,
          confidence: 0.9,
          error: { code: 'ELEMENT_NOT_FOUND', message: 'nothing there' },
        }),
      },
    });

    // Without this the model is told only what it asked for, never what came
    // of it — it could click a dead control until loop detection ends the run.
    expect(stubs(create, 2)[1]).toContain('ELEMENT_NOT_FOUND');
  });

  it('reports an action that succeeded but moved nothing', async () => {
    // The dead-button case: `ok: true`, and the page is identical afterwards.
    // The error code alone would say "fine"; only the page comparison does not.
    const { create } = await runWith(THREE_CALLS);

    expect(stubs(create, 2)[1]).toContain('→ ok');
    expect(stubs(create, 2)[1]).toContain('page unchanged');
  });

  it('reports an action that did change the page', async () => {
    let n = 0;
    const { create } = await runWith(THREE_CALLS, {
      engineOverrides: {
        observe: vi.fn().mockImplementation(async () => {
          n += 1;
          return makeView([{ handle: 'e1', role: 'button', name: `Step ${String(n)}`, indent: 0 }]);
        }) as unknown as ReturnType<typeof makeMockEngine>['observe'],
      },
    });

    expect(stubs(create, 2)[1]).toContain('page changed');
  });

  it('names the action and handle it is reporting on', async () => {
    const { create } = await runWith(THREE_CALLS);

    expect(stubs(create, 2)[1]).toContain('click e1');
  });

  it('leaves the first stub bare, since nothing preceded it', async () => {
    const { create } = await runWith(THREE_CALLS);

    expect(stubs(create, 2)[0]).toBe('[page state at step 0]');
  });

  it('still keeps two messages per retained step', async () => {
    // The note rides on the existing stub rather than adding a third message,
    // so `windowedMessages` keeps pairing turns correctly.
    const { create } = await runWith([...THREE_CALLS], { maxHistorySteps: 1 });
    const messages = callMessages(create, 2);

    expect(messages).toHaveLength(1 * 2 + 2);
  });

  it('reports a secret-carrying step without the literal (AC-P7)', async () => {
    const { create } = await runWith(
      [
        JSON.stringify({ action: 'type', handle: 'e1', text: '{{sepia:secret:1}}' }),
        JSON.stringify({ action: 'click', handle: 'e2' }),
        doneAction('signed in'),
      ],
      { goal: 'sign in with password s3cret-hunter2' },
    );

    expect(joined(callMessages(create, 2))).not.toContain('s3cret-hunter2');
  });
});
