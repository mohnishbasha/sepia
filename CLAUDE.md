# CLAUDE.md — Operating guide for AI coding agents

This file is the authoritative operating guide for any AI coding agent (or human contributor) working inside the Sepia repository. Read it before writing any code.

---

## Phase workflow

Sepia is built in strict phases. Do not write implementation code before the current phase gate is passed.

| Phase | What happens                                                | Gate                                    |
| ----- | ----------------------------------------------------------- | --------------------------------------- |
| 0     | Reason and plan. Produce `docs/phase0-reasoning.md`.        | Maintainer reviews open questions       |
| 1     | Write spec. Produce `docs/phase1-spec.md`.                  | Maintainer approves spec                |
| 2     | Implement, test-first. Each milestone maps to numbered FRs. | `make ci` green; acceptance tests pass  |
| 3     | Harden and verify. Full validation harness.                 | All AC-\* tests pass; spec matches code |

**Current status:** Phase 3 complete, plus a post-Phase-3 hardening pass. 231 tests passing, 2 todo (AC-F1/AC-F2 — see below). See [`docs/phase3-addendum.md`](docs/phase3-addendum.md) for the AC-\* coverage matrix.

See [`docs/phase1-spec.md`](docs/phase1-spec.md) for the numbered functional requirements (FR-_) and acceptance criteria (AC-_) that govern implementation.

---

## Naming convention

| Context              | Correct form        |
| -------------------- | ------------------- |
| Display name         | `Sepia`             |
| CLI command          | `sepia run "..."`   |
| Package name         | `sepia`             |
| Directory names      | `sepia/`, `sepia-*` |
| All machine contexts | `sepia` (lowercase) |

There is **no** automated lint rule enforcing this — it is reviewer-enforced. If you see a casing variant in code (not prose), fix it by hand.

---

## Module boundaries and one-way dependency rule

```
types/          → (no sepia imports)        ← shared primitive types
config/         → types only
serializer/     → types only
resolver/       → types only
fingerprint/    → types only
privacy/        → types only
security/       → types only
telemetry/      → types only
actions/        → types, engine
engine/         → types, serializer, resolver, fingerprint, security
agent/          → types, config, serializer, actions, engine, privacy, telemetry
training/       → agent (types only)
interfaces/*    → agent, actions, engine, config, types
cli/            → agent, config, interfaces
```

**Lower layers never import from higher layers.** Enforced by `eslint.config.mjs` `no-restricted-imports` rules. Violations fail `make lint` and block CI.

The `types/` module is the only zero-dependency shared module. All others may import from it.

---

## Hard invariants — never violate these

1. **No `eval` of model output.** Actions are a fixed typed enum in `actions/index.ts`. Model output is validated against this enum before dispatch. Violations fail `make lint` via the `no-eval` rule.

2. **Interact by handle, never raw selector.** No CSS selector, XPath, or DOM path ever reaches the model or comes back from it. All element targeting goes through the resolver.

3. **Fail closed on ambiguity.** Enforced by `gateHandle()` in `resolver/index.ts`, which every engine action calls before touching the page. Below `config.agent.confidenceThreshold` the engine returns `LOW_CONFIDENCE` and does not act; a missing element returns `STALE_HANDLE`. When the agent exhausts `maxRetries` against either, the run ends `stale_bail`.

   Elements sharing a role and accessible name get distinct handles, and actions target the handle's own ordinal — never `.first()`. Regression coverage: `tests/integration/list-handles.test.ts`.

4. **Secrets never enter LLM context or logs.** `redactCompactView()` strips secret-named field values and credential-shaped strings from the view before it is formatted for the model; `sanitizeForLLM()` then masks prompt-injection patterns. Covered by `tests/data-boundary/`.

5. **Serializer and resolver are pure and deterministic.** No LLM calls, no network calls. Token counting uses a local `cl100k_base` table (no network). One documented impurity: `serialize()` stamps `timestampMs` via `Date.now()`, so compare views with that field excluded.

