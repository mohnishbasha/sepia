// SR-10: Per-domain rate limiting and robots.txt awareness unit tests
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseRobotsForAgent,
  isPathAllowed,
  createRateLimiter,
  createRobotsCache,
} from '../../security/index.js';

// ── parseRobotsForAgent ───────────────────────────────────────────────────────

describe('parseRobotsForAgent — wildcard agent', () => {
  it('returns empty rules for empty content', () => {
    const { rules, crawlDelayMs } = parseRobotsForAgent('', 'Sepia');
    expect(rules).toHaveLength(0);
    expect(crawlDelayMs).toBeNull();
  });

  it('picks up wildcard Disallow', () => {
    const content = 'User-agent: *\nDisallow: /private/';
    const { rules } = parseRobotsForAgent(content, 'Sepia');
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ allow: false, path: '/private/' });
  });

  it('picks up wildcard Allow', () => {
    const content = 'User-agent: *\nAllow: /public/\nDisallow: /';
    const { rules } = parseRobotsForAgent(content, 'Sepia');
    expect(rules).toContainEqual({ allow: true, path: '/public/' });
    expect(rules).toContainEqual({ allow: false, path: '/' });
  });

  it('parses Crawl-delay in seconds → ms', () => {
    const content = 'User-agent: *\nDisallow: /\nCrawl-delay: 2';
    const { crawlDelayMs } = parseRobotsForAgent(content, 'Sepia');
    expect(crawlDelayMs).toBe(2_000);
  });

  it('parses fractional Crawl-delay', () => {
    const content = 'User-agent: *\nCrawl-delay: 0.5';
    const { crawlDelayMs } = parseRobotsForAgent(content, 'Sepia');
    expect(crawlDelayMs).toBe(500);
  });

  it('ignores comment lines', () => {
    const content = '# comment\nUser-agent: *\n# another comment\nDisallow: /secret/';
    const { rules } = parseRobotsForAgent(content, 'Sepia');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.path).toBe('/secret/');
  });

  it('handles CRLF line endings', () => {
    const content = 'User-agent: *\r\nDisallow: /foo/\r\n';
    const { rules } = parseRobotsForAgent(content, 'Sepia');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.path).toBe('/foo/');
  });
});

describe('parseRobotsForAgent — agent specificity', () => {
  it('prefers named agent group over wildcard', () => {
    const content = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: Sepia',
      'Disallow: /admin/',
    ].join('\n');
    const { rules } = parseRobotsForAgent(content, 'Sepia');
    // Should use Sepia group only
    expect(rules).toHaveLength(1);
    expect(rules[0]?.path).toBe('/admin/');
  });

  it('agent matching is case-insensitive', () => {
    const content = 'User-agent: SEPIA\nDisallow: /secret/';
    const { rules } = parseRobotsForAgent(content, 'sepia');
    expect(rules).toHaveLength(1);
  });

  it('falls back to wildcard when named agent not present', () => {
    const content = 'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /blocked/';
    const { rules } = parseRobotsForAgent(content, 'Sepia');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.path).toBe('/blocked/');
  });

  it('returns empty rules when no matching group and no wildcard', () => {
    const content = 'User-agent: Googlebot\nDisallow: /';
    const { rules } = parseRobotsForAgent(content, 'Sepia');
    expect(rules).toHaveLength(0);
  });
});

// ── isPathAllowed ─────────────────────────────────────────────────────────────

describe('isPathAllowed', () => {
  it('allows everything when rules are empty', () => {
    expect(isPathAllowed('/anything', [])).toBe(true);
  });

  it('blocks path that matches Disallow', () => {
    const rules = [{ allow: false, path: '/private/' }];
    expect(isPathAllowed('/private/page.html', rules)).toBe(false);
  });

  it('allows path that does not match Disallow', () => {
    const rules = [{ allow: false, path: '/private/' }];
    expect(isPathAllowed('/public/page.html', rules)).toBe(true);
  });

  it('Allow beats Disallow on equal-length prefix', () => {
    const rules = [
      { allow: false, path: '/dir/' },
      { allow: true, path: '/dir/' },
    ];
    expect(isPathAllowed('/dir/file.html', rules)).toBe(true);
  });

  it('longer match wins over shorter match', () => {
    const rules = [
      { allow: false, path: '/' },
      { allow: true, path: '/public/' },
    ];
    expect(isPathAllowed('/public/page.html', rules)).toBe(true);
    expect(isPathAllowed('/private/page.html', rules)).toBe(false);
  });

  it('Disallow: (empty) means allow all', () => {
    const rules = [{ allow: false, path: '' }];
    expect(isPathAllowed('/anything', rules)).toBe(true);
  });

  it('Disallow: / blocks all paths', () => {
    const rules = [{ allow: false, path: '/' }];
    expect(isPathAllowed('/page.html', rules)).toBe(false);
    expect(isPathAllowed('/', rules)).toBe(false);
  });
});

