/**
 * AC-P7 — a credential in the goal reaches neither the model nor the trace
 * (issue #9).
 *
 * `redactCompactView()` protected page content while the goal was replayed
 * verbatim in every user message and stored in `trace.goal`:
 *
 *     hunter2 in page outline (all 5 calls) : no
 *     hunter2 in goal line    (all 5 calls) : YES
 *     hunter2 in trace.goal                 : YES
 *
 * Anything persisting a RunTrace persisted the credential — including
 * `training/`, which exports traces as fine-tuning data with the goal as the
 * instruction field. `soul.md` claims "the trace records that a secret was
 * redacted, not what it was". That was true of the page half and false of the
 * goal half.
 *
 * Redacting the goal outright would make the task impossible: an agent told to
 * sign in cannot type a password it was never given. So the credential is
 * *extracted* rather than deleted — the model sees a placeholder, and the
 * literal is substituted back inside the engine call, below the model boundary.
 * The model can still do the job; nothing that leaves the process carries the
 * secret.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractGoalSecrets, applyGoalSecrets } from '../../privacy/index.js';
import {
  makeMockEngine,
  makeConfig,
  makeView,
  modelReturning,
  doneAction,
} from '../helpers/agent-harness.js';
import type { SepiaEngine } from '../../engine/index.js';
import type { RunTrace } from '../../agent/index.js';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('AC-P7 — credentials are lifted out of the goal', () => {
  it('replaces a bare password with a placeholder', () => {
    const { redacted, secrets } = extractGoalSecrets(
      'sign in with alice@example.com and password hunter2',
    );

    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('alice@example.com');
    expect([...secrets.values()]).toContain('hunter2');
  });

  it('handles the separator forms people actually write', () => {
    for (const goal of [
      'log in, password: hunter2',
      'log in, password=hunter2',
      'log in, password is hunter2',
      'log in with the passcode hunter2',
      'use api key sk-abc123def456',
    ]) {
      expect(extractGoalSecrets(goal).redacted).not.toMatch(/hunter2|sk-abc123def456/);
    }
  });

  it('leaves prose about passwords alone', () => {
    // Over-redaction is not free: it destroys the instruction the agent needs.
    for (const goal of [
      'click the password reset link',
      'find the page that explains password requirements',
      'check whether the password field is required',
    ]) {
      expect(extractGoalSecrets(goal).redacted).toBe(goal);
      expect(extractGoalSecrets(goal).secrets.size).toBe(0);
    }
  });

  it('leaves a goal with no credential completely untouched', () => {
    const goal = 'find the current Node.js LTS version';

    expect(extractGoalSecrets(goal).redacted).toBe(goal);
    expect(extractGoalSecrets(goal).secrets.size).toBe(0);
  });

  it('puts the literal back when the model echoes the placeholder', () => {
    const { redacted, secrets } = extractGoalSecrets('sign in with password hunter2');
    const placeholder = [...secrets.keys()][0]!;

    expect(applyGoalSecrets(placeholder, secrets)).toBe('hunter2');
    expect(applyGoalSecrets(`x${placeholder}y`, secrets)).toBe('xhunter2y');
    expect(redacted).toContain(placeholder);
  });

  it('leaves text alone when it contains no placeholder', () => {
    const { secrets } = extractGoalSecrets('sign in with password hunter2');

    expect(applyGoalSecrets('ordinary text', secrets)).toBe('ordinary text');
  });
});

describe('AC-P7 — end to end through a run', () => {
  async function runSignIn(
    goal: string,
  ): Promise<{ trace: RunTrace; prompts: string[]; engine: SepiaEngine }> {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');
    const OpenAI = (await import('openai')).default;

    const engine = makeMockEngine({
      observe: vi
        .fn()
        .mockResolvedValue(
          makeView([{ handle: 'e1', role: 'textbox', name: 'Password', indent: 0 }]),
        ),
    });
    vi.mocked(createEngine).mockResolvedValue(engine);

    // The model copies the placeholder out of the goal, as it would any literal.
    const prompts: string[] = [];
    const create = modelReturning(
      JSON.stringify({ action: 'type', handle: 'e1', text: '{{sepia:secret:1}}' }),
      doneAction('signed in'),
    );
    const spy = vi.fn().mockImplementation((args: { messages: { content: string }[] }) => {
      prompts.push(args.messages.map((m) => m.content).join('\n'));
      return create(args);
    });
    vi.mocked(OpenAI).mockImplementation(
      () => ({ chat: { completions: { create: spy } } }) as unknown as InstanceType<typeof OpenAI>,
    );

    const trace = await createAgent(makeConfig()).run(goal);
    return { trace, prompts, engine };
  }

  it('never sends the credential to the model', async () => {
    const { prompts } = await runSignIn('sign in with password hunter2');

    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).not.toContain('hunter2');
    }
  });

  it('never writes the credential into the trace', async () => {
    const { trace } = await runSignIn('sign in with password hunter2');

    expect(JSON.stringify(trace)).not.toContain('hunter2');
    expect(trace.goal).not.toContain('hunter2');
  });

  it('still types the real credential into the page', async () => {
    const { engine } = await runSignIn('sign in with password hunter2');

    // Below the model boundary the literal is restored — otherwise the run is
    // safe and useless.
    expect(vi.mocked(engine.type)).toHaveBeenCalledWith('e1', 'hunter2', expect.anything());
  });

  it('marks the step as having carried a secret', async () => {
    const { trace } = await runSignIn('sign in with password hunter2');

    expect(trace.steps.find((s) => s.action === 'type')?.secretsRedacted).toBe(true);
  });
});
