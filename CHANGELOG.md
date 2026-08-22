# Changelog

All notable changes to Sepia are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

- **`/metrics` did not count authentication failures.** `checkAuth()` returned before `totalRequests++`, so rejected requests appeared in neither `totalRequests` nor `totalErrors` — credential stuffing against `POST /run` was invisible to an operator. Rejections now increment a separate `totalUnauthorized` counter exposed via `/metrics`; the existing counters keep their meaning (accepted requests, and failures of processed runs). (AC-I1)
- **Distinct elements no longer share a handle.** `assignHandle()` reused an existing handle whenever a fuzzy similarity score exceeded 0.85. Elements sharing a role and accessible name within ~4 ordinal positions collapsed together: 20 identical "Delete" buttons produced 5 handles, and handles were not stable across two observations of an unchanged page. Identity is now exact (role + accessible name + stable attributes + ordinal among identically-named same-role siblings). (AC-R6)
- **Actions hit the element the handle denotes.** Every engine action resolved its target with `getByRole(role, {name}).first()`, so on a list of identically-labelled controls each handle acted on the first match regardless of which was requested. Execution now targets the handle's own ordinal. (AC-R7)
- **`agent.confidenceThreshold` is enforced.** It was declared in config and read by nothing. `gateHandle()` now refuses to act below it, returning `LOW_CONFIDENCE`. (AC-AG6)
- **A run can return an answer.** The `done` action's `summary` was parsed and discarded, so a run had no result. `RunTrace.answer` now carries it. (AC-AG5)
- **Retries carry corrective feedback.** A model returning unparseable JSON was re-sent a byte-identical request. Retries now state what was wrong. (AC-AG8)
- **The fingerprint profile is actually applied.** Nothing outside tests called `getPreset()` or `validateAndStart()`; sessions ran with stock settings and `navigator.webdriver === true`. The default preset also claimed Chrome 130 while the bundled browser was Chrome 149. (AC-F6)
- **Page content is redacted before reaching the model.** `redactSecrets()` only ran on the model's own output to set a boolean flag. (AC-P5)
- **HTTP server hardened.** `POST /run` merged a caller-supplied `config` straight into the run config, exposing `browser.executablePath` (launch an arbitrary local binary) and `model.endpoint` (redirect scraped content to an attacker). Auth was optional, the request body was read unbounded, and the concurrency check was separated from its increment by an `await`, so the cap could be exceeded. (SR-11)
- **CSS selector injection.** The click fallback interpolated page-controlled accessible names into an attribute selector unescaped.
- **`sepia mcp` exists.** The README documented it; the CLI only handled `run` and `serve`.
- **Observation cost bounded.** `settle()` waited up to 8s for network-idle every observation; on a page that never goes idle three observations cost 24s, now ~3s. The CDP session is reused instead of reattached per call. (AC-R8)
- **`done` no longer always reports success.** `done` was the only terminal action and unconditionally set `outcome: 'success'`, so a model that could not complete the goal had no honest way to say so. The typed `abort` action now ends the run as `outcome: 'unable'`, with the model's `reason` surfaced as `RunTrace.answer`; CLI/HTTP callers observe exit `1` / HTTP `422` instead of a false success. (AC-AG9)
- **System prompt advertised only 4 of 18 implemented actions.** `select`, `check`, `hover`, `scroll`, `press`, `read`, `observe`, `wait`, `back`, `forward`, and `tabs.*` were implemented and validated but unreachable — the model was never told they existed. Both system prompts now advertise the full dispatchable action set with field notes; `screenshot` stays operator/SDK-only and is deliberately kept out of the model context. (AC-A10)
- **No loop detection — repeated identical actions burned the step budget.** A model stuck on a dead element (unresponsive button, unopened modal, CAPTCHA) re-issued the same action until `maxSteps` ran out. New `agent.loopThreshold` (default `3`, bounded `[2, 20]`): when the identical action — keyed on the whole validated payload, so `scroll down 200` and `scroll up 900` stay distinct — repeats that many consecutive times with an unchanged `hashView()` of the observed view, the run stops early with `outcome: 'unable'` and a diagnostic `answer`. Pairs with issue #5's `unable` path; CLI/HTTP callers see `exit 1` / HTTP `422` with zero caller-side changes. (AC-AG10)

