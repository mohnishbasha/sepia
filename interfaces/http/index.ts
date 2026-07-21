import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAgent } from '../../agent/index.js';
import { mergeConfig } from '../../config/index.js';
import type { SepiaConfig } from '../../config/index.js';
import type { RunTrace } from '../../agent/index.js';

export interface ServeOptions {
  port?: number;
  maxConcurrent?: number;
  config?: Partial<SepiaConfig>;
  /** Bearer token required on POST /run. Omit to disable auth. */
  serverApiKey?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startServer(opts: ServeOptions = {}): void {
  const { port = 3000, maxConcurrent = 5 } = opts;
  const serverApiKey = opts.serverApiKey ?? process.env['SEPIA_SERVER_API_KEY'];
  const baseConfig = mergeConfig(opts.config ?? {});
  let inflight = 0;
  let totalRequests = 0;
  let totalErrors = 0;
  const startMs = Date.now();

  function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!serverApiKey) return true;
    const auth = req.headers['authorization'];
    if (auth === `Bearer ${serverApiKey}`) return true;
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

      if (inflight >= maxConcurrent) {
        totalErrors++;
        json(res, 503, { ok: false, error: 'CAPACITY_EXCEEDED', inflight, maxConcurrent });
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readBody(req);
      } catch {
        totalErrors++;
        json(res, 400, { ok: false, error: 'BODY_READ_ERROR' });
        return;
      }

      let goal: string;
      let runConfig: Partial<SepiaConfig> | undefined;
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
        if (parsed.config !== null && typeof parsed.config === 'object') {
          runConfig = parsed.config as Partial<SepiaConfig>;
        }
      } catch {
        totalErrors++;
        json(res, 400, { ok: false, error: 'INVALID_JSON' });
        return;
      }

      inflight++;
      try {
        const config = runConfig ? mergeConfig({ ...baseConfig, ...runConfig }) : baseConfig;
        const agent = createAgent(config);
        const trace: RunTrace = await agent.run(goal);
        if (trace.outcome !== 'success') totalErrors++;
        json(res, trace.outcome === 'success' ? 200 : 422, trace);
      } catch (err) {
        totalErrors++;
        json(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: String(err) });
      } finally {
        inflight--;
      }
      return;
    }

    json(res, 404, { ok: false, error: 'NOT_FOUND' });
  });

  server.listen(port, () => {
    process.stderr.write(
      `[sepia] http server listening on :${String(port)} (maxConcurrent=${String(maxConcurrent)})\n`,
    );
  });
}
