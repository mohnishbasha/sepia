// Shared test harness for agent-loop tests.
// Not collected by vitest (include is tests/**/*.test.ts).

import { vi } from 'vitest';
import type { SepiaEngine } from '../../engine/index.js';
import type { SepiaConfig } from '../../config/index.js';
import type { CompactNode, CompactView, ActionResult } from '../../types/index.js';

export function okResult(confidence = 0.95): ActionResult {
  return { ok: true, confidence };
}

export function makeView(nodes?: CompactNode[]): CompactView {
  return {
    url: 'https://example.com',
    title: 'Example',
    verbosity: 'standard',
    tokenCount: 30,
    timestampMs: 0,
    nodes: nodes ?? [
      { handle: 'e1', role: 'textbox', name: 'Email', indent: 0, state: { enabled: true } },
      { handle: 'e2', role: 'button', name: 'Sign in', indent: 0, state: { enabled: true } },
    ],
  };
}

export function makeMockEngine(overrides: Partial<SepiaEngine> = {}): SepiaEngine {
  return {
    open: vi.fn().mockResolvedValue(okResult()),
    observe: vi.fn().mockResolvedValue(makeView()),
    click: vi.fn().mockResolvedValue(okResult()),
    type: vi.fn().mockResolvedValue(okResult()),
    select: vi.fn().mockResolvedValue(okResult()),
    check: vi.fn().mockResolvedValue(okResult()),
    hover: vi.fn().mockResolvedValue(okResult()),
    scroll: vi.fn().mockResolvedValue(okResult()),
    press: vi.fn().mockResolvedValue(okResult()),
    read: vi.fn().mockResolvedValue({ ok: true, text: '' }),
    text: vi.fn().mockResolvedValue({ ok: true, text: 'page text', truncated: false }),
    screenshot: vi.fn().mockResolvedValue({ ok: true, path: '/tmp/shot.png' }),
    wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
    back: vi.fn().mockResolvedValue(okResult()),
    forward: vi.fn().mockResolvedValue(okResult()),
    tabs: {
      new: vi.fn().mockResolvedValue({ ok: true, tabId: '1' }),
      close: vi.fn().mockResolvedValue({ ok: true }),
      list: vi.fn().mockResolvedValue([]),
      switch: vi.fn().mockResolvedValue({ ok: true }),
    },
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as SepiaEngine;
}

export function makeConfig(overrides: Partial<SepiaConfig['agent']> = {}): SepiaConfig {
  return {
    model: {
      endpoint: 'https://api.anthropic.com/v1',
      model: 'test-model',
      apiKey: 'test',
      maxTokensPerStep: 10_000,
    },
    browser: { profile: 'default', headless: true, ephemeral: true },
    agent: {
      maxSteps: 10,
      maxTokensPerRun: 100_000,
      verbosity: 'standard',
      retryBackoffMs: 0,
      maxRetries: 2,
      confidenceThreshold: 0.7,
      ...overrides,
    },
    privacy: { telemetry: false },
    security: { robotsAwareness: false },
  };
}

/**
 * Build a mocked chat.completions.create that returns the given raw contents
 * in order. The final content repeats if the agent asks for more turns.
 */
export function modelReturning(...contents: string[]) {
  let i = 0;
  return vi.fn().mockImplementation(() => {
    const content = contents[Math.min(i, contents.length - 1)] ?? '';
    i++;
    return Promise.resolve({
      choices: [{ message: { content } }],
      usage: { total_tokens: 50 },
    });
  });
}

export function doneAction(summary: string): string {
  return JSON.stringify({ action: 'done', summary });
}