### Added

- **`abort` terminal action.** Typed `{"action":"abort","reason":"..."}` alongside `done`, validated at the boundary (`parseTerminalAction`) and never dispatched to the engine; both system prompts advertise when to use it. (AC-A9)
- **`screenshot` action** across engine, action enum, SDK, and MCP. Writes a PNG to a path or returns base64; never enters the model context. (AC-A6)
- **Real tokenizer.** `estimateTokens()` uses `cl100k_base` via `tiktoken` (promoted to a runtime dependency), falling back to `characters / 4` only if it cannot load. Counts run ~35% higher than the old estimate on realistic lines. (AC-S7)
- **Action schema validation.** `parseAction()` validates required fields and field types instead of casting. (AC-A5)
- **`stale_bail` outcome** is now produced when stale or low-confidence retries are exhausted. (AC-AG7)
- **`pruneHandleMap()`** bounds the handle map on long single-origin sessions. (AC-R8)
- **`--answer-only`** CLI flag; **`--allow-unauthenticated`** serve flag; `browser.settleTimeoutMs` config.
- **Helm `serverAuth`** values for the now-mandatory HTTP bearer token.

### Changed

- **BREAKING — the HTTP server requires authentication.** It refuses to start unless `SEPIA_SERVER_API_KEY` is set or `--allow-unauthenticated` / `SEPIA_ALLOW_UNAUTHENTICATED=true` is passed. Helm deployments must set `serverAuth.existingSecret` or `serverAuth.allowUnauthenticated`.
- **BREAKING — `startServer()` returns the `http.Server`** instead of `void`.
- **BREAKING — `SepiaEngine` and `SepiaSession` gained `screenshot`**; custom implementations must add it.
- **`HandleRecord` gained `lastSeenSeq`**, and `SemanticFingerprint` gained `ordinalAmongSameRoleAndName`.
- Default `browser.profile` is now `chrome-149-linux-x86_64`, matching the bundled browser.
- Documentation corrected against the code: the JA3/JA4 patch set is not in this repository, the corpus is 5 synthetic fixtures rather than 20 pages, `stableAttrs` are not populated by the default engine path, and there is no lint rule enforcing `sepia` casing.

### Added

#### Security (SR-10)

- **Per-domain rate limiting** — `security.rateLimitMs` config field (env: `SEPIA_RATE_LIMIT_MS`). When set, `engine.open()` waits the minimum interval between navigations to the same hostname. Uses a per-hostname last-request clock; independent domains are tracked separately.
- **robots.txt awareness** — `security.robotsAwareness` config field (env: `SEPIA_ROBOTS_AWARENESS=true`). When enabled, `engine.open()` fetches and caches the target domain's `robots.txt` before navigating. URLs matched by `Disallow:` return `{ ok: false, error: { code: 'ROBOTS_DISALLOWED' } }`. Robots.txt is fetched with a 5-second timeout; any network failure fails open (navigation proceeds). Cache TTL: 5 minutes.
- **`Crawl-delay` respected as rate-limit floor** — when `robotsAwareness` is enabled and the robots.txt specifies a `Crawl-delay`, that value is used as the minimum interval if it is larger than `rateLimitMs`.
- **`security/index.ts`** — new module: `createRateLimiter()`, `createRobotsCache(agentName?)`, `parseRobotsForAgent()` (exported for testing), `isPathAllowed()`. Pure module — no browser, no LLM calls. Added to `eslint.config.mjs` core module list; cannot import from upper layers.
- **`ROBOTS_DISALLOWED` error code** — added to `ErrorCode` union in `types/index.ts`.
- **30 new unit tests** in `tests/unit/security.test.ts` — covers parser (wildcard/named agent, CRLF, comments, specificity), path-matching rules (longest-match, Allow-beats-Disallow), rate-limiter timing, and robots cache (mocked fetch, fail-open, TTL, crawl-delay, named agent priority).

