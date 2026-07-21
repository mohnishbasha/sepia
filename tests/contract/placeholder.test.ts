import { describe, it, expect, vi } from 'vitest';
import { ACTION_NAMES, parseAction, dispatch } from '../../actions/index.js';
import type { SepiaEngine } from '../../engine/index.js';
import type { ActionResult, CompactView } from '../../types/index.js';

describe('action contract — parseAction', () => {
  it('parses a valid click action', () => {
    const action = parseAction({ action: 'click', handle: 'e12' });
    expect(action.action).toBe('click');
    expect(action.handle).toBe('e12');
  });

  it('parses a valid type action', () => {
    const action = parseAction({ action: 'type', handle: 'e13', text: 'hello', submit: false });
    expect(action.action).toBe('type');
    expect(action.text).toBe('hello');
  });

  it('throws on unknown action name', () => {
    expect(() => parseAction({ action: 'eval', handle: 'e1' })).toThrow(
      /Unknown or invalid action/,
    );
  });

  it('throws on non-object input', () => {
    expect(() => parseAction('click')).toThrow();
    expect(() => parseAction(null)).toThrow();
    expect(() => parseAction(42)).toThrow();
  });

  it('ACTION_NAMES includes all required actions', () => {
    const required = [
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
    ];
    for (const name of required) {
      expect(ACTION_NAMES.has(name as never), `missing action: ${name}`).toBe(true);
    }
  });
});

describe('action contract — parseAction with done action', () => {
  it('parseAction with model done JSON throws (done is not a valid ActionName)', () => {
    // done is not in ACTION_NAMES, handled specially by agent
    expect(() => parseAction({ action: 'done' })).toThrow(/Unknown or invalid action/);
  });

  it('parseAction with eval action throws', () => {
    expect(() => parseAction({ action: 'eval', code: 'alert(1)' })).toThrow(
      /Unknown or invalid action/,
    );
  });
});

describe('action contract — dispatch', () => {
  function makeMockEngine(): SepiaEngine {
    const mockView: CompactView = {
      url: 'https://example.com',
      title: 'Test',
      verbosity: 'standard',
      tokenCount: 10,
      timestampMs: Date.now(),
      nodes: [],
    };
    return {
      open: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      observe: vi.fn().mockResolvedValue(mockView),
      click: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      type: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      select: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      check: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      hover: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      scroll: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      press: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      read: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
      wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
      back: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      forward: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      tabs: {
        new: vi.fn().mockResolvedValue({ ok: true, tabId: '1' }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('dispatch click routes to engine.click', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'click', handle: 'e12' });
    await dispatch(action, engine);
    expect(engine.click).toHaveBeenCalledWith('e12');
  });

  it('dispatch open routes to engine.open', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'open', url: 'https://example.com' });
    await dispatch(action, engine);
    expect(engine.open).toHaveBeenCalledWith('https://example.com');
  });

  it('dispatch observe routes to engine.observe', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'observe' });
    await dispatch(action, engine);
    expect(engine.observe).toHaveBeenCalled();
  });

  it('dispatch type routes to engine.type', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'type', handle: 'e5', text: 'hello' });
    await dispatch(action, engine);
    expect(engine.type).toHaveBeenCalledWith('e5', 'hello', { submit: undefined });
  });

  it('dispatch with eval throws (invalid action — parseAction rejects it)', async () => {
    expect(() => parseAction({ action: 'eval', code: 'bad' })).toThrow();
  });

  it('dispatch select routes to engine.select', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'select', handle: 'e3', option: 'Option A' });
    await dispatch(action, engine);
    expect(engine.select).toHaveBeenCalledWith('e3', 'Option A');
  });

  it('dispatch check routes to engine.check', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'check', handle: 'e4', checked: true });
    await dispatch(action, engine);
    expect(engine.check).toHaveBeenCalledWith('e4', true);
  });

  it('dispatch hover routes to engine.hover', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'hover', handle: 'e5' });
    await dispatch(action, engine);
    expect(engine.hover).toHaveBeenCalledWith('e5');
  });

  it('dispatch scroll routes to engine.scroll', async () => {
    const engine = makeMockEngine();
    // scroll uses scrollTarget/scrollDistance fields in TypedAction
    const action = parseAction({ action: 'scroll', scrollTarget: 'down', scrollDistance: 300 });
    await dispatch(action, engine);
    expect(engine.scroll).toHaveBeenCalledWith('down', 300);
  });

  it('dispatch press routes to engine.press', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'press', key: 'Enter' });
    await dispatch(action, engine);
    expect(engine.press).toHaveBeenCalledWith('Enter');
  });

  it('dispatch read routes to engine.read', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'read', handle: 'e6' });
    await dispatch(action, engine);
    expect(engine.read).toHaveBeenCalledWith('e6');
  });

  it('dispatch wait routes to engine.wait', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'wait', condition: { type: 'networkIdle' } });
    await dispatch(action, engine);
    expect(engine.wait).toHaveBeenCalledWith({ type: 'networkIdle' }, undefined);
  });

  it('dispatch back routes to engine.back', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'back' });
    await dispatch(action, engine);
    expect(engine.back).toHaveBeenCalled();
  });

  it('dispatch forward routes to engine.forward', async () => {
    const engine = makeMockEngine();
    const action = parseAction({ action: 'forward' });
    await dispatch(action, engine);
    expect(engine.forward).toHaveBeenCalled();
  });
});

describe('action contract — stale handle returns STALE_HANDLE (AC-A1)', () => {
  function makeMockEngine(): SepiaEngine {
    const mockView: CompactView = {
      url: 'https://example.com',
      title: 'Test',
      verbosity: 'standard',
      tokenCount: 10,
      timestampMs: Date.now(),
      nodes: [],
    };
    return {
      open: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      observe: vi.fn().mockResolvedValue(mockView),
      click: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      type: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      select: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      check: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      hover: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      scroll: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      press: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      read: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
      wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
      back: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      forward: vi.fn().mockResolvedValue({ ok: true, confidence: 1 }),
      tabs: {
        new: vi.fn().mockResolvedValue({ ok: true, tabId: '1' }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('click on stale handle returns error.code = STALE_HANDLE', async () => {
    const engine = makeMockEngine();
    // Override click to return stale result
    vi.mocked(engine.click).mockResolvedValue({
      ok: false,
      confidence: 0,
      error: { code: 'STALE_HANDLE', message: 'stale', handle: 'e99' },
    });
    const action = parseAction({ action: 'click', handle: 'e99' });
    const result = (await dispatch(action, engine)) as ActionResult;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STALE_HANDLE');
    expect(result.error?.handle).toBe('e99');
  });

  it('type on stale handle returns error.code = STALE_HANDLE', async () => {
    const engine = makeMockEngine();
    vi.mocked(engine.type).mockResolvedValue({
      ok: false,
      confidence: 0,
      error: { code: 'STALE_HANDLE', message: 'stale', handle: 'e88' },
    });
    const action = parseAction({ action: 'type', handle: 'e88', text: 'hello' });
    const result = (await dispatch(action, engine)) as ActionResult;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('STALE_HANDLE');
  });
});
