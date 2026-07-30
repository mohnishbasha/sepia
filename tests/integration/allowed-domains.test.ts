/**
 * SR-13 — `security.allowedDomains` actually restricts navigation (issue #14).
 *
 * The field existed in `SecurityConfig` and was accepted by the HTTP config
 * allowlist, but nothing read it. `engine.open()` validated the scheme and
 * nothing else. An operator who set it reasonably believed navigation was
 * restricted; the agent would follow any http(s) URL the model emitted,
 * including one injected through page content.
 *
 * A control that is believed and absent is worse than one that was never
 * offered, so this either had to work or be deleted.
 *
 * Enforcement is in two places on purpose. `open()` refuses up front so the
 * caller gets a distinct error code rather than a navigation failure — but
 * `open()` is not the only way to reach a page. A click on a link navigates too,
 * and an injected link is exactly the attack in the issue. So the allowlist is
 * also enforced at the request layer, where every main-frame document request
 * passes regardless of what caused it.
 */

import { createServer, type Server } from 'node:http';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createEngine } from '../../engine/index.js';
import { isDomainAllowed } from '../../security/index.js';

/** Two servers on 127.0.0.1 and localhost: same machine, different hostnames. */
let allowedServer: Server;
let blockedServer: Server;
let allowedUrl: string;
let blockedUrl: string;

function page(title: string, linkTo: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><a href="${linkTo}">Go elsewhere</a></body></html>`;
}

beforeAll(async () => {
  blockedServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('BLOCKED-SITE', '/'));
  });
  await new Promise<void>((r) => blockedServer.listen(0, '127.0.0.1', r));
  const blockedPort = (blockedServer.address() as { port: number }).port;
  // `localhost` and `127.0.0.1` resolve to the same server but are different
  // hostnames, which is exactly what an allowlist discriminates on.
  blockedUrl = `http://localhost:${blockedPort}`;

  allowedServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('ALLOWED-SITE', `${blockedUrl}/`));
  });
  await new Promise<void>((r) => allowedServer.listen(0, '127.0.0.1', r));
  allowedUrl = `http://127.0.0.1:${(allowedServer.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => allowedServer.close(() => r()));
  await new Promise<void>((r) => blockedServer.close(() => r()));
});

describe('SR-13 — host matching', () => {
  it('matches the domain itself', () => {
    expect(isDomainAllowed('example.com', ['example.com'])).toBe(true);
  });

  it('matches a subdomain', () => {
    expect(isDomainAllowed('www.example.com', ['example.com'])).toBe(true);
    expect(isDomainAllowed('a.b.example.com', ['example.com'])).toBe(true);
  });

  it('refuses a lookalike that merely ends with the same letters', () => {
    // The bug a naive endsWith() check produces.
    expect(isDomainAllowed('notexample.com', ['example.com'])).toBe(false);
    expect(isDomainAllowed('evil-example.com', ['example.com'])).toBe(false);
  });

  it('refuses a host that only has the allowed domain as a prefix', () => {
    expect(isDomainAllowed('example.com.attacker.test', ['example.com'])).toBe(false);
  });

  it('ignores case', () => {
    expect(isDomainAllowed('WWW.Example.COM', ['example.com'])).toBe(true);
  });

  it('accepts a leading wildcard as a way of writing the same thing', () => {
    expect(isDomainAllowed('www.example.com', ['*.example.com'])).toBe(true);
    expect(isDomainAllowed('example.com', ['*.example.com'])).toBe(true);
  });

  it('allows everything when no allowlist is configured', () => {
    expect(isDomainAllowed('anything.test', undefined)).toBe(true);
    expect(isDomainAllowed('anything.test', [])).toBe(true);
  });
});

describe('SR-13 — open() refuses a disallowed host', () => {
  it('returns DOMAIN_NOT_ALLOWED instead of navigating', async () => {
    const engine = await createEngine({
      headless: true,
      security: { allowedDomains: ['127.0.0.1'] },
    });
    try {
      const result = await engine.open(`${blockedUrl}/`);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('DOMAIN_NOT_ALLOWED');

      // And nothing was loaded.
      const view = await engine.observe();
      expect(view.nodes.some((n) => n.name.includes('BLOCKED-SITE'))).toBe(false);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('still opens a host on the allowlist', async () => {
    const engine = await createEngine({
      headless: true,
      security: { allowedDomains: ['127.0.0.1'] },
    });
    try {
      const result = await engine.open(`${allowedUrl}/`);

      expect(result.ok).toBe(true);
      const view = await engine.observe();
      expect(view.nodes.some((n) => n.name.includes('ALLOWED-SITE'))).toBe(true);
    } finally {
      await engine.close();
    }
  }, 30000);

  it('opens anything when no allowlist is set', async () => {
    const engine = await createEngine({ headless: true });
    try {
      expect((await engine.open(`${blockedUrl}/`)).ok).toBe(true);
    } finally {
      await engine.close();
    }
  }, 30000);
});

describe('SR-13 — a link cannot walk out of the allowlist', () => {
  it('does not follow a link to a disallowed host', async () => {
    const engine = await createEngine({
      headless: true,
      security: { allowedDomains: ['127.0.0.1'] },
    });
    try {
      await engine.open(`${allowedUrl}/`);
      const link = (await engine.observe()).nodes.find((n) => n.role === 'link');
      expect(link?.handle).toBeDefined();

      await engine.click(link!.handle!);

      // Whether the click reports ok is not the point — the page must not have
      // become the blocked site. An injected link is the attack in the issue.
      const after = await engine.observe();
      expect(after.url.startsWith(blockedUrl)).toBe(false);
      expect(after.nodes.some((n) => n.name.includes('BLOCKED-SITE'))).toBe(false);
    } finally {
      await engine.close();
    }
  }, 30000);
});