---

## [0.2.0] — 2026-07-21

### Added

#### Observability

- **Structured JSON logging** — `createLogger()` now accepts `format: 'json'` (or set `SEPIA_LOG_FORMAT=json`). In JSON mode every log line is a newline-delimited JSON object `{ts, level, message, ...meta}` compatible with log aggregation pipelines (Loki, Datadog, CloudWatch, etc.). Default format remains human-readable text.
- **`GET /metrics` endpoint** — HTTP server now exposes `/metrics` returning `{ok, uptimeMs, inflight, maxConcurrent, totalRequests, totalErrors}`. No auth required (metrics are not sensitive); suitable for Prometheus scraping via a sidecar or simple health monitors.

#### Auth / multi-tenancy

- **HTTP server API key** — Set `SEPIA_SERVER_API_KEY` to require `Authorization: Bearer <key>` on `POST /run`. Returns `401 UNAUTHORIZED` when the key is set and the header is missing or wrong. When the env var is unset, the server remains open (backward compatible). The upstream model key (`SEPIA_API_KEY`) is unaffected.

#### Session persistence

- **`browser.profileStorePath`** config field — When `browser.ephemeral: false` and `browser.profileStorePath` is set, each agent run reuses a named Chromium profile directory (`<storePath>/<sessionId>/`) across runs. Cookies, localStorage, IndexedDB, and service-worker registrations survive between sessions. Implemented via `chromium.launchPersistentContext()`.
- **`createNamedProfile(name, storePath)`** — New export from `privacy/index.ts`. Creates or reuses `storePath/name/` and returns it as a `SessionProfile`.

#### Model compatibility (SLM support)

- **Prompt styles** — `model.promptStyle: 'default' | 'minimal'`. The `minimal` variant is shorter and more schema-explicit for small models (≤ 7B). Set via `SEPIA_PROMPT_STYLE=minimal`.
- **JSON mode** — `model.jsonMode: boolean` adds `response_format: {type: "json_object"}` to model calls for models that require it. Set via `SEPIA_JSON_MODE=true`.
- **JSON repair and retry** — `repairJson()` in the agent strips markdown code fences and trailing commas before retrying parse failures. Up to `agent.maxRetries` attempts per step.
- **Message history sliding window** — `agent.maxHistorySteps` (default: 10) keeps the last N user/assistant pairs in context so long tasks don't overflow small context windows.
- **Token estimation fallback** — `model.tokenEstimation: 'api' | 'local' | 'auto'`. In `auto` mode (default), uses API-reported token counts; falls back to the serializer's `estimateTokens()` heuristic when a local model returns `null` usage.

#### Training and fine-tuning

- **`training/index.ts`** — New module. `exportToShareGPT()` and `exportToAlpaca()` convert `RunTrace[]` to JSONL training datasets. `parseTraceJSONL()` deserializes trace files. Skips failed runs and steps with `secretsRedacted: true`.
- **`make export-traces`** — Makefile target: `make export-traces TRACE_FILE=traces.jsonl OUT_DIR=out/training` writes `sharegpt.jsonl` and `alpaca.jsonl`.

#### LiteLLM integration

- **`docs/litellm.md`** — Full integration guide: quickstart, config file reference, fallback chains, model names, JSON mode for SLMs, cost tracking, Kubernetes sidecar, Ollama load balancing.
- **`config/litellm.yaml`** — Example LiteLLM proxy config (Anthropic, OpenAI, Ollama, Groq).
- **`make litellm-start` / `make litellm-stop`** — Start/stop the LiteLLM Docker proxy using `config/litellm.yaml`.
- **Helm sidecar** — `helm/sepia/values.yaml` and `templates/deployment.yaml` updated with `litellm.enabled`, `litellm.image`, `litellm.port`, `litellm.configSecret`, `litellm.defaultModel`. When enabled, Sepia's `SEPIA_MODEL_ENDPOINT` is automatically overridden to `http://localhost:4000/v1`.

