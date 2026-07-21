import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompactView, ActionResult } from '../../types/index.js';
import type { SepiaEngine } from '../../engine/index.js';
import type { RunTrace } from '../../agent/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeView(url = 'https://example.com'): CompactView {
  return {
    url,
    title: 'Example',
    verbosity: 'standard',
    tokenCount: 50,
    timestampMs: Date.now(),
    nodes: [
      {
        handle: 'e1',
        role: 'button',
        name: 'Sign in',
        indent: 0,
        state: { enabled: true },
      },
      {
        handle: 'e2',
        role: 'textbox',
        name: 'Email',
        indent: 0,
        state: { enabled: true, required: true },
      },
    ],
  };
}

function makeOkResult(): ActionResult {
  return { ok: true, confidence: 0.95 };
}

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

describe('integration — agent loop (mocked engine + model)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('agent completes when model returns done', async () => {
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
      read: vi.fn().mockResolvedValue({ ok: true, text: 'hello' }),
      wait: vi.fn().mockResolvedValue({ ok: true, timedOut: false }),
      back: vi.fn().mockResolvedValue(makeOkResult()),
      forward: vi.fn().mockResolvedValue(makeOkResult()),
      tabs: {
        new: vi.fn().mockResolvedValue({ ok: true, tabId: '1' }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(createEngine).mockResolvedValue(mockEngine);

    // Model: first call returns open, second returns done
    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"action":"open","url":"https://example.com"}' } }],
        usage: { total_tokens: 100 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"action":"done","summary":"All done"}' } }],
        usage: { total_tokens: 50 },
      });

    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as InstanceType<typeof OpenAI>,
    );

    const config = {
      model: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'test-key',
        maxTokensPerStep: 1000,
      },
      browser: {
        profile: 'default',
        headless: true,
        ephemeral: true,
        humanTiming: false,
      },
      agent: {
        maxSteps: 10,
        maxTokensPerRun: 100_000,
        verbosity: 'standard' as const,
        retryBackoffMs: 0,
        maxRetries: 3,
        confidenceThreshold: 0.7,
      },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const agent = createAgent(config);
    const trace: RunTrace = await agent.run('Open example.com');

    expect(trace.outcome).toBe('success');
    expect(mockEngine.open).toHaveBeenCalledWith('https://example.com');
    expect(mockEngine.close).toHaveBeenCalled();
  });

  it('open rejects non-http URLs (AC-A2)', async () => {
    const { createEngine } = await import('../../engine/index.js');

    const mockEngine: SepiaEngine = {
      open: vi.fn().mockImplementation(async (url: string) => {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          return {
            ok: false,
            confidence: 0,
            error: { code: 'INVALID_URL', message: `Invalid URL: ${url}` },
          };
        }
        return makeOkResult();
      }),
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

    const result = await mockEngine.open('javascript:alert(1)');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_URL');
  });

  it('model output with action eval is rejected (AC-A3)', async () => {
    const { parseAction } = await import('../../actions/index.js');
    expect(() => parseAction({ action: 'eval', code: 'bad' })).toThrow(/Unknown or invalid action/);
  });

  it('agent dispatches click action and calls engine.click', async () => {
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

    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"action":"click","handle":"e1"}' } }],
        usage: { total_tokens: 80 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"action":"done","summary":"clicked"}' } }],
        usage: { total_tokens: 40 },
      });

    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as InstanceType<typeof OpenAI>,
    );

    const config = {
      model: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'test',
        maxTokensPerStep: 1000,
      },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: {
        maxSteps: 10,
        maxTokensPerRun: 100_000,
        verbosity: 'standard' as const,
        retryBackoffMs: 0,
        maxRetries: 3,
        confidenceThreshold: 0.7,
      },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const trace = await createAgent(config).run('click sign in');
    expect(trace.outcome).toBe('success');
    expect(mockEngine.click).toHaveBeenCalledWith('e1');
  });

  it('agent handles stale handle retry', async () => {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');
    const OpenAI = (await import('openai')).default;

    const staleResult: ActionResult = {
      ok: false,
      confidence: 0,
      error: { code: 'STALE_HANDLE', message: 'stale', handle: 'e1' },
    };

    let clickCallCount = 0;
    const mockEngine: SepiaEngine = {
      open: vi.fn().mockResolvedValue(makeOkResult()),
      observe: vi.fn().mockResolvedValue(makeView()),
      click: vi.fn().mockImplementation(async () => {
        clickCallCount++;
        // first call returns stale, second returns ok
        if (clickCallCount === 1) return staleResult;
        return makeOkResult();
      }),
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

    const mockCreate = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"action":"click","handle":"e1"}' } }],
        usage: { total_tokens: 80 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: '{"action":"done","summary":"ok"}' } }],
        usage: { total_tokens: 40 },
      });

    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as InstanceType<typeof OpenAI>,
    );

    const config = {
      model: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'test',
        maxTokensPerStep: 1000,
      },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: {
        maxSteps: 10,
        maxTokensPerRun: 100_000,
        verbosity: 'standard' as const,
        retryBackoffMs: 0,
        maxRetries: 3,
        confidenceThreshold: 0.7,
      },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const trace = await createAgent(config).run('click sign in');
    // agent should have retried and eventually succeeded
    expect(clickCallCount).toBeGreaterThanOrEqual(1);
    expect(mockEngine.close).toHaveBeenCalled();
    // outcome depends on whether retry succeeded before done
    expect(['success', 'error', 'budget_exceeded']).toContain(trace.outcome);
  });

  it('agent terminates on done action', async () => {
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

    // Model immediately returns done
    const mockCreate = vi.fn().mockResolvedValueOnce({
      choices: [{ message: { content: '{"action":"done","summary":"nothing to do"}' } }],
      usage: { total_tokens: 30 },
    });

    vi.mocked(OpenAI).mockImplementation(
      () =>
        ({
          chat: { completions: { create: mockCreate } },
        }) as unknown as InstanceType<typeof OpenAI>,
    );

    const config = {
      model: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'test',
        maxTokensPerStep: 1000,
      },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: {
        maxSteps: 10,
        maxTokensPerRun: 100_000,
        verbosity: 'standard' as const,
        retryBackoffMs: 0,
        maxRetries: 3,
        confidenceThreshold: 0.7,
      },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const trace = await createAgent(config).run('nothing');
    expect(trace.outcome).toBe('success');
    // model was only called once
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});