// ── createRateLimiter ─────────────────────────────────────────────────────────

describe('createRateLimiter', () => {
  it('first call for a hostname returns immediately', async () => {
    const limiter = createRateLimiter();
    const before = Date.now();
    await limiter.enforce('example.com', 500);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(100);
  });

  it('second call within interval waits the remainder', async () => {
    const limiter = createRateLimiter();
    await limiter.enforce('example.com', 200);
    const before = Date.now();
    await limiter.enforce('example.com', 200);
    const elapsed = Date.now() - before;
    // Should have waited ~200ms (allow generous margin for CI runners)
    expect(elapsed).toBeGreaterThanOrEqual(150);
  });

  it('second call after interval has elapsed returns immediately', async () => {
    const limiter = createRateLimiter();
    await limiter.enforce('slow.com', 50);
    await new Promise<void>((r) => setTimeout(r, 100)); // wait out the interval
    const before = Date.now();
    await limiter.enforce('slow.com', 50);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(50);
  });

  it('tracks different hostnames independently', async () => {
    const limiter = createRateLimiter();
    await limiter.enforce('a.com', 300);
    // b.com has no prior call — should not wait
    const before = Date.now();
    await limiter.enforce('b.com', 300);
    const elapsed = Date.now() - before;
    expect(elapsed).toBeLessThan(100);
  });
});

// ── createRobotsCache ─────────────────────────────────────────────────────────

describe('createRobotsCache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(body: string, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        text: async () => body,
      }),
    );
  }

  it('allows URL when robots.txt permits it', async () => {
    mockFetch('User-agent: *\nDisallow: /private/');
    const cache = createRobotsCache();
    expect(await cache.isAllowed('https://example.com/public/page.html')).toBe(true);
  });

  it('blocks URL disallowed by robots.txt', async () => {
    mockFetch('User-agent: *\nDisallow: /private/');
    const cache = createRobotsCache();
    expect(await cache.isAllowed('https://example.com/private/data.json')).toBe(false);
  });

  it('allows all when robots.txt fetch fails (fail open)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    const cache = createRobotsCache();
    expect(await cache.isAllowed('https://unreachable.example/page')).toBe(true);
  });

  it('allows all when robots.txt returns non-200', async () => {
    mockFetch('', 404);
    const cache = createRobotsCache();
    expect(await cache.isAllowed('https://example.com/page')).toBe(true);
  });

  it('returns crawl-delay from robots.txt', async () => {
    mockFetch('User-agent: *\nCrawl-delay: 3');
    const cache = createRobotsCache();
    expect(await cache.crawlDelayMs('https://example.com/')).toBe(3_000);
  });

  it('returns null crawl-delay when not specified', async () => {
    mockFetch('User-agent: *\nDisallow: /');
    const cache = createRobotsCache();
    expect(await cache.crawlDelayMs('https://example.com/')).toBeNull();
  });

  it('caches per hostname — only one fetch per domain', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const cache = createRobotsCache();
    await cache.isAllowed('https://example.com/a');
    await cache.isAllowed('https://example.com/b');
    await cache.isAllowed('https://example.com/c');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses named agent over wildcard when specified', async () => {
    mockFetch(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: Sepia', 'Disallow: /restricted/'].join(
        '\n',
      ),
    );
    const cache = createRobotsCache('Sepia');
    // Sepia group only disallows /restricted/, not /
    expect(await cache.isAllowed('https://example.com/open/')).toBe(true);
    expect(await cache.isAllowed('https://example.com/restricted/data')).toBe(false);
  });
});
