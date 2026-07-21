# Sepia

**An open-source secure AI browser engine**

> Describe it. Sepia finds it, acts on it, scales it, privately.

[![CI](https://github.com/mohinishbasha/sepia/actions/workflows/ci.yml/badge.svg)](https://github.com/mohinishbasha/sepia/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Security Scan](https://img.shields.io/badge/security-audited-green.svg)](SECURITY.md)

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

## Quickstart

**Prerequisites:** Git, Node.js 22.11.0 (`nvm install 22.11.0`), a model API key or local [Ollama](https://ollama.ai) instance.

```bash
# 1. Clone and install
git clone https://github.com/mohinishbasha/sepia.git
cd sepia
make setup                      # installs pnpm, deps, and Playwright's Chromium

# 2. Build
make build

# 3. Run your first goal (hosted model)
export SEPIA_MODEL_ENDPOINT=https://api.anthropic.com/v1
export SEPIA_MODEL=claude-sonnet-4-6
export SEPIA_API_KEY=sk-ant-...
make run ARGS='run "What is the current Node.js LTS version on nodejs.org?"'

# 4. Or use a local model (no API key needed)
export SEPIA_MODEL_ENDPOINT=http://localhost:11434/v1
export SEPIA_MODEL=llama3.1
make run ARGS='run "What is the current Node.js LTS version on nodejs.org?"'

# 5. Run CI (tests + lint + typecheck + security)
make ci
```

**Expected output:**
```json
{
  "goal": "What is the current Node.js LTS version on nodejs.org?",
  "outcome": "success",
  "answer": "Node.js 22.x (Iron) LTS",
  "totalSteps": 3,
  "totalTokens": 2140
}
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
interfaces/mcp ──→ agent
interfaces/sdk ──→ agent
         cli   ──→ agent + config

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

## Further reading

- [CLAUDE.md](CLAUDE.md) — Operating guide for AI coding agents working in this repo
- [SKILLS.md](SKILLS.md) — Catalog of reusable agent skills
- [CONTRIBUTING.md](CONTRIBUTING.md) — How to contribute
- [SECURITY.md](SECURITY.md) — Security policy and threat model
- [docs/phase1-spec.md](docs/phase1-spec.md) — Full product requirements and technical specification
- [examples/research-assistant/](examples/research-assistant/) — SDK demo for the AI engineer persona
