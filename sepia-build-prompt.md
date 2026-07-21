# Build Prompt: Sepia — Secure AI Browser Engine

> **Build status (2026-07-20): Complete.**
> Phase 0 (reasoning), Phase 1 (spec), Phase 2 (M0–M5 implementation), and Phase 3 (hardening) are all done.
> `make ci` exits 0. 96 tests pass; 2 intentional todos (AC-F1/AC-F2 require `make chromium-build`).
> See [`docs/phase3-addendum.md`](docs/phase3-addendum.md) for the full AC-\* coverage matrix.
> This prompt is preserved as a historical artifact of how the project was initiated.

---

> Paste this as a project brief for a coding agent. Follow the phases in order. **Do not write implementation code until Phase 0 and Phase 1 are complete and the specification is approved.**

---

## Project

**Sepia** — an open-source, secure AI browser engine. A user (or an upstream LLM) describes a goal in plain language; Sepia **finds** the right page state, **acts** on it, and **scales** the workflow across pages and sessions, privately. It is designed as an agent-grade browser: it exposes a compact, token-efficient view of each page and accepts actions by **stable handle** rather than brittle selector.

Optimize for three hard constraints, in priority order:

1. **Low token footprint per page** for the LLM in the loop (target: compact view ~750 tokens vs ~8,700+ for raw DOM).
2. **Action stability** across layout shifts and re-renders.
3. **Undetectability and coherence** at the network/TLS layer, not just headers.

Naming convention: display name `Sepia`; machine form `sepia` everywhere (repo, package, CLI: `sepia run "..."`). Enforce this in the README and contributing guide.

---

## How to work (read before doing anything)

**Reason before you build. Specify before you code. Test everything you ship.**

Follow these phases strictly and do not skip ahead:

### Phase 0 — Reason and plan (no code)

Before writing anything, think through the problem end to end and produce a short written analysis:

- Restate the goal in your own words and list the hard constraints and their tradeoffs.
- Identify the riskiest unknowns (fingerprint coherence, handle stability under mutation, token budget) and how you'll de-risk each.
- Outline the component boundaries and the data flow between them.
- List assumptions explicitly and flag anything that needs a decision from the maintainer (e.g. CDP vs Playwright driver; patch-on-fork Chromium vs existing hardened base).
  Stop and surface open questions here rather than guessing.

### Phase 1 — Product specification (no implementation code)

Produce a **Product Requirements & Technical Specification** document _first_, and get it approved before implementation. It must capture:

- **Product requirements:** user personas, primary use cases, plain-language goal examples, and explicit non-goals.
- **Functional requirements:** every capability as a numbered, testable requirement (e.g. "FR-12: `click(handle)` returns `{ok, viewDelta, confidence}` and never acts on a `stale` handle").
- **Non-functional requirements:** performance/token budgets, latency targets, reliability targets, resource limits, concurrency.
- **Security requirements:** threat model, data-boundary definition, secret handling, sandboxing, dependency policy (see Security section below).
- **Interfaces & contracts:** the action API surface, serializer output schema, config schema, MCP/SDK surface — specified as typed contracts.
- **Acceptance criteria:** for each functional area, the measurable condition that means "done," expressed so it can become an automated test.
- **Architecture:** component diagram, chosen stack with justification, and the Chromium patch strategy.
- **Milestones:** ordered, each with its own acceptance tests.
  Only after this spec is reviewed and approved do you proceed to Phase 2.

### Phase 2 — Implement, test-first

- Implement in small, reviewable increments mapped to the numbered requirements.
- **Write tests before or alongside the code** (unit, integration, and the specific mutation/fingerprint/token test suites described below). No feature is "done" without passing tests traceable to its acceptance criteria.
- Keep the serializer/handle-resolver layers deterministic and LLM-free so they are fully testable.
- Every PR-sized change includes tests, updates the spec if behavior changed, and passes lint + type checks + security scan in CI.

### Phase 3 — Harden and verify

- Run the full validation harness (token budget, mutation stability, fingerprint coherence, data-boundary audit) before declaring any milestone complete.
- Document how to reproduce each acceptance test.

---

## Component 1 — Token-efficient page model (core differentiator)

Do not send raw HTML or screenshots to the model by default. Achieve a ~750-token compact view via **accessibility-first serialization**:

