/**
 * AC-H1 — browser startup is amortised, without sharing anything else (#13).
 *
 * `POST /run` launched a Chromium and closed it in a `finally`, so every
 * request paid full process startup and throughput was bounded by launches
 * rather than by the model.
 *
 * What is pooled is the process. Each borrower still builds its own
 * `BrowserContext` — the thing that holds cookies, storage and cache — so
 * sessions stay as isolated as when each had its own process. Pooling the
 * context instead would save a little more and leak everything that matters,
 * which is why the isolation test below is the important one.
 */

import { describe, it, expect } from 'vitest';
import { createBrowserPool, createEngine } from '../../engine/index.js';

describe('AC-H1 — the pool reuses processes', () => {
  it('hands back the same browser once it is released', async () => {
    const pool = createBrowserPool({ maxSize: 2 });
    try {
      const first = await pool.acquire();
      pool.release(first);
      const second = await pool.acquire();

      expect(second).toBe(first);
      expect(pool.size()).toBe(1);
    } finally {
      await pool.close();
    }
  }, 60000);

  it('launches a second process only when the first is still out', async () => {
    const pool = createBrowserPool({ maxSize: 2 });
    try {
      const a = await pool.acquire();
      const b = await pool.acquire();

      expect(b).not.toBe(a);
      expect(pool.size()).toBe(2);
    } finally {
      await pool.close();
    }
  }, 60000);

  it('does not keep more idle processes than its ceiling', async () => {
    const pool = createBrowserPool({ maxSize: 1 });
    try {
      const a = await pool.acquire();
      const b = await pool.acquire();
      pool.release(a);
      pool.release(b);

      // One is kept warm; the other is closed rather than left lying around for
      // the rest of the server's life.
      expect(pool.size()).toBe(1);
    } finally {
      await pool.close();
    }
  }, 60000);

  it('closes everything it holds', async () => {
    const pool = createBrowserPool({ maxSize: 2 });
    const a = await pool.acquire();
    pool.release(a);

    await pool.close();

    expect(a.isConnected()).toBe(false);
    expect(pool.size()).toBe(0);
  }, 60000);

  it('refuses to hand out a browser after closing', async () => {
    const pool = createBrowserPool({ maxSize: 1 });
    await pool.close();

    await expect(pool.acquire()).rejects.toThrow(/closed/i);
  }, 60000);
});

describe('AC-H1 — borrowing shares no session state', () => {
  it('does not carry cookies from one borrower to the next', async () => {
    const pool = createBrowserPool({ maxSize: 1 });
    try {
      const browser = await pool.acquire();

      const first = await createEngine({ headless: true, browser });
      await first.open('https://example.com');
      // Set a cookie in the first session's context.
      const ctxA = browser.contexts()[browser.contexts().length - 1]!;
      await ctxA.addCookies([
        { name: 'sepia_probe', value: 'first-session', url: 'https://example.com' },
      ]);
      expect((await ctxA.cookies('https://example.com')).length).toBe(1);
      await first.close();

      const second = await createEngine({ headless: true, browser });
      const ctxB = browser.contexts()[browser.contexts().length - 1]!;
      const carried = await ctxB.cookies('https://example.com');
      await second.close();

      expect(carried).toEqual([]);
    } finally {
      await pool.close();
    }
  }, 90000);

  it('leaves the pooled browser alive when a borrower closes', async () => {
    const pool = createBrowserPool({ maxSize: 1 });
    try {
      const browser = await pool.acquire();
      const engine = await createEngine({ headless: true, browser });

      await engine.close();

      // Closing a borrowed engine must dispose its context, not the process the
      // pool still owns.
      expect(browser.isConnected()).toBe(true);
    } finally {
      await pool.close();
    }
  }, 60000);
});
