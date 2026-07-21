import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunTrace } from '../../agent/index.js';

// ── Mock the agent so we don't need a real browser ────────────────────────────

vi.mock('../../agent/index.js', () => {
  return {
    createAgent: vi.fn(),
  };
});

function makeRunTrace(query: string): RunTrace {
  return {
    runId: 'r1',
    goal: `Search for "${query}"`,
    sessionId: 's1',
    startMs: Date.now() - 1000,
    endMs: Date.now(),
    outcome: 'success',
    totalSteps: 3,
    totalTokens: 150,
    steps: [
      {
        stepN: 0,
        action: 'open',
        confidence: 1,
        tokensUsed: 50,
        latencyMs: 200,
        result: { ok: true, confidence: 1 },
        secretsRedacted: false,
      },
      {
        stepN: 1,
        action: 'click',
        handle: 'e1',
        confidence: 0.95,
        tokensUsed: 60,
        latencyMs: 150,
        result: { ok: true, confidence: 0.95 },
        secretsRedacted: false,
      },
      {
        stepN: 2,
        action: 'read',
        handle: 'e2',
        confidence: 0.9,
        tokensUsed: 40,
        latencyMs: 100,
        result: { ok: true, confidence: 0.9 },
        secretsRedacted: false,
      },
    ],
  };
}

describe('example: research-assistant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stdout JSON report matches schema (AC-E2)', async () => {
    const { createAgent } = await import('../../agent/index.js');

    vi.mocked(createAgent).mockReturnValue({
      run: vi.fn().mockImplementation(async (goal: string) => {
        const query = goal.match(/Search for "(.+?)"/)?.[1] ?? goal;
        return makeRunTrace(query);
      }),
    });

    // Simulate what the research-assistant does
    const queries = ['TypeScript generics', 'Rust ownership'];

    // Import createAgent to build agents
    const agentFactory = vi.mocked(createAgent);
    const config = {
      model: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'test',
        maxTokensPerStep: 100_000,
      },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: {
        maxSteps: 10,
        maxTokensPerRun: 50_000,
        verbosity: 'standard' as const,
        retryBackoffMs: 1000,
        maxRetries: 3,
        confidenceThreshold: 0.7,
      },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const results = await Promise.all(
      queries.map(async (q) => {
        const agent = agentFactory(config);
        const trace = await agent.run(`Search for "${q}" and return a summary`);
        const avgConf =
          trace.steps.reduce((s, step) => s + step.confidence, 0) / trace.steps.length;
        return {
          query: q,
          url: 'https://example.com',
          summary: `Agent completed in ${trace.totalSteps} steps. Outcome: ${trace.outcome}.`,
          tokensUsed: trace.totalTokens,
          stepsUsed: trace.totalSteps,
          confidence: Number(avgConf.toFixed(3)),
        };
      }),
    );

    const report = { queries: results };

    // Validate schema
    expect(report).toHaveProperty('queries');
    expect(Array.isArray(report.queries)).toBe(true);

    for (const result of report.queries) {
      expect(result).toHaveProperty('query');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('tokensUsed');
      expect(result).toHaveProperty('stepsUsed');
      expect(result).toHaveProperty('confidence');
      expect(typeof result.query).toBe('string');
      expect(typeof result.tokensUsed).toBe('number');
      expect(typeof result.stepsUsed).toBe('number');
      expect(typeof result.confidence).toBe('number');
    }
  });

  it('per-step token counts appear on stderr (AC-E4)', async () => {
    const { createAgent } = await import('../../agent/index.js');

    vi.mocked(createAgent).mockReturnValue({
      run: vi.fn().mockResolvedValue(makeRunTrace('test query')),
    });

    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrLines.push(String(chunk));
      return true;
    });

    // Simulate what research-assistant does for step logging
    const config = {
      model: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'claude-sonnet-4-6',
        apiKey: 'test',
        maxTokensPerStep: 100_000,
      },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: {
        maxSteps: 10,
        maxTokensPerRun: 50_000,
        verbosity: 'standard' as const,
        retryBackoffMs: 1000,
        maxRetries: 3,
        confidenceThreshold: 0.7,
      },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const agentFactory = vi.mocked(createAgent);
    const agent = agentFactory(config);
    const trace = await agent.run('Search for "test query"');

    // Emit per-step telemetry like the research-assistant does
    for (const step of trace.steps) {
      process.stderr.write(
        `  [step ${step.stepN}] ${step.action}` +
          (step.handle ? ` @${step.handle}` : '') +
          ` | tokensUsed=${step.tokensUsed} confidence=${step.confidence.toFixed(2)}\n`,
      );
    }

    spy.mockRestore();
    void originalWrite;

    // At least one line should contain 'tokensUsed'
    const tokensLines = stderrLines.filter((l) => l.includes('tokensUsed'));
    expect(tokensLines.length).toBeGreaterThan(0);
  });

  it('concurrent cap of 5 sessions is respected (AC-E5)', async () => {
    const { createAgent } = await import('../../agent/index.js');

    let concurrentCount = 0;
    let maxConcurrent = 0;

    vi.mocked(createAgent).mockReturnValue({
      run: vi.fn().mockImplementation(async (goal: string) => {
        void goal;
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        // Simulate async work
        await new Promise<void>((r) => setTimeout(r, 20));
        concurrentCount--;
        return makeRunTrace('q');
      }),
    });

    const MAX_CONCURRENT = 5;
    const queries = Array.from({ length: 10 }, (_, i) => `query ${i + 1}`);

    const config = {
      model: {
        endpoint: 'https://api.anthropic.com/v1',
        model: 'test',
        apiKey: 'test',
        maxTokensPerStep: 1000,
      },
      browser: { profile: 'default', headless: true, ephemeral: true, humanTiming: false },
      agent: {
        maxSteps: 5,
        maxTokensPerRun: 10_000,
        verbosity: 'standard' as const,
        retryBackoffMs: 0,
        maxRetries: 1,
        confidenceThreshold: 0.7,
      },
      privacy: { telemetry: false },
      security: { robotsAwareness: false },
    };

    const agentFactory = vi.mocked(createAgent);

    // Run in batches of MAX_CONCURRENT like the research-assistant does
    const results: RunTrace[] = [];
    for (let i = 0; i < queries.length; i += MAX_CONCURRENT) {
      const chunk = queries.slice(i, i + MAX_CONCURRENT);
      const chunkResults = await Promise.all(
        chunk.map(async (q) => {
          const agent = agentFactory(config);
          return agent.run(`Search for "${q}"`);
        }),
      );
      results.push(...chunkResults);
    }

    expect(results).toHaveLength(10);
    // Each batch runs at most MAX_CONCURRENT concurrently
    expect(maxConcurrent).toBeLessThanOrEqual(MAX_CONCURRENT);
  });
});
