// SR-10: Per-domain rate limiting and robots.txt awareness.
// Both are disabled by default; opt in via SecurityConfig.

const FETCH_TIMEOUT_MS = 5_000;
const ROBOTS_CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes

// ── Rate limiter ──────────────────────────────────────────────────────────────

export interface RateLimiter {
  enforce: (hostname: string, minIntervalMs: number) => Promise<void>;
}

export function createRateLimiter(): RateLimiter {
  const lastMs = new Map<string, number>();

  return {
    async enforce(hostname: string, minIntervalMs: number): Promise<void> {
      const last = lastMs.get(hostname);
      const now = Date.now();
      if (last !== undefined) {
        const wait = minIntervalMs - (now - last);
        if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
      }
      lastMs.set(hostname, Date.now());
    },
  };
}

// ── robots.txt parser ─────────────────────────────────────────────────────────

interface RobotRule {
  allow: boolean;
  path: string;
}

export interface ParsedRobots {
  rules: RobotRule[];
  crawlDelayMs: number | null;
}

// Exported for unit testing.
export function parseRobotsForAgent(content: string, agentName: string): ParsedRobots {
  const agentLower = agentName.toLowerCase();

  type Group = { agents: string[]; rules: RobotRule[]; crawlDelayMs: number | null };
  const groups: Group[] = [];
  let current: Group | null = null;
  let currentHasDirectives = false;

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).toLowerCase().trim();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      if (current === null || currentHasDirectives) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
        currentHasDirectives = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current !== null) {
      if (field === 'disallow') {
        current.rules.push({ allow: false, path: value });
        currentHasDirectives = true;
      } else if (field === 'allow') {
        current.rules.push({ allow: true, path: value });
        currentHasDirectives = true;
      } else if (field === 'crawl-delay') {
        const delay = parseFloat(value);
        if (!isNaN(delay) && delay >= 0) {
          current.crawlDelayMs = Math.round(delay * 1_000);
          currentHasDirectives = true;
        }
      }
    }
  }

  const specificGroup = groups.find((g) => g.agents.includes(agentLower));
  const wildcardGroup = groups.find((g) => g.agents.includes('*'));
  const active = specificGroup ?? wildcardGroup ?? null;

  return {
    rules: active?.rules ?? [],
    crawlDelayMs: active?.crawlDelayMs ?? null,
  };
}

// Longest-match wins; Allow beats Disallow on equal length (standard robots.txt precedence).
export function isPathAllowed(path: string, rules: RobotRule[]): boolean {
  if (rules.length === 0) return true;

  let bestLen = -1;
  let bestAllow = true;

  for (const rule of rules) {
    // Empty Disallow means allow everything — skip
    if (!rule.allow && rule.path === '') continue;
    if (path.startsWith(rule.path)) {
      if (rule.path.length > bestLen || (rule.path.length === bestLen && rule.allow)) {
        bestLen = rule.path.length;
        bestAllow = rule.allow;
      }
    }
  }

  return bestLen === -1 ? true : bestAllow;
}

// ── robots.txt cache ──────────────────────────────────────────────────────────

interface CacheEntry extends ParsedRobots {
  fetchedAt: number;
}

export interface RobotsCache {
  isAllowed: (url: string) => Promise<boolean>;
  crawlDelayMs: (url: string) => Promise<number | null>;
}

export function createRobotsCache(agentName: string = 'Sepia'): RobotsCache {
  const cache = new Map<string, CacheEntry>();

  async function fetchParsed(hostname: string, protocol: string): Promise<ParsedRobots> {
    const cached = cache.get(hostname);
    if (cached !== undefined && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
      return cached;
    }

    let text = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(`${protocol}//${hostname}/robots.txt`, {
          signal: controller.signal,
        });
        if (resp.ok) text = await resp.text();
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Network error or timeout: fail open — treat as empty robots.txt
    }

    const parsed = parseRobotsForAgent(text, agentName);
    cache.set(hostname, { ...parsed, fetchedAt: Date.now() });
    return parsed;
  }

  async function getParsed(url: string): Promise<ParsedRobots | null> {
    try {
      const u = new URL(url);
      return await fetchParsed(u.hostname, u.protocol);
    } catch {
      return null;
    }
  }

  return {
    async isAllowed(url: string): Promise<boolean> {
      const result = await getParsed(url);
      if (result === null) return true;
      try {
        const u = new URL(url);
        return isPathAllowed(u.pathname + u.search, result.rules);
      } catch {
        return true;
      }
    },

    async crawlDelayMs(url: string): Promise<number | null> {
      const result = await getParsed(url);
      return result?.crawlDelayMs ?? null;
    },
  };
}