6. **Core modules stay LLM-free.** `types`, `config`, `serializer`, `resolver`, `fingerprint`, `privacy`, `telemetry`, `engine`, `actions` — none of these import from `agent` or make model API calls.

---

## How to build, run, and test

```bash
make setup          # install deps (once after clone)
make build          # compile TypeScript → dist/
make run ARGS='run "your goal here"'
make dev            # watch mode
make test           # full suite
make test-unit      # unit tests only
make test-tokens    # token-budget suite (M1+)
make test-mutation  # mutation suite (M2+)
make ci             # full CI gate: build + lint + typecheck + test + security
make security       # pnpm audit (fails on critical CVEs)
make lint           # ESLint
make typecheck      # tsc --noEmit
make fmt            # Prettier format
make clean          # remove dist/ coverage/
```

For the example app:

```bash
make run-example QUERIES="TypeScript generics,Rust ownership"
make test-example
```

---

## Definition of done for a change

A PR is ready to merge when:

1. **Tests pass and are traceable to requirements.** Every new or changed behavior has at least one automated test that references its FR-_ or AC-_ number. `make test` is green.
2. **Spec is updated if behavior changed.** If your change alters an existing FR, AC, or NFR, update `docs/phase1-spec.md` to match.
3. **CI is green.** `make ci` passes (build + lint + typecheck + test + security).
4. **No new lint violations.** `make lint` is clean.
5. **No new type errors.** `make typecheck` is clean.
6. **Dependency pins are exact.** If you add a dependency, pin it to an exact version in `package.json` and commit the updated `pnpm-lock.yaml`.

---

## Where things live

| Artifact                   | Location                                                       |
| -------------------------- | -------------------------------------------------------------- |
| Phase 0 reasoning          | `docs/phase0-reasoning.md`                                     |
| Phase 1 spec               | `docs/phase1-spec.md`                                          |
| Phase 3 hardening addendum | `docs/phase3-addendum.md`                                      |
| Design philosophy          | `soul.md`                                                      |
| Skill catalog              | `SKILLS.md`                                                    |
| 20-page test corpus        | `fixtures/corpus/`                                             |
| Mutation test cases        | `fixtures/mutation/`                                           |
| Fingerprint probe payloads | `fixtures/fingerprint/`                                        |
| E2E fixture pages          | `fixtures/pages/`                                              |
| Chromium patch set         | not in this repository — see `patches/README.md` (issue #17)   |
| Patched Chromium source    | `patches/chromium/` (not committed; see patches/README.md)     |
| Compiled browser binary    | `bin/chromium` (not committed; built by `make chromium-build`) |
| Example app                | `examples/research-assistant/`                                 |

---

## Chromium build notes

**No patch set is committed.** `patches/` holds a README describing what a
four-layer stack would need to do and no `.patch` files, so `make patch` and
`make chromium-build` refuse to run rather than silently producing stock
Chromium. TLS-level fingerprinting (JA3/JA4, AC-F1/AC-F2) is therefore
**unimplemented**, not merely unbuilt: what ships is JS and header level
coherence, which is what the fingerprint suite actually tests.

The rest of this section describes what building such a stack would involve,
for whoever takes it on.

**Why it takes hours:** Chromium is ~35 million lines of C++. A full build on a 16-core machine with 32 GB RAM takes 2–4 hours. The BoringSSL patch requires a full rebuild — incremental builds don't help on a fresh clone.

**Alternatives for CI:**

- **Prebuilt binary cache** — Build once, upload `bin/chromium` to a private artifact store (e.g. S3 + CloudFront), cache in CI with a hash of `patches/`. The `make chromium-build` target supports `CHROMIUM_CACHE_URL` env var for this workflow.
- **sccache / goma** — Distributed compilation cache. Cuts rebuild time to ~20 min if a warm cache exists.
- **Status** — AC-F1/AC-F2 are `.todo` and will stay that way until a patch set exists to build. They are blocked on missing source, not on CI capacity. Every other test passes on a standard runner.
