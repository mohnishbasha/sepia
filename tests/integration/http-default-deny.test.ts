/**
 * SR-14 — authentication is default-deny, decided once (CodeQL js/user-controlled-bypass).
 *
 * Auth used to be opt-in per branch: `POST /run` called `checkAuth()` inside its
 * own route, and `/health` and `/metrics` simply never did. That makes the
 * security decision a property of where someone remembered to put a call, so a
 * route added later is public by default — open by omission rather than by
 * choice. CodeQL flagged the shape as a user-controlled value guarding a
 * sensitive action, and it was right about the structure even though no
 * concrete bypass existed.
 *
 * The decision now happens once, before dispatch, against an explicit list of
 * routes that are meant to be public. A new route is authenticated because
 * nobody listed it, which is the correct direction for the mistake to fall.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startServer } from '../../interfaces/http/index.js';

vi.mock('../../agent/index.js', () => ({ createAgent: vi.fn() }));

const KEY = 'test-server-key';
let server: Server | undefined;

async function listen(withKey = true): Promise<string> {
  server = startServer(
    withKey ? { port: 0, serverApiKey: KEY } : { port: 0, allowUnauthenticated: true },
  );
  await new Promise<void>((r) => server!.once('listening', () => r()));
  const addr = server!.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
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
      outcome: 'success',
      totalSteps: 0,
      totalTokens: 0,
      steps: [],
    }),
  });
});

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('SR-14 — unlisted routes require authentication', () => {
  it('refuses an unknown route without credentials', async () => {
    const url = await listen();

    const res = await fetch(`${url}/admin`);

    // 401 rather than 404: an unauthenticated caller should not learn which
    // routes exist, and a future route lands here rather than wide open.
    expect(res.status).toBe(401);
  });

  it('serves an unknown route as 404 once authenticated', async () => {
    const url = await listen();

    const res = await fetch(`${url}/admin`, { headers: { Authorization: `Bearer ${KEY}` } });

    expect(res.status).toBe(404);
  });

  it('still refuses POST /run without credentials', async () => {
    const url = await listen();

    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'hi' }),
    });

    expect(res.status).toBe(401);
  });

  it('accepts POST /run with credentials', async () => {
    const url = await listen();

    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ goal: 'hi' }),
    });

    expect(res.status).toBe(200);
  });
});

describe('SR-14 — the public list stays public', () => {
  it('serves /health and / without credentials', async () => {
    const url = await listen();

    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/`)).status).toBe(200);
  });

  it('serves /metrics without credentials', async () => {
    // Kept public deliberately so probes and scrapers keep working; the point
    // of the change is that this is now a listed decision, not an omission.
    const url = await listen();

    expect((await fetch(`${url}/metrics`)).status).toBe(200);
  });

  it('counts a rejected unlisted route as unauthorized', async () => {
    const url = await listen();

    await fetch(`${url}/admin`);
    const m = (await (await fetch(`${url}/metrics`)).json()) as { totalUnauthorized: number };

    expect(m.totalUnauthorized).toBe(1);
  });
});

describe('SR-14 — an unauthenticated server is unchanged', () => {
  it('serves every route when no key is configured', async () => {
    const url = await listen(false);

    expect((await fetch(`${url}/health`)).status).toBe(200);
    expect((await fetch(`${url}/admin`)).status).toBe(404);
    const res = await fetch(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'hi' }),
    });
    expect(res.status).toBe(200);
  });
});
