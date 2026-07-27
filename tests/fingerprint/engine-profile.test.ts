/**
 * AC-F6 — the configured fingerprint profile is actually applied to sessions.
 *
 * The fingerprint module existed and was unit-tested, but nothing in the
 * production path ever called getPreset() or validateAndStart(): sessions
 * launched with the stock Playwright defaults and `navigator.webdriver === true`.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import type { CompactView } from '../../types/index.js';

const PROFILE = 'chrome-149-linux-x86_64';

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  const dir = new URL('../../fixtures/pages', import.meta.url).pathname;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(dir, 'probe.html'), 'utf-8'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function probe(view: CompactView, prefix: string): string {
  return view.nodes.map((n) => n.name).find((name) => name.startsWith(prefix)) ?? '';
}

async function probeWith(opts: Parameters<typeof createEngine>[0]): Promise<CompactView> {
  const engine = await createEngine(opts);
  try {
    await engine.open(`${baseUrl}/probe.html`);
    return await engine.observe();
  } finally {
    await engine.close();
  }
}

describe('AC-F6 — profile applied to the session', () => {
  it('masks navigator.webdriver', async () => {
    const view = await probeWith({ headless: true, profile: PROFILE });
    expect(probe(view, 'webdriver=')).toBe('webdriver=undefined');
  }, 30000);

  it('exposes a window.chrome runtime object', async () => {
    const view = await probeWith({ headless: true, profile: PROFILE });
    expect(probe(view, 'chrome=')).toBe('chrome=true');
  }, 30000);

  it('reports the user agent declared by the preset', async () => {
    const view = await probeWith({ headless: true, profile: PROFILE });
    expect(probe(view, 'ua=')).toContain('Chrome/149');
  }, 30000);

  it('keeps navigator.vendor coherent with the preset', async () => {
    const view = await probeWith({ headless: true, profile: PROFILE });
    expect(probe(view, 'vendor=')).toBe('vendor=Google Inc.');
  }, 30000);
});

describe('AC-F6 — fail closed on an unusable profile', () => {
  it('refuses to start with an unknown preset id', async () => {
    await expect(
      createEngine({ headless: true, profile: 'chrome-999-does-not-exist' }),
    ).rejects.toThrow(/Unknown fingerprint preset/i);
  }, 30000);
});
