/**
 * AC-I1 — /metrics accounts for authentication rejections.
 *
 * Issue #19: checkAuth() returned before totalRequests++, so a rejected
 * request was counted nowhere — three 401s left every counter unchanged and
 * credential stuffing against POST /run was invisible to an operator watching
 * /metrics. Rejections now increment a separate `totalUnauthorized` counter;
 * totalRequests/totalErrors keep their meaning (accepted requests, failures of
 * processed runs).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startServer } from '../../interfaces/http/index.js';

vi.mock('../../agent/index.js', () => ({ createAgent: vi.fn() }));

const KEY = 'test-server-key';

let server: Server | undefined;

async function listen(
  opts: Parameters<typeof startServer>[0] = {},
  withKey = true,
): Promise<string> {
  server = startServer(withKey ? { port: 0, serverApiKey: KEY, ...opts } : { port: 0, ...opts });
  await new Promise<void>((r) => server!.once('listening', () => r()));
  const addr = server!.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

async function post(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ goal: 'hi' }),
  });
}

interface Metrics {
  ok: boolean;
  inflight: number;
  maxConcurrent: number;
  totalRequests: number;
  totalErrors: number;
  totalUnauthorized: number;
}

async function metrics(url: string): Promise<Metrics> {
  const res = await fetch(`${url}/metrics`);
  expect(res.status).toBe(200);
  return (await res.json()) as Metrics;
}

beforeEach(async () => {
  const { createAgent } = await import('../../agent/index.js');
  vi.mocked(createAgent).mockReturnValue({
    run: vi.fn().mockResolvedValue({
      runId: 'r',
      goal: 'g',
      sessionId: 's',
      startMs: 0,
      endMs: 1,
      outcome: 'success' as const,
      totalSteps: 1,
      totalTokens: 1,
      steps: [],
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

describe('AC-I1 — auth rejections are counted on /metrics', () => {
  it('counts unauthenticated rejections in totalUnauthorized', async () => {
    const url = await listen();

    for (let i = 0; i < 3; i++) {
      const res = await post(url);
      expect(res.status).toBe(401);
    }

    const m = await metrics(url);
    expect(m.totalUnauthorized).toBe(3);
    expect(m.inflight).toBe(0);
  });

  it('counts wrong-key rejections in totalUnauthorized', async () => {
    const url = await listen();
    const badKey = 'x'.repeat(KEY.length);

    for (let i = 0; i < 3; i++) {
      const res = await post(url, { authorization: `Bearer ${badKey}` });
      expect(res.status).toBe(401);
    }

    const m = await metrics(url);
    expect(m.totalUnauthorized).toBe(3);
  });

  it('does not count rejected requests toward totalRequests or totalErrors', async () => {
    const url = await listen();

    // The reported repro: three 401s used to leave the counters unchanged —
    // which was the bug. They must now be visible in totalUnauthorized only.
    for (let i = 0; i < 3; i++) {
      await post(url, { authorization: 'Bearer wrong-key' });
    }
    let m = await metrics(url);
    expect(m.totalUnauthorized).toBe(3);
    expect(m.totalRequests).toBe(0);
    expect(m.totalErrors).toBe(0);

    // An accepted request keeps the existing counters' meaning...
    const ok = await post(url, { authorization: `Bearer ${KEY}` });
    expect(ok.status).toBe(200);
    m = await metrics(url);
    expect(m.totalRequests).toBe(1);
    expect(m.totalErrors).toBe(0);
    // ...and rejected attempts stay in their own bucket.
    expect(m.totalUnauthorized).toBe(3);
  });

  it('starts at zero and stays zero when auth is disabled', async () => {
    const url = await listen({ allowUnauthenticated: true }, false);

    const res = await post(url);
    expect(res.status).toBe(200);

    const m = await metrics(url);
    expect(m.totalUnauthorized).toBe(0);
    expect(m.totalRequests).toBe(1);
  });

  it('does not count accepted requests as unauthorized', async () => {
    const url = await listen();

    for (let i = 0; i < 2; i++) {
      const res = await post(url, { authorization: `Bearer ${KEY}` });
      expect(res.status).toBe(200);
    }

    const m = await metrics(url);
    expect(m.totalUnauthorized).toBe(0);
    expect(m.totalRequests).toBe(2);
  });
});
