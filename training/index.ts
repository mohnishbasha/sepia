import type { RunTrace, StepTrace } from '../agent/index.js';

// ShareGPT format — widely supported by fine-tuning frameworks (axolotl, LLaMA-Factory, unsloth).
export interface ShareGPTConversation {
  conversations: Array<{ from: 'system' | 'human' | 'gpt'; value: string }>;
  metadata: { runId: string; goal: string; outcome: string; totalTokens: number };
}

// Alpaca format — simpler instruction/input/output format.
export interface AlpacaSample {
  instruction: string;
  input: string;
  output: string;
}

const SYSTEM_MESSAGE =
  'You are a browser automation agent. Given a goal and the current page state, ' +
  'respond with exactly one JSON action using the handles shown on the page.';

function stepToShareGPT(
  goal: string,
  step: StepTrace,
  pageContent: string,
): ShareGPTConversation['conversations'] {
  const human = `Goal: ${goal}\n\nCurrent page:\n${pageContent}`;
  const gpt = JSON.stringify({ action: step.action, handle: step.handle });
  return [
    { from: 'system', value: SYSTEM_MESSAGE },
    { from: 'human', value: human },
    { from: 'gpt', value: gpt },
  ];
}

/**
 * Export a list of RunTraces to ShareGPT JSONL.
 *
 * Each successful step becomes one conversation turn. Skips runs that did not
 * succeed, steps that carried a secret, and steps with no recorded page — the
 * page is the input the sample teaches from, so without it there is nothing to
 * learn (AC-TR1). Recording is opt-in via `privacy.recordPageContent`.
 */
export function exportToShareGPT(traces: RunTrace[]): string {
  const lines: string[] = [];

  for (const trace of traces) {
    if (trace.outcome !== 'success') continue;

    for (const step of trace.steps) {
      if (step.secretsRedacted) continue;
      // A step whose page was never recorded cannot teach anything: the input
      // half of the sample is the thing being learned from. Emitting it anyway
      // is what made every exported sample worthless (issue #21).
      const pageContent = step.pageContent;
      if (pageContent === undefined || pageContent === '') continue;
      const conversation: ShareGPTConversation = {
        conversations: stepToShareGPT(trace.goal, step, pageContent),
        metadata: {
          runId: trace.runId,
          goal: trace.goal,
          outcome: trace.outcome,
          totalTokens: trace.totalTokens,
        },
      };
      lines.push(JSON.stringify(conversation));
    }
  }

  return lines.join('\n');
}

/**
 * Export a list of RunTraces to Alpaca JSONL.
 * Each successful step becomes one instruction sample.
 * Skips runs that did not succeed and steps with secretsRedacted.
 */
export function exportToAlpaca(traces: RunTrace[]): string {
  const lines: string[] = [];

  for (const trace of traces) {
    if (trace.outcome !== 'success') continue;

    for (const step of trace.steps) {
      if (step.secretsRedacted) continue;
      const pageContent = step.pageContent;
      if (pageContent === undefined || pageContent === '') continue;
      const sample: AlpacaSample = {
        instruction: SYSTEM_MESSAGE,
        input: `Goal: ${trace.goal}\n\nCurrent page:\n${pageContent}`,
        output: JSON.stringify({ action: step.action, handle: step.handle }),
      };
      lines.push(JSON.stringify(sample));
    }
  }

  return lines.join('\n');
}

/**
 * Load RunTrace objects from a JSONL file string (one JSON object per line).
 */
export function parseTraceJSONL(jsonl: string): RunTrace[] {
  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RunTrace);
}
