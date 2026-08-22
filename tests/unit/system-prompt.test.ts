/**
 * AC-A10 — the system prompt advertises the full dispatchable action set.
 *
 * Before this requirement (issue #4) both system prompts documented only a
 * handful of the implemented actions (click/type/open/done). Every other
 * action was implemented, validated, dispatched, and tested — but unreachable,
 * because the model was never told it existed. Dropdowns were unusable (no
 * `select`/`check`), content below the fold invisible (no `scroll`), truncated
 * prose unrecoverable (no `read`), navigation one-way (no `back`/`forward`).
 *
 * `screenshot` stays deliberately out of the model prompt: it is an
 * operator/SDK artifact and its base64 must not enter the LLM context.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../engine/index.js', () => ({ createEngine: vi.fn() }));
vi.mock('openai', () => ({ default: vi.fn() }));

import { selectSystemPrompt } from '../../agent/index.js';
import {
  ACTION_NAMES,
  parseAction,
  parseTerminalAction,
  isTerminalActionName,
  type ActionName,
} from '../../actions/index.js';

// Every dispatchable action the model may use, minus the operator-only `screenshot`.
const modelVisible = new Set([...ACTION_NAMES].filter((name) => name !== 'screenshot'));

/** Pull the `{"action":...}` example lines out of a system prompt. */
function exampleLines(prompt: string): string[] {
  return prompt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
}

describe('AC-A10 — the system prompt advertises the full dispatchable action set', () => {
  it('default prompt advertises every dispatchable action except screenshot', () => {
    const prompt = selectSystemPrompt('default');
    for (const name of modelVisible) {
      expect(prompt, `default prompt should advertise "${name}"`).toContain(`"action":"${name}"`);
    }
  });

  it('minimal prompt advertises every dispatchable action except screenshot', () => {
    const prompt = selectSystemPrompt('minimal');
    for (const name of modelVisible) {
      expect(prompt, `minimal prompt should advertise "${name}"`).toContain(`"action":"${name}"`);
    }
  });

  it('neither prompt advertises screenshot', () => {
    for (const style of ['default', 'minimal'] as const) {
      expect(
        selectSystemPrompt(style),
        `${style} prompt must not advertise screenshot`,
      ).not.toContain('"action":"screenshot"');
    }
  });

  it('both prompts still steer handle discipline', () => {
    for (const style of ['default', 'minimal'] as const) {
      expect(selectSystemPrompt(style)).toContain('never invent handles');
    }
  });

  it('both prompts advertise the terminal actions with when-to-use guidance', () => {
    for (const style of ['default', 'minimal'] as const) {
      const prompt = selectSystemPrompt(style);
      expect(prompt).toContain('"action":"done"');
      expect(prompt).toContain('"action":"abort"');
    }
  });

  it('every example the prompt advertises is accepted by the boundary validator', () => {
    // Guard against the prompt teaching a shape that parseAction/parseTerminalAction
    // would reject: the model would burn retries on a payload its own contract
    // declares invalid.
    for (const style of ['default', 'minimal'] as const) {
      for (const line of exampleLines(selectSystemPrompt(style))) {
        const parsed = JSON.parse(line) as { action: string };
        if (isTerminalActionName(parsed.action)) {
          expect(() => parseTerminalAction(JSON.parse(line)), `${style}: ${line}`).not.toThrow();
        } else {
          expect(() => parseAction(JSON.parse(line)), `${style}: ${line}`).not.toThrow();
        }
      }
    }
  });

  it('does not advertise an action outside the known dispatchable set', () => {
    for (const style of ['default', 'minimal'] as const) {
      const advertised = new Set(
        exampleLines(selectSystemPrompt(style)).map(
          (line) => (JSON.parse(line) as { action: string }).action,
        ),
      );
      for (const name of advertised) {
        if (name !== 'done' && name !== 'abort') {
          expect(ACTION_NAMES.has(name as ActionName), `${style}: ${name}`).toBe(true);
        }
      }
    }
  });
});
