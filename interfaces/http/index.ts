import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createAgent } from '../../agent/index.js';
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

export function sanitizeRunConfig(raw: unknown): SanitizedRunConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, Record<string, unknown> | undefined>;
  const clean: SanitizedRunConfig = {};

  const agent = input['agent'];
  if (agent !== undefined && typeof agent === 'object') {
    const picked: Record<string, unknown> = {};
    for (const key of [
      'maxSteps',
      'maxTokensPerRun',
      'verbosity',
      'retryBackoffMs',
      'maxRetries',
      'confidenceThreshold',
      'maxHistorySteps',
    ]) {
      if (agent[key] !== undefined) picked[key] = agent[key];
    }
    if (Object.keys(picked).length > 0) clean.agent = picked as Partial<SepiaConfig['agent']>;
  }

  const security = input['security'];
  if (security !== undefined && typeof security === 'object') {
    const picked: Record<string, unknown> = {};
    for (const key of ['robotsAwareness', 'rateLimitMs', 'allowedDomains']) {
      if (security[key] !== undefined) picked[key] = security[key];
    }
    if (Object.keys(picked).length > 0) clean.security = picked as Partial<SepiaConfig['security']>;
  }

  const browser = input['browser'];
  if (browser !== undefined && typeof browser === 'object') {
    const picked: Record<string, unknown> = {};
    for (const key of ['headless', 'profile', 'settleTimeoutMs']) {
      if (browser[key] !== undefined) picked[key] = browser[key];
    }
    if (Object.keys(picked).length > 0) clean.browser = picked as Partial<SepiaConfig['browser']>;
  }

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
  const startMs = Date.now();

  function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!serverApiKey) return true;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      if (tokenMatches(auth.slice('Bearer '.length), serverApiKey)) return true;
    }
    json(res, 401, { ok: false, error: 'UNAUTHORIZED' });
    return false;
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

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
      });
      return;
    }

    if (req.method === 'POST' && url === '/run') {
      if (!checkAuth(req, res)) return;
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
          const agent = createAgent(config);
          const trace: RunTrace = await agent.run(goal);
          if (trace.outcome !== 'success') totalErrors++;
          json(res, trace.outcome === 'success' ? 200 : 422, trace);
        } catch (err) {
          totalErrors++;
          json(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: String(err) });
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

  return server;
}
