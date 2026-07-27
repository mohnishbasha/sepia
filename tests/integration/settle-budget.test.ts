/**
 * AC-R8 — observation cost is bounded on pages that never go network-idle.
 *
 * settle() waited for 'networkidle' with an 8s timeout and swallowed the
 * rejection, so any page with long-polling, SSE, or a beacon loop paid the full
 * timeout on EVERY observation.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  const dir = new URL('../../fixtures/pages', import.meta.url).pathname;
  server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/slow')) {
      // Never respond: keeps an in-flight request open forever.
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(dir, 'busy.html'), 'utf-8'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('AC-R8 — bounded settle', () => {
  it('observes a never-idle page well inside the old 8s timeout', async () => {
    const engine = await createEngine({ headless: true, settleTimeoutMs: 1000 });
    try {
      await engine.open(`${baseUrl}/busy.html`);

      const started = Date.now();
      const view = await engine.observe();
      const elapsed = Date.now() - started;

      expect(view.nodes.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('still surfaces the page content it settled on', async () => {
    const engine = await createEngine({ headless: true, settleTimeoutMs: 1000 });
    try {
      await engine.open(`${baseUrl}/busy.html`);
      const view = await engine.observe();

      expect(view.nodes.some((n) => n.role === 'button' && n.name.includes('Continue'))).toBe(true);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('repeated observations stay cheap', async () => {
    const engine = await createEngine({ headless: true, settleTimeoutMs: 1000 });
    try {
      await engine.open(`${baseUrl}/busy.html`);

      const started = Date.now();
      await engine.observe();
      await engine.observe();
      await engine.observe();
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(6000);
    } finally {
      await engine.close();
    }
  }, 40000);
});
