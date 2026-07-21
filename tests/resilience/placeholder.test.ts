import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompactView, ActionResult } from '../../types/index.js';
import type { SepiaEngine } from '../../engine/index.js';

// ── Mock createEngine ─────────────────────────────────────────────────────────

vi.mock('../../engine/index.js', () => {
  return {
    createEngine: vi.fn(),
  };
});

// ── Mock OpenAI ───────────────────────────────────────────────────────────────

vi.mock('openai', () => {
  return {
    default: vi.fn(),
  };
});

function makeView(): CompactView {
  return {
    url: 'https://example.com',
    title: 'Example',
    verbosity: 'standard',
    tokenCount: 50,
    timestampMs: Date.now(),
    nodes: [],
  };
}

function makeOkResult(): ActionResult {
  return { ok: true, confidence: 1 };
}

function makeBaseConfig(overrides?: Partial<{ maxSteps: number; maxTokensPerRun: number }>) {
  return {
    model: {
      endpoint: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-6',
      apiKey: 'test',
      maxTokensPerStep: 1000,
    },
    browser: {
      profile: 'default',
      headless: true,
      ephemeral: true,
      humanTiming: false,
    },
    agent: {
      maxSteps: overrides?.maxSteps ?? 10,
      maxTokensPerRun: overrides?.maxTokensPerRun ?? 100_000,
      verbosity: 'standard' as const,
      retryBackoffMs: 0,
      maxRetries: 1,
      confidenceThreshold: 0.7,
    },
    privacy: { telemetry: false },
    security: { robotsAwareness: false },
  };
}

describe('resilience — network timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('agent returns outcome:error when observe times out', async () => {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');

    const mockEngine: SepiaEngine = {
      open: vi.fn().mockResolvedValue(makeOkResult()),
      observe: vi.fn().mockRejectedValue(new Error('network timeout after 100ms')),
      click: vi.fn().mockResolvedValue(makeOkResult()),
      type: vi.fn().mockResolvedValue(makeOkResult()),
      select: vi.fn().mockResolvedValue(makeOkResult()),
      check: vi.fn().mockResolvedValue(makeOkResult()),
      hover: vi.fn().mockResolvedValue(makeOkResult()),
      scroll: vi.fn().mockResolvedValue(makeOkResult()),
      press: vi.fn().mockResolvedValue(makeOkResult()),
      read: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
      back: vi.fn().mockResolvedValue(makeOkResult()),
      forward: vi.fn().mockResolvedValue(makeOkResult()),
      tabs: {
        new: vi.fn().mockResolvedValue({ ok: true }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(createEngine).mockResolvedValue(mockEngine);

    const config = makeBaseConfig();
    const trace = await createAgent(config).run('do something');

    expect(trace.outcome).toBe('error');
    expect(mockEngine.close).toHaveBeenCalled();
  });

  it('agent returns outcome:error when model call times out', async () => {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');
    const OpenAI = (await import('openai')).default;

    const mockEngine: SepiaEngine = {
      open: vi.fn().mockResolvedValue(makeOkResult()),
      observe: vi.fn().mockResolvedValue(makeView()),
      click: vi.fn().mockResolvedValue(makeOkResult()),
      type: vi.fn().mockResolvedValue(makeOkResult()),
      select: vi.fn().mockResolvedValue(makeOkResult()),
      check: vi.fn().mockResolvedValue(makeOkResult()),
      hover: vi.fn().mockResolvedValue(makeOkResult()),
      scroll: vi.fn().mockResolvedValue(makeOkResult()),
      press: vi.fn().mockResolvedValue(makeOkResult()),
      read: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
      back: vi.fn().mockResolvedValue(makeOkResult()),
      forward: vi.fn().mockResolvedValue(makeOkResult()),
      tabs: {
        new: vi.fn().mockResolvedValue({ ok: true }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createEngine).mockResolvedValue(mockEngine);

    vi.mocked(OpenAI).mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockRejectedValue(new Error('Request timed out')),
        },
      },
    }) as unknown as InstanceType<typeof OpenAI>);

    const config = makeBaseConfig();
    const trace = await createAgent(config).run('do something');

    expect(trace.outcome).toBe('error');
    expect(mockEngine.close).toHaveBeenCalled();
  });
});

describe('resilience — budget exceeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('agent returns outcome:budget_exceeded when maxSteps is reached', async () => {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');
    const OpenAI = (await import('openai')).default;

    const mockEngine: SepiaEngine = {
      open: vi.fn().mockResolvedValue(makeOkResult()),
      observe: vi.fn().mockResolvedValue(makeView()),
      click: vi.fn().mockResolvedValue(makeOkResult()),
      type: vi.fn().mockResolvedValue(makeOkResult()),
      select: vi.fn().mockResolvedValue(makeOkResult()),
      check: vi.fn().mockResolvedValue(makeOkResult()),
      hover: vi.fn().mockResolvedValue(makeOkResult()),
      scroll: vi.fn().mockResolvedValue(makeOkResult()),
      press: vi.fn().mockResolvedValue(makeOkResult()),
      read: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
      back: vi.fn().mockResolvedValue(makeOkResult()),
      forward: vi.fn().mockResolvedValue(makeOkResult()),
      tabs: {
        new: vi.fn().mockResolvedValue({ ok: true }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createEngine).mockResolvedValue(mockEngine);

    // Model always returns a click action — never 'done'
    vi.mocked(OpenAI).mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"action":"click","handle":"e1"}' } }],
            usage: { total_tokens: 100 },
          }),
        },
      },
    }) as unknown as InstanceType<typeof OpenAI>);

    // maxSteps: 2 → loop runs only 2 times, then budget_exceeded
    const config = makeBaseConfig({ maxSteps: 2 });
    const trace = await createAgent(config).run('do something forever');

    expect(trace.outcome).toBe('budget_exceeded');
    expect(trace.totalSteps).toBe(2);
    expect(mockEngine.close).toHaveBeenCalled();
  });

  it('agent returns outcome:budget_exceeded when token budget is exceeded', async () => {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');
    const OpenAI = (await import('openai')).default;

    const mockEngine: SepiaEngine = {
      open: vi.fn().mockResolvedValue(makeOkResult()),
      observe: vi.fn().mockResolvedValue(makeView()),
      click: vi.fn().mockResolvedValue(makeOkResult()),
      type: vi.fn().mockResolvedValue(makeOkResult()),
      select: vi.fn().mockResolvedValue(makeOkResult()),
      check: vi.fn().mockResolvedValue(makeOkResult()),
      hover: vi.fn().mockResolvedValue(makeOkResult()),
      scroll: vi.fn().mockResolvedValue(makeOkResult()),
      press: vi.fn().mockResolvedValue(makeOkResult()),
      read: vi.fn().mockResolvedValue({ ok: true, text: '' }),
      wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
      back: vi.fn().mockResolvedValue(makeOkResult()),
      forward: vi.fn().mockResolvedValue(makeOkResult()),
      tabs: {
        new: vi.fn().mockResolvedValue({ ok: true }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(createEngine).mockResolvedValue(mockEngine);

    // Each model call returns 1000 tokens; budget is 500 → exceeded after first step
    vi.mocked(OpenAI).mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"action":"click","handle":"e1"}' } }],
            usage: { total_tokens: 1000 },
          }),
        },
      },
    }) as unknown as InstanceType<typeof OpenAI>);

    const config = makeBaseConfig({ maxSteps: 10, maxTokensPerRun: 500 });
    const trace = await createAgent(config).run('spend all tokens');

    expect(trace.outcome).toBe('budget_exceeded');
    expect(mockEngine.close).toHaveBeenCalled();
  });
});
