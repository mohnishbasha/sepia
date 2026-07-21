# Sepia — Product Specification & Feature Reference

> This document is the user-facing feature reference. For the numbered FR-_/AC-_ requirements used during development see [`phase1-spec.md`](phase1-spec.md). For Phase 3 hardening details see [`phase3-addendum.md`](phase3-addendum.md).

---

## Table of contents

1. [What Sepia is](#1-what-sepia-is)
2. [Who it is for](#2-who-it-is-for)
3. [Use cases](#3-use-cases)
4. [Action API](#4-action-api)
5. [Compact view (serializer)](#5-compact-view-serializer)
6. [Handle stability (resolver)](#6-handle-stability-resolver)
7. [Agent loop](#7-agent-loop)
8. [Fingerprint coherence](#8-fingerprint-coherence)
9. [Privacy and data boundary](#9-privacy-and-data-boundary)
10. [Security hardening](#10-security-hardening)
11. [Interfaces](#11-interfaces)
12. [Configuration reference](#12-configuration-reference)
13. [Model compatibility](#13-model-compatibility)
14. [Training and fine-tuning](#14-training-and-fine-tuning)
15. [LiteLLM integration](#15-litellm-integration)
16. [Performance characteristics](#16-performance-characteristics)
17. [Explicit non-goals](#17-explicit-non-goals)

---

## 1. What Sepia is

Sepia is an open-source, secure AI browser engine. A user or an upstream LLM describes a goal in plain language; Sepia navigates to the right page state, acts on it precisely, and can scale the workflow across pages and sessions — privately.

Three hard problems solved together:

| Problem          | What most tools do                           | What Sepia does                                     |
| ---------------- | -------------------------------------------- | --------------------------------------------------- |
| Token cost       | Send raw HTML (8,700+ tokens) or screenshots | Compact AX-tree outline (median ≤ 900 tokens)       |
| Layout fragility | CSS selectors / XPath break on redesign      | Semantic handles stable across DOM mutations        |
| Detection        | Patch `User-Agent` header                    | Patch BoringSSL source; full cross-signal coherence |

---

## 2. Who it is for

| Persona                        | Primary need                                                                |
| ------------------------------ | --------------------------------------------------------------------------- |
| **AI engineer**                | A reliable, token-efficient browser tool callable via TypeScript SDK or MCP |
| **Framework author**           | A well-typed MCP 2024-11 server so any LLM can drive the browser            |
| **Privacy-conscious operator** | Local-model path; auditable data boundary; ephemeral profiles               |
| **Security researcher**        | Replayable traces; deterministic core; isolated profiles                    |

---

## 3. Use cases

| ID   | Use case               | Example goal                                                                                   |
| ---- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| UC-1 | Login                  | `"Sign in to app.example.com with my stored credentials"`                                      |
| UC-2 | Search and extract     | `"Search for 'TypeScript async patterns' on MDN and return the first 3 results"`               |
| UC-3 | Fill and submit a form | `"Fill the contact form: name='Alice', email='alice@example.com', message='Hello' and submit"` |
| UC-4 | Multi-page navigation  | `"Add the first search result to cart and proceed to checkout"`                                |
| UC-5 | Scale across N inputs  | `"Run UC-2 for each of these 50 keywords and return structured results"`                       |
| UC-6 | Observe and report     | `"What are the current plan prices on pricing.example.com?"`                                   |

---

## 4. Action API

All actions return a typed result. No action ever evaluates model output as code. Actions are dispatched through a typed enum — the model outputs a JSON object, Sepia validates it, and routes it through a fixed switch table.

### Navigation

| Action    | Signature                     | Description                                                                                    |
| --------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `open`    | `open(url: string)`           | Navigate to a URL. Validates `http`/`https` only; rejects `file://`, `data://`, `javascript:`. |
| `back`    | `back()`                      | Navigate browser history back.                                                                 |
| `forward` | `forward()`                   | Navigate browser history forward.                                                              |
| `wait`    | `wait(condition, timeoutMs?)` | Wait for a URL pattern, element handle, or network idle. Returns `{ok, timedOut}`.             |

### Element interaction

| Action   | Signature                   | Description                                                                                                           |
| -------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `click`  | `click(handle)`             | Click the resolved element.                                                                                           |
| `type`   | `type(handle, text, opts?)` | Type text into an input. `opts.submit=true` triggers form submit after typing.                                        |
| `select` | `select(handle, option)`    | Select an option in a `<select>` or combobox, matched by visible text or value.                                       |
| `check`  | `check(handle, checked)`    | Check or uncheck a checkbox or radio button.                                                                          |
| `hover`  | `hover(handle)`             | Move the pointer over an element (triggers hover states).                                                             |
| `scroll` | `scroll(target, distance?)` | Scroll the page (`'up'`/`'down'`) or scroll an element into view by handle.                                           |
| `press`  | `press(key)`                | Send a keyboard event. Key names follow Playwright conventions (`'Enter'`, `'Tab'`, `'Escape'`, etc.).                |
| `read`   | `read(handle)`              | Return the full visible text of a single node (for content the compact view truncated). Returns `{ok, text, error?}`. |

### Observation

| Action    | Signature        | Description                                                                                           |
| --------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `observe` | `observe(opts?)` | Return the current `CompactView` of the page. Accepts `verbosity: 'minimal' \| 'standard' \| 'full'`. |

### Tab management

| Action        | Signature         | Description                                      |
| ------------- | ----------------- | ------------------------------------------------ |
| `tabs.new`    | `tabs.new(url?)`  | Open a new tab, optionally navigating to a URL.  |
| `tabs.close`  | `tabs.close(id?)` | Close a tab by ID, or the active tab if omitted. |
| `tabs.list`   | `tabs.list()`     | Return all open tabs as `TabInfo[]`.             |
| `tabs.switch` | `tabs.switch(id)` | Switch the active tab.                           |

### Result types

```typescript
// Every navigation/interaction action returns:
interface ActionResult {
  ok: boolean;
  confidence: number; // resolver confidence [0.0–1.0]
  viewDelta?: CompactView;
  error?: { code: ErrorCode; message: string; handle?: string };
}

type ErrorCode =
  | 'STALE_HANDLE' // handle no longer resolves with confidence ≥ threshold
  | 'ELEMENT_NOT_FOUND' // handle not present in current view
  | 'ELEMENT_DISABLED' // element is present but not interactable
  | 'NAVIGATION_FAILED' // open() or back()/forward() failed
  | 'TIMEOUT' // wait() or settle() exceeded timeout
  | 'BUDGET_EXCEEDED' // step or token budget exhausted
  | 'INVALID_URL' // open() received a non-http(s) URL
  | 'UNKNOWN';
```

---

## 5. Compact view (serializer)

The compact view is the core of Sepia's token efficiency. It is a pure, deterministic function: same AX snapshot → same output, always.

**What is included:**

- All interactive elements: buttons, links, inputs, selects, textareas, `role=button|tab|menuitem`, `contenteditable`
- Meaningful content: headings, labels, table cells
- State annotations: `(enabled)`, `(disabled)`, `(checked)`, `(required)`, `(expanded/collapsed)`
- Element values when present (e.g. current text in an input)

**What is excluded:**

- Layout wrappers with no semantic content
- `aria-hidden` nodes
- Offscreen nodes
- Tracking pixels and decorative images
- Repeated boilerplate text after first occurrence

**Verbosity levels:**

| Level                | Content                                      |
| -------------------- | -------------------------------------------- |
| `minimal`            | Interactive elements only                    |
| `standard` (default) | Interactive + key content (headings, labels) |
| `full`               | Everything except explicitly excluded nodes  |

**DOM fallback:** If the AX tree has fewer than 5 interactive nodes, the serializer falls back to DOM-inferred role/name for interactive elements before giving up.

**Token budget (measured on 20-page corpus):**

| Metric                     | Result                |
| -------------------------- | --------------------- |
| Median token count         | ≤ 900                 |
| 95th-percentile            | ≤ 1,500               |
| Interactive element recall | ≥ 95% of ground truth |

---

## 6. Handle stability (resolver)

Handles (`[e12]`, `[e13]`, …) are derived from a semantic fingerprint, not DOM path or position:

```
fingerprint = {
  role,
  accessible_name (lowercased),
  stable_attrs    (id, name, data-testid, aria-label),
  ordinal_among_same_role_siblings
}
```

**Scoring (weighted Jaccard):**

| Signal                  | Weight |
| ----------------------- | ------ |
| role match              | 0.40   |
| accessible name match   | 0.35   |
| stable attributes match | 0.15   |
| ordinal similarity      | 0.10   |

**Resolution rules:**

- Score ≥ 0.85 → reuse existing handle (stable across layout shifts)
- Score 0.6–0.85 → resolve with reported confidence
- Score < 0.6 → mark `stale`, surface error, **never act**
- Score ≥ 0.85 required to reuse handle on new assignment

**Guarantees:**

- If `role` + `accessible_name` are stable, the handle is stable through DOM reorders, class renames, and style changes
- When an element is removed, it returns `stale: true` immediately
- Resolution is deterministic: same input → same confidence score, always

---

## 7. Agent loop

Sepia runs a **plan → observe → act → verify** loop driven by any OpenAI-compatible model.

```
for step in 0..maxSteps:
  view = observe()                     # compact view, ≤ 900 tokens median
  sanitize(view)                       # prompt-injection guard
  action = model(goal + view)          # one JSON action per step
  validate(action)                     # typed enum check, no eval
  result = dispatch(action, engine)    # execute with confidence scoring
  if result.stale and retries < maxRetries:
    re-observe and retry with backoff
  if budget_exhausted or done:
    break
return RunTrace
```

**Termination conditions:**

- Model emits `{"action":"done"}` → `outcome: 'success'`
- `maxSteps` reached → `outcome: 'budget_exceeded'`
- `maxTokensPerRun` exceeded → `outcome: 'budget_exceeded'`
- Unrecoverable error → `outcome: 'error'`

**Stale handle retry:** up to `maxRetries` (default 3) with `retryBackoffMs` (default 1000ms) exponential backoff. Re-observes before each retry.

**Run trace:** every step emits `{action, handle, confidence, tokensUsed, latencyMs, result, secretsRedacted}`. The full `RunTrace` includes `{runId, goal, sessionId, startMs, endMs, outcome, totalSteps, totalTokens, steps[]}`.

---

## 8. Fingerprint coherence

Sepia patches Chromium at the BoringSSL source level so the TLS ClientHello itself matches a real Chrome build. Header-level UA spoofing is not used.

**Signals kept coherent as one unit:**

| Signal                    | Detail                                  |
| ------------------------- | --------------------------------------- |
| TLS ClientHello (JA3/JA4) | Matches Chrome 130 on Linux x86_64      |
| User-Agent                | Chrome 130 / Linux x86_64               |
| `Sec-CH-UA` Client Hints  | Consistent with UA                      |
| `navigator.webdriver`     | Absent or `undefined`                   |
| `window.chrome`           | Present and consistent with real Chrome |
| WebGL renderer / vendor   | Consistent with profile                 |
| Canvas fingerprint        | Noise injection matching profile        |
| System fonts              | Profile-consistent subset               |
| Timezone / locale         | Profile-consistent                      |

**Validation harness:** before every session starts, `validateCoherence()` runs all jsProbes in the browser context. If any probe fails, the session does not start — `validateAndStart` throws.

**Built-in preset:** `chrome-130-linux-x86_64`

**Patched Chromium binary:** `make chromium-build` applies a 4-layer patch stack (ungoogled-chromium → rebrowser-patches → BoringSSL JA3/JA4 → profile-coherence). Takes 2–4 hours on first build. Stock Playwright Chromium is used for all other features.

---

## 9. Privacy and data boundary

**What leaves the device per step:**

1. The compact view + user instruction → configured model endpoint
2. HTTP requests made by Chromium to the target website

Nothing else. The raw DOM, HTML, screenshots, credentials, and session cookies never leave the device.

**Credential handling:**

- Stored encrypted at rest (AES-256-GCM, 32-byte random key, 12-byte random IV per write)
- Never placed in LLM context
- Redacted from all structured logs and run traces
- `secretsRedacted: true` flagged in `StepTrace` when a type action contained a credential pattern

**Profile isolation:**

- Ephemeral by default — profile directory deleted on session end
- Each concurrent session gets its own isolated Chromium profile directory
- No shared cookies, storage, or cache between sessions

**Telemetry:**

- Off by default
- Opt-in sends only anonymized `{stepCount, latencyMs}` aggregates — never page content or user data

**Audit log:** every outbound payload is recorded by `createAuditor()` with `{destination, byteCount, fields, timestampMs}`. Covered by automated tests in `tests/data-boundary/`.

---

## 10. Security hardening

| Feature                        | Detail                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| No `eval` of model output      | Actions dispatched via typed enum switch; `no-eval` ESLint rule fails CI                     |
| Prompt injection sanitization  | `sanitizeForLLM()` masks 7 injection pattern families before page content enters LLM context |
| AES-256-GCM at-rest encryption | Profile credentials encrypted with random IV per write; auth tag verification on read        |
| URL validation                 | `open()` rejects non-`http`/`https` URLs with `INVALID_URL` error                            |
| Stale handle enforcement       | Actions on stale handles return error immediately; never silently act on wrong element       |
| One-way module dependency      | Core modules cannot import from agent; enforced by ESLint, fails `make lint`                 |
| Dependency audit               | `make security` runs `pnpm audit --audit-level=critical`; fails CI on critical CVEs          |

**Injection pattern families detected by `sanitizeForLLM()`:**

1. `SYSTEM:` directives
2. Role-override (`You are now…`)
3. Instruction-override (`Ignore previous instructions`)
4. LLaMA `[INST]` tags
5. Chat-template tokens (`<|im_start|>`, etc.)
6. Markdown system headers (`### System`)
7. Act-as overrides (`Act as…`)

---

## 11. Interfaces

### TypeScript SDK

```typescript
import { createSession, createAgent, mergeConfig } from 'sepia/interfaces/sdk';

const config = mergeConfig({ model: { endpoint: '...', model: '...' } });

// Low-level: drive individual actions
const session = await createSession(config);
await session.open('https://example.com');
const view = await session.observe();
await session.click(view.nodes[0].handle!);
await session.close();

// High-level: run a goal end-to-end
const agent = createAgent(config);
const trace = await agent.run('Find the current Node.js LTS version');
console.log(trace.outcome); // 'success'
```

### HTTP API

Start: `sepia serve [--port 3000] [--max-concurrent 5]`

| Endpoint  | Method | Description                                                       |
| --------- | ------ | ----------------------------------------------------------------- |
| `/run`    | `POST` | Submit a goal. Body: `{"goal": "..."}`. Returns `RunTrace`.       |
| `/health` | `GET`  | Liveness check. Returns `{ok, version, inflight, maxConcurrent}`. |

HTTP status codes: `200` (success), `422` (budget_exceeded/error outcome), `503` (capacity exceeded), `400` (bad request), `500` (internal error).

### MCP stdio

`sepia mcp` starts an MCP 2024-11 stdio server. Registers 12 tools matching the action API: `open`, `observe`, `click`, `type`, `select`, `check`, `hover`, `scroll`, `press`, `read`, `back`, `forward`.

Compatible with Claude Desktop and any MCP 2024-11 host.

### CLI

```bash
sepia run "<goal>" [--model X] [--endpoint Y] [--verbose]
sepia serve [--port N] [--max-concurrent N]
```

---

## 12. Configuration reference

Full schema in [`config/index.ts`](../config/index.ts). All fields have safe defaults.

### `model`

| Field              | Default                        | Description                                                             |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------- |
| `endpoint`         | `https://api.anthropic.com/v1` | OpenAI-compatible model API base URL                                    |
| `model`            | `claude-sonnet-4-6`            | Model name passed to the API                                            |
| `apiKey`           | —                              | API key (optional for local models)                                     |
| `maxTokensPerStep` | `1024`                         | Max tokens per model call                                               |
| `jsonMode`         | `false`                        | Add `response_format: {type: "json_object"}` to model calls             |
| `promptStyle`      | `default`                      | System prompt variant: `default` (large models) or `minimal` (SLMs ≤7B) |
| `tokenEstimation`  | `auto`                         | Token counting: `api`, `local`, or `auto` (API with local fallback)     |

### `browser`

| Field            | Default                   | Description                                         |
| ---------------- | ------------------------- | --------------------------------------------------- |
| `headless`       | `true`                    | Run Chromium headless                               |
| `ephemeral`      | `true`                    | Delete profile directory on session end             |
| `profile`        | `chrome-130-linux-x86_64` | Fingerprint preset name                             |
| `executablePath` | —                         | Path to custom Chromium binary (e.g. patched build) |

### `agent`

| Field                 | Default    | Description                                                        |
| --------------------- | ---------- | ------------------------------------------------------------------ |
| `maxSteps`            | `50`       | Hard cap on observe-act iterations per run                         |
| `maxTokensPerRun`     | `100000`   | Token budget per run                                               |
| `maxRetries`          | `3`        | Max stale-handle retries per action (also caps JSON parse retries) |
| `retryBackoffMs`      | `1000`     | Initial backoff for stale-handle retry                             |
| `confidenceThreshold` | `0.7`      | Minimum resolver confidence to act                                 |
| `verbosity`           | `standard` | Compact view verbosity (`minimal`/`standard`/`full`)               |
| `maxHistorySteps`     | `10`       | Sliding window: keep last N user/assistant pairs in context        |

### `privacy`

| Field       | Default | Description                       |
| ----------- | ------- | --------------------------------- |
| `telemetry` | `false` | Opt-in anonymized usage telemetry |

### `security`

| Field             | Default | Description                                                 |
| ----------------- | ------- | ----------------------------------------------------------- |
| `robotsAwareness` | `false` | Respect `robots.txt` (opt-in)                               |
| `rateLimitMs`     | `0`     | Per-domain minimum interval between requests (0 = disabled) |

---

## 13. Model compatibility

Sepia works with any OpenAI-compatible model API — cloud or local. The `model` config section controls how Sepia adapts to different model capabilities.

### Prompt styles

| `promptStyle` | Best for                             | Description                                                                      |
| ------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `default`     | Large models (Claude, GPT-4, Gemini) | Full system prompt with plain-English explanation and JSON schema examples       |
| `minimal`     | Small models (≤ 7B params)           | Shorter, more schema-explicit prompt with explicit rules; reduces token overhead |

Set `SEPIA_PROMPT_STYLE=minimal` (or `model.promptStyle: 'minimal'` in code) for local SLMs.

### JSON mode

Some models require explicit `response_format: {type: "json_object"}` to reliably output JSON. Enable it with `SEPIA_JSON_MODE=true` (or `model.jsonMode: true`). When routing through LiteLLM, pair this with `drop_params: true` in the LiteLLM config so the parameter is silently dropped for models that don't support it (e.g. Ollama without the `--json` flag).

### JSON repair and retry

Sepia automatically repairs common formatting errors from small models before retrying:

- Strips markdown code fences (` ```json ... ``` `)
- Removes trailing commas before `}` or `]`

Up to `agent.maxRetries` parse attempts are made before aborting the step.

### Message history window

Sepia maintains a rolling conversation window to support multi-step tasks without overflowing small context windows. The last `agent.maxHistorySteps` (default: 10) user/assistant pairs are included in each model call. The system prompt is always present and is not counted against this limit.

### Token estimation

| `tokenEstimation` | Behavior                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`             | Always trust the usage count reported by the API                                                                                            |
| `local`           | Always estimate locally using a character/word heuristic                                                                                    |
| `auto` (default)  | Use API-reported tokens when available; fall back to local estimate for models that return `null` usage (common for local Ollama instances) |

### Tested provider paths

| Provider              | Transport                   | Notes                                                     |
| --------------------- | --------------------------- | --------------------------------------------------------- |
| Anthropic (Claude)    | Direct API                  | Default; highest reliability                              |
| OpenAI (GPT-4o, o1)   | Direct API                  | Full JSON mode support                                    |
| Ollama (local)        | `http://localhost:11434/v1` | Set `promptStyle: minimal`; use LiteLLM for `drop_params` |
| Groq                  | OpenAI-compat API           | Fast inference for Llama 3.x models                       |
| Together AI           | OpenAI-compat API           | Cloud-hosted open models                                  |
| Any OpenAI-compat API | Via `SEPIA_MODEL_ENDPOINT`  | LiteLLM proxy recommended for multi-provider routing      |

---

## 14. Training and fine-tuning

Sepia can export agent execution traces as structured fine-tuning datasets for training open-weights models to perform browser automation.

### Trace format

Every agent run produces a `RunTrace` with per-step details: page content seen, action taken, outcome, token usage, and a `secretsRedacted` flag. Traces are emitted as JSONL to stdout or a file.

### Export formats

| Format             | File             | Framework support                 |
| ------------------ | ---------------- | --------------------------------- |
| **ShareGPT JSONL** | `sharegpt.jsonl` | axolotl, LLaMA-Factory, unsloth   |
| **Alpaca JSONL**   | `alpaca.jsonl`   | Most instruction-tuning pipelines |

Both formats skip:

- Runs where `outcome !== 'success'`
- Steps where `secretsRedacted === true` (credentials are never in the training data)

### Usage

```bash
# Run the agent and save traces
make run ARGS='run "Find the price of Node.js LTS"' > traces.jsonl

# Export to both formats
make export-traces TRACE_FILE=traces.jsonl OUT_DIR=out/training
# → out/training/sharegpt.jsonl
# → out/training/alpaca.jsonl
```

The export functions are in `training/index.ts` and can be called directly from TypeScript:

```typescript
import { exportToShareGPT, exportToAlpaca, parseTraceJSONL } from 'sepia/training';

const traces = parseTraceJSONL(fs.readFileSync('traces.jsonl', 'utf8'));
const sharegpt = exportToShareGPT(traces, pageContents);
const alpaca = exportToAlpaca(traces, pageContents);
```

### Dataset design notes

- Each successful step becomes **one training sample** (not one per run) — fine-grained supervision signal
- The system prompt in training data matches Sepia's production `SYSTEM_PROMPT_DEFAULT`
- Page content is passed as the human turn; the action JSON is the model turn
- `metadata` field on ShareGPT records includes `runId`, `goal`, `outcome`, `totalTokens` for filtering

---

## 15. LiteLLM integration

[LiteLLM](https://docs.litellm.ai) is an optional proxy layer that sits between Sepia and your model providers. It gives you a single OpenAI-compatible endpoint that can route to 100+ providers, with cost tracking, fallbacks, and rate limiting — all transparent to Sepia.

See [docs/litellm.md](litellm.md) for the full integration guide.

### When to use it

| Need                                | Without LiteLLM             | With LiteLLM                           |
| ----------------------------------- | --------------------------- | -------------------------------------- |
| Switch providers                    | Change env vars and restart | Change one config line                 |
| Cost tracking                       | Not available               | Built-in spend dashboard at `:4000/ui` |
| Fallback chains                     | Manual retry logic          | Automatic `model_list` fallback        |
| Rate limiting across teams          | Not available               | Per-key rate limits                    |
| Load balance across Ollama replicas | Not available               | Round-robin or least-busy routing      |
| A/B testing models                  | Two Sepia instances         | One Sepia instance, LiteLLM router     |

### Quickstart

```bash
# Start proxy (requires Docker; config from config/litellm.yaml)
make litellm-start ANTHROPIC_API_KEY=sk-ant-...

# Point Sepia at it
export SEPIA_MODEL_ENDPOINT=http://localhost:4000/v1
export SEPIA_MODEL=anthropic/claude-sonnet-4-6
make run ARGS='run "What is the Node.js LTS version?"'
```

### Kubernetes sidecar

The Sepia Helm chart supports LiteLLM as an optional sidecar. When `litellm.enabled: true`, the proxy runs in the same pod and Sepia's endpoint is automatically set to `http://localhost:4000/v1`.

```yaml
litellm:
  enabled: true
  configSecret: litellm-config # kubectl secret with litellm.yaml key
  defaultModel: anthropic/claude-sonnet-4-6
```

---

## 16. Performance characteristics

| Metric                               | Target                     | Measured |
| ------------------------------------ | -------------------------- | -------- |
| Median compact view (20-page corpus) | ≤ 900 tokens               | ✅ pass  |
| 95th-percentile compact view         | ≤ 1,500 tokens             | ✅ pass  |
| Interactive element recall           | ≥ 95% of ground truth      | ✅ pass  |
| Page settle + serialization          | ≤ 3s p95 (≤ 200 DOM nodes) | —        |
| Handle resolution latency            | ≤ 50ms per action          | —        |
| Concurrent sessions (16GB / 8-core)  | ≥ 10                       | —        |
| Per-session peak memory              | ≤ 512MB                    | —        |

Performance benchmarks marked `—` require a load test runner not included in standard CI. The token budget metrics run on every `make ci` commit.

---

## 17. Explicit non-goals

| ID    | Non-goal                                                            |
| ----- | ------------------------------------------------------------------- |
| NG-1  | General-purpose JavaScript runtime                                  |
| NG-2  | Rendering for human users (no visible browser window in production) |
| NG-3  | Full Playwright/Puppeteer API compatibility                         |
| NG-4  | Scraping without an LLM in the loop                                 |
| NG-5  | Mobile or native app automation                                     |
| NG-6  | PDF generation, video/audio capture                                 |
| NG-7  | Browser extension support                                           |
| NG-8  | Cross-OS fingerprint spoofing (Linux host as macOS/Windows Chrome)  |
| NG-9  | Multi-user / SaaS hosting — each operator runs their own instance   |
| NG-10 | Human-operated browser sessions                                     |
