#!/usr/bin/env node
/**
 * research-assistant — Sepia SDK demo for the AI engineer persona
 *
 * Demonstrates UC-2 (search and extract) and UC-5 (scale across N inputs).
 * Given a comma-separated list of research queries, runs one Sepia agent
 * session per query (concurrently, up to 5 at a time), extracts a structured
 * summary, and emits a JSON report to stdout.
 *
 * Usage:
 *   make run-example QUERIES="TypeScript generics,Rust ownership,Go channels"
 *
 * Environment:
 *   SEPIA_MODEL_ENDPOINT  Model API base URL (default: https://api.anthropic.com/v1)
 *   SEPIA_MODEL           Model name (default: claude-sonnet-4-6)
 *   SEPIA_API_KEY         API key (required for hosted models; omit for Ollama)
 */

import { createAgent, mergeConfig } from 'sepia';
import type { RunTrace, SepiaConfig } from 'sepia';

const MAX_CONCURRENT = 5;

interface QueryResult {
  query: string;
  url: string;
  summary: string;
  tokensUsed: number;
  stepsUsed: number;
  confidence: number;
}

interface Report {
  queries: QueryResult[];
}

function buildConfig(): SepiaConfig {
  return mergeConfig({
    model: {
      endpoint: process.env['SEPIA_MODEL_ENDPOINT'] ?? 'https://api.anthropic.com/v1',
      model: process.env['SEPIA_MODEL'] ?? 'claude-sonnet-4-6',
      apiKey: process.env['SEPIA_API_KEY'],
      maxTokensPerStep: 100_000,
    },
    agent: {
      maxSteps: 10,
      maxTokensPerRun: 50_000,
      verbosity: 'standard',
      retryBackoffMs: 1_000,
      maxRetries: 3,
      confidenceThreshold: 0.7,
    },
  });
}

function goalForQuery(query: string): string {
  return `Search for "${query}" and return a one-paragraph summary of the most relevant result, including the URL.`;
}

function extractResult(query: string, trace: RunTrace): QueryResult {
  const avgConfidence =
    trace.steps.length > 0
      ? trace.steps.reduce((sum, s) => sum + s.confidence, 0) / trace.steps.length
      : 0;

  // In a real implementation the agent would return structured output.
  // For the stub, we surface the trace metadata.
  return {
    query,
    url: 'https://example.com (extracted by agent — implement in M3)',
    summary: `Agent completed in ${trace.totalSteps} steps using ${trace.totalTokens} tokens. Outcome: ${trace.outcome}.`,
    tokensUsed: trace.totalTokens,
    stepsUsed: trace.totalSteps,
    confidence: Number(avgConfidence.toFixed(3)),
  };
}

async function runQuery(query: string, config: SepiaConfig): Promise<QueryResult> {
  const agent = createAgent(config);
  process.stderr.write(`[research-assistant] starting: "${query}"\n`);

  const trace = await agent.run(goalForQuery(query));

  // Log per-step telemetry to stderr so stdout stays clean JSON
  for (const step of trace.steps) {
    process.stderr.write(
      `  [step ${step.stepN}] ${step.action}` +
        (step.handle ? ` @${step.handle}` : '') +
        ` | tokensUsed=${step.tokensUsed} confidence=${step.confidence.toFixed(2)}\n`,
    );
  }

  return extractResult(query, trace);
}

async function runBatch(queries: string[], config: SepiaConfig): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  // Process in chunks of MAX_CONCURRENT
  for (let i = 0; i < queries.length; i += MAX_CONCURRENT) {
    const chunk = queries.slice(i, i + MAX_CONCURRENT);
    const chunkResults = await Promise.all(chunk.map((q) => runQuery(q, config)));
    results.push(...chunkResults);
  }
  return results;
}

async function main(): Promise<void> {
  const rawQueries = process.argv[2] ?? '';
  if (!rawQueries.trim()) {
    process.stderr.write(
      'Usage: make run-example QUERIES="TypeScript generics,Rust ownership,Go channels"\n',
    );
    process.exit(1);
  }

  const queries = rawQueries
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean);

  if (queries.length === 0) {
    process.stderr.write('Error: no queries provided.\n');
    process.exit(1);
  }

  process.stderr.write(
    `[research-assistant] ${queries.length} queries, concurrency=${Math.min(MAX_CONCURRENT, queries.length)}\n`,
  );

  const config = buildConfig();
  const queryResults = await runBatch(queries, config);

  const report: Report = { queries: queryResults };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`[research-assistant] fatal: ${String(err)}\n`);
  process.exit(1);
});
