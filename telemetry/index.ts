export interface StepEvent {
  timestamp: number;
  sessionId: string;
  runId: string;
  stepN: number;
  action: string;
  handle?: string;
  confidence: number;
  tokensUsed: number;
  latencyMs: number;
  ok: boolean;
  errorCode?: string;
}

export interface Logger {
  step: (event: StepEvent) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

// Emit a single JSON log line to stderr. Used when SEPIA_LOG_FORMAT=json.
function emitJson(level: string, message: string, meta?: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: Date.now(), level, message, ...meta }) + '\n');
}

export function createLogger(opts?: {
  verbose?: boolean;
  enabled?: boolean;
  format?: 'text' | 'json';
}): Logger {
  const enabled = opts?.enabled ?? false;
  const verbose = opts?.verbose ?? false;
  const format = opts?.format ?? (process.env['SEPIA_LOG_FORMAT'] === 'json' ? 'json' : 'text');

  const noop = () => undefined;

  if (!enabled) {
    return { step: noop, info: noop, warn: noop, error: noop };
  }

  if (format === 'json') {
    return {
      step: (event) => {
        if (verbose) {
          emitJson('step', `action=${event.action}`, {
            stepN: event.stepN,
            action: event.action,
            handle: event.handle,
            confidence: event.confidence,
            tokensUsed: event.tokensUsed,
            latencyMs: event.latencyMs,
            ok: event.ok,
            errorCode: event.errorCode,
            sessionId: event.sessionId,
            runId: event.runId,
          });
        }
      },
      info: (msg, meta) => emitJson('info', msg, meta),
      warn: (msg, meta) => emitJson('warn', msg, meta),
      error: (msg, meta) => emitJson('error', msg, meta),
    };
  }

  return {
    step: (event) => {
      if (verbose) {
        process.stderr.write(
          `[step ${event.stepN}] ${event.action}${event.handle ? ` @${event.handle}` : ''} ` +
            `conf=${event.confidence.toFixed(2)} tokens=${event.tokensUsed} latency=${event.latencyMs}ms\n`,
        );
      }
    },
    info: (msg, meta) =>
      process.stderr.write(`[info] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
    warn: (msg, meta) =>
      process.stderr.write(`[warn] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
    error: (msg, meta) =>
      process.stderr.write(`[error] ${msg} ${meta ? JSON.stringify(meta) : ''}\n`),
  };
}
