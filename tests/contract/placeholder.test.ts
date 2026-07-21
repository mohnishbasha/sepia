import { describe, it, expect, vi } from 'vitest';
import { ACTION_NAMES, parseAction, dispatch } from '../../actions/index.js';
import type { SepiaEngine } from '../../engine/index.js';
import type { CompactView } from '../../types/index.js';

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
    expect(() => parseAction({ action: 'eval', handle: 'e1' })).toThrow(/Unknown or invalid action/);
  });

  it('throws on non-object input', () => {
    expect(() => parseAction('click')).toThrow();
    expect(() => parseAction(null)).toThrow();
    expect(() => parseAction(42)).toThrow();
  });

  it('ACTION_NAMES includes all required actions', () => {
    const required = ['click', 'type', 'select', 'check', 'hover', 'scroll', 'press', 'read', 'observe', 'wait', 'open', 'back', 'forward'];
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
    expect(() => parseAction({ action: 'eval', code: 'alert(1)' })).toThrow(/Unknown or invalid action/);
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
});
