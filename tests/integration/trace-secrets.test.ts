import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SepiaEngine } from '../../engine/index.js';
import type { CompactView, ActionResult } from '../../types/index.js';

vi.mock('../../engine/index.js', () => ({
  createEngine: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn(),
}));

function makeOkResult(): ActionResult {
  return { ok: true, confidence: 0.95 };
}

function makeView(): CompactView {
  return {
    url: 'https://example.com',
    title: 'Login',
    verbosity: 'standard',
    tokenCount: 30,
    timestampMs: Date.now(),
    nodes: [
      { handle: 'e1', role: 'textbox', name: 'Password', indent: 0, state: { enabled: true } },
      { handle: 'e2', role: 'button', name: 'Sign in', indent: 0, state: { enabled: true } },
    ],
  };
}

describe('AC-A4 / AC-P4 — trace secrets redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('step.secretsRedacted is true when type action contains a secret API key (AC-A4)', async () => {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');
    const OpenAI = (await import('openai')).default;

    // Use an sk- prefixed key so redactSecrets() detects it (matches /\bsk-[A-Za-z0-9\-_]{5,}/g)
    const SECRET = 'sk-Sup3rS3cr3tPass1';

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
        new: vi.fn().mockResolvedValue({ ok: true, tabId: '1' }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(createEngine).mockResolvedValue(mockEngine);

    const mockCreate = vi.fn()
      // Step 1: type the secret
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ action: 'type', handle: 'e1', text: SECRET }) } }],
        usage: { total_tokens: 100 },
      })
      // Step 2: done
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ action: 'done', summary: 'done' }) } }],
        usage: { total_tokens: 50 },
      });

    vi.mocked(OpenAI).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }) as unknown as InstanceType<typeof OpenAI>);

    const config = {
      model: { endpoint: 'https://api.anthropic.com/v1', model: 'test', apiKey: 'test', maxTokensPerStep: 10000 },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: { maxSteps: 10, maxTokensPerRun: 100_000, verbosity: 'standard' as const, retryBackoffMs: 0, maxRetries: 0, confidenceThreshold: 0.7 },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const trace = await createAgent(config).run('type password');

    // Find the type step
    const typeStep = trace.steps.find(s => s.action === 'type');
    expect(typeStep, 'type step should exist').toBeDefined();
    expect(typeStep!.secretsRedacted, 'secretsRedacted must be true when sk- prefixed secret is typed').toBe(true);
  });

  it('password string does not appear in JSON-serialized RunTrace (AC-P4)', async () => {
    const { createEngine } = await import('../../engine/index.js');
    const { createAgent } = await import('../../agent/index.js');
    const OpenAI = (await import('openai')).default;

    // StepTrace does not store the typed text field, so the secret must not appear in the trace JSON
    const SECRET = 'TopSecretPassword999';

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
        new: vi.fn().mockResolvedValue({ ok: true, tabId: '1' }),
        close: vi.fn().mockResolvedValue({ ok: true }),
        list: vi.fn().mockResolvedValue([]),
        switch: vi.fn().mockResolvedValue({ ok: true }),
      },
      close: vi.fn().mockResolvedValue(undefined),
    };

    vi.mocked(createEngine).mockResolvedValue(mockEngine);

    const mockCreate = vi.fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ action: 'type', handle: 'e1', text: SECRET }) } }],
        usage: { total_tokens: 80 },
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ action: 'done', summary: 'done' }) } }],
        usage: { total_tokens: 40 },
      });

    vi.mocked(OpenAI).mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    }) as unknown as InstanceType<typeof OpenAI>);

    const config = {
      model: { endpoint: 'https://api.anthropic.com/v1', model: 'test', apiKey: 'test', maxTokensPerStep: 10000 },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: { maxSteps: 10, maxTokensPerRun: 100_000, verbosity: 'standard' as const, retryBackoffMs: 0, maxRetries: 0, confidenceThreshold: 0.7 },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const trace = await createAgent(config).run('login');

    // Serialize the trace and verify the secret password is not in it.
    // StepTrace stores {stepN, action, handle, confidence, tokensUsed, latencyMs, result, secretsRedacted}
    // but NOT the typed text itself, so the secret must not appear.
    const traceJson = JSON.stringify(trace);
    expect(traceJson).not.toContain(SECRET);
  });
});
