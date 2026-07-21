# CLAUDE.md — Operating guide for AI coding agents

This file is the authoritative operating guide for any AI coding agent (or human contributor) working inside the Sepia repository. Read it before writing any code.

---

## Phase workflow

Sepia is built in strict phases. Do not write implementation code before the current phase gate is passed.

| Phase | What happens | Gate |
|---|---|---|
| 0 | Reason and plan. Produce `docs/phase0-reasoning.md`. | Maintainer reviews open questions |
| 1 | Write spec. Produce `docs/phase1-spec.md`. | Maintainer approves spec |
| 2 | Implement, test-first. Each milestone maps to numbered FRs. | `make ci` green; acceptance tests pass |
| 3 | Harden and verify. Full validation harness. | All AC-* tests pass; spec matches code |

**Current status:** Phase 2, Milestone M0 (scaffolding) → in progress.

See [`docs/phase1-spec.md`](docs/phase1-spec.md) for the numbered functional requirements (FR-*) and acceptance criteria (AC-*) that govern implementation.

---

## Naming convention

| Context | Correct form |
|---|---|
| Display name | `Sepia` |
| CLI command | `sepia run "..."` |
| Package name | `sepia` |
| Directory names | `sepia/`, `sepia-*` |
| All machine contexts | `sepia` (lowercase) |

A lint rule blocks any PR that introduces a casing variant. If you see `Sepia` in code (not prose), fix it.

---

## Module boundaries and one-way dependency rule

```
types/          → (no sepia imports)        ← shared primitive types
config/         → types only
serializer/     → types only
resolver/       → types only
fingerprint/    → types only
privacy/        → types only
telemetry/      → types only
actions/        → types, serializer, resolver
engine/         → types, serializer, actions, fingerprint, config
agent/          → types, config, serializer, resolver, actions, engine, privacy, telemetry
interfaces/*    → agent, config, types
cli/            → agent, config, types
```

**Lower layers never import from higher layers.** Enforced by `eslint.config.mjs` `no-restricted-imports` rules. Violations fail `make lint` and block CI.

The `types/` module is the only zero-dependency shared module. All others may import from it.

---

## Hard invariants — never violate these

1. **No `eval` of model output.** Actions are a fixed typed enum in `actions/index.ts`. Model output is validated against this enum before dispatch. Violations fail `make lint` via the `no-eval` rule.

2. **Interact by handle, never raw selector.** No CSS selector, XPath, or DOM path ever reaches the model or comes back from it. All element targeting goes through the resolver.

3. **Fail closed on ambiguity.** If a handle resolves with confidence < `config.agent.confidenceThreshold`, stop and report — do not act. If a handle is `stale`, return an error; never click a wrong element.

4. **Secrets never enter LLM context or logs.** Credentials are stored in the encrypted profile store. The `privacy/` module redacts them before any payload leaves the process. This is covered by automated tests in `tests/data-boundary/` and `tests/unit/`.

5. **Serializer and resolver are pure and deterministic.** No LLM calls, no network calls, no side effects. If you need to call a model in these modules, you're in the wrong module.

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

1. **Tests pass and are traceable to requirements.** Every new or changed behavior has at least one automated test that references its FR-* or AC-* number. `make test` is green.
2. **Spec is updated if behavior changed.** If your change alters an existing FR, AC, or NFR, update `docs/phase1-spec.md` to match.
3. **CI is green.** `make ci` passes (build + lint + typecheck + test + security).
4. **No new lint violations.** `make lint` is clean.
5. **No new type errors.** `make typecheck` is clean.
6. **Dependency pins are exact.** If you add a dependency, pin it to an exact version in `package.json` and commit the updated `pnpm-lock.yaml`.

---

## Where things live

| Artifact | Location |
|---|---|
| Phase 0 reasoning | `docs/phase0-reasoning.md` |
| Phase 1 spec | `docs/phase1-spec.md` |
| 20-page test corpus | `fixtures/corpus/` |
| Mutation test cases | `fixtures/mutation/` |
| Fingerprint probe payloads | `fixtures/fingerprint/` |
| Chromium patch set | `patches/*.patch` |
| Patched Chromium source | `patches/chromium/` (not committed; see patches/README.md) |
| Compiled browser binary | `bin/chromium` (not committed; built by `make chromium-build`) |
| Example app | `examples/research-assistant/` |
