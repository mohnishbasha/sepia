/**
 * AC-A8 — a decided plan executes without a model call per step (issue #29).
 *
 * Measured on a 10-field registration form: 12 steps, 13 model calls, 24,023
 * tokens, prompt growing 16.7x. By call two the model had already decided every
 * value — they were in the goal — and then spent eleven round trips transcribing
 * its own prior intent against a page that had not changed.
 *
 * The replay token is the handle, never a selector: a plan is expressible in
 * exactly the vocabulary the model already has, and nothing about the DOM has to
 * cross the boundary to make replay work.
 *
 * What is deliberately NOT saved is observation. Every step still goes through
 * `gate()`, which re-observes and re-resolves, so a page that shifts mid-batch
 * fails closed on the affected step instead of plowing on. Batching removes
 * model round trips, not the safety they were paying for.
 */

import { createServer } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import { dispatchBatch, parseBatch, MAX_BATCH_STEPS } from '../../actions/index.js';
import type { SepiaEngine } from '../../engine/index.js';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Register</title></head>
<body>
  <h1>Register</h1>
  <form onsubmit="event.preventDefault();document.getElementById('done').textContent='SUBMITTED'">
    <label for="first">First name</label><input id="first" />
    <label for="last">Last name</label><input id="last" />
    <label for="email">Email</label><input id="email" />
    <label for="terms">Accept terms</label><input type="checkbox" id="terms" />
    <button type="submit">Create account</button>
  </form>
  <h2 id="done">pending</h2>
</body></html>`;

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function withEngine<T>(fn: (e: SepiaEngine) => Promise<T>): Promise<T> {
  const engine = await createEngine({ headless: true });
  try {
    await engine.open(`${baseUrl}/`);
    return await fn(engine);
  } finally {
    await engine.close();
  }
}

/** Handle of the textbox whose accessible name matches, from a fresh observation. */
async function handles(engine: SepiaEngine): Promise<Record<string, string>> {
  const view = await engine.observe();
  const out: Record<string, string> = {};
  for (const node of view.nodes) {
    if (node.handle !== undefined && node.name !== '') out[node.name] = node.handle;
  }
  return out;
}

describe('AC-A8 — a batch executes every step', () => {
  it('fills a form and submits it in one call', async () => {
    const { result, submitted } = await withEngine(async (e) => {
      const h = await handles(e);
      const batch = await dispatchBatch(
        [
          { action: 'type', handle: h['First name']!, text: 'Alice' },
          { action: 'type', handle: h['Last name']!, text: 'Smith' },
          { action: 'type', handle: h['Email']!, text: 'alice@example.com' },
          { action: 'check', handle: h['Accept terms']!, checked: true },
          { action: 'click', handle: h['Create account']! },
        ],
        e,
      );
      const view = await e.observe({ verbosity: 'full' });
      return { result: batch, submitted: view.nodes.some((n) => n.name.includes('SUBMITTED')) };
    });

    expect(result.ok).toBe(true);
    expect(result.completed).toBe(5);
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(submitted).toBe(true);
  }, 40000);

  it('reports each step with its index and action', async () => {
    const result = await withEngine(async (e) => {
      const h = await handles(e);
      return dispatchBatch(
        [
          { action: 'type', handle: h['First name']!, text: 'Alice' },
          { action: 'click', handle: h['Create account']! },
        ],
        e,
      );
    });

    expect(result.results.map((r) => r.step)).toEqual([0, 1]);
    expect(result.results.map((r) => r.action)).toEqual(['type', 'click']);
  }, 40000);
});

describe('AC-A8 — a batch fails closed', () => {
  it('stops at the first failing step and does not run the rest', async () => {
    const result = await withEngine(async (e) => {
      const h = await handles(e);
      return dispatchBatch(
        [
          { action: 'type', handle: h['First name']!, text: 'Alice' },
          // A handle that was never issued: the gate refuses it.
          { action: 'type', handle: 'e9999', text: 'nobody' },
          { action: 'click', handle: h['Create account']! },
        ],
        e,
      );
    });

    expect(result.ok).toBe(false);
    expect(result.completed).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results[1]?.error?.code).toBe('STALE_HANDLE');
  }, 40000);

  it('does not submit the form when an earlier step failed', async () => {
    const submitted = await withEngine(async (e) => {
      const h = await handles(e);
      await dispatchBatch(
        [
          { action: 'type', handle: 'e9999', text: 'nobody' },
          { action: 'click', handle: h['Create account']! },
        ],
        e,
      );
      const view = await e.observe({ verbosity: 'full' });
      return view.nodes.some((n) => n.name.includes('SUBMITTED'));
    });

    expect(submitted).toBe(false);
  }, 40000);

  it('runs the remaining steps when the caller opts into continuing', async () => {
    const result = await withEngine(async (e) => {
      const h = await handles(e);
      return dispatchBatch(
        [
          { action: 'type', handle: 'e9999', text: 'nobody' },
          { action: 'type', handle: h['Last name']!, text: 'Smith' },
        ],
        e,
        { continueOnError: true },
      );
    });

    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[1]?.ok).toBe(true);
  }, 40000);
});

describe('AC-A8 — the whole plan is validated before anything runs', () => {
  it('rejects a plan containing a malformed step', () => {
    expect(() => parseBatch([{ action: 'click', handle: 'e1' }, { action: 'click' }])).toThrow(
      /step 1/,
    );
  });

  it('rejects an unknown action inside a plan', () => {
    expect(() => parseBatch([{ action: 'sudo' }])).toThrow(/step 0/);
  });

  it('rejects a plan that is not an array', () => {
    expect(() => parseBatch({ action: 'click', handle: 'e1' })).toThrow(/array/i);
  });

  it('rejects an empty plan rather than silently succeeding', () => {
    expect(() => parseBatch([])).toThrow(/at least one/i);
  });

  it('refuses a plan longer than the step cap', () => {
    const long = Array.from({ length: MAX_BATCH_STEPS + 1 }, () => ({
      action: 'click',
      handle: 'e1',
    }));

    expect(() => parseBatch(long)).toThrow(new RegExp(String(MAX_BATCH_STEPS)));
  });

  it('accepts a plan exactly at the cap', () => {
    const atCap = Array.from({ length: MAX_BATCH_STEPS }, () => ({
      action: 'click',
      handle: 'e1',
    }));

    expect(parseBatch(atCap)).toHaveLength(MAX_BATCH_STEPS);
  });
});
