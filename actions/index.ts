import type {
  ErrorCode,
  WaitConditionType,
  ActionResult,
  ActionError,
  ReadResult,
  WaitResult,
  TabInfo,
  CompactView,
  ScreenshotResult,
  TextResult,
} from '../types/index.js';
import type { SepiaEngine } from '../engine/index.js';

// Re-export shared action result types so callers can import from actions/ or types/
export type {
  ErrorCode,
  ActionResult,
  ActionError,
  ReadResult,
  WaitResult,
  TabInfo,
  ScreenshotResult,
  TextResult,
};

export type ActionName =
  | 'click'
  | 'type'
  | 'select'
  | 'check'
  | 'hover'
  | 'scroll'
  | 'press'
  | 'read'
  | 'text'
  | 'screenshot'
  | 'observe'
  | 'wait'
  | 'open'
  | 'back'
  | 'forward'
  | 'tabs.new'
  | 'tabs.close'
  | 'tabs.list'
  | 'tabs.switch';

export const ACTION_NAMES: Set<ActionName> = new Set([
  'click',
  'type',
  'select',
  'check',
  'hover',
  'scroll',
  'press',
  'read',
  'text',
  'screenshot',
  'observe',
  'wait',
  'open',
  'back',
  'forward',
  'tabs.new',
  'tabs.close',
  'tabs.list',
  'tabs.switch',
]);

export function isValidActionName(name: string): name is ActionName {
  return ACTION_NAMES.has(name as ActionName);
}

export interface TypedAction {
  action: ActionName;
  handle?: string;
  text?: string;
  submit?: boolean;
  option?: string;
  checked?: boolean;
  scrollTarget?: 'up' | 'down' | string;
  scrollDistance?: number;
  key?: string;
  url?: string;
  path?: string;
  fullPage?: boolean;
  maxChars?: number;
  condition?: WaitConditionType;
  timeoutMs?: number;
  tabId?: string;
  verbosity?: 'minimal' | 'standard' | 'full';
}

const VERBOSITY_VALUES = new Set(['minimal', 'standard', 'full']);

function requireString(obj: Record<string, unknown>, field: string, action: string): void {
  const value = obj[field];
  if (value === undefined || value === null || value === '') {
    throw new Error(`${action} requires ${field}`);
  }
  if (typeof value !== 'string') {
    throw new Error(`${action} ${field} must be a string`);
  }
}

function optionalString(obj: Record<string, unknown>, field: string, action: string): void {
  const value = obj[field];
  if (value !== undefined && typeof value !== 'string') {
    throw new Error(`${action} ${field} must be a string`);
  }
}

function optionalBoolean(obj: Record<string, unknown>, field: string, action: string): void {
  const value = obj[field];
  if (value !== undefined && typeof value !== 'boolean') {
    throw new Error(`${action} ${field} must be a boolean`);
  }
}

function optionalNumber(obj: Record<string, unknown>, field: string, action: string): void {
  const value = obj[field];
  if (value !== undefined && (typeof value !== 'number' || Number.isNaN(value))) {
    throw new Error(`${action} ${field} must be a number`);
  }
}

function requireCondition(obj: Record<string, unknown>, action: string): void {
  const condition = obj['condition'];
  if (condition === undefined || condition === null) {
    throw new Error(`${action} requires condition`);
  }
  if (typeof condition !== 'object') {
    throw new Error(`${action} condition must be an object`);
  }
  const type = (condition as Record<string, unknown>)['type'];
  if (type !== 'url' && type !== 'element' && type !== 'networkIdle') {
    throw new Error(`${action} condition.type must be url, element, or networkIdle`);
  }
}

/**
 * Validate a decoded model response against the typed action contract (AC-A5).
 *
 * Validation happens here, at the trust boundary, so the engine can rely on
 * every required field being present and correctly typed.
 */
