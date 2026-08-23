/**
 * AC-TR1 — the training export can actually be run (issue #21).
 *
 * `exportToShareGPT()` and `exportToAlpaca()` took a
 * `pageContents: Map<runId, string[]>` that nothing in the codebase produced:
 * the agent never recorded page content and `RunTrace` had no field for it.
 * `make export-traces` passed an empty Map, so every sample came out with an
 * empty `Current page:` section — structurally valid JSONL, and worthless as
 * training data, since the input the model is meant to learn from was missing.
 *
 * The page the model saw is now recorded on the step itself, behind an opt-in
 * because it is bulky and it is page content: `privacy.recordPageContent`.
 */

import { describe, it, expect } from 'vitest';
import { exportToShareGPT, exportToAlpaca } from '../../training/index.js';
import type { RunTrace } from '../../agent/index.js';

function trace(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: 'r1',
    goal: 'sign in',
    sessionId: 's1',
    startMs: 0,
    endMs: 1,
    outcome: 'success',
    totalSteps: 1,
    totalTokens: 10,
    steps: [
      {
        stepN: 0,
        action: 'click',
        handle: 'e1',
        confidence: 0.9,
        tokensUsed: 10,
        latencyMs: 1,
        result: { ok: true, confidence: 0.9 },
        secretsRedacted: false,
        pageContent: '[e1] button "Sign in"',
      },
    ],
    ...overrides,
  };
}

describe('AC-TR1 — the export reads what a trace actually holds', () => {
  it('needs no second argument the caller cannot supply', () => {
    // The old signature demanded a Map nothing produced.
    expect(exportToShareGPT.length).toBe(1);
    expect(exportToAlpaca.length).toBe(1);
  });

  it('carries the recorded page into the sample', () => {
    const line = exportToShareGPT([trace()]).trim();
    const sample = JSON.parse(line) as { conversations: Array<{ from: string; value: string }> };
    const human = sample.conversations.find((c) => c.from === 'human')!.value;

    expect(human).toContain('[e1] button "Sign in"');
    expect(human).toContain('Goal: sign in');
  });

  it('carries it into Alpaca input too', () => {
    const sample = JSON.parse(exportToAlpaca([trace()]).trim()) as { input: string };

    expect(sample.input).toContain('[e1] button "Sign in"');
  });

  it('emits nothing for a step whose page was never recorded', () => {
    // Better an empty dataset than one full of samples teaching "given no page,
    // click e1" — the failure this issue is about.
    const bare = trace();
    delete bare.steps[0]!.pageContent;

    expect(exportToShareGPT([bare]).trim()).toBe('');
    expect(exportToAlpaca([bare]).trim()).toBe('');
  });

  it('still skips failed runs and steps that carried a secret', () => {
    expect(exportToShareGPT([trace({ outcome: 'unable' })]).trim()).toBe('');

    const secret = trace();
    secret.steps[0]!.secretsRedacted = true;
    expect(exportToShareGPT([secret]).trim()).toBe('');
  });
});