- On page settle (DOM stable + network-idle heuristic), build a merged tree from the **accessibility (AX) tree** joined against the DOM.
- Keep only (a) interactive nodes (link, button, input, select, textarea, role=button/tab/menuitem, contenteditable) and (b) meaningful, non-redundant content (headings, labels, table cells). Drop layout wrappers, tracking pixels, offscreen/`aria-hidden` nodes, duplicate whitespace, and repeated boilerplate after first occurrence.
- Emit a compact indented outline, one line per node, each interactive node carrying a short **handle**:
  ```
  [e12] button "Sign in"  (enabled)
  [e13] textbox "Email"   (empty, required)
  heading "Your dashboard"
  [e15] combobox "Sort by" (value="Newest")
  ```
- The model reasons about handles only; it never sees or writes CSS/XPath.
- Provide a `verbosity` knob (`minimal` / `standard` / `full`), default `standard`.

**Acceptance test:** on a fixed 20-page corpus, median serialized view ≤ 900 tokens and ≥ 95% of genuinely clickable elements present with a handle. Ship this as an automated test with the corpus checked in.

---

## Component 2 — Stable handles that survive layout shifts

Eliminate the dominant failure mode: selectors breaking the instant a layout shifts. Handles must be **semantic, not positional**.

- Derive each handle from a **semantic fingerprint**: hash of `{role, accessible name, input type, stable attributes (name/id/data-testid/aria-label), normalized nearby label text, ordinal-among-same-role-siblings}` — never a DOM path.
- Persist a handle→fingerprint map per session; on every re-render, **re-resolve** by weighted best-match (role + accessible name dominate; position is a low-weight tiebreaker).
- If an element moves/restyles but role + name are stable, the handle stays the same. If the match is ambiguous or gone, mark it `stale` and surface it to the agent — **never silently click a wrong element.**
- Expose a resolution confidence score per action.

**Acceptance test (mutation suite):** programmatically mutate pages (reorder DOM, wrap elements, swap class names, move a button across containers) and assert previously issued handles still resolve correctly with confidence ≥ 0.8, and that genuinely-removed elements return `stale`. Checked into CI.

---

## Component 3 — Action API (by handle, never by selector)

Small, typed action set emitted against handles:

- `click(handle)`, `type(handle, text, {submit?})`, `select(handle, option)`, `check(handle, bool)`
- `hover(handle)`, `scroll(direction|handle)`, `press(key)`
- `read(handle)` → full text/value of one node when the compact view truncated it
- `observe()` → current compact view; `wait(condition)`; `open(url)`, `back()`, `forward()`, `tabs.*`

Rules: every action returns `{ok, viewDelta, confidence, error?}`. Prefer emitting a **view delta** over the full page. All actions are logged as structured, replayable events with secrets redacted.

**Acceptance test:** contract tests for every action verifying the return schema, the stale-handle guard, and delta correctness.

---

## Component 4 — Anti-detection at the source level (coherent, not just spoofed)

Header patching is insufficient; the real tells are the **TLS ClientHello (JA3/JA4)** and cross-signal inconsistency. Control fingerprints in the network stack, not after the fact.

- Patch the network layer (BoringSSL/ClientHello construction) so the **JA3/JA4 fingerprint matches a real, current Chrome build** for the spoofed profile — cipher suites, extensions, and their order internally consistent.
- Keep the **whole profile coherent as one unit**: TLS fingerprint, User-Agent, Client Hints, WebGL/Canvas, fonts, timezone, locale, screen metrics, Accept-* headers must all describe the *same\* plausible machine. Mismatch between any two is the actual detection vector.
- Remove automation leaks: no `navigator.webdriver`, no CDP-runtime artifacts, consistent `chrome` runtime object.
- Optional human-plausible timing layer (typing cadence, pointer pathing, jitter).
- Ship a small set of **verified profile presets** and a **validation harness** that checks the assembled profile against known probes (JA3/JA4 echo, header-order, JS-environment audits) before a session is considered "clean."
- Build from a maintainable Chromium **patch set (patch-on-fork)** so it survives version bumps.

**Acceptance test:** automated harness asserts each preset passes JA3/JA4 echo and cross-signal coherence checks; a session cannot start "clean" if any check fails.

---

## Component 5 — Privacy & data boundary

