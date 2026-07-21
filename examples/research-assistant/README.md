# research-assistant

A Sepia SDK demo for the **AI engineer** persona. Given a list of research queries, it runs one Sepia agent session per query (concurrently, up to 5), extracts a structured summary from the web, and emits a JSON report to stdout.

Demonstrates use cases UC-2 (search and extract) and UC-5 (scale across N inputs).

---

## What this shows

- **`createAgent(config)`** — how to instantiate the Sepia agent from the SDK
- **`agent.run(goal)`** — how to invoke the plan-observe-act-verify loop with a plain-language goal
- **`RunTrace`** — how to read per-step token counts, confidence scores, and outcomes
- **Concurrent sessions** — capped at 5 via a simple chunk-based pool
- **Model portability** — works identically with Anthropic Claude or a local Ollama model

---

## Quickstart

```bash
# From the repo root:
make setup   # if you haven't already

# Hosted model (Anthropic)
export SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1
export SEPIA_MODEL=claude-sonnet-4-6
export SEPIA_API_KEY=sk-ant-...
make run-example QUERIES="TypeScript generics,Rust ownership,Go channels"

# Local model (Ollama — no API key needed)
export SEPIA_MODEL_ENDPOINT=http://localhost:11434/v1
export SEPIA_MODEL=llama3.1
make run-example QUERIES="TypeScript generics,Rust ownership"
```

---

## Output format

The report is written to **stdout** as JSON. Per-step telemetry (token counts, confidence) is written to **stderr** so the two streams can be separated:

```bash
make run-example QUERIES="TypeScript generics" 2>telemetry.log | jq .
```

**stdout:**

```json
{
  "queries": [
    {
      "query": "TypeScript generics",
      "url": "https://www.typescriptlang.org/docs/handbook/2/generics.html",
      "summary": "TypeScript generics allow you to write reusable, type-safe components...",
      "tokensUsed": 1840,
      "stepsUsed": 4,
      "confidence": 0.91
    }
  ]
}
```

**stderr (per-step telemetry):**

```
[research-assistant] 1 queries, concurrency=1
[research-assistant] starting: "TypeScript generics"
  [step 1] open | tokensUsed=0 confidence=1.00
  [step 2] observe | tokensUsed=320 confidence=1.00
  [step 3] click @e14 | tokensUsed=640 confidence=0.94
  [step 4] read @e22 | tokensUsed=880 confidence=0.91
```

---

## SDK calls made

```typescript
import { createAgent, mergeConfig } from 'sepia';
import type { SepiaConfig, RunTrace } from 'sepia';

const config: SepiaConfig = mergeConfig({ model: { endpoint, model, apiKey } });
const agent = createAgent(config);
const trace: RunTrace = await agent.run('Search for "TypeScript generics" and summarize');

// Per-step introspection:
for (const step of trace.steps) {
  console.log(step.tokensUsed, step.confidence, step.action);
}
```

---

## Extending this example

To add a new query type (e.g. "extract pricing table from a URL"):

1. Write a new goal template: `"Visit {url} and return the pricing tiers as a JSON array"`
2. Pass it to `agent.run()` with the URL interpolated
3. Parse `trace.steps` for the last `read` action's result
4. Add a test in `tests/example/` asserting the output schema

The Sepia action API (`click`, `type`, `select`, `read`, etc.) is the only interface the agent uses — no selectors, no raw DOM. See [SKILLS.md](../../SKILLS.md) for the full catalog of reusable skills this example composes.
