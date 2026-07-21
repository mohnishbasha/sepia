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

export function createLogger(opts?: { verbose?: boolean; enabled?: boolean }): Logger {
  const enabled = opts?.enabled ?? false;
  const verbose = opts?.verbose ?? false;

  const noop = () => undefined;

  if (!enabled) {
    return { step: noop, info: noop, warn: noop, error: noop };
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
