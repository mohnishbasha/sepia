# Sepia

**An open-source secure AI browser engine**

> Describe it. Sepia finds it, acts on it, scales it, privately.

[![CI](https://github.com/mohnishbasha/sepia/actions/workflows/ci.yml/badge.svg)](https://github.com/mohnishbasha/sepia/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Security Scan](https://img.shields.io/badge/security-audited-green.svg)](SECURITY.md)

[![Features](https://img.shields.io/badge/Features-Reference-0075ca?style=for-the-badge)](docs/features.md)
[![Changelog](https://img.shields.io/badge/Changelog-v0.1.0-0075ca?style=for-the-badge)](CHANGELOG.md)
[![Spec](https://img.shields.io/badge/Spec-FR%20%2F%20AC-0075ca?style=for-the-badge)](docs/phase1-spec.md)
[![Soul](https://img.shields.io/badge/Philosophy-soul.md-0075ca?style=for-the-badge)](soul.md)

---

## What it is / why it's different

Most browser automation tools send raw HTML or screenshots to the model — thousands of tokens of noise. They break the instant a site ships a layout change. And they're trivially detected by network-level fingerprinting.

Sepia solves all three:

**1. Token-efficient compact view (~750 tokens vs ~8,700+ for raw DOM)**
Sepia distills each page to a compact semantic outline — one line per meaningful node — built from the accessibility tree joined against the DOM. The model reasons about handles like `[e12] button "Sign in"`, never raw selectors. Median view: ≤ 900 tokens on a 20-page corpus, measured in CI on every commit.

**2. Stable handles that survive layout shifts**
Handles are derived from a semantic fingerprint (`role + accessible name + stable attributes + nearby label`), not DOM path or position. When a site ships a redesign that moves your button to a different container, the handle stays the same. When an element is genuinely gone, Sepia marks it `stale` and stops — it never silently clicks the wrong thing.

**3. Source-level fingerprint coherence (JA3/JA4 + full cross-signal)**
Header patching is not enough. Sepia patches Chromium's BoringSSL layer so the TLS ClientHello itself matches a real Chrome build. The entire profile is coherent as one unit: TLS fingerprint, User-Agent, Client Hints, WebGL/Canvas, fonts, timezone, and locale all describe the same plausible machine. A validation harness checks this before every session starts.

---

## Build

### Prerequisites

- Git
- Node.js 22.11.0 — `nvm install 22.11.0`
- A model API key or a local [Ollama](https://ollama.ai) instance

```bash
git clone https://github.com/mohnishbasha/sepia.git
cd sepia
make setup    # installs pnpm, all deps, and Playwright's Chromium binary
make build    # compiles TypeScript → dist/
```

For watch mode during development:

```bash
make dev
```

---

## Run

Sepia has three runtime modes: CLI one-shot, HTTP server, and MCP stdio.

### CLI — one-shot agent run

```bash
export SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1
export SEPIA_MODEL=claude-sonnet-4-6
export SEPIA_API_KEY=sk-ant-...

make run ARGS='run "What is the current Node.js LTS version on nodejs.org?"'
```

Or with a local model (no API key needed):

```bash
export SEPIA_MODEL_ENDPOINT=http://localhost:11434/v1
export SEPIA_MODEL=llama3.1
make run ARGS='run "What is the current Node.js LTS version on nodejs.org?"'
```

Output is a `RunTrace` JSON object on stdout:

```json
{
  "goal": "What is the current Node.js LTS version on nodejs.org?",
  "outcome": "success",
  "totalSteps": 3,
  "totalTokens": 2140,
  "steps": [...]
}
```

### HTTP server

Start a long-running HTTP API that accepts goals over the network:

```bash
export SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1
export SEPIA_MODEL=claude-sonnet-4-6
export SEPIA_API_KEY=sk-ant-...

make run ARGS='serve --port 3000 --max-concurrent 5'
```

**`POST /run`** — submit a goal, get a `RunTrace` back:

```bash
curl -s -X POST http://localhost:3000/run \
  -H 'Content-Type: application/json' \
  -d '{"goal": "What is the current Node.js LTS version on nodejs.org?"}' \
  | jq .outcome
```

Returns `200` on `success`, `422` on `budget_exceeded` or `error`, `503` when the concurrent session cap is reached.

**`GET /health`** — liveness check:

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"0.1.0","inflight":0,"maxConcurrent":5}
```

**Environment variables for the HTTP server:**

| Variable | Default | Description |
|---|---|---|
| `SEPIA_HTTP_PORT` | `3000` | Port to listen on |
| `SEPIA_MAX_CONCURRENT` | `5` | Max concurrent agent runs |
| `SEPIA_MODEL_ENDPOINT` | `https://api.anthropic.com/v1` | Model API base URL |
| `SEPIA_MODEL` | `claude-sonnet-4-6` | Model name |
| `SEPIA_API_KEY` | — | API key (optional for local models) |

### MCP stdio

For use as a tool server with Claude Desktop or any MCP 2024-11 host:

```bash
make run ARGS='mcp'
```

Registers 12 tools: `open`, `observe`, `click`, `type`, `select`, `check`, `hover`, `scroll`, `press`, `read`, `back`, `forward`.

---

## Deploy

### Docker

Build the OCI image:

```bash
make docker-build                        # builds sepia:dev
make docker-build DOCKER_TAG=v0.1.0      # tag a release
```

Run the HTTP server in a container:

```bash
make docker-run \
  SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1 \
  SEPIA_MODEL=claude-sonnet-4-6 \
  SEPIA_API_KEY=sk-ant-...
```

Or run a one-shot goal:

```bash
docker run --rm \
  -e SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1 \
  -e SEPIA_MODEL=claude-sonnet-4-6 \
  -e SEPIA_API_KEY=sk-ant-... \
  sepia:dev run "What is the Node.js LTS version?"
```

Chromium's sandbox is automatically disabled inside containers (`/.dockerenv` detected → `--no-sandbox`). No `--privileged` flag required.

**OCI images** are published to `ghcr.io/mohnishbasha/sepia` on every `v*` tag push via `.github/workflows/docker.yml`. Tags: `v0.1.0`, `v0.1`, `v0`, `sha-<sha>`.

```bash
docker pull ghcr.io/mohnishbasha/sepia:v0.1.0
```

### Kubernetes (Helm)

Prerequisites: `kubectl` pointed at your cluster, `helm` 3.x installed.

**Quick install:**

```bash
# 1. Create the API key secret
kubectl create namespace sepia
kubectl create secret generic sepia-credentials \
  --namespace sepia \
  --from-literal=SEPIA_API_KEY=sk-ant-...

# 2. Install the chart
helm upgrade --install sepia helm/sepia \
  --namespace sepia \
  --set existingSecret=sepia-credentials \
  --set env.SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1 \
  --set env.SEPIA_MODEL=claude-sonnet-4-6 \
  --wait
```

Or with `make`:

```bash
make helm-install SEPIA_API_KEY=sk-ant-...
```

**What gets deployed:**

| Resource | Default |
|---|---|
| Deployment | 2 replicas (managed by HPA) |
| Service | ClusterIP on port 3000 |
| HorizontalPodAutoscaler | 1–10 replicas, scale at 70% CPU |
| Memory limit per pod | 2 Gi (Chromium is memory-hungry) |
| CPU limit per pod | 2 000m |

**Key `values.yaml` overrides:**

```yaml
# helm/sepia/values.yaml — common overrides
replicaCount: 2

image:
  repository: ghcr.io/mohnishbasha/sepia
  tag: "v0.1.0"           # pin to a release

env:
  SEPIA_MODEL_ENDPOINT: "https://api.anthropic.com/v1"
  SEPIA_MODEL: "claude-sonnet-4-6"
  SEPIA_MAX_CONCURRENT: "5"

existingSecret: sepia-credentials   # kubectl secret holding SEPIA_API_KEY

resources:
  limits:
    memory: "2Gi"
    cpu: "2000m"

hpa:
  enabled: true
  minReplicas: 1
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

chromium:
  noSandbox: true    # false requires privileged: true or SYS_ADMIN cap
```

Lint and dry-run the chart before applying:

```bash
make helm-lint
```

Uninstall:

```bash
make helm-uninstall
```

---

## How it works

Sepia runs a **plan → observe → act → verify** loop:

1. **Plan** — Parse the plain-language goal into a task.
2. **Observe** — Navigate to the page, wait for it to settle (DOM stable + network-idle), build the compact view from the AX tree. Each interactive element gets a handle: `[e12] button "Sign in"`.
3. **Act** — The model sees the compact view and goal, chooses one typed action by handle: `{"action":"click","handle":"e12"}`. Sepia validates it against the typed action enum (never `eval`), resolves the handle with confidence scoring, and executes.
4. **Verify** — Receive `{ok, viewDelta, confidence}`. If confidence is low or the handle is stale, re-observe and retry (bounded). Repeat until done or budget exhausted.

The serializer and resolver are **pure and deterministic** — no LLM calls, fully unit-tested. Only the `agent` module touches the model.

---

## Configuration

All configuration is via a `SepiaConfig` object or environment variables. Secure defaults everywhere — opt-in for anything that could expose data.

| Key | Default | Description |
|---|---|---|
| `model.endpoint` | `https://api.anthropic.com/v1` | Model API endpoint (Anthropic or OpenAI-compat) |
| `model.model` | `claude-sonnet-4-6` | Model name |
| `browser.ephemeral` | `true` | Ephemeral profile (cleared on session end) |
| `browser.headless` | `true` | Headless mode |
| `browser.profile` | `chrome-130-linux-x86_64` | Fingerprint preset |
| `agent.maxSteps` | `50` | Max steps per run |
| `agent.confidenceThreshold` | `0.7` | Re-observe if confidence drops below this |
| `privacy.telemetry` | `false` | Usage telemetry (off by default) |
| `security.robotsAwareness` | `false` | Respect robots.txt (opt-in) |

See [`config/index.ts`](config/index.ts) for the full typed schema.

---

## Architecture

```
interfaces/http ──→ agent + config
interfaces/mcp  ──→ agent
interfaces/sdk  ──→ agent
            cli ──→ agent + config + interfaces/http

          agent ──→ actions + serializer + resolver + engine + privacy + telemetry

        actions ──→ engine + resolver
     serializer ──→ types (no other sepia imports)
       resolver ──→ types (no other sepia imports)
         engine ──→ fingerprint + config
    fingerprint ──→ types (no other sepia imports)
        privacy ──→ types (no other sepia imports)
      telemetry ──→ types (no other sepia imports)
         config ──→ types (no other sepia imports)
          types ──→ (no sepia imports)
```

**One-way rule:** Lower layers never import from higher layers. The action layer never `eval`s model text. Enforced by ESLint `no-restricted-imports` rules; violations fail `make lint`.

---

## Chromium build and JA3/JA4 fingerprints

Standard `make setup` installs Playwright's stock Chromium — sufficient for all features except TLS fingerprint matching (AC-F1/AC-F2). To build the patched binary:

```bash
make chromium-build   # ~2–4 hours on 16-core machine; applies 4 patches to BoringSSL layer
make test-fingerprint # AC-F1 and AC-F2 will pass once the binary exists
```

**Why it takes hours:** Chromium is ~35 million lines of C++. The JA3/JA4 patch touches BoringSSL at the source level — header patching is not sufficient — so a full recompile is required on every fresh checkout.

**CI strategy options:**
- **Prebuilt cache** — Build once, push `bin/chromium` to a private artifact store keyed on `sha256(patches/*.patch)`. Set `CHROMIUM_CACHE_URL` to pull it in CI.
- **sccache / goma** — Distributed C++ compilation cache; warms to ~20 min rebuild after first build.
- **Skip and defer** — AC-F1/AC-F2 remain `todo` in CI without the binary. All 94 other tests pass on stock runners.

---

## Test suite

| Suite | Count | Gate |
|---|---|---|
| Unit (serializer, resolver, privacy, fingerprint) | ~50 | `make test-unit` |
| Contract (all 16 actions, stale-handle) | ~20 | `make test` |
| Integration (E2E browser, trace-secrets) | ~10 | `make test` |
| Resilience (budget, retry) | ~6 | `make test` |
| Token budget (M1 corpus) | ~5 | `make test-tokens` |
| Mutation (M2 handle stability) | ~5 | `make test-mutation` |
| **Total** | **96 pass, 2 todo** | `make ci` |

The 2 todo items (AC-F1, AC-F2) require `make chromium-build`. Everything else passes on standard CI.

---

## Further reading

- [docs/features.md](docs/features.md) — Full product specification and feature reference (actions, config, privacy, security, performance)
- [CHANGELOG.md](CHANGELOG.md) — Release history
- [soul.md](soul.md) — Design philosophy and principles behind Sepia
- [CLAUDE.md](CLAUDE.md) — Operating guide for AI coding agents working in this repo
- [SKILLS.md](SKILLS.md) — Catalog of reusable agent skills
- [CONTRIBUTING.md](CONTRIBUTING.md) — How to contribute
- [SECURITY.md](SECURITY.md) — Security policy and threat model
- [docs/phase1-spec.md](docs/phase1-spec.md) — Numbered FR-*/AC-* technical specification (development reference)
- [docs/phase3-addendum.md](docs/phase3-addendum.md) — Phase 3 hardening: AC-* coverage matrix, deferred items, new APIs
- [examples/research-assistant/](examples/research-assistant/) — SDK demo for the AI engineer persona