#### Helm chart testing

- **`helm/sepia/tests/`** — `helm unittest` test suite for all three chart templates (Deployment, Service, HPA). 20 test cases covering: image defaults, port exposure, health probe paths, replica/HPA interaction, sandbox flag injection, secret key ref wiring, LiteLLM sidecar toggling, and volume mounts.
- **`make helm-test`** — Runs `helm unittest` (installs the plugin if not present).
- **CI** — New `helm` job in `.github/workflows/ci.yml` runs `helm lint` + `helm unittest` on every push and PR. Added to the CI gate.

### Changed

- **`GET /health`** — `version` field bumped to `0.2.0`.
- **Docker** publish pipeline now triggers on `v*` tag pushes (was already wired; `v0.1.0` is the first tag that will trigger it).

### Infrastructure

- Node 24.18.0, Playwright 1.61.1 (Chrome 149), TypeScript 5.9.3, vitest 3.2.7
- CDP AX snapshot migration (`engine/index.ts`): replaced removed `page.accessibility.snapshot()` with `Accessibility.getFullAXTree` via CDP
- `chrome-149-linux-x86_64` fingerprint preset for Playwright 1.61 headless shell coherence tests
- Pre-commit hook (husky + lint-staged): ESLint + Prettier on staged files
- All GitHub Actions SHAs updated to Node-24-compatible versions

---

## [0.1.0] — 2026-07-21

Initial public release. Covers Phase 2 (M0–M5 implementation) and Phase 3 (hardening). `make ci` exits 0; 96 tests pass, 2 intentional todos (AC-F1/AC-F2 require `make chromium-build`).

### Added

#### Core engine

- **Serializer (M1)** — Pure, deterministic AX-tree walker producing a compact indented outline. Median ≤ 900 tokens on a 20-page corpus. Three verbosity levels (`minimal` / `standard` / `full`). DOM fallback activates when the AX tree has fewer than 5 interactive nodes. Token counting via `estimateTokens()`.
- **Resolver (M2)** — Semantic handle fingerprinting with weighted Jaccard scoring (`role` 0.40 · `name` 0.35 · `attrs` 0.15 · `ordinal` 0.10). Handles survive DOM reorders, class-name swaps, and style changes. Stale detection at confidence < 0.6.
- **Engine (M3)** — Playwright Chromium driver. Per-engine handle map reset on origin change. `open()` validates `http`/`https` and rejects all other schemes. `settle()` waits for network-idle before returning. Auto-detects container environment (`/.dockerenv` or `SEPIA_NO_SANDBOX=1`) and adds `--no-sandbox --disable-setuid-sandbox`.
- **Agent loop (M3)** — Plan → observe → act → verify loop driven by any OpenAI-compatible model. Typed action dispatch (never `eval`). Stale-handle retry with bounded exponential backoff. Structured `RunTrace` output. Token and step budget enforcement.
- **Fingerprint validation harness (M4)** — `validateCoherence()` runs jsProbes in real browser context before session start. Built-in preset `chrome-130-linux-x86_64`. Session blocked if any probe fails. JA3/JA4 checks deferred until patched Chromium binary is built (`make chromium-build`).
- **Privacy module (M5)** — `redactSecrets()` with 5 pattern families. `createAuditor()` recording all outbound payloads. `createSessionProfile()` using ephemeral `mkdtemp` directories. `createSessionPool(maxConcurrent)` semaphore. `wrapWithAuditor()` proxy. AES-256-GCM at-rest encryption (`encryptData` / `decryptData` / `generateKey`) with random 12-byte IV per write. Prompt injection sanitization (`sanitizeForLLM()`) masking 7 injection pattern families before page content enters LLM context.

#### Interfaces