export function parseAction(raw: unknown): TypedAction {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Action must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const action = obj['action'];
  if (typeof action !== 'string' || !isValidActionName(action)) {
    throw new Error(`Unknown or invalid action: ${String(action)}`);
  }

  switch (action) {
    case 'click':
    case 'hover':
    case 'read':
      requireString(obj, 'handle', action);
      break;

    case 'type':
      requireString(obj, 'handle', action);
      if (obj['text'] === undefined || obj['text'] === null) {
        throw new Error(`${action} requires text`);
      }
      if (typeof obj['text'] !== 'string') {
        throw new Error(`${action} text must be a string`);
      }
      optionalBoolean(obj, 'submit', action);
      break;

    case 'select':
      requireString(obj, 'handle', action);
      requireString(obj, 'option', action);
      break;

    case 'check':
      requireString(obj, 'handle', action);
      optionalBoolean(obj, 'checked', action);
      break;

    case 'text':
      optionalNumber(obj, 'maxChars', action);
      break;

    case 'screenshot':
      optionalString(obj, 'path', action);
      optionalBoolean(obj, 'fullPage', action);
      break;

    case 'scroll':
      optionalString(obj, 'scrollTarget', action);
      optionalNumber(obj, 'scrollDistance', action);
      break;

    case 'press':
      requireString(obj, 'key', action);
      break;

    case 'open':
      requireString(obj, 'url', action);
      break;

    case 'wait':
      requireCondition(obj, action);
      optionalNumber(obj, 'timeoutMs', action);
      break;

    case 'observe': {
      const verbosity = obj['verbosity'];
      if (verbosity !== undefined && !VERBOSITY_VALUES.has(String(verbosity))) {
        throw new Error(`${action} verbosity must be minimal, standard, or full`);
      }
      break;
    }

    case 'tabs.new':
      optionalString(obj, 'url', action);
      break;

    case 'tabs.close':
      optionalString(obj, 'tabId', action);
      break;

    case 'tabs.switch':
      requireString(obj, 'tabId', action);
      break;

    case 'tabs.list':
    case 'back':
    case 'forward':
      break;
  }

  return obj as unknown as TypedAction;
}

/**
 * Upper bound on steps in one batch.
 *
 * A plan comes from the model, so its length is untrusted input; the cap keeps a
 * malformed or runaway reply from turning into an unbounded run of page actions.
 * Well above any real form — the 10-field registration flow that motivated
 * batching is 12 steps.
 */
export const MAX_BATCH_STEPS = 50;

export interface BatchStepResult {
  /** Index in the submitted plan, so a caller can say which step failed. */
  step: number;
  action: ActionName;
  ok: boolean;
  confidence?: number;
  error?: ActionError;
}

export interface BatchResult {
  /** True only when every step ran and succeeded. */
  ok: boolean;
  /** Steps that succeeded, in order, before any failure. */
  completed: number;
  results: BatchStepResult[];
}

/**
 * Validate a whole plan before any of it runs (AC-A8).
 *
 * All-or-nothing on purpose: half-executing a plan and then rejecting step
 * seven leaves the page in a state neither side predicted, which is worse than
 * refusing the plan outright.
 */
