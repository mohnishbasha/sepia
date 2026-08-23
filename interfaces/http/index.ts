import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createAgent } from '../../agent/index.js';
import { createBrowserPool } from '../../engine/index.js';
import { mergeConfig } from '../../config/index.js';
import type { SepiaConfig } from '../../config/index.js';
import type { RunTrace } from '../../agent/index.js';

const DEFAULT_MAX_BODY_BYTES = 1_000_000;

export interface ServeOptions {
  port?: number;
  maxConcurrent?: number;
  config?: Partial<SepiaConfig>;
  /** Bearer token required on POST /run. */
  serverApiKey?: string;
  /** Explicitly run with no authentication. Required when no key is supplied. */
  allowUnauthenticated?: boolean;
  /** Reject request bodies larger than this many bytes. */
  maxBodyBytes?: number;
}

/**
 * Reduce a caller-supplied config to the fields that are safe to accept from
 * the network (SR-11).
 *
 * Everything not listed here is dropped. The dangerous fields are the ones that
 * redirect where data goes or what gets executed:
 *   - `model.endpoint` / `model.apiKey` — would exfiltrate scraped page content
 *     to a caller-chosen host, using the server's credentials.
 *   - `browser.executablePath` — would launch an arbitrary local binary.
 *   - `browser.profileStorePath` — would read or write arbitrary directories.
 */
export type SanitizedRunConfig = {
  agent?: Partial<SepiaConfig['agent']>;
  security?: Partial<SepiaConfig['security']>;
  browser?: Partial<SepiaConfig['browser']>;
  model?: Partial<SepiaConfig['model']>;
};

type FieldSpec =
  | { kind: 'number'; min: number; max: number }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'stringArray'; maxLength: number };

// Bounds matter as much as the allowlist. Several of these values become timer
// durations or loop counts, so an unbounded number is a denial of service: a
// single request setting retryBackoffMs to 1e9 would hold a concurrency slot
// for days (CodeQL js/resource-exhaustion). Clamp rather than reject, so a
// caller asking for something merely aggressive still gets a run (SR-12).
const AGENT_FIELDS: Record<string, FieldSpec> = {
  maxSteps: { kind: 'number', min: 1, max: 200 },
  maxTokensPerRun: { kind: 'number', min: 1, max: 10_000_000 },
  verbosity: { kind: 'enum', values: ['minimal', 'standard', 'full'] },
  retryBackoffMs: { kind: 'number', min: 0, max: 30_000 },
  maxRetries: { kind: 'number', min: 0, max: 10 },
  confidenceThreshold: { kind: 'number', min: 0, max: 1 },
  maxHistorySteps: { kind: 'number', min: 1, max: 100 },
};

const SECURITY_FIELDS: Record<string, FieldSpec> = {
  robotsAwareness: { kind: 'boolean' },
  rateLimitMs: { kind: 'number', min: 0, max: 60_000 },
  allowedDomains: { kind: 'stringArray', maxLength: 100 },
};

// `profile` is deliberately absent: a network caller has no reason to choose
// the fingerprint preset, and an unknown id would fail the session at launch.
const BROWSER_FIELDS: Record<string, FieldSpec> = {
  headless: { kind: 'boolean' },
  settleTimeoutMs: { kind: 'number', min: 0, max: 30_000 },
};

/** Coerce one value against its spec. Returns undefined to drop the field. */
function coerce(value: unknown, spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      if (value < spec.min) return spec.min;
      if (value > spec.max) return spec.max;
      return value;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? value : undefined;
    case 'stringArray':
      if (!Array.isArray(value)) return undefined;
      return value.filter((v): v is string => typeof v === 'string').slice(0, spec.maxLength);
  }
}

function pick(
  section: unknown,
  fields: Record<string, FieldSpec>,
): Record<string, unknown> | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined;
  const input = section as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    if (input[key] === undefined) continue;
    const value = coerce(input[key], spec);
    if (value !== undefined) picked[key] = value;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function sanitizeRunConfig(raw: unknown): SanitizedRunConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const clean: SanitizedRunConfig = {};

  const agent = pick(input['agent'], AGENT_FIELDS);
  if (agent !== undefined) clean.agent = agent as Partial<SepiaConfig['agent']>;

  const security = pick(input['security'], SECURITY_FIELDS);
  if (security !== undefined) clean.security = security as Partial<SepiaConfig['security']>;

  const browser = pick(input['browser'], BROWSER_FIELDS);
  if (browser !== undefined) clean.browser = browser as Partial<SepiaConfig['browser']>;

  return clean;
}

