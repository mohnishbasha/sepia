// CLI subcommands — Phase 2 M3. Split from index.ts so tests can drive them
// directly instead of spawning a process that calls process.exit().

import { createAgent } from '../agent/index.js';
import { mergeConfig } from '../config/index.js';
import { startServer } from '../interfaces/http/index.js';
import { loadDotEnv } from './dotenv.js';
import { HEADLESS_ENV_VAR, resolveHeadless } from './headless.js';

export function printUsage(): void {
  process.stderr.write(
    'Usage:\n' +
      '  sepia run "<goal>" [--model X] [--endpoint Y] [--verbose] [--answer-only] [--headed]\n' +
      '  sepia serve [--port 3000] [--max-concurrent 5] [--allow-unauthenticated]\n' +
      '  sepia mcp\n',
  );
}

/**
 * Resolve `--headed` / SEPIA_HEADLESS into a browser.headless override.
 *
 * Precedence strongest-first: explicit --headed flag, then SEPIA_HEADLESS,
 * then the configured default (browser.headless: true). An unusable
 * SEPIA_HEADLESS value exits 2 rather than being silently ignored.
 */
function headlessOverrideOrExit(headedFlag: boolean): boolean | undefined {
  try {
    return resolveHeadless(headedFlag, process.env[HEADLESS_ENV_VAR]);
  } catch (err) {
    process.stderr.write(`[sepia] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
}

export async function runCommand(args: string[]): Promise<void> {
  let goal = '';
  let model: string | undefined;
  let endpoint: string | undefined;
  let verbose = false;
  let answerOnly = false;
  let headed = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    } else if (arg === '--answer-only') {
      answerOnly = true;
    } else if (arg === '--headed') {
      headed = true;
    } else if (arg === '--model' && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === '--endpoint' && i + 1 < args.length) {
      endpoint = args[++i];
    } else if (!arg.startsWith('--')) {
      goal = arg;
    }
  }

  if (!goal.trim()) {
    printUsage();
    process.exit(1);
  }

  const modelEndpoint =
    endpoint ?? process.env['SEPIA_MODEL_ENDPOINT'] ?? 'https://api.anthropic.com/v1';
  const modelName = model ?? process.env['SEPIA_MODEL'] ?? 'claude-sonnet-4-6';
  const apiKey = process.env['SEPIA_API_KEY'];

  // A remote endpoint with no key produces a run that fails on every step and,
  // with --answer-only, prints nothing at all. Say so instead.
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(modelEndpoint);
  if (apiKey === undefined && !isLocal) {
    process.stderr.write(
      `[sepia] no API key. Set SEPIA_API_KEY, or add a .env beside your project:\n` +
        `           SEPIA_MODEL_ENDPOINT=${modelEndpoint}\n` +
        `           SEPIA_MODEL=${modelName}\n` +
        `           SEPIA_API_KEY=...\n` +
        `         A local endpoint (localhost) needs no key.\n`,
    );
    process.exit(2);
  }
  const robotsAwareness = process.env['SEPIA_ROBOTS_AWARENESS'] === 'true';
  const rateLimitMsRaw = process.env['SEPIA_RATE_LIMIT_MS'];
  const rateLimitMs = rateLimitMsRaw !== undefined ? Number(rateLimitMsRaw) : undefined;

  const headlessOverride = headlessOverrideOrExit(headed);

  const config = mergeConfig({
    model: {
      endpoint: modelEndpoint,
      model: modelName,
      maxTokensPerStep: 100_000,
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
    ...(headlessOverride !== undefined ? { browser: { headless: headlessOverride } } : {}),
    privacy: { telemetry: verbose },
    security: {
      robotsAwareness,
      ...(rateLimitMs !== undefined ? { rateLimitMs } : {}),
    },
  });

  const agent = createAgent(config);

  try {
    const trace = await agent.run(goal);
    if (answerOnly) {
      process.stdout.write((trace.answer ?? '') + '\n');
    } else {
      process.stdout.write(JSON.stringify(trace, null, 2) + '\n');
    }
    process.exit(trace.outcome === 'success' ? 0 : 1);
  } catch (err) {
    process.stderr.write(`[sepia] fatal: ${String(err)}\n`);
    process.exit(1);
  }
}

export function serveCommand(args: string[]): void {
  let port = Number(process.env['SEPIA_HTTP_PORT'] ?? '3000');
  let maxConcurrent = Number(process.env['SEPIA_MAX_CONCURRENT'] ?? '5');
  let allowUnauthenticated = process.env['SEPIA_ALLOW_UNAUTHENTICATED'] === 'true';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
      port = Number(args[++i]);
    } else if (arg === '--max-concurrent' && i + 1 < args.length) {
      maxConcurrent = Number(args[++i]);
    } else if (arg === '--allow-unauthenticated') {
      allowUnauthenticated = true;
    }
  }

  const modelEndpoint = process.env['SEPIA_MODEL_ENDPOINT'] ?? 'https://api.anthropic.com/v1';
  const modelName = process.env['SEPIA_MODEL'] ?? 'claude-sonnet-4-6';
  const apiKey = process.env['SEPIA_API_KEY'];
  const serverApiKey = process.env['SEPIA_SERVER_API_KEY'];
  const robotsAwareness = process.env['SEPIA_ROBOTS_AWARENESS'] === 'true';
  const rateLimitMsRaw = process.env['SEPIA_RATE_LIMIT_MS'];
  const rateLimitMs = rateLimitMsRaw !== undefined ? Number(rateLimitMsRaw) : undefined;

  const config = mergeConfig({
    model: {
      endpoint: modelEndpoint,
      model: modelName,
      maxTokensPerStep: 100_000,
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
    security: {
      robotsAwareness,
      ...(rateLimitMs !== undefined ? { rateLimitMs } : {}),
    },
  });

  startServer({
    port,
    maxConcurrent,
    config,
    allowUnauthenticated,
    ...(serverApiKey ? { serverApiKey } : {}),
  });
}

export async function mcpCommand(): Promise<void> {
  const { startMcpServer } = await import('../interfaces/mcp/index.js');

  // No model configuration: in MCP mode the host does the reasoning, so Sepia
  // needs no endpoint and no API key. Only browser settings apply.
  const { browser, agent } = mergeConfig({});
  // Same rule as `sepia run`: --headed has no MCP equivalent, but the
  // environment variable means the same thing in every subcommand.
  const headlessOverride = headlessOverrideOrExit(false);

  await startMcpServer({
    engine: {
      headless: headlessOverride ?? true,
      profile: browser.profile,
      confidenceThreshold: agent.confidenceThreshold,
      ...(browser.settleTimeoutMs !== undefined
        ? { settleTimeoutMs: browser.settleTimeoutMs }
        : {}),
      ...(process.env['SEPIA_BROWSER_PATH'] !== undefined
        ? { executablePath: process.env['SEPIA_BROWSER_PATH'] }
        : {}),
    },
  });
}

export async function main(): Promise<void> {
  // Installed globally, the CLI runs from directories that export nothing.
  // Real environment variables still take precedence over the file.
  const envFile = loadDotEnv();
  if (envFile !== null && process.env['SEPIA_DEBUG_ENV'] === '1') {
    process.stderr.write(`[sepia] loaded ${envFile}\n`);
  }

  const args = process.argv.slice(2);
  const subcommand = args[0];
  const rest = args.slice(1);

  if (subcommand === 'run') {
    await runCommand(rest);
  } else if (subcommand === 'serve') {
    serveCommand(rest);
  } else if (subcommand === 'mcp') {
    await mcpCommand();
  } else {
    printUsage();
    process.exit(1);
  }
}
