/**
 * SR-11 — HTTP server hardening.
 *
 * The server accepted an arbitrary `config` object per request and merged it
 * into the run config. That exposed `browser.executablePath` (launch any local
 * binary) and `model.endpoint` (redirect scraped page content to an attacker).
 * Auth was off unless a key happened to be set, the body was read unbounded,
 * and the concurrency check was separated from its increment by an `await`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { sanitizeRunConfig, startServer } from '../../interfaces/http/index.js';

vi.mock('../../agent/index.js', () => ({ createAgent: vi.fn() }));

const KEY = 'test-server-key';

let server: Server | undefined;

async function listen(opts: Parameters<typeof startServer>[0] = {}): Promise<string> {
  server = startServer({ port: 0, serverApiKey: KEY, ...opts });
  await new Promise<void>((r) => server!.once('listening', () => r()));
  const addr = server!.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(async () => {
  const { createAgent } = await import('../../agent/index.js');
  vi.mocked(createAgent).mockReturnValue({
    run: vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return {
        runId: 'r',
        goal: 'g',
        sessionId: 's',
        startMs: 0,
        endMs: 1,
        outcome: 'success' as const,
        totalSteps: 1,
        totalTokens: 1,
        steps: [],
      };
    }),
  });
});

afterEach(async () => {
  if (server !== undefined) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  vi.clearAllMocks();
});

describe('SR-11 — per-request config is allowlisted', () => {
  it('drops browser.executablePath', () => {
    const clean = sanitizeRunConfig({ browser: { executablePath: '/bin/sh' } });
    expect(clean.browser?.executablePath).toBeUndefined();
  });

  it('drops model.endpoint', () => {
    const clean = sanitizeRunConfig({ model: { endpoint: 'https://attacker.example' } });
    expect(clean.model?.endpoint).toBeUndefined();
  });

  it('drops model.apiKey', () => {
    const clean = sanitizeRunConfig({ model: { apiKey: 'sk-stolen' } });
    expect(clean.model?.apiKey).toBeUndefined();
  });

  it('drops browser.profileStorePath', () => {
    const clean = sanitizeRunConfig({ browser: { profileStorePath: '/etc' } });
    expect(clean.browser?.profileStorePath).toBeUndefined();
  });

  it('keeps benign agent tuning', () => {
    const clean = sanitizeRunConfig({ agent: { maxSteps: 3, verbosity: 'minimal' } });
    expect(clean.agent?.maxSteps).toBe(3);
    expect(clean.agent?.verbosity).toBe('minimal');
  });

  it('ignores non-object input', () => {
    expect(sanitizeRunConfig('nope')).toEqual({});
    expect(sanitizeRunConfig(null)).toEqual({});
  });
});

describe('SR-11 — authentication', () => {
  it('rejects an unauthenticated run', async () => {
    const url = await listen();
    const res = await post(url, { goal: 'hi' });
    expect(res.status).toBe(401);
  });

  it('accepts a correctly authenticated run', async () => {
    const url = await listen();
    const res = await post(url, { goal: 'hi' }, { authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong key of identical length', async () => {
    const url = await listen();
    const res = await post(
      url,
      { goal: 'hi' },
      { authorization: `Bearer ${'x'.repeat(KEY.length)}` },
    );
    expect(res.status).toBe(401);
  });

  it('refuses to start with no key unless explicitly opted out', () => {
    expect(() => startServer({ port: 0 })).toThrow(
      /allowUnauthenticated|SEPIA_ALLOW_UNAUTHENTICATED/i,
    );
  });
});

describe('SR-11 — request body limit', () => {
  it('rejects an oversized body with 413', async () => {
    const url = await listen({ maxBodyBytes: 1024 });
    const huge = JSON.stringify({ goal: 'x'.repeat(5000) });
    const res = await post(url, huge, { authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(413);
  });

  it('still accepts a body under the limit', async () => {
    const url = await listen({ maxBodyBytes: 1024 });
    const res = await post(url, { goal: 'small' }, { authorization: `Bearer ${KEY}` });
    expect(res.status).toBe(200);
  });
});

describe('SR-11 — concurrency cap is not racy', () => {
  it('never runs more than maxConcurrent agents simultaneously', async () => {
    // Count agents actually in flight. Total completions may exceed the cap
    // over the life of the test as slots free up; what must never happen is
    // more than `maxConcurrent` running at the same instant.
    let running = 0;
    let peak = 0;

    const { createAgent } = await import('../../agent/index.js');
    vi.mocked(createAgent).mockReturnValue({
      run: vi.fn().mockImplementation(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 80));
        running--;
        return {
          runId: 'r',
          goal: 'g',
          sessionId: 's',
          startMs: 0,
          endMs: 1,
          outcome: 'success' as const,
          totalSteps: 1,
          totalTokens: 1,
          steps: [],
        };
      }),
    });

    const url = await listen({ maxConcurrent: 2 });

    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        post(url, { goal: 'hi' }, { authorization: `Bearer ${KEY}` }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
    // Every request is answered, either run or shed.
    expect(responses.every((r) => r.status === 200 || r.status === 503)).toBe(true);
    expect(responses).toHaveLength(12);
  }, 20000);
});
