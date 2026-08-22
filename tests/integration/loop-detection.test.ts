/**
 * AC-AG10 — loop detection stops a run when the same (action, handle) is
 * re-issued against an unchanged view.
 *
 * Before this, an agent that kept re-issuing an identical command — clicking the
 * same dead button, for example — would simply burn the step budget until it ran
 * out and report `budget_exceeded` / `error` (issue #6). Now, when the same
 * (action, handle) repeats N consecutive times (default N = 3, configurable via
 * `config.agent.loopThreshold`) with no change to the observed view hash, the
 * run stops early with `outcome: 'unable'` and a diagnostic `answer`, pairing
 * with the `unable` outcome from issue #5.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makeMockEngine,
  makeConfig,
  modelReturning,
  makeView,
  doneAction,
} from '../helpers/agent-harness.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

interface RunOpts {
  /** Override the loop-detection threshold (default: 3). */
  loopThreshold?: number;
  /** When true, each observe returns a distinct view so the view hash changes. */
  viewChanges?: boolean;
}

async function runWith(contents: string[], opts: RunOpts = {}) {
  const { createEngine } = await import('../../engine/index.js');
  const { createAgent } = await import('../../agent/index.js');
  const OpenAI = (await import('openai')).default;

  // A static observe yields the same view hash every step; a changing observe
  // makes the page content differ so the hash moves.
  const engine = opts.viewChanges ? makeMockEngineWithChangingView() : makeMockEngine();
  vi.mocked(createEngine).mockResolvedValue(engine);
  const create = modelReturning(...contents);
  vi.mocked(OpenAI).mockImplementation(
    () => ({ chat: { completions: { create } } }) as unknown as InstanceType<typeof OpenAI>,
  );

  const agentOverrides =
    opts.loopThreshold !== undefined ? { loopThreshold: opts.loopThreshold } : {};
  const trace = await createAgent(makeConfig(agentOverrides)).run('click the button');
  return { trace, create, engine };
}

/** An engine whose observed view mutates on every observe call. */
function makeMockEngineWithChangingView() {
  let obs = 0;
  return makeMockEngine({
    observe: vi.fn().mockImplementation(async () => {
      obs += 1;
      return makeView([
        {
          handle: 'e1',
          role: 'button',
          name: `Button ${obs}`,
          indent: 0,
          state: { enabled: true },
        },
      ]);
    }) as unknown as ReturnType<typeof makeMockEngine>['observe'],
  });
}

describe('AC-AG10 — loop detection stops repeated no-op actions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stops with `unable` when the same action on an unchanged view repeats', async () => {
    const { trace, engine, create } = await runWith([
      JSON.stringify({ action: 'click', handle: 'e1' }),
    ]);

    expect(trace.outcome).toBe('unable');
    expect(trace.answer).toMatch(/Loop detected/);
    // Default threshold is 3: the third identical no-op is where we stop.
    expect(trace.totalSteps).toBe(3);
    expect(engine.click).toHaveBeenCalledTimes(3);
    // The fourth model call never happens — we stop before asking again.
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('respects a lower configured threshold', async () => {
    const { trace } = await runWith([JSON.stringify({ action: 'click', handle: 'e1' })], {
      loopThreshold: 2,
    });

    expect(trace.outcome).toBe('unable');
    expect(trace.answer).toMatch(/Loop detected/);
    expect(trace.totalSteps).toBe(2);
  });

  it('does not flag a loop when the view changes between identical actions', async () => {
    // The page mutates on every observe, so the same click is not a no-op loop.
    const { trace } = await runWith(
      [
        JSON.stringify({ action: 'click', handle: 'e1' }),
        JSON.stringify({ action: 'click', handle: 'e1' }),
        doneAction('reached the next page'),
      ],
      { loopThreshold: 2, viewChanges: true },
    );

    expect(trace.outcome).toBe('success');
    expect(trace.answer).toBe('reached the next page');
    expect(trace.totalSteps).toBe(2);
  });

  it('resets the counter when a different action is issued in between', async () => {
    // Alternating handles means the (action, handle) key changes each step, so
    // the repeat count never climbs to the threshold.
    const { trace } = await runWith(
      [
        JSON.stringify({ action: 'click', handle: 'e1' }),
        JSON.stringify({ action: 'click', handle: 'e2' }),
        JSON.stringify({ action: 'click', handle: 'e1' }),
        JSON.stringify({ action: 'click', handle: 'e2' }),
        doneAction('done'),
      ],
      { loopThreshold: 2 },
    );

    expect(trace.outcome).toBe('success');
    expect(trace.totalSteps).toBe(4);
  });
});
