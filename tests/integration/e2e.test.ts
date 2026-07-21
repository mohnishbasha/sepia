/**
 * AC-AG1 / AC-AG2 — E2E integration tests against local fixture pages.
 *
 * Spins up a node:http server serving fixtures/pages/*.html and runs a real
 * Playwright Chromium browser via createEngine().
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import type { CompactView } from '../../types/index.js';

// ── Local HTTP server shared by both describe blocks ──────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const file = req.url === '/form.html' ? 'form.html' : 'login.html';
    const content = readFileSync(
      join(new URL('../../fixtures/pages', import.meta.url).pathname, file),
      'utf-8',
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// ── AC-AG1 — login flow ───────────────────────────────────────────────────────

describe('AC-AG1 — login flow against fixture server', () => {
  it('engine types email+password and clicks Sign in; result is visible', async () => {
    const engine = await createEngine({ headless: true });
    try {
      // Open the login page
      const openResult = await engine.open(`${baseUrl}/login.html`);
      expect(openResult.ok).toBe(true);

      // Observe
      const view: CompactView = await engine.observe();
      expect(view.nodes.length).toBeGreaterThan(0);

      // Find handles by role+name
      const emailNode = view.nodes.find(
        (n) => n.role === 'textbox' && n.name.toLowerCase().includes('email'),
      );
      const passwordNode = view.nodes.find((n) => n.name.toLowerCase().includes('password'));
      const signInNode = view.nodes.find(
        (n) => n.role === 'button' && n.name.toLowerCase().includes('sign'),
      );

      expect(emailNode?.handle, 'email input must have a handle').toBeDefined();
      expect(signInNode?.handle, 'sign in button must have a handle').toBeDefined();

      // Type credentials
      const typeEmail = await engine.type(emailNode!.handle!, 'alice@example.com');
      expect(typeEmail.ok).toBe(true);

      if (passwordNode?.handle) {
        const typePwd = await engine.type(passwordNode.handle, 'secret123');
        expect(typePwd.ok).toBe(true);
      }

      // Click submit
      const clickResult = await engine.click(signInNode!.handle!);
      expect(clickResult.ok).toBe(true);

      // Re-observe — result should be visible
      const afterView: CompactView = await engine.observe();
      const resultNode = afterView.nodes.find(
        (n) =>
          n.name.toLowerCase().includes('logged in') || n.name.toLowerCase().includes('success'),
      );
      expect(resultNode, 'success message should appear after login').toBeDefined();
    } finally {
      await engine.close();
    }
  }, 30000);
});

// ── AC-AG2 — form fill ────────────────────────────────────────────────────────

describe('AC-AG2 — form fill against fixture server', () => {
  it('engine fills contact form and submits; result is visible', async () => {
    const engine = await createEngine({ headless: true });
    try {
      const openResult = await engine.open(`${baseUrl}/form.html`);
      expect(openResult.ok).toBe(true);

      const view: CompactView = await engine.observe();

      const nameNode = view.nodes.find(
        (n) => n.role === 'textbox' && n.name.toLowerCase().includes('name'),
      );
      const emailNode = view.nodes.find(
        (n) => n.role === 'textbox' && n.name.toLowerCase().includes('email'),
      );
      const messageNode = view.nodes.find((n) => n.name.toLowerCase().includes('message'));
      const submitNode = view.nodes.find(
        (n) => n.role === 'button' && n.name.toLowerCase().includes('submit'),
      );

      expect(nameNode?.handle, 'name input must have a handle').toBeDefined();
      expect(submitNode?.handle, 'submit button must have a handle').toBeDefined();

      if (nameNode?.handle) {
        const r = await engine.type(nameNode.handle, 'Alice Smith');
        expect(r.ok).toBe(true);
      }
      if (emailNode?.handle) {
        const r = await engine.type(emailNode.handle, 'alice@example.com');
        expect(r.ok).toBe(true);
      }
      if (messageNode?.handle) {
        const r = await engine.type(messageNode.handle, 'Hello, I need help.');
        expect(r.ok).toBe(true);
      }

      const clickResult = await engine.click(submitNode!.handle!);
      expect(clickResult.ok).toBe(true);

      const afterView: CompactView = await engine.observe();
      const resultNode = afterView.nodes.find(
        (n) =>
          n.name.toLowerCase().includes('sent') ||
          n.name.toLowerCase().includes('success') ||
          n.name.toLowerCase().includes('message sent'),
      );
      expect(resultNode, 'success message should appear after form submit').toBeDefined();
    } finally {
      await engine.close();
    }
  }, 30000);
});
