# Sepia — Product Requirements & Technical Specification

> **Status: DRAFT — awaiting maintainer approval before Phase 2 (implementation) begins.**
> Phase 0 decisions locked: TypeScript · Playwright + executablePath · ungoogled-chromium base · MIT license · Chrome 130 / Linux x86_64 for M4 · MCP 2024-11 stdio

---

## Table of contents

1. [Product requirements](#1-product-requirements)
2. [Functional requirements](#2-functional-requirements)
3. [Non-functional requirements](#3-non-functional-requirements)
4. [Security requirements & threat model](#4-security-requirements--threat-model)
5. [Interfaces & contracts](#5-interfaces--contracts)
6. [Acceptance criteria](#6-acceptance-criteria)
7. [Architecture](#7-architecture)
8. [Milestones](#8-milestones)

---

## 1. Product requirements

### 1.1 Display name and machine form

| Context | Value |
|---|---|
| Display name | `Sepia` |
| CLI command | `sepia` |
| Package name | `sepia` |
| Repo / directory names | `sepia` |
| All other machine contexts | `sepia` |

Enforce in README, CLAUDE.md, CONTRIBUTING.md, and package.json. Any PR that introduces a casing variant is blocked by a lint rule.

### 1.2 User personas

| Persona | Description | Primary need |
|---|---|---|
| **AI engineer** | Building agent pipelines with LLM orchestration frameworks | A reliable, token-efficient browser tool callable via SDK or MCP |
| **Framework author** | Building an agent framework (LangChain, LlamaIndex, custom) | A well-typed MCP server so any LLM can drive the browser |
| **Privacy-conscious operator** | Automating workflows without sending page data to third parties | Local-model path; auditable data boundary; ephemeral profiles |
| **Security researcher** | Auditing or testing web applications in a reproducible environment | Replay traces; deterministic core; isolated profiles |

### 1.3 Primary use cases

| ID | Use case | Example plain-language goal |
|---|---|---|
| UC-1 | Login to a web service | `"Sign in to app.example.com with my stored credentials"` |
| UC-2 | Search and extract | `"Search for 'TypeScript async patterns' on MDN and return the first three results as a list"` |
| UC-3 | Fill and submit a form | `"Fill in the contact form with name='Alice', email='alice@example.com', message='Hello' and submit"` |
| UC-4 | Multi-page navigation flow | `"Add the first item in the search results to cart and proceed to checkout"` |
| UC-5 | Scale across N inputs | `"Run UC-2 for each keyword in this list of 50, return structured results"` |
| UC-6 | Observe and report | `"What are the current plan prices on pricing.example.com?"` |

### 1.4 Non-goals (explicitly out of scope)

- NG-1: General-purpose JavaScript runtime or Node.js replacement.
- NG-2: Rendering for human users (no visible browser window in production use).
- NG-3: Full Playwright/Puppeteer API compatibility — sepia exposes only its typed action set.
- NG-4: Built-in scraping without an LLM in the loop.
- NG-5: Mobile / native app automation.
- NG-6: PDF generation, video capture, or audio capture.
- NG-7: Browser extension support (in M1–M5).
- NG-8: Cross-OS fingerprint spoofing (Linux host presenting as macOS or Windows Chrome) — deferred past M5.
- NG-9: Multi-user / SaaS hosting — sepia is a local library/CLI tool; each operator runs their own instance.
- NG-10: Human-operated browser sessions.

---

## 2. Functional requirements

Requirements are numbered FR-N. Every FR must trace to at least one acceptance test in §6 and at least one automated test in the test suite before the relevant milestone closes.

### 2.1 Serializer (Component 1)

| ID | Requirement |
|---|---|
| FR-1 | On page settle (DOM stable + network-idle heuristic), build a compact view from the merged AX tree + DOM. |
| FR-2 | Compact view MUST include all interactive nodes: `link`, `button`, `input`, `select`, `textarea`, `role=button\|tab\|menuitem`, `contenteditable`. |
| FR-3 | Compact view MUST include meaningful non-interactive content: headings, labels, table cells. |
| FR-4 | Compact view MUST drop: layout wrappers with no semantic content, tracking pixels, offscreen nodes, `aria-hidden` nodes, duplicate whitespace, boilerplate text repeated after first occurrence. |
| FR-5 | Each interactive node MUST carry a short handle in format `[eNN]` (e.g. `[e12]`). Non-interactive nodes carry no handle. |
| FR-6 | Emit a compact indented outline, one line per node. Example format: `[e12] button "Sign in"  (enabled)`. |
| FR-7 | Expose a `verbosity` parameter: `minimal` / `standard` / `full`. Default: `standard`. Higher verbosity includes more context nodes. |
| FR-8 | If AX tree is sparse (fewer than 5 interactive nodes detected), fall back to DOM-inferred role/name for interactive elements before giving up. |
| FR-9 | `serializer` MUST be a pure, deterministic function: given the same AX snapshot + DOM snapshot, it MUST produce the same compact view. No LLM calls, no network calls, no side effects. |

### 2.2 Resolver (Component 2)

| ID | Requirement |
|---|---|
| FR-10 | Each handle MUST be derived from a semantic fingerprint: weighted hash of `{role, accessible_name, input_type, stable_attrs (id/name/data-testid/aria-label), normalized_nearby_label_text, ordinal_among_same_role_siblings}`. |
| FR-11 | On every re-render, re-resolve all handles by weighted best-match. Weight order: `role + accessible_name` >> `stable_attrs` >> `nearby_label` >> `ordinal`. Position/path is a low-weight tiebreaker only. |
| FR-12 | If an element moves or restyles but `role` + `accessible_name` are stable, the handle MUST remain the same. |
| FR-13 | If a handle's best match has confidence < 0.6, mark it `stale` and surface it to the caller. NEVER silently dispatch an action to a stale handle. |
| FR-14 | Every resolution MUST return a `confidence` score in range `[0.0, 1.0]`. |
| FR-15 | Persist the handle→fingerprint map for the duration of a session. Map is cleared on session end or `open(url)` navigation to a new origin. |
| FR-16 | `resolver` MUST be a pure, deterministic function. No LLM calls, no network calls. |

### 2.3 Action API (Component 3)

| ID | Requirement |
|---|---|
| FR-17 | `click(handle)` — clicks the resolved element. Returns `ActionResult`. |
| FR-18 | `type(handle, text, opts?: {submit?: boolean})` — types text into the element. If `submit=true`, triggers form submit after typing. Returns `ActionResult`. |
| FR-19 | `select(handle, option)` — selects an option in a `combobox` or `select` element. `option` matched by visible text or value. Returns `ActionResult`. |
| FR-20 | `check(handle, checked: boolean)` — checks or unchecks a checkbox or radio. Returns `ActionResult`. |
| FR-21 | `hover(handle)` — moves pointer over element. Returns `ActionResult`. |
| FR-22 | `scroll(target: 'up' | 'down' | handle, distance?: number)` — scrolls the page or scrolls element into view. Returns `ActionResult`. |
| FR-23 | `press(key: string)` — sends a keyboard event. Key names follow Playwright conventions. Returns `ActionResult`. |
| FR-24 | `read(handle)` — returns the full visible text or value of a single node (for nodes the compact view truncated). Returns `{ok, text, error?}`. |
| FR-25 | `observe(opts?: {verbosity?})` — returns the current `CompactView`. |
| FR-26 | `wait(condition: WaitCondition, timeoutMs?: number)` — waits for a condition. `WaitCondition` is a discriminated union: `{type: 'url', pattern: string}`, `{type: 'element', handle: string}`, `{type: 'networkIdle'}`. Returns `{ok, timedOut}`. |
| FR-27 | `open(url: string)` — navigates to URL. Validates URL is http/https; rejects file://, data://, javascript:. Returns `ActionResult`. |
| FR-28 | `back()`, `forward()` — navigate browser history. Return `ActionResult`. |
| FR-29 | `tabs.new(url?)`, `tabs.close(id?)`, `tabs.list()`, `tabs.switch(id)` — tab management. Return typed results. |
| FR-30 | Every action MUST be validated against the typed action enum before dispatch. Model output is never `eval`d; actions are dispatched only via the typed dispatch table. |
| FR-31 | Every action MUST refuse dispatch if the target handle is `stale`. Return `ActionResult` with `error.code = 'STALE_HANDLE'`. |
| FR-32 | Every action MUST be logged as a structured, replayable event with secrets redacted before logging. |

### 2.4 Anti-detection / Fingerprint (Component 4)

| ID | Requirement |
|---|---|
| FR-33 | The TLS ClientHello (JA3/JA4) MUST match the selected profile preset for the session. |
| FR-34 | The full profile MUST be internally coherent: TLS fingerprint, User-Agent, `Sec-CH-UA` Client Hints, WebGL renderer, canvas fingerprint noise, system fonts list, timezone, locale, and `Accept-*` headers must all describe the same plausible machine. |
| FR-35 | Remove all automation detection vectors: `navigator.webdriver` MUST be absent or `undefined`; no CDP runtime artifacts in the JS environment; `window.chrome` runtime object MUST be consistent with a real Chrome profile. |
| FR-36 | Ship at least one verified profile preset at M4: `chrome-130-linux-x86_64`. |
| FR-37 | A validation harness MUST check the assembled profile against known probes (JA3/JA4 echo server, header-order probe, JS-environment audit) before a session starts. |
| FR-38 | A session MUST NOT be marked "clean" if any coherence check fails. |
| FR-39 | Optional human-plausible timing: configurable typing cadence jitter and pointer path smoothing. Default: disabled. |

### 2.5 Privacy & data boundary (Component 5)

| ID | Requirement |
|---|---|
| FR-40 | Serialization, handle resolution, and all DOM work MUST happen on-device. |
| FR-41 | The ONLY bytes that leave the device are: (a) the compact view + user instruction sent to the configured model endpoint, and (b) HTTP requests made by the controlled Chromium browser to the target site. |
| FR-42 | Telemetry MUST be off by default. Any opt-in telemetry sends only anonymized step-count / latency aggregates; never page content or user data. |
| FR-43 | Profiles MUST be ephemeral by default. Persistence across sessions is explicit opt-in per profile. |
| FR-44 | Per-profile storage MUST be encrypted at rest (AES-256-GCM). |
| FR-45 | Credentials and tokens MUST never be placed in LLM context unless the user explicitly scopes a `login` action. They MUST be redacted from all logs and replay traces. |
| FR-46 | A single auditable code path in `privacy/` MUST report, per step, exactly which bytes are sent off-device. This MUST be covered by an automated test that fails if unexpected bytes are added to the outbound payload. |

### 2.6 Agent loop (Component 6)

| ID | Requirement |
|---|---|
| FR-47 | Parse the plain-language goal into a task structure before beginning the observe-act loop. |
| FR-48 | Loop: `observe()` → LLM chooses action → validate → dispatch → receive `ActionResult` → verify progress → repeat. |
| FR-49 | On `stale` handle or confidence < `config.agent.confidenceThreshold` (default `0.7`), re-observe and retry with bounded exponential backoff: max `config.agent.maxRetries` (default `3`), initial delay `config.agent.retryBackoffMs` (default `1000ms`). |
| FR-50 | Terminate the loop when: goal reached (LLM signals completion), step budget exhausted, or error threshold exceeded. |
| FR-51 | Emit a structured trace per run: `{goal, steps: [{action, handle, confidence, tokensUsed, latencyMs, result}], totalTokens, totalSteps, outcome}`. |
| FR-52 | Support concurrent runs: each run MUST use an isolated Chromium profile. No shared state between concurrent runs. |
| FR-53 | Enforce per-run resource budgets: `maxSteps` (default `50`), `maxTokensPerRun` (default `100,000`). Exceed either → terminate run, return structured error. |

### 2.7 Interfaces

| ID | Requirement |
|---|---|
| FR-54 | Expose a local TypeScript SDK (`interfaces/sdk`) with full typed access to the agent, action, and observe APIs. |
| FR-55 | Expose an MCP 2024-11 server (`interfaces/mcp`) with `stdio` transport, implementing `tools/list` and `tools/call` for every action in FR-17–FR-29 plus `observe` and `run_goal`. |
| FR-56 | Expose a CLI (`sepia run "..."`) that invokes the agent loop with a plain-language goal and prints the structured trace to stdout. |

---

## 3. Non-functional requirements

### 3.1 Performance & token budget

| ID | Requirement |
|---|---|
| NFR-1 | Median compact view ≤ 900 tokens on the 20-page corpus (measured with the `cl100k_base` / tiktoken encoder as a proxy for model token count). |
| NFR-2 | 95th-percentile compact view ≤ 1,500 tokens on the same corpus. |
| NFR-3 | ≥ 95% of genuinely interactive elements present in the compact view (measured against ground-truth element counts in the corpus). |
| NFR-4 | Page settle + serialization latency ≤ 3 seconds (p95) on a page with ≤ 200 DOM nodes. |
| NFR-5 | Handle resolution latency ≤ 50ms per action call. |

### 3.2 Concurrency & resource limits

| ID | Requirement |
|---|---|
| NFR-6 | Support ≥ 10 concurrent isolated sessions on a machine with 16GB RAM and 8 CPU cores. |
| NFR-7 | Per-session peak memory ≤ 512MB (Chromium process + sepia process combined). |
| NFR-8 | Default per-run step budget: 50 steps. Configurable up to 500. |
| NFR-9 | Default per-run token budget: 100,000 tokens. Configurable. |

### 3.3 Reliability

| ID | Requirement |
|---|---|
| NFR-10 | On ambiguous state or stale handle: stop and report; never act incorrectly. Fail closed. |
| NFR-11 | All timeouts are bounded. No unbounded loops in any layer. |
| NFR-12 | Action replay is deterministic: given the same handle map and input, the same action sequence MUST produce the same dispatch calls. |
| NFR-13 | Resilience: graceful behavior under slow networks (≥ 3s response), partial renders, dropped sessions, and model timeouts. In each case: stop, report structured error, clean up session. |

### 3.4 Observability

| ID | Requirement |
|---|---|
| NFR-14 | Structured logs: every step emits `{timestamp, sessionId, runId, stepN, action, handle, confidence, tokensUsed, latencyMs, result}`. |
| NFR-15 | Clear error taxonomy (see §5). Errors include `code`, `message`, and `handle` where applicable. |
| NFR-16 | `make dev` mode: optional verbose console output of each step without secrets. |

### 3.5 Example application

Rationale: a working example app is the fastest way for an AI engineer to evaluate Sepia. It must demonstrate the token-efficiency story, SDK ergonomics, and concurrency in one runnable command — no tutorial required.

Persona targeted: **AI engineer** building an agent pipeline (§1.2).

| ID | Requirement |
|---|---|
| NFR-17 | A self-contained example application MUST ship in `examples/research-assistant/` demonstrating end-to-end Sepia usage via the TypeScript SDK. |
| NFR-18 | The example MUST implement UC-2 (search and extract) and UC-5 (scale across N inputs): given a list of research queries as CLI arguments, it runs one Sepia agent session per query (concurrently, up to 5 at a time), extracts a structured summary, and emits a JSON report to stdout. |
| NFR-19 | The example MUST be runnable with a single command: `make run-example QUERIES="TypeScript generics,Rust ownership,Go channels"`. No setup beyond `make setup` and setting `SEPIA_MODEL_ENDPOINT` + `SEPIA_MODEL` env vars. |
| NFR-20 | During each run the example MUST print per-step token counts and confidence scores to stderr, giving a first-time evaluator a live view of Sepia's token-efficiency story. |
| NFR-21 | The example MUST support both a hosted model (Anthropic API: `SEPIA_MODEL=claude-sonnet-4-6`) and a local model (Ollama: `SEPIA_MODEL_ENDPOINT=http://localhost:11434/v1 SEPIA_MODEL=llama3.1`), selected entirely via environment variables — no code change required. |
| NFR-22 | The stdout JSON report MUST conform to the schema: `{ queries: [ { query: string, url: string, summary: string, tokensUsed: number, stepsUsed: number, confidence: number } ] }`. |
| NFR-23 | The example directory MUST include its own `README.md` explaining: the use case, the SDK calls it makes (`createAgent`, `agent.run`, `RunTrace`), how to interpret the token/confidence output, and how to extend it with a new query type. |
| NFR-24 | The example MUST be covered by an integration smoke test (`make test-example`) that runs it against the local fixture corpus (not the live internet) and asserts a schema-valid, non-empty JSON report is produced within 60 seconds. |

---

## 4. Security requirements & threat model

### 4.1 Assets

| Asset | Sensitivity | Protection |
|---|---|---|
| User credentials / session tokens | High | Encrypted at rest; never in LLM context; redacted from logs |
| Page content (may contain PII) | Medium | On-device only; not persisted by default |
| Model API keys | High | In config only; never logged; loaded from env or encrypted store |
| Host filesystem | High | No arbitrary FS access from agent layer; `open()` rejects non-http(s) URLs |
| Per-profile encrypted storage | High | AES-256-GCM; isolated per profile |

### 4.2 Adversaries and trust boundaries

**Trusted:** sepia process, host OS, explicitly configured model endpoint.

**Untrusted:** all page content, all model output (validated before dispatch), all external URLs, all external dependencies (pinned + scanned).

**Adversaries:**
- A-1: Malicious page injecting instructions into page text that influence model output (prompt injection).
- A-2: Malicious page using `file://`, `data://`, or `javascript:` URLs to access the host filesystem.
- A-3: Anti-bot detection systems fingerprinting the automation layer.
- A-4: Supply-chain attacks via compromised npm packages.
- A-5: Cross-profile data bleed between concurrent sessions.

### 4.3 Controls

| ID | Control | Addresses |
|---|---|---|
| SR-1 | Validate all model output against typed action enum before dispatch. Never `eval`. | A-1 |
| SR-2 | Sanitize page content before placing in LLM prompt. Strip or escape any content that resembles a system prompt injection. | A-1 |
| SR-3 | `open()` validates scheme: accept only `http:` and `https:`. Reject `file:`, `data:`, `javascript:`, `blob:`. | A-2 |
| SR-4 | Process isolation: each session runs in a separate Chromium profile directory with OS-level process isolation. | A-5 |
| SR-5 | No cross-profile shared storage. Each profile has its own encrypted directory. Automated cross-profile leak test in CI. | A-5 |
| SR-6 | Pin all dependencies to exact versions. Commit lockfile. Run `npm audit` + Dependabot in CI. Fail build on known-critical CVEs. | A-4 |
| SR-7 | Credentials and tokens redacted from all logs and traces. Secret redaction covered by automated test. | A-1, A-5 |
| SR-8 | Validation harness runs before session start; session does not start if fingerprint coherence fails. | A-3 |
| SR-9 | Track Chromium patch set against upstream CVEs via `make security` (SAST + Chromium CVE feed check). | A-4 |
| SR-10 | Per-domain rate limiting hooks and `robots.txt` awareness hooks — disabled by default, configurable by operator. | Responsible use |

### 4.4 Dependency policy

- Pin every dependency to an **exact version** (no `^`, `~`, `*`, `latest`).
- Pin to the **latest stable release** at adoption time. No pre-release, alpha, beta, RC, or nightly builds unless a capability forces it; document exceptions inline.
- Commit `pnpm-lock.yaml` so builds are byte-reproducible.
- Pin the Node.js version in `.nvmrc` and in the CI workflow.
- Pin CI action versions by SHA.
- Pin base Docker images by digest.
- Renovate bot opens upgrade PRs; each must pass `make ci` before merge.

---

## 5. Interfaces & contracts

### 5.1 Compact view schema

```typescript
type Verbosity = 'minimal' | 'standard' | 'full';

interface CompactView {
  url: string;
  title: string;
  verbosity: Verbosity;
  tokenCount: number;       // estimated token count (informational)
  timestampMs: number;
  nodes: CompactNode[];
}

interface CompactNode {
  handle?: string;          // e.g. "e12" — present only on interactive nodes
  role: string;             // ARIA role
  name: string;             // accessible name
  value?: string;           // current value (inputs, selects)
  state?: NodeState;
  indent: number;           // nesting depth in the visual outline
  children?: CompactNode[]; // used only in 'full' verbosity
}

interface NodeState {
  enabled?: boolean;
  checked?: boolean;
  required?: boolean;
  expanded?: boolean;
  selected?: boolean;
}
```

### 5.2 Action result schema

```typescript
interface ActionResult {
  ok: boolean;
  viewDelta?: CompactView;  // portion of view that changed; omitted if no visible change
  confidence: number;       // 0.0–1.0; confidence of handle resolution
  error?: ActionError;
}

type ErrorCode =
  | 'STALE_HANDLE'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_DISABLED'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_URL'
  | 'PROMPT_INJECTION_DETECTED'
  | 'UNKNOWN';

interface ActionError {
  code: ErrorCode;
  message: string;
  handle?: string;
}
```

### 5.3 Semantic fingerprint schema (resolver internals)

```typescript
interface SemanticFingerprint {
  role: string;
  accessibleName: string;
  inputType?: string;
  stableAttrs: {
    id?: string;
    name?: string;
    dataTestId?: string;
    ariaLabel?: string;
  };
  normalizedNearbyLabel?: string;
  ordinalAmongSameRole: number;
}

interface HandleRecord {
  handle: string;                  // e.g. "e12"
  fingerprint: SemanticFingerprint;
  confidence: number;
  stale: boolean;
  lastSeenMs: number;
}
```

### 5.4 Config schema

```typescript
interface SepiaConfig {
  model: {
    endpoint: string;              // e.g. "https://api.anthropic.com" or "http://localhost:11434/v1"
    model: string;                 // e.g. "claude-sonnet-4-6"
    apiKey?: string;               // loaded from env; never logged
    maxTokensPerStep: number;      // default: 100000
  };
  browser: {
    executablePath?: string;       // path to patched Chromium; falls back to Playwright bundled binary
    profile: string;               // fingerprint preset, e.g. "chrome-130-linux-x86_64"
    headless: boolean;             // default: true
    ephemeral: boolean;            // default: true
    humanTiming: boolean;          // default: false — typing/pointer jitter
  };
  agent: {
    maxSteps: number;              // default: 50
    maxTokensPerRun: number;       // default: 100000
    verbosity: Verbosity;          // default: 'standard'
    retryBackoffMs: number;        // default: 1000
    maxRetries: number;            // default: 3
    confidenceThreshold: number;   // default: 0.7 — below this, re-observe before acting
  };
  privacy: {
    telemetry: boolean;            // default: false
  };
  security: {
    allowedDomains?: string[];     // if set, agent may only navigate to these domains
    robotsAwareness: boolean;      // default: false — when true, respect robots.txt
    rateLimitMs?: number;          // minimum ms between requests to the same domain
  };
}
```

### 5.5 Run trace schema

```typescript
interface RunTrace {
  runId: string;
  goal: string;
  sessionId: string;
  startMs: number;
  endMs: number;
  outcome: 'success' | 'budget_exceeded' | 'error' | 'stale_bail';
  totalSteps: number;
  totalTokens: number;
  steps: StepTrace[];
}

interface StepTrace {
  stepN: number;
  action: string;            // action name, e.g. "click"
  handle?: string;
  confidence: number;
  tokensUsed: number;
  latencyMs: number;
  result: ActionResult;
  secretsRedacted: boolean;
}
```

### 5.6 MCP server surface (MCP 2024-11, stdio transport)

The `interfaces/mcp` server exposes these tools:

| Tool name | Description | Maps to |
|---|---|---|
| `sepia_run` | Run a plain-language goal end-to-end | Agent loop (FR-47–FR-53) |
| `sepia_open` | Navigate to URL | FR-27 |
| `sepia_observe` | Return current compact view | FR-25 |
| `sepia_click` | Click a handle | FR-17 |
| `sepia_type` | Type text into a handle | FR-18 |
| `sepia_select` | Select an option by handle | FR-19 |
| `sepia_check` | Check/uncheck a handle | FR-20 |
| `sepia_scroll` | Scroll page or to handle | FR-22 |
| `sepia_press` | Send keyboard event | FR-23 |
| `sepia_read` | Read full text of a handle | FR-24 |
| `sepia_wait` | Wait for a condition | FR-26 |
| `sepia_back` | Navigate back | FR-28 |
| `sepia_forward` | Navigate forward | FR-28 |

Each tool's input/output schema is the typed contract from §5.2 serialized as JSON Schema.

### 5.7 SDK surface

```typescript
// interfaces/sdk/index.ts
export interface SepiaSession {
  observe(opts?: { verbosity?: Verbosity }): Promise<CompactView>;
  click(handle: string): Promise<ActionResult>;
  type(handle: string, text: string, opts?: { submit?: boolean }): Promise<ActionResult>;
  select(handle: string, option: string): Promise<ActionResult>;
  check(handle: string, checked: boolean): Promise<ActionResult>;
  hover(handle: string): Promise<ActionResult>;
  scroll(target: 'up' | 'down' | string, distance?: number): Promise<ActionResult>;
  press(key: string): Promise<ActionResult>;
  read(handle: string): Promise<{ ok: boolean; text?: string; error?: ActionError }>;
  wait(condition: WaitCondition, timeoutMs?: number): Promise<{ ok: boolean; timedOut: boolean }>;
  open(url: string): Promise<ActionResult>;
  back(): Promise<ActionResult>;
  forward(): Promise<ActionResult>;
  tabs: TabsAPI;
  close(): Promise<void>;
}

export interface SepiaAgent {
  run(goal: string): Promise<RunTrace>;
}

export function createSession(config: SepiaConfig): Promise<SepiaSession>;
export function createAgent(config: SepiaConfig): SepiaAgent;
```

---

## 6. Acceptance criteria

### AC-Serializer (validates M1)

| AC | Criterion | Test |
|---|---|---|
| AC-S1 | Median token count ≤ 900 across 20-page corpus | `test-tokens`: measure token count per corpus page; assert median ≤ 900 |
| AC-S2 | 95th-percentile token count ≤ 1,500 across 20-page corpus | `test-tokens`: assert p95 ≤ 1500 |
| AC-S3 | ≥ 95% of ground-truth interactive elements present in compact view | `test-tokens`: compare compact view handles to labelled ground-truth; assert ≥ 95% coverage |
| AC-S4 | Serializer output is deterministic for same input | Unit test: call serializer twice with same AX+DOM snapshot; assert identical output |
| AC-S5 | DOM-fallback mode activates when AX tree yields < 5 interactive nodes | Unit test: synthetic sparse-AX page; assert interactive nodes still appear in output |

### AC-Resolver (validates M2)

| AC | Criterion | Test |
|---|---|---|
| AC-R1 | Handle survives DOM reorder with confidence ≥ 0.8 | `test-mutation`: reorder sibling nodes; assert same handle, confidence ≥ 0.8 |
| AC-R2 | Handle survives class-name / style swap with confidence ≥ 0.8 | `test-mutation`: swap CSS classes, change wrapper div; assert same handle |
| AC-R3 | Genuinely removed element returns `stale: true` | `test-mutation`: remove element; assert handle is `stale` |
| AC-R4 | Resolution is deterministic | Unit test: re-run resolution on same snapshot; assert identical handle map |
| AC-R5 | Icon-only button (no accessible name) handled gracefully | Unit test: synthetic page with unlabelled icon buttons; assert fallback fingerprint assigned, no crash |

### AC-Actions (validates M3)

| AC | Criterion | Test |
|---|---|---|
| AC-A1 | Every action returns `{ok, confidence, error?}`; stale handle returns error code `STALE_HANDLE` | Contract test for each of FR-17–FR-29 |
| AC-A2 | `open()` rejects non-http(s) URLs with `error.code = 'INVALID_URL'` | Unit test: `open('file:///etc/passwd')` → error |
| AC-A3 | Model output is never eval'd; action dispatched only via typed enum | Static analysis + unit test: mock model output with arbitrary JS string; assert only typed dispatch runs |
| AC-A4 | Action logs are replayable and secrets are redacted | Integration test: run a login action; assert `password` field is redacted in trace |

### AC-Agent (validates M3)

| AC | Criterion | Test |
|---|---|---|
| AC-AG1 | Agent completes UC-1 (login) on a fixture login page | E2E integration test against local fixture server |
| AC-AG2 | Agent completes UC-3 (fill form) on a fixture form page | E2E integration test against local fixture server |
| AC-AG3 | Agent stops on budget exhaustion and returns `outcome: 'budget_exceeded'` | Integration test: set `maxSteps=2` on a complex task |
| AC-AG4 | Agent retries on stale handle, up to `maxRetries`, then stops | Integration test: synthetic stale-handle fixture |

### AC-Fingerprint (validates M4)

| AC | Criterion | Test |
|---|---|---|
| AC-F1 | JA3 fingerprint matches Chrome 130 on Linux x86_64 | `test-fingerprint`: connect to JA3-echo server; assert hash matches expected value |
| AC-F2 | JA4 fingerprint matches Chrome 130 on Linux x86_64 | `test-fingerprint`: connect to JA4-echo server; assert hash matches expected value |
| AC-F3 | `navigator.webdriver` is absent or `undefined` | `test-fingerprint`: JS probe inside Chromium; assert webdriver absent |
| AC-F4 | Full cross-signal coherence: UA, Client Hints, WebGL, canvas, fonts, timezone, locale all describe same profile | `test-fingerprint`: run coherence harness; all probes pass |
| AC-F5 | Session does not start if any coherence check fails | Unit test: inject a mismatched UA; assert session start throws |

### AC-Example (validates M3 + M5)

| AC | Criterion | Test |
|---|---|---|
| AC-E1 | `make run-example QUERIES="TypeScript generics,Rust ownership"` completes with no unhandled error | `make test-example` smoke test against fixture corpus |
| AC-E2 | Stdout JSON report matches schema: `{queries:[{query,url,summary,tokensUsed,stepsUsed,confidence}]}` | `make test-example`: parse and validate output with the schema; fail on missing fields |
| AC-E3 | Works with `SEPIA_MODEL_ENDPOINT=http://localhost:11434/v1` (local Ollama) — no API key required | `make test-example` run with env pointing to fixture model stub; no import of Anthropic SDK hardcoded |
| AC-E4 | Per-step token counts and confidence scores appear on stderr during the run | `make test-example`: assert stderr contains at least one `tokensUsed` and `confidence` line per step |
| AC-E5 | Concurrent cap of 5 sessions is respected: with 10 queries, no more than 5 Chromium processes run simultaneously | `make test-example`: instrument session pool; assert concurrent high-water mark ≤ 5 |

### AC-Privacy (validates M5)

| AC | Criterion | Test |
|---|---|---|
| AC-P1 | Only compact view + instruction leave the device | `test-boundary`: intercept all outbound network calls from sepia process; assert only model endpoint receives sepia-originated data |
| AC-P2 | Credentials never appear in LLM context | `test-boundary`: run login flow; assert password string absent from all model API call payloads |
| AC-P3 | No cross-profile data bleed | `test-leak`: run two concurrent sessions; assert profile A's cookies/storage absent from profile B's context |
| AC-P4 | Secret redaction in logs | Unit test: action with credential; assert log output contains `[REDACTED]` in place of secret |

---

## 7. Architecture

### 7.1 Stack

| Layer | Technology | Version | Rationale |
|---|---|---|---|
| Runtime | Node.js | 22.11.0 LTS (pinned) | LTS support; matches Playwright requirements |
| Language | TypeScript | 5.6.3 (pinned) | Type safety; Playwright native; best AX tree ecosystem |
| Browser driver | Playwright | 1.48.2 (pinned) | Mature AX tree API; CDP session access; `executablePath` override |
| Chromium base | ungoogled-chromium | Pinned to Chrome 130 major | Maintained patch-rebase workflow; strips Google integrations |
| Automation patches | rebrowser-patches | Pinned to matching Chromium version | Removes CDP/WebDriver detection artifacts |
| TLS patches | Custom BoringSSL cipher-suite patch | In `patches/` | JA3/JA4 matching Chrome 130 on Linux |
| Package manager | pnpm | 9.12.3 (pinned) | Lockfile; workspace support; disk-efficient |
| Test framework | Vitest | 2.1.8 (pinned) | Fast; TypeScript-native; coverage via V8 |
| Lint | ESLint + typescript-eslint | 9.15.0 + 8.17.0 (pinned) | Enforces no-eval, naming conventions, import direction |
| Type check | tsc | (from TypeScript above) | `--noEmit --strict` |
| SAST | CodeQL | GitHub Actions (SHA-pinned) | Catches injection and unsafe patterns |
| SCA | `pnpm audit` + Renovate | Renovate config pinned | Dependency vulnerability scanning; upgrade PRs |
| Tokenizer (test) | tiktoken (cl100k_base) | 0.7.0 (pinned) | Token-budget acceptance test proxy |

### 7.2 Module map and dependency direction

```
sepia/
  cli/            CLI entry point — wiring + config loading only
  agent/          Natural-language loop (ONLY LLM-touching module)
  actions/        Typed action enum + validation + dispatch
  serializer/     AX+DOM → compact view (pure, deterministic, no LLM)
  resolver/       Semantic-fingerprint handles + re-resolution (pure, deterministic, no LLM)
  engine/         Chromium/Playwright lifecycle + page settle detection
  fingerprint/    Profile presets + JA3/JA4 validation harness
  privacy/        Data-boundary auditor + secret redaction
  config/         Typed config schema + defaults
  telemetry/      Structured logging + per-step metrics (off by default)
  interfaces/
    sdk/          Local TypeScript library API
    mcp/          MCP 2024-11 server (stdio)
examples/
  research-assistant/   SDK demo: batch research queries → JSON report (AI engineer persona)
    README.md           Use case, SDK calls, output format, extension guide
    src/index.ts        Entry point — createAgent, concurrent session pool, JSON reporter
    package.json        Own dependencies (pinned); inherits sepia SDK from workspace
tests/
  unit/           Per-module unit tests (mirrors module tree)
  contract/       Action API contract tests
  integration/    E2E tests against fixture servers
  example/        Smoke test for examples/research-assistant (make test-example)
  token-budget/   20-page corpus token + coverage tests
  mutation/       Handle stability mutation suite
  fingerprint/    JA3/JA4 + coherence harness
  cross-profile/  Cross-profile leak tests
  data-boundary/  Outbound byte audit tests
  resilience/     Slow network, partial render, dropped session tests
fixtures/
  corpus/         20-page static HTML corpus (checked in)
  mutation/       DOM mutation test cases
  fingerprint/    Known JA3/JA4 probe payloads
patches/
  README.md       Patch application instructions
  *.patch         Ordered patch files (ungoogled-chromium → rebrowser → BoringSSL → coherence)
```

**One-way dependency rule (enforced by ESLint import/no-restricted-paths):**

```
interfaces/* → agent
cli          → agent, config
agent        → actions, serializer, resolver, engine, privacy, telemetry, config
actions      → engine, resolver, config
engine       → fingerprint, config
serializer   → (no sepia imports)
resolver     → (no sepia imports)
fingerprint  → (no sepia imports)
privacy      → (no sepia imports)
telemetry    → (no sepia imports)
config       → (no sepia imports)
```

`serializer`, `resolver`, `fingerprint`, `privacy`, `telemetry`, `config` are at the bottom of the dependency graph. They never import from `agent`, `actions`, `engine`, or `interfaces`.

### 7.3 Chromium patch strategy

```
patches/
  001-ungoogled-chromium.patch     Strip Google integrations (upstream ungoogled-chromium)
  002-rebrowser.patch              Remove CDP/WebDriver runtime leaks
  003-boring-ssl-ja3.patch         Cipher-suite order matching Chrome 130 on Linux x86_64
  004-profile-coherence.patch      UA, Client Hints, canvas noise, WebGL renderer string
```

**Apply order:** 001 → 002 → 003 → 004. Each patch is idempotent; `make patch` applies all in order.

**Maintenance policy:**
- Patches tracked in `patches/` as unified diffs against the pinned ungoogled-chromium tag.
- `make chromium-build` applies patches, builds Chromium, and places the binary at `bin/chromium`.
- CI runs a nightly `make patch-check` that applies patches to the current tag and alerts on failure.
- When a new Chromium major version is adopted: create a new patch branch, rebase all four patch files, update the pinned version in `package.json`, run the full fingerprint harness to validate.
- Track the Chromium CVE feed; `make security` fails if an open critical CVE is present in the pinned version.

### 7.4 Data flow (per step)

```
User / upstream LLM
  │  plain-language goal
  ▼
[cli / interfaces/sdk / interfaces/mcp]
  │  SepiaAgent.run(goal)
  ▼
[agent]
  │  observe()
  ▼
[engine]  —→  Chromium (patched, ephemeral profile)
  │              page.waitForLoadState('networkidle')
  │              page.accessibility.snapshot()  +  page DOM snapshot
  ▼
[serializer]  AX+DOM → CompactView  (pure, deterministic)
  │
[resolver]    assign/re-resolve handles  (pure, deterministic)
  │
CompactView returned to [agent]
  │
[agent]  —→  LLM API call  (compact view + goal + history)
  │              model returns: {action, handle, params}
  ▼
[actions]  validate against typed enum  (no eval)
  │         resolver.resolve(handle) — check confidence + stale
  ▼
[engine]  execute action in Chromium
  │
[privacy]  audit outbound bytes (synchronous, per step)
  │
[telemetry]  emit structured log event
  │
ActionResult → [agent] → next step or terminate
```

---

## 8. Milestones

### M0 — Scaffolding

**Deliverables:**
- Repository layout matching §7.2 (empty module directories, index files with stub exports)
- `Makefile` with all targets from the build prompt (setup, build, run, dev, test-*, lint, fmt, typecheck, security, ci, clean)
- `README.md` per spec
- `CLAUDE.md` — AI agent operating guide
- `SKILLS.md` — agent skills catalog
- `CONTRIBUTING.md`
- `SECURITY.md`
- `LICENSE` (MIT, already committed)
- `pnpm-lock.yaml` committed; all deps pinned to exact versions
- `.nvmrc` pinned to Node.js 22.11.0
- ESLint config enforcing: one-way imports, no-eval, naming convention (`sepia`)
- TypeScript `tsconfig.json` with `strict: true`
- Vitest config
- CI workflow (GitHub Actions): `make ci` on push + PR
- Renovate config

**Acceptance test:** `make ci` passes on an empty skeleton (no implementation, stubs only). ESLint import-direction rule blocks a test violation.

---

### M1 — Serializer

**Deliverables:**
- `serializer/` module: AX+DOM → CompactView; pure, deterministic, no LLM
- DOM-fallback mode (FR-8)
- Verbosity knob (FR-7)
- 20-page corpus checked into `fixtures/corpus/` with ground-truth element labels
- `tests/token-budget/` suite: token count + element coverage for each corpus page
- Unit tests for serializer (determinism, pruning rules, DOM-fallback activation)

**Acceptance tests:** AC-S1 through AC-S5 all pass in CI.

---

### M2 — Resolver

**Deliverables:**
- `resolver/` module: semantic fingerprint derivation + weighted best-match re-resolution
- Handle→fingerprint session map with `stale` detection
- Confidence scoring
- `fixtures/mutation/` test cases: reorder, class-swap, element removal, icon-only buttons
- `tests/mutation/` suite

**Acceptance tests:** AC-R1 through AC-R5 all pass in CI.

---

### M3 — Action API + Agent loop

**Deliverables:**
- `actions/` module: typed action enum + dispatch + stale guard + log-with-redaction
- `engine/` module: Playwright lifecycle wrapper + page settle detection + CDP session bridge
- `agent/` module: plan-observe-act-verify loop + structured trace
- `interfaces/sdk/` and `interfaces/mcp/` (MCP 2024-11 stdio)
- `cli/` entry point: `sepia run "..."`
- `examples/research-assistant/` — SDK demo for the AI engineer persona (NFR-17–24): concurrent batch research queries → JSON report; supports hosted and local model via env vars
- `make run-example` and `make test-example` Makefile targets
- Fixture local HTTP servers for E2E tests (login page, form page, search-results page)
- `tests/contract/`, `tests/integration/`
- `tests/example/` smoke test suite
- `tests/resilience/` (slow network, dropped session, model timeout)
- `tests/data-boundary/` (outbound byte audit)

**Acceptance tests:** AC-A1 through AC-A4, AC-AG1 through AC-AG4, AC-E1 through AC-E5, AC-P1 through AC-P4.

---

### M4 — Fingerprint layer

**Deliverables:**
- `fingerprint/` module: profile presets, coherence harness, pre-session validation
- `patches/001-003` applied and buildable: ungoogled-chromium + rebrowser + BoringSSL JA3/JA4
- `patches/004` coherence patch: UA, Client Hints, WebGL, canvas, fonts, timezone
- Verified preset: `chrome-130-linux-x86_64`
- `make chromium-build` target
- `tests/fingerprint/` suite: JA3/JA4 echo, JS-env probes, coherence harness
- Human-timing layer (disabled by default)

**Acceptance tests:** AC-F1 through AC-F5.

---

### M5 — Privacy, security & scale

**Deliverables:**
- Local-model path: Ollama-compatible OpenAI REST endpoint in config
- Ephemeral profiles enforced by default; opt-in persistence with AES-256-GCM encrypted storage
- `privacy/` data-boundary auditor complete with automated test
- Cross-profile isolation enforced; automated leak test in CI
- Concurrent sessions (≥ 10): session pool, isolated profile directories
- `tests/cross-profile/` suite
- Full `make security` gate: CodeQL SAST + `pnpm audit` fail-on-critical
- Renovate bot configured for automated dependency upgrade PRs
- Per-domain rate limiting and `robots.txt` hooks (disabled by default)
- All security tests gate merges in CI

**Acceptance tests:** AC-P1 through AC-P4, NFR-6 (10 concurrent sessions validated by load test).

---

*End of Phase 1 specification. Awaiting maintainer approval before Phase 2 (Scaffolding / M0) begins.*
