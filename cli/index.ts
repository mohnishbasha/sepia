#!/usr/bin/env node
// CLI entry point — Phase 2 M3

import { createAgent } from '../agent/index.js';
import { mergeConfig } from '../config/index.js';

interface ParsedArgs {
  goal: string;
  model: string | undefined;
  endpoint: string | undefined;
  verbose: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // remove 'node' and script path

  if (args[0] !== 'run') {
    process.stderr.write('Usage: sepia run "<goal>" [--model X] [--endpoint Y] [--verbose]\n');
    process.exit(1);
  }

  let goal = '';
  let model: string | undefined;
  let endpoint: string | undefined;
  let verbose = false;

  for (let i = 1; i < args.length; i++) {
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

  return { goal, model, endpoint, verbose };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (!parsed.goal.trim()) {
    process.stderr.write('Usage: sepia run "<goal>" [--model X] [--endpoint Y] [--verbose]\n');
    process.exit(1);
  }

  const modelEndpoint =
    parsed.endpoint ?? process.env['SEPIA_MODEL_ENDPOINT'] ?? 'https://api.anthropic.com/v1';
  const modelName = parsed.model ?? process.env['SEPIA_MODEL'] ?? 'claude-sonnet-4-6';
  const apiKey = process.env['SEPIA_API_KEY'];

  const config = mergeConfig({
    model: {
      endpoint: modelEndpoint,
      model: modelName,
      maxTokensPerStep: 100_000,
      ...(apiKey !== undefined ? { apiKey } : {}),
    },
    privacy: {
      telemetry: parsed.verbose,
    },
  });

  const agent = createAgent(config);

  try {
    const trace = await agent.run(parsed.goal);
    process.stdout.write(JSON.stringify(trace, null, 2) + '\n');
    process.exit(trace.outcome === 'success' ? 0 : 1);
  } catch (err) {
    process.stderr.write(`[sepia] fatal: ${String(err)}\n`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[sepia] fatal: ${String(err)}\n`);
  process.exit(1);
});
