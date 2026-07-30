# Sepia

**An open-source secure AI browser engine**

> Describe it. Sepia finds it, acts on it, scales it, privately.

[![CI](https://github.com/mohnishbasha/sepia/actions/workflows/ci.yml/badge.svg)](https://github.com/mohnishbasha/sepia/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Security Scan](https://img.shields.io/badge/security-audited-green.svg)](SECURITY.md)

[Features](docs/features.md) · [Changelog](CHANGELOG.md) · [Spec](docs/phase1-spec.md) · [Philosophy](soul.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

---

## What it is / why it's different

Most browser automation tools send raw HTML or screenshots to the model — thousands of tokens of noise. They break the instant a site ships a layout change. And they're trivially detected by network-level fingerprinting.

Sepia solves all three:

**1. Token-efficient compact view**
Sepia distills each page to a compact semantic outline — one line per meaningful node — built from the accessibility tree. The model reasons about handles like `[e12] button "Sign in"`, never raw selectors. Token counts come from the real `cl100k_base` tokenizer, not a character estimate.

The committed corpus is 5 synthetic fixtures (`fixtures/corpus/`), on which the median view is **80 tokens** and the maximum 111. The CI gate asserts median ≤ 900 and max ≤ 1,500, which those fixtures clear comfortably — they are regression guards, not a benchmark against real-world pages. No measured comparison against raw-DOM baselines ships in this repo.

**2. Stable handles that survive layout shifts**
Handles are derived from a semantic fingerprint (`role + accessible name + ordinal among identically-named siblings`), not DOM path or position. When a site ships a redesign that moves your button to a different container, the handle stays the same. When an element is genuinely gone, Sepia marks it `stale` and stops.

Elements that share a role _and_ an accessible name — every "Delete" button in a list — each get their own handle, and acting on a handle targets that element specifically. Below `agent.confidenceThreshold` (default `0.7`) Sepia refuses to act at all and the run ends `stale_bail`.

The fingerprint also carries optional stable attributes (`id`, `name`, `data-testid`, `aria-label`) and they participate in scoring, but the bundled CDP accessibility-tree path does not populate them; they are available to callers supplying their own nodes.

**3. Coherent browser profile, validated before every session**
The configured preset is applied at context creation — User-Agent, locale, timezone, viewport — and `navigator.webdriver` is masked. A coherence harness runs before the session is handed out; if the signals contradict each other, the session does not start.

**Scope, honestly:** the TLS-level (JA3/JA4) work is _not_ implemented in this repository. `patches/` documents an intended four-patch BoringSSL stack but contains no `.patch` files, so `make chromium-build` has nothing to apply and AC-F1/AC-F2 remain `todo`. What ships today is JavaScript- and header-level coherence, which does not defeat TLS fingerprinting.

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

### Two ways to invoke it

**Working on Sepia** — go through `make run`. It runs the TypeScript directly via
`tsx`, so it always reflects your current sources with no build step:

```bash
make run ARGS='run "What is the Node.js LTS version?"'
```

**Using Sepia as a tool** — put a real `sepia` command on your PATH:

```bash
make cli-link          # builds dist/ and links it globally
sepia run "What is the Node.js LTS version?" --answer-only
```

`cli-link` points the command at _this working tree_, so it executes `dist/`, not
your sources. After editing, run `make build` — or leave `make cli-watch` running,
which recompiles on every change — otherwise you will silently run stale code.
`make cli-unlink` removes it.

### Configuration

Every mode reads the same environment variables. The `sepia` binary also walks up
from the working directory for a `.env`, so it works from anywhere:

```bash
# .env  (gitignored)
SEPIA_MODEL_ENDPOINT=https://openrouter.ai/api/v1
SEPIA_MODEL=deepseek/deepseek-v4-flash
SEPIA_API_KEY=sk-or-v1-...
```

Real environment variables always win over the file. Any OpenAI-compatible
endpoint works — Anthropic, OpenRouter, a local Ollama — since only the base URL
and model name change. A local endpoint needs no key; a remote one without a key
exits with an error rather than failing silently.

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
  "answer": "The current Node.js LTS release is 22.11.0.",
  "totalSteps": 3,
  "totalTokens": 2140,
  "steps": [...]
}
```

`answer` carries the model's `done` summary — this is the run's result. For just that string:

```bash
make run ARGS='run "What is the Node.js LTS version?" --answer-only'
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

Returns `200` on `success`, `422` on `budget_exceeded` or `error`, `503` when the concurrent session cap is reached, `401` when the bearer token is missing or wrong, and `413` when the body exceeds `maxBodyBytes` (default 1 MB).

**Authentication is required.** The server refuses to start unless you either set `SEPIA_SERVER_API_KEY` or explicitly opt out with `--allow-unauthenticated`. An open agent runner can be driven to fetch arbitrary URLs using your model credentials, so running without auth has to be a deliberate choice.

```bash
export SEPIA_SERVER_API_KEY=$(openssl rand -hex 32)
make run ARGS='serve --port 3000'

curl -s -X POST http://localhost:3000/run \
  -H "Authorization: Bearer $SEPIA_SERVER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"goal": "..."}'
```

A request may also carry a `config` object, but only a safe subset is honoured: fields under `agent`, `security`, and the `headless` / `profile` / `settleTimeoutMs` browser fields. Anything that would redirect data or execution — `model.endpoint`, `model.apiKey`, `browser.executablePath`, `browser.profileStorePath` — is discarded.

**`GET /health`** — liveness check:

```bash
curl http://localhost:3000/health
# {"ok":true,"version":"0.1.0","inflight":0,"maxConcurrent":5}
```

**Environment variables for the HTTP server:**

| Variable                      | Default                        | Description                           |
| ----------------------------- | ------------------------------ | ------------------------------------- |
| `SEPIA_HTTP_PORT`             | `3000`                         | Port to listen on                     |
| `SEPIA_MAX_CONCURRENT`        | `5`                            | Max concurrent agent runs             |
| `SEPIA_SERVER_API_KEY`        | —                              | Bearer token required on `POST /run`  |
| `SEPIA_ALLOW_UNAUTHENTICATED` | `false`                        | Run with no auth (deliberate opt-out) |
| `SEPIA_MODEL_ENDPOINT`        | `https://api.anthropic.com/v1` | Model API base URL                    |
| `SEPIA_MODEL`                 | `claude-sonnet-4-6`            | Model name                            |
| `SEPIA_API_KEY`               | —                              | API key (optional for local models)   |

### MCP stdio

Sepia as a browser for someone else's agent. The host — Claude Code, Codex, Claude
Desktop — does the reasoning; Sepia only drives the browser.

**This mode needs no model API key.** Nothing in the MCP server's import graph
reaches the agent loop, so no endpoint, no key, and no model configuration apply.
`SEPIA_MODEL_ENDPOINT` and `SEPIA_API_KEY` are ignored here.

```bash
sepia mcp          # after `make cli-link`
```

**Installing from a registry**

Once published, a host can use the package directly without cloning:

```bash
npm install -g sepia-browser
sepia mcp
```

The package is `sepia-browser` because plain `sepia` on npm is taken by an
unrelated module from 2013. The **command** is still `sepia` — `bin` is
independent of the package name, so nothing about using it changes.

Sepia drives a real Chromium and does not bundle one, and installing the package
does not fetch it. Run this once:

```bash
npx playwright install chromium
```

Skipping it is not silent — the first tool call returns `NO_BROWSER` naming that
exact command, rather than a generic failure.

**Claude Code**

```bash
# personal, available in every project
claude mcp add sepia -- sepia mcp

# or shared with the repo — writes .mcp.json, commit it
claude mcp add --scope project sepia -- sepia mcp
```

Flags go before the server name; everything after `--` is the command Claude Code
runs. If you have not linked the binary, use the absolute path to the build
instead: `-- node /path/to/sepia/dist/cli/index.js mcp`.

**Codex**

```bash
codex mcp add sepia -- sepia mcp
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.sepia]
command = "sepia"
args = ["mcp"]
# Codex times a tool out after 60s by default. A cold browser launch plus a
# navigation can exceed that, so raise it.
tool_timeout_sec = 300
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) by hand and restart the app. It does not inherit your `PATH`, so use
absolute paths:

```json
{
  "mcpServers": {
    "sepia": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/sepia/dist/cli/index.js", "mcp"]
    }
  }
}
```

**Tools** — 18, covering everything the engine can do:

|          |                                                                |
| -------- | -------------------------------------------------------------- |
| Look     | `observe`, `read`, `screenshot`                                |
| Navigate | `open`, `back`, `forward`, `wait`                              |
| Interact | `click`, `type`, `select`, `check`, `press`, `hover`, `scroll` |
| Tabs     | `tabs_list`, `tabs_new`, `tabs_switch`, `tabs_close`           |

Each carries MCP annotations, so a host can tell `observe` (read-only) from
`click` (potentially destructive) and gate the dangerous ones behind confirmation.
`observe` also returns the page as structured data, not only as text.

**Lifecycle** — the browser starts on the first tool call, not when the host
connects, so registering Sepia and never using it costs nothing. It is released
when the host disconnects, closes stdin, or signals the process.

**Environment**

| Variable               | Effect                                                           |
| ---------------------- | ---------------------------------------------------------------- |
| `SEPIA_HEADLESS=false` | Show the browser window — useful for watching what the host does |
| `SEPIA_BROWSER_PATH`   | Use a specific Chromium binary                                   |

**Known limitation.** Elements that share a role and accessible name are
indistinguishable in the compact view: a list with six buttons all named
"Delete", one of which is "Delete all", gives the host six handles and no way to
tell which is which. Take a screenshot before a destructive action on repeated
controls. Tracked as [#3](https://github.com/mohnishbasha/sepia/issues/3).

---

## Releasing

Publishing happens only when a maintainer publishes a GitHub Release — the same
flow as `smallcase-mcp` to PyPI. Merging a pull request never publishes.

**There is no publish token in this repository.** Authentication is OIDC trusted
publishing: npm trusts this workflow, in this repository, running in the `npm`
environment, and hands it a short-lived credential scoped to one package and one
run. A leaked repository secret is not a failure mode if the secret does not
exist.

To release:

1. Bump `version` in `package.json` (its own PR, so the release has a reviewable
   commit).
2. Optionally run Actions → **Publish** manually first. A manual run performs every
   check — build, tarball verification, and a smoke test of the packed MCP server —
   and stops before publishing. It cannot ship anything.
3. Create a GitHub Release tagged `vX.Y.Z`. That publishes.

The run refuses if the tag does not match `package.json`, or if that version is
already on the registry.

### One-time setup

Publish the first version, or reserve the name, from an account you control —
then on npmjs.com → package → Settings → Trusted publishers, add:

| Field             | Value          |
| ----------------- | -------------- |
| Organization/user | `mohnishbasha` |
| Repository        | `sepia`        |
| Workflow filename | `publish.yml`  |
| Environment       | `npm`          |
| Allowed actions   | `npm publish`  |

Then create a GitHub environment named `npm` and restrict it to `v*` tags — that
protection is the real gate, since the trusted publisher is bound to it.

Requirements, for when something fails confusingly: npm ≥ 11.5.1 and Node ≥
22.14.0 (the workflow upgrades npm itself and asserts the version), and
`repository.url` in `package.json` must match the GitHub repository exactly. npm
does not validate the trusted-publisher config when you save it — mistakes only
surface as an auth error during a publish.

Publishing to a **private registry** instead would need a token and a registry
URL; OIDC trusted publishing is an npmjs and PyPI feature, not something a
self-hosted registry provides.

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

# 2. Create the bearer token the HTTP API requires
kubectl create secret generic sepia-server-auth \
  --namespace sepia \
  --from-literal=SEPIA_SERVER_API_KEY=$(openssl rand -hex 32)

# 3. Install the chart
helm upgrade --install sepia helm/sepia \
  --namespace sepia \
  --set existingSecret=sepia-credentials \
  --set serverAuth.existingSecret=sepia-server-auth \
  --set env.SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1 \
  --set env.SEPIA_MODEL=claude-sonnet-4-6 \
  --wait
```

Without `serverAuth.existingSecret` (or `serverAuth.allowUnauthenticated=true`) the pod exits at
startup with an explanatory error rather than serving unauthenticated traffic.

Or with `make`:

```bash
make helm-install SEPIA_API_KEY=sk-ant-...
```

**What gets deployed:**

| Resource                | Default                          |
| ----------------------- | -------------------------------- |
| Deployment              | 2 replicas (managed by HPA)      |
| Service                 | ClusterIP on port 3000           |
| HorizontalPodAutoscaler | 1–10 replicas, scale at 70% CPU  |
| Memory limit per pod    | 2 Gi (Chromium is memory-hungry) |
| CPU limit per pod       | 2 000m                           |

**Key `values.yaml` overrides:**

```yaml
# helm/sepia/values.yaml — common overrides
replicaCount: 2

image:
  repository: ghcr.io/mohnishbasha/sepia
  tag: 'v0.1.0' # pin to a release

env:
  SEPIA_MODEL_ENDPOINT: 'https://api.anthropic.com/v1'
  SEPIA_MODEL: 'claude-sonnet-4-6'
  SEPIA_MAX_CONCURRENT: '5'

existingSecret: sepia-credentials # kubectl secret holding SEPIA_API_KEY

resources:
  limits:
    memory: '2Gi'
    cpu: '2000m'

hpa:
  enabled: true
  minReplicas: 1
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70

chromium:
  noSandbox: true # false requires privileged: true or SYS_ADMIN cap
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

| Key                         | Default                        | Description                                      |
| --------------------------- | ------------------------------ | ------------------------------------------------ |
| `model.endpoint`            | `https://api.anthropic.com/v1` | Model API endpoint (Anthropic or OpenAI-compat)  |
| `model.model`               | `claude-sonnet-4-6`            | Model name                                       |
| `browser.ephemeral`         | `true`                         | Ephemeral profile (cleared on session end)       |
| `browser.headless`          | `true`                         | Headless mode                                    |
| `browser.profile`           | `chrome-149-linux-x86_64`      | Fingerprint preset (matches the bundled browser) |
| `agent.maxSteps`            | `50`                           | Max steps per run                                |
| `agent.confidenceThreshold` | `0.7`                          | Refuse to act below this resolver confidence     |
| `browser.settleTimeoutMs`   | `1500`                         | Cap on each page-settle wait                     |
| `privacy.telemetry`         | `false`                        | Usage telemetry (off by default)                 |
| `security.robotsAwareness`  | `false`                        | Respect robots.txt (opt-in)                      |

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

| Suite                                             | Gate                 |
| ------------------------------------------------- | -------------------- |
| Unit (serializer, resolver, privacy, fingerprint) | `make test-unit`     |
| Contract (action enum, validation, stale-handle)  | `make test`          |
| Integration (E2E browser, agent loop, HTTP)       | `make test`          |
| Resilience (budget, retry, stale bail)            | `make test`          |
| Token budget (corpus + tokenizer)                 | `make test-tokens`   |
| Mutation (handle stability)                       | `make test-mutation` |
| **Total**                                         | **231 pass, 2 todo** |

The 2 todo items are AC-F1/AC-F2 (JA3/JA4). They cannot pass from this repository as it stands — `patches/` contains no patch files for `make chromium-build` to apply.

---

## Further reading

- [docs/features.md](docs/features.md) — Full product specification and feature reference (actions, config, privacy, security, performance)
- [CHANGELOG.md](CHANGELOG.md) — Release history
- [soul.md](soul.md) — Design philosophy and principles behind Sepia
- [CLAUDE.md](CLAUDE.md) — Operating guide for AI coding agents working in this repo
- [SKILLS.md](SKILLS.md) — Catalog of reusable agent skills
- [CONTRIBUTING.md](CONTRIBUTING.md) — How to contribute
- [SECURITY.md](SECURITY.md) — Security policy and threat model
- [docs/phase1-spec.md](docs/phase1-spec.md) — Numbered FR-_/AC-_ technical specification (development reference)
- [docs/phase3-addendum.md](docs/phase3-addendum.md) — Phase 3 hardening: AC-\* coverage matrix, deferred items, new APIs
- [examples/research-assistant/](examples/research-assistant/) — SDK demo for the AI engineer persona
