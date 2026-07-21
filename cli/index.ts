#!/usr/bin/env node
// CLI entry point — Phase 2 M3

import { createAgent } from '../agent/index.js';
import { mergeConfig } from '../config/index.js';
import { startServer } from '../interfaces/http/index.js';

function printUsage(): void {
  process.stderr.write(
    'Usage:\n' +
      '  sepia run "<goal>" [--model X] [--endpoint Y] [--verbose]\n' +
      '  sepia serve [--port 3000] [--max-concurrent 5]\n',
  );
}

async function runCommand(args: string[]): Promise<void> {
  let goal = '';
  let model: string | undefined;
  let endpoint: string | undefined;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
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

  const config = mergeConfig({
    model: {
      endpoint: modelEndpoint,
      model: modelName,
      maxTokensPerStep: 100_000,
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
    privacy: { telemetry: verbose },
  });

  const agent = createAgent(config);

  try {
    const trace = await agent.run(goal);
    process.stdout.write(JSON.stringify(trace, null, 2) + '\n');
    process.exit(trace.outcome === 'success' ? 0 : 1);
  } catch (err) {
    process.stderr.write(`[sepia] fatal: ${String(err)}\n`);
    process.exit(1);
  }
}

function serveCommand(args: string[]): void {
  let port = Number(process.env['SEPIA_HTTP_PORT'] ?? '3000');
  let maxConcurrent = Number(process.env['SEPIA_MAX_CONCURRENT'] ?? '5');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
      port = Number(args[++i]);
    } else if (arg === '--max-concurrent' && i + 1 < args.length) {
      maxConcurrent = Number(args[++i]);
    }
  }

  const modelEndpoint = process.env['SEPIA_MODEL_ENDPOINT'] ?? 'https://api.anthropic.com/v1';
  const modelName = process.env['SEPIA_MODEL'] ?? 'claude-sonnet-4-6';
  const apiKey = process.env['SEPIA_API_KEY'];

  const config = mergeConfig({
    model: {
      endpoint: modelEndpoint,
      model: modelName,
      maxTokensPerStep: 100_000,
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
  });

  startServer({ port, maxConcurrent, config });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0];
  const rest = args.slice(1);

  if (subcommand === 'run') {
    await runCommand(rest);
  } else if (subcommand === 'serve') {
    serveCommand(rest);
  } else {
    printUsage();
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[sepia] fatal: ${String(err)}\n`);
  process.exit(1);
});