/** Constant-time bearer-token comparison. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Pause rather than destroy: destroying the socket here would abort the
        // connection before the 413 response could be written.
        req.pause();
        reject(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Routes served without credentials.
 *
 * Listed rather than implied, so that publishing a route to the world is a
 * decision someone made and a reviewer can see. `/metrics` stays here because
 * probes and scrapers depend on it; that it exposes request and auth-failure
 * counts is the trade being made knowingly.
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['/', '/health', '/metrics']);

export function startServer(opts: ServeOptions = {}): Server {
  const { port = 3000, maxConcurrent = 5 } = opts;
  const serverApiKey = opts.serverApiKey ?? process.env['SEPIA_SERVER_API_KEY'];
  const allowUnauthenticated =
    opts.allowUnauthenticated ?? process.env['SEPIA_ALLOW_UNAUTHENTICATED'] === 'true';
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  // Secure by default: an unauthenticated agent runner on the network can be
  // driven to fetch arbitrary URLs, so running open must be a deliberate choice.
  if (!serverApiKey && !allowUnauthenticated) {
    throw new Error(
      'Refusing to start without authentication. Set SEPIA_SERVER_API_KEY, or pass ' +
        'allowUnauthenticated (SEPIA_ALLOW_UNAUTHENTICATED=true) to run open deliberately.',
    );
  }

  const baseConfig = mergeConfig(opts.config ?? {});
  let inflight = 0;
  let totalRequests = 0;
  let totalErrors = 0;
  let totalUnauthorized = 0;
  const startMs = Date.now();

  // Warm browsers shared across requests (AC-H1). Each request still builds its
  // own context inside one, so sessions stay isolated; what is saved is process
  // startup, which was previously paid in full on every POST /run and bounded
  // throughput by launches rather than by the model.
  const browserPool = createBrowserPool({ maxSize: maxConcurrent });

  function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!serverApiKey) return true;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      if (tokenMatches(auth.slice('Bearer '.length), serverApiKey)) return true;
    }
    // Counted separately (AC-I1): a rejected request never ran the agent, so
    // it belongs in neither totalRequests (accepted requests) nor totalErrors
    // (failures of processed runs). Keeping it separate makes credential
    // stuffing visible on /metrics without inflating error-rate alerts.
    totalUnauthorized++;
    json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    return false;
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // Default deny (SR-14). Authentication used to be opt-in per branch, which
    // made it a property of where someone remembered to put the call: a route
    // added later was public because nobody thought about it. Deciding once,
    // against an explicit list, means the mistake falls the other way — an
    // unlisted route is refused rather than served.
    if (!PUBLIC_ROUTES.has(url) && !checkAuth(req, res)) return;

    if (req.method === 'GET' && (url === '/health' || url === '/')) {
      json(res, 200, { ok: true, version: '0.2.0', inflight, maxConcurrent });
      return;
    }

    if (req.method === 'GET' && url === '/metrics') {
      json(res, 200, {
        ok: true,
        uptimeMs: Date.now() - startMs,
        inflight,
        maxConcurrent,
        totalRequests,
        totalErrors,
        totalUnauthorized,
        pooledBrowsers: browserPool.size(),
      });
      return;
    }

    if (req.method === 'POST' && url === '/run') {
      // Authentication already happened above, for every route that is not on
      // the public list.
      totalRequests++;

      // Claim the slot before any await, so concurrent requests cannot all pass
      // the check before any of them increments (SR-11).
      if (inflight >= maxConcurrent) {
        totalErrors++;
        json(res, 503, { ok: false, error: 'CAPACITY_EXCEEDED', inflight, maxConcurrent });
        return;
      }
      inflight++;

      try {
        let rawBody: string;
        try {
          rawBody = await readBody(req, maxBodyBytes);
        } catch (err) {
          totalErrors++;
          const tooLarge = err instanceof Error && err.message === 'BODY_TOO_LARGE';
          json(res, tooLarge ? 413 : 400, {
            ok: false,
            error: tooLarge ? 'BODY_TOO_LARGE' : 'BODY_READ_ERROR',
            ...(tooLarge ? { maxBodyBytes } : {}),
          });
          // Drain whatever the client is still sending so the socket closes cleanly.
          req.resume();
          return;
        }

        let goal: string;
        let runConfig: SanitizedRunConfig | undefined;
        try {
          const parsed = JSON.parse(rawBody) as { goal?: unknown; config?: unknown };
          if (typeof parsed.goal !== 'string' || !parsed.goal.trim()) {
            totalErrors++;
            json(res, 400, {
              ok: false,
              error: 'INVALID_REQUEST',
              message: '"goal" string is required',
            });
            return;
          }
          goal = parsed.goal;
          if (parsed.config !== undefined) {
            runConfig = sanitizeRunConfig(parsed.config);
          }
        } catch {
          totalErrors++;
          json(res, 400, { ok: false, error: 'INVALID_JSON' });
          return;
        }

        try {
          const config =
            runConfig !== undefined && Object.keys(runConfig).length > 0
              ? mergeConfig({
                  ...baseConfig,
                  ...runConfig,
                  agent: { ...baseConfig.agent, ...runConfig.agent },
                  browser: { ...baseConfig.browser, ...runConfig.browser },
                  security: { ...baseConfig.security, ...runConfig.security },
                })
              : baseConfig;
          const agent = createAgent(config, { browserPool });
          const trace: RunTrace = await agent.run(goal);
          if (trace.outcome !== 'success') totalErrors++;
          json(res, trace.outcome === 'success' ? 200 : 422, trace);
        } catch (err) {
          totalErrors++;
          // Log the detail for the operator; return only a generic code. The
          // underlying error can carry filesystem paths and stack frames
          // (CodeQL js/stack-trace-exposure).
          process.stderr.write(`[sepia] internal error handling /run: ${String(err)}\n`);
          json(res, 500, { ok: false, error: 'INTERNAL_ERROR' });
        }
      } finally {
        inflight--;
      }
      return;
    }

    json(res, 404, { ok: false, error: 'NOT_FOUND' });
  });

  server.listen(port, () => {
    process.stderr.write(
      `[sepia] http server listening on :${String(port)} (maxConcurrent=${String(maxConcurrent)}` +
        `${serverApiKey ? '' : ', UNAUTHENTICATED'})\n`,
    );
  });

  // Warm browsers outlive a request by design; they must not outlive the server.
  server.on('close', () => {
    void browserPool.close();
  });

  return server;
}
