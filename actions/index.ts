import type {
  ErrorCode,
  WaitConditionType,
  ActionResult,
  ActionError,
  ReadResult,
  WaitResult,
  TabInfo,
  CompactView,
} from '../types/index.js';
import type { SepiaEngine } from '../engine/index.js';

// Re-export shared action result types so callers can import from actions/ or types/
export type { ErrorCode, ActionResult, ActionError, ReadResult, WaitResult, TabInfo };

export type ActionName =
  | 'click'
  | 'type'
  | 'select'
  | 'check'
  | 'hover'
  | 'scroll'
  | 'press'
  | 'read'
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
  condition?: WaitConditionType;
  timeoutMs?: number;
  tabId?: string;
  verbosity?: 'minimal' | 'standard' | 'full';
}

export function parseAction(raw: unknown): TypedAction {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Action must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const action = obj['action'];
  if (typeof action !== 'string' || !isValidActionName(action)) {
    throw new Error(`Unknown or invalid action: ${String(action)}`);
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
): Promise<ActionResult | ReadResult | WaitResult | CompactView | TabInfo[]> {
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