- **TypeScript SDK** (`interfaces/sdk`) — `createSession()` wrapping engine actions, `createAgent()` delegating to agent loop. Full typed surface: `SepiaSession`, `SepiaAgent`, `RunTrace`, `CompactView`, `ActionResult`.
- **MCP stdio server** (`interfaces/mcp`) — MCP 2024-11 stdio transport via `@modelcontextprotocol/sdk` 1.29.0. 12 tools registered: `open`, `observe`, `click`, `type`, `select`, `check`, `hover`, `scroll`, `press`, `read`, `back`, `forward`.
- **HTTP API** (`interfaces/http`) — `startServer()` with `POST /run` (goal → RunTrace) and `GET /health`. Concurrent session cap with `503 CAPACITY_EXCEEDED` on overflow. Base config built from env vars at startup; per-request config override supported.
- **CLI** (`cli`) — `sepia run "<goal>"` one-shot agent run with `--model`, `--endpoint`, `--verbose` flags. `sepia serve [--port N] [--max-concurrent N]` starts the HTTP API server. Reads `SEPIA_MODEL_ENDPOINT`, `SEPIA_MODEL`, `SEPIA_API_KEY`, `SEPIA_HTTP_PORT`, `SEPIA_MAX_CONCURRENT` env vars.

#### Example application

- **Research assistant** (`examples/research-assistant`) — SDK demo implementing UC-2 (search and extract) and UC-5 (scale across N inputs). Accepts comma-separated queries, runs up to 5 concurrent Sepia sessions, emits a structured JSON report to stdout with per-step token counts and confidence scores on stderr. Supports Anthropic and Ollama endpoints via env vars.

#### Testing (96 pass, 2 todo)

- Token budget suite (AC-S1–S6) — corpus-based serializer tests
- Mutation suite (AC-R1–R5) — handle stability under DOM mutations
- Contract suite (AC-A1–A4) — all 16 actions, stale-handle, no-eval, secret-redaction
- Fingerprint suite (AC-F3–F5) — jsProbe coherence, webdriver absent, validateAndStart guard; AC-F1/AC-F2 deferred
- Agent loop integration (AC-AG1–AG4) — E2E browser tests against fixture pages, budget/retry resilience
- Privacy suite (AC-P1–P4) — data-boundary audit, cross-profile isolation, trace secret redaction
- Example smoke suite (AC-E1–E5) — schema validation, token reporting, concurrency cap

#### Infrastructure

- **Dockerfile** — Multi-stage build: `builder` (TypeScript compile) + `runtime` (prod deps + Playwright Chromium binary). Non-root user `sepia` (uid 1001). Default CMD: `serve`.
- **OCI publish** (`.github/workflows/docker.yml`) — Builds and pushes `ghcr.io/mohnishbasha/sepia` on `v*` tag push. Tags: `vX.Y.Z`, `vX.Y`, `vX`, `sha-<sha>`. Layer cache via GHA. Provenance and SBOM attestations.
- **Helm chart** (`helm/sepia`) — Deployment, Service, HPA (1–10 replicas, 70% CPU target). Resource defaults: 2Gi / 2 CPU per pod. `existingSecret` pattern for `SEPIA_API_KEY`. `chromium.noSandbox` value wires `SEPIA_NO_SANDBOX=1` into pods.
- **CI** (`.github/workflows/ci.yml`) — build + lint + typecheck + test + security audit on push to `master` / PRs. Playwright browser install step with `--with-deps`.
- **Makefile** — `setup`, `build`, `dev`, `run`, `test-*`, `lint`, `typecheck`, `security`, `ci`, `clean`, `chromium-build`, `docker-build`, `docker-run`, `docker-push`, `helm-lint`, `helm-package`, `helm-install`, `helm-uninstall`.

### Security

- Prompt injection sanitization on every page view before model call (SR-2)
- AES-256-GCM at-rest encryption for profile credentials (NFR-44/FR-44)
- `no-eval` / `no-new-func` / `no-implied-eval` ESLint rules enforced in CI
- One-way module dependency enforced by ESLint `no-restricted-imports`
- `pnpm audit --audit-level=critical` gate in CI

---

[Unreleased]: https://github.com/mohnishbasha/sepia/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/mohnishbasha/sepia/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mohnishbasha/sepia/releases/tag/v0.1.0