- **Local-first:** serialization, handle resolution, and DOM work happen on-device. Only the compact view + the user's instruction leave the process, and only to the model endpoint the user configures (support local/self-hosted models).
- No telemetry by default. Ephemeral per-session profiles; persistence is explicit opt-in.
- Encrypted, isolated storage per profile. Credentials never enter LLM context unless the user explicitly scopes a login action, and are redacted from logs/replays.
- **Auditable boundary:** a single inspectable code path that reports exactly what bytes leave the device per step. Cover it with a test that fails if anything unexpected is sent.

---

## Component 6 — Natural-language agent loop

Plan → observe → act → verify:

1. Parse the plain-language goal into a task.
2. `observe()` the compact view.
3. Model chooses one action by handle.
4. Execute; get delta + confidence.
5. Verify progress; on `stale` or low confidence, re-observe and retry with backoff (bounded).
6. Repeat until goal reached or budget exhausted. Emit a structured trace.

**Scale:** run the same parameterized task across N inputs/sessions concurrently with isolated profiles, aggregating structured results. Enforce per-run resource and step budgets.

---

## Reliability requirements (must be designed in, not bolted on)

- **Deterministic core:** serializer and resolver are pure/deterministic and unit-tested to high coverage.
- **Bounded everything:** timeouts, retry caps, step budgets, memory/concurrency limits; no unbounded loops in the agent controller.
- **Graceful degradation:** on ambiguous state, stop and report rather than act incorrectly. Fail closed, never fail into a wrong click.
- **Idempotency & replay:** structured action traces allow deterministic replay for debugging and regression tests.
- **Observability:** structured logs, per-step metrics (tokens used, confidence, latency), and clear error taxonomy.
- **Resilience tests:** simulate slow networks, partial renders, mutated DOM, dropped sessions, and model timeouts; assert safe behavior in each.

---

## Security requirements (non-negotiable)

- **Threat model first:** document assets, adversaries, and trust boundaries in the Phase 1 spec.
- **Sandboxing & isolation:** strict process/profile isolation; no cross-profile data bleed (cover with an automated cross-profile leak test).
- **Least privilege:** the agent layer gets the minimum capability needed; no arbitrary code execution paths from model output. Never `eval` model text; actions are a fixed typed enum, validated before dispatch.
- **Input validation:** treat all page content and model output as untrusted. Validate/sanitize before use; guard against prompt-injection from page content influencing the action layer.
- **Secret handling:** credentials and integration tokens are encrypted at rest, never logged, never placed in LLM context unless explicitly scoped, and redacted from traces.
- **Dependency & supply-chain hygiene:** pin every dependency to an exact version (no floating ranges), and set that pin to the **latest stable release** at the time of adoption — no pre-release, alpha, beta, RC, or nightly builds unless a specific capability requires it and the exception is documented. Commit a lockfile so builds are reproducible. Run automated vulnerability scanning (SCA) and static analysis (SAST) in CI, fail the build on known-critical findings, and keep pins current via a scheduled update job (e.g. Dependabot/Renovate) that opens PRs which must pass the full test + security suite before merge. Track the Chromium patch set against upstream CVEs.
- **Secure defaults:** privacy and isolation on by default; dangerous options are explicit opt-in and documented.
- **Compliance affordances:** per-domain rate limits, allowlists, and ToS/robots awareness hooks so operators can run it responsibly.
- **Security tests in CI:** cross-profile leak tests, secret-redaction tests, input-validation/prompt-injection tests, and the data-boundary audit test all gate merges.

---

## Testing & quality bar (applies to all code)

- Every functional requirement traces to at least one automated test.
- Layers: **unit** (deterministic core), **contract** (action API schemas), **integration** (end-to-end task completion on fixtures/live), plus the specialized suites: **token-budget**, **mutation-stability**, **fingerprint-coherence**, **cross-profile-leak**, **data-boundary**, **resilience**.
- CI gates every merge on: tests, lint, type checks, SAST, and SCA.
- Meaningful coverage on the deterministic core; no feature merges without tests and updated docs/spec.

---

## Repository layout & module boundaries (separation of concerns)

Package the code into small, single-responsibility modules with explicit interfaces between them. The dependency direction flows one way: the deterministic core (serializer, resolver, actions) must not depend on the agent/LLM layer, and only the `agent` and `mcp` layers may touch a model. Suggested structure (adapt names to the chosen language):