export function parseBatch(raw: unknown): TypedAction[] {
  if (!Array.isArray(raw)) {
    throw new Error('Batch must be an array of actions');
  }
  if (raw.length === 0) {
    throw new Error('Batch must contain at least one action');
  }
  if (raw.length > MAX_BATCH_STEPS) {
    throw new Error(
      `Batch has ${String(raw.length)} steps, over the limit of ${String(MAX_BATCH_STEPS)}`,
    );
  }

  return raw.map((step, i) => {
    try {
      return parseAction(step);
    } catch (err) {
      throw new Error(
        `Batch step ${String(i)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Run a decided plan against the engine, one model call for the whole plan.
 *
 * Every step still goes through the engine's own confidence gate, which
 * re-observes and re-resolves the handle before touching the page. What batching
 * removes is model round trips, not the checks they were paying for: a page that
 * shifts mid-plan makes the affected step fail closed rather than act on the
 * wrong element.
 *
 * Stops at the first failure by default. Continuing is friendlier for form fill
 * and worse for anything destructive, so it is the caller's explicit choice.
 */
export async function dispatchBatch(
  steps: TypedAction[],
  engine: SepiaEngine,
  opts?: { continueOnError?: boolean },
): Promise<BatchResult> {
  const results: BatchStepResult[] = [];
  let completed = 0;
  let failed = false;

  for (const [i, step] of steps.entries()) {
    let outcome: BatchStepResult;
    try {
      const raw = await dispatch(step, engine);
      // Only action-shaped results carry ok/error; a read or observe simply
      // succeeded by returning.
      const asAction = raw as Partial<ActionResult>;
      const ok = asAction.ok !== false;
      outcome = { step: i, action: step.action, ok };
      if (asAction.confidence !== undefined) outcome.confidence = asAction.confidence;
      if (asAction.error !== undefined) outcome.error = asAction.error;
    } catch (err) {
      outcome = {
        step: i,
        action: step.action,
        ok: false,
        error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) },
      };
    }

    results.push(outcome);
    if (outcome.ok) {
      if (!failed) completed++;
    } else {
      failed = true;
      if (opts?.continueOnError !== true) break;
    }
  }

  return { ok: !failed, completed, results };
}

/**
 * Dispatch a typed action to the engine. Routes each action to the correct
 * engine method using a typed switch/dispatch table — never dynamic eval.
 */
export async function dispatch(
  action: TypedAction,
  engine: SepiaEngine,
): Promise<ActionResult | ReadResult | WaitResult | CompactView | TabInfo[] | ScreenshotResult> {
  switch (action.action) {
    case 'click': {
      if (!action.handle) throw new Error('click requires handle');
      return engine.click(action.handle);
    }

    case 'type': {
      if (!action.handle) throw new Error('type requires handle');
      if (action.text === undefined) throw new Error('type requires text');
      const typeOpts: { submit?: boolean } = {};
      if (action.submit !== undefined) typeOpts.submit = action.submit;
      return engine.type(action.handle, action.text, typeOpts);
    }

    case 'select': {
      if (!action.handle) throw new Error('select requires handle');
      if (!action.option) throw new Error('select requires option');
      return engine.select(action.handle, action.option);
    }

    case 'check': {
      if (!action.handle) throw new Error('check requires handle');
      const checkedVal = action.checked ?? true;
      return engine.check(action.handle, checkedVal);
    }

    case 'hover': {
      if (!action.handle) throw new Error('hover requires handle');
      return engine.hover(action.handle);
    }

    case 'scroll': {
      const scrollTarget = action.scrollTarget ?? 'down';
      return engine.scroll(scrollTarget, action.scrollDistance);
    }

    case 'press': {
      if (!action.key) throw new Error('press requires key');
      return engine.press(action.key);
    }

    case 'read': {
      if (!action.handle) throw new Error('read requires handle');
      return engine.read(action.handle);
    }

    case 'text': {
      const textOpts: { maxChars?: number } = {};
      if (action.maxChars !== undefined) textOpts.maxChars = action.maxChars;
      return engine.text(textOpts);
    }

    case 'screenshot': {
      const shotOpts: { path?: string; fullPage?: boolean } = {};
      if (action.path !== undefined) shotOpts.path = action.path;
      if (action.fullPage !== undefined) shotOpts.fullPage = action.fullPage;
      return engine.screenshot(shotOpts);
    }

    case 'observe': {
      const obsOpts: { verbosity?: 'minimal' | 'standard' | 'full' } = {};
      if (action.verbosity !== undefined) obsOpts.verbosity = action.verbosity;
      return engine.observe(obsOpts);
    }

    case 'wait': {
      if (!action.condition) throw new Error('wait requires condition');
      return engine.wait(action.condition, action.timeoutMs);
    }

    case 'open': {
      if (!action.url) throw new Error('open requires url');
      return engine.open(action.url);
    }

    case 'back': {
      return engine.back();
    }

    case 'forward': {
      return engine.forward();
    }

    case 'tabs.new': {
      return engine.tabs.new(action.url);
    }

    case 'tabs.close': {
      return engine.tabs.close(action.tabId);
    }

    case 'tabs.list': {
      return engine.tabs.list();
    }

    case 'tabs.switch': {
      if (!action.tabId) throw new Error('tabs.switch requires tabId');
      return engine.tabs.switch(action.tabId);
    }
  }
}
