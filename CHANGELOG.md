# Changelog

All notable changes to Sepia are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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

[Unreleased]: https://github.com/mohnishbasha/sepia/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mohnishbasha/sepia/releases/tag/v0.1.0