```
sepia/
  cli/            # entry point; `sepia run "..."`, config loading, wiring only
  agent/          # natural-language loop (plan-observe-act-verify); the ONLY LLM-touching module
  actions/        # typed action enum + validation + dispatch; returns {ok, viewDelta, confidence}
  serializer/     # AX+DOM -> compact token-efficient view; pure, deterministic, no LLM
  resolver/       # semantic-fingerprint handles + re-resolution; pure, deterministic, no LLM
  engine/         # Chromium driver (CDP/Playwright), page lifecycle, settle detection
  fingerprint/    # profile presets + JA3/JA4 coherence validation harness
  privacy/        # data-boundary auditor, secret handling, redaction
  interfaces/
    sdk/          # local library API
    mcp/          # MCP server so upstream LLM tools can drive Sepia
  config/         # typed config schema + defaults (secure by default)
  telemetry/      # structured logging, per-step metrics, error taxonomy (off by default)
tests/            # mirrors module tree + specialized suites (see below)
patches/          # Chromium patch set (patch-on-fork), tracked against upstream CVEs
fixtures/         # 20-page corpus, mutation cases, fingerprint probes
Makefile
README.md
CLAUDE.md
SKILLS.md
CONTRIBUTING.md
SECURITY.md
LICENSE
```

Rules:

- **One responsibility per module**, communicating through typed contracts, not shared mutable state.
- **Core stays LLM-free:** `serializer`, `resolver`, `actions`, `engine`, `fingerprint`, `privacy` contain no model calls and are unit-testable in isolation.
- **No upward dependencies:** lower layers never import the agent. The action layer never `eval`s model text; it validates against the fixed action enum.
- `tests/` mirrors the module tree so every module has a colocated test package, plus the specialized suites (token-budget, mutation, fingerprint-coherence, cross-profile-leak, data-boundary, resilience).

### Version pinning (applies to every module and to scaffolding)

- **Pin to exact, latest stable versions.** Every dependency in every module and in the scaffolding (toolchain, build tools, linters, test frameworks, CI actions, base images) is pinned to an exact version, and that version is the **latest stable release** available at adoption time. No floating ranges (`^`, `~`, `*`, `latest`) and no pre-release/alpha/beta/RC/nightly builds unless a required capability forces it, in which case document the exception inline.
- **Commit lockfiles** for every package so builds are byte-reproducible across machines and CI.
- **Single source of truth for shared versions.** Where multiple modules share a dependency, pin it once (workspace/root manifest or a versions catalog) so the whole repo moves together and versions cannot drift between modules.
- **Pin the toolchain too:** language/runtime version, build system, container base images (by digest), and CI action versions (by tag or SHA).
- **Keep pins current, safely:** a scheduled update bot (Dependabot/Renovate) proposes upgrades to the next stable release as PRs that must pass the full test + security suite before merge. `make setup`/`make ci` install only from the locked versions.

---

## Required project files

Generate all of these; they are part of the deliverable, not optional.

### Makefile

A single entry point for every common task, so contributors and CI run identical commands. Include at minimum:

- `make setup` / `make install` — install toolchain and dependencies (pinned).
- `make build` — build the project and, where applicable, the Chromium patch set.
- `make run ARGS="..."` — run the CLI locally (e.g. `make run ARGS='run "book a table for 2"'`).
- `make dev` — run in watch/dev mode.
- `make test` — full test suite. Plus granular targets: `make test-unit`, `make test-integration`, `make test-tokens`, `make test-mutation`, `make test-fingerprint`, `make test-leak`, `make test-boundary`, `make test-resilience`.
- `make lint`, `make fmt`, `make typecheck`.
- `make security` — SAST + SCA (dependency vulnerability scan); fails on known-critical findings.
- `make ci` — the exact gate CI runs (build + lint + typecheck + test + security).
- `make clean`.
  Keep targets thin wrappers over real scripts; document each in `make help`.

### README.md

The front door. Must contain, in this order:

- Header lockup: **Sepia** / descriptor "An open-source secure AI browser engine" / tagline "Describe it. Sepia finds it, acts on it, scales it, privately."
- Badges (build, tests, license, security scan).
- **What it is / why it's different** — a short opener built around the three differentiators: token-efficient compact view, stable handles that survive layout shifts, source-level fingerprint coherence.
- **Quickstart** — copy-pasteable build and run: prerequisites, `make setup`, `make build`, and a first `make run ARGS='...'` example with expected output.
- **How it works** — the plan-observe-act-verify loop and the handle model, briefly.
- **Configuration** — key options and secure defaults, pointer to the config schema.
- **Architecture** — the module map above and the one-way dependency rule.
- Links to CLAUDE.md, SKILLS.md, CONTRIBUTING.md, SECURITY.md, and the license.

### CLAUDE.md

Operating guide for AI coding agents (and humans) working _in_ the repo. Must state:

- The **phase workflow** (reason -> spec -> test-first implement -> harden) and that implementation code is not written before the spec is approved.
- **Naming convention:** display `Sepia`, machine form `sepia` everywhere.
- **Module boundaries and the one-way dependency rule**; the core-stays-LLM-free invariant.
- **Hard invariants:** never `eval` model output; actions are a fixed typed enum; interact by handle, never raw selector; fail closed on ambiguity; secrets never enter LLM context or logs.
- **How to build, run, and test** (point to the Make targets).
- **Definition of done** for a change: tests traceable to requirements, spec updated if behavior changed, CI green.
- Where the spec, fixtures, and patch set live.

### SKILLS.md

Catalog of Sepia's **agent skills/capabilities** — the reusable, parameterized tasks the browser can perform (e.g. `login`, `search-and-extract`, `fill-form`, `paginate-collect`, `scale-across-inputs`). For each skill document: purpose, inputs/outputs, the actions it composes, preconditions, failure/`stale`-handling behavior, and an example invocation. Include a short **"How to add a new skill"** section defining the contract a new skill must satisfy (typed I/O, deterministic where possible, test required) so the catalog stays extensible without touching the core.

### How to build and run

Provide explicit, reproducible instructions in both the README (human-facing) and the Makefile (executable). Cover: prerequisites and versions, one-command setup, building the engine/patch set, running the CLI against a sample goal, running with a local vs hosted model, and running the test and security suites. A new contributor should go from clone to a passing `make ci` and a working `make run` using only these docs.

---

## Suggested stack

- **Engine:** Chromium patch set (network-stack patches for JA3/JA4; automation-leak removal). Consider an existing hardened-Chromium patch base as a starting reference.
- **Control plane:** CDP over a typed client, or Playwright/Puppeteer as driver with the AX-tree serializer on top. (Flag this choice in Phase 0.)
- **Serializer + resolver:** TypeScript or Python; deterministic; no LLM in this layer.
- **Agent orchestration:** separate, model-agnostic service; local-model path for privacy.
- **Interfaces:** local API/SDK + an MCP server so upstream LLM tools can drive it.
- **License:** decide deliberately in Phase 1 (Apache-2.0 for permissive + patent grant, or AGPL to keep hosted forks open).

---

## Deliverables / milestones

0. **Reasoning note** (Phase 0 analysis + open questions).
1. **Product Requirements & Technical Specification** (approved before code).
2. **Scaffolding:** repository laid out into the modules above with the one-way dependency rule enforced, plus `Makefile`, `README.md`, `CLAUDE.md`, `SKILLS.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and green `make ci` on an empty skeleton.
3. **M1 — Serializer:** AX+DOM → compact view, hitting token target on the 20-page corpus, with tests.
4. **M2 — Resolver:** stable handles passing the mutation suite.
5. **M3 — Action API + agent loop:** end-to-end natural-language task completion, contract + integration tests.
6. **M4 — Fingerprint layer:** patched build passing JA3/JA4 + coherence harness.
7. **M5 — Privacy, security & scale:** local-model path, ephemeral profiles, auditable boundary, concurrent runs, full security test suite green.

## Definition of done

A user types a goal in plain language; Sepia completes it on a live site using ≤ ~900 tokens of page context per step, keeps working after the site ships a layout change, presents a coherent browser fingerprint that passes JA3/JA4 validation, sends nothing off-device beyond the configured model endpoint, and does all of it behind a test suite and CI gates (unit, integration, mutation, fingerprint, security, data-boundary) that a reviewer can run and reproduce.
