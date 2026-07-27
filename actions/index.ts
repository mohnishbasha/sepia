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

    case 'screenshot': {
      const shotOpts: { path?: string; fullPage?: boolean } = {};
      if (action.path !== undefined) shotOpts.path = action.path;
      if (action.fullPage !== undefined) shotOpts.fullPage = action.fullPage;
      return engine.screenshot(shotOpts);
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
