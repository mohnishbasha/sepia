/**
 * AC-A6 — screenshot capture.
 *
 * A browser agent that cannot show what it was looking at is very hard to debug
 * when a run goes wrong. Screenshots are an operator artefact: they are written
 * to disk or returned to the caller, never fed into the model context.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createEngine } from '../../engine/index.js';
import { parseAction, dispatch, ACTION_NAMES } from '../../actions/index.js';
import { makeMockEngine } from '../helpers/agent-harness.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let workDir: string;

beforeAll(async () => {
  const dir = new URL('../../fixtures/pages', import.meta.url).pathname;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(join(dir, 'login.html'), 'utf-8'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  workDir = mkdtempSync(join(tmpdir(), 'sepia-shot-'));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(workDir, { recursive: true, force: true });
});

describe('AC-A6 — screenshot capture', () => {
  it('writes a PNG to the requested path', async () => {
    const engine = await createEngine({ headless: true });
    const path = join(workDir, 'shot.png');
    try {
      await engine.open(`${baseUrl}/login.html`);
      const result = await engine.screenshot({ path });

      expect(result.ok).toBe(true);
      expect(result.path).toBe(path);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).subarray(0, 4)).toEqual(PNG_MAGIC);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('returns base64 PNG data when no path is given', async () => {
    const engine = await createEngine({ headless: true });
    try {
      await engine.open(`${baseUrl}/login.html`);
      const result = await engine.screenshot();

      expect(result.ok).toBe(true);
      expect(result.base64).toBeDefined();
      expect(Buffer.from(result.base64!, 'base64').subarray(0, 4)).toEqual(PNG_MAGIC);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('captures a taller image with fullPage', async () => {
    const engine = await createEngine({ headless: true });
    try {
      await engine.open(`${baseUrl}/login.html`);
      const viewport = await engine.screenshot();
      const full = await engine.screenshot({ fullPage: true });

      expect(viewport.ok && full.ok).toBe(true);
      expect(full.base64).toBeDefined();
    } finally {
      await engine.close();
    }
  }, 30000);
});

describe('AC-A6 — screenshot is a first-class action', () => {
  it('is part of the typed action enum', () => {
    expect(ACTION_NAMES.has('screenshot')).toBe(true);
  });

  it('parses without requiring a handle', () => {
    expect(parseAction({ action: 'screenshot' })).toMatchObject({ action: 'screenshot' });
  });

  it('rejects a non-boolean fullPage', () => {
    expect(() => parseAction({ action: 'screenshot', fullPage: 'yes' })).toThrow(/fullPage/i);
  });

  it('dispatches to engine.screenshot', async () => {
    const engine = makeMockEngine();
    await dispatch(parseAction({ action: 'screenshot', path: '/tmp/x.png' }), engine);
    expect(vi.mocked(engine.screenshot)).toHaveBeenCalled();
  });
});
