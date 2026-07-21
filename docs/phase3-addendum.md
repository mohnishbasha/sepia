# Sepia — Phase 3 Hardening Addendum

> **Status: Complete (2026-07-21)**
> This document is an addendum to [`phase1-spec.md`](phase1-spec.md). It records what was built during Phase 3 hardening, deferred items, and the current AC-\* gate state. Do not duplicate into the main spec — cross-reference here instead.

---

## 1. Phase 3 gate

Phase 3 gate (from CLAUDE.md): **All AC-\* tests pass; spec matches code.**

Current result: **`make ci` exits 0 — 96 tests pass, 2 todo.**

The 2 todo items (AC-F1, AC-F2) are intentionally deferred — they require `make chromium-build` (BoringSSL-patched Chromium binary, not built in standard CI). Everything else passes.

---

## 2. AC-\* coverage matrix

### Serializer (M1)

| AC    | Description                                                   | Status          |
| ----- | ------------------------------------------------------------- | --------------- |
| AC-S1 | Median token count ≤ 900 across 20-page corpus                | ✅ pass         |
| AC-S2 | 95th-percentile token count ≤ 1,500                           | ✅ pass         |
| AC-S3 | ≥ 95% of ground-truth interactive elements present            | ✅ pass         |
| AC-S4 | Serializer output is deterministic for same input             | ✅ pass         |
| AC-S5 | DOM-fallback activates when AX tree has < 5 interactive nodes | ✅ pass         |
| AC-S6 | Minimal verbosity produces fewer/equal nodes than standard    | ✅ pass (bonus) |

### Resolver (M2)

| AC    | Description                                                  | Status  |
| ----- | ------------------------------------------------------------ | ------- |
| AC-R1 | Handle survives DOM reorder with confidence ≥ 0.8            | ✅ pass |
| AC-R2 | Handle survives class-name / style swap                      | ✅ pass |
| AC-R3 | Removed element returns `stale: true`                        | ✅ pass |
| AC-R4 | Resolution is deterministic                                  | ✅ pass |
| AC-R5 | Icon-only button handled gracefully (no crash, valid handle) | ✅ pass |

### Actions (M3)

| AC    | Description                                                                    | Status                                                |
| ----- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| AC-A1 | Every action returns `{ok, confidence, error?}`; stale handle → `STALE_HANDLE` | ✅ pass — all 16 actions covered in `tests/contract/` |
| AC-A2 | `open()` rejects non-http(s) URLs with `INVALID_URL`                           | ✅ pass                                               |
| AC-A3 | Model output is never eval'd; only typed dispatch runs                         | ✅ pass                                               |
| AC-A4 | Action trace marks `secretsRedacted: true` when credential text typed          | ✅ pass — `tests/integration/trace-secrets.test.ts`   |

### Agent loop (M3)

| AC     | Description                                                     | Status                                                  |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------- |
| AC-AG1 | Agent completes UC-1 (login) on fixture login page              | ✅ pass — `tests/integration/e2e.test.ts`, real browser |
| AC-AG2 | Agent completes UC-3 (fill form) on fixture form page           | ✅ pass — `tests/integration/e2e.test.ts`, real browser |
| AC-AG3 | Agent stops on budget exhaustion → `outcome: 'budget_exceeded'` | ✅ pass — `tests/resilience/`                           |
| AC-AG4 | Agent retries on stale handle up to `maxRetries`, then stops    | ✅ pass — `tests/integration/`                          |

### Fingerprint (M4)

| AC    | Description                                         | Status                                                                                   |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AC-F1 | JA3 fingerprint matches Chrome 130 on Linux x86_64  | ⏭ **todo** — requires `make chromium-build`                                              |
| AC-F2 | JA4 fingerprint matches Chrome 130 on Linux x86_64  | ⏭ **todo** — requires `make chromium-build`                                              |
| AC-F3 | `navigator.webdriver` is absent or `undefined`      | ✅ pass — real browser probe                                                             |
| AC-F4 | Full cross-signal coherence (UA, jsProbes) all pass | ✅ pass — `chrome-149-linux-x86_64` preset; UA probe dynamic from `preset.chromeVersion` |
| AC-F5 | Session does not start if coherence check fails     | ✅ pass — `validateAndStart` throws                                                      |

### Example app (M3 + M5)

| AC    | Description                                                        | Status                                        |
| ----- | ------------------------------------------------------------------ | --------------------------------------------- |
| AC-E1 | `make run-example QUERIES="..."` completes with no unhandled error | ✅ pass (covered by test-example smoke suite) |
| AC-E2 | Stdout JSON report matches schema                                  | ✅ pass                                       |
| AC-E3 | Works with local Ollama endpoint (no hardcoded Anthropic SDK)      | ✅ pass — config-driven, env vars only        |
| AC-E4 | Per-step token counts + confidence on stderr                       | ✅ pass                                       |
| AC-E5 | Concurrent cap of 5 sessions respected                             | ✅ pass                                       |

### Privacy (M5)

| AC    | Description                                                   | Status                                              |
| ----- | ------------------------------------------------------------- | --------------------------------------------------- |
| AC-P1 | Only compact view + instruction leave the device              | ✅ pass                                             |
| AC-P2 | Credentials never appear in LLM context                       | ✅ pass                                             |
| AC-P3 | No cross-profile data bleed (profile A cookies absent from B) | ✅ pass                                             |
| AC-P4 | Secret never appears in JSON-serialized `RunTrace`            | ✅ pass — `tests/integration/trace-secrets.test.ts` |

---

## 3. Phase 3 deliverables

### H1 — E2E browser tests

**Files added:**

- `fixtures/pages/login.html` — login form (email, password, "Sign in" button; reveals `<h2>Logged in successfully!</h2>` on submit)
- `fixtures/pages/form.html` — contact form (name, email, message, "Submit" button; reveals `<h2>Message sent!</h2>` on submit)
- `tests/integration/e2e.test.ts` — spins up `node:http` server, runs real Playwright Chromium, tests full action sequence (open → observe → type → click → observe)

**Key finding:** Playwright's `accessibility.snapshot()` with `interestingOnly: true` (the default) does not surface `role=status` live-region nodes reliably. Fixture pages use `<section aria-label="..."><h2>...</h2></section>` so the result heading appears in the AX tree and in the serializer's `CONTENT_ROLES` set.

### H2 — Contract completeness and trace secrets

**Files modified/added:**

- `tests/contract/placeholder.test.ts` — added dispatch routing tests for: `select`, `check`, `hover`, `scroll`, `press`, `read`, `wait`, `back`, `forward`; added STALE_HANDLE contract tests for `click` and `type`
- `tests/integration/trace-secrets.test.ts` — two tests:
  - AC-A4: agent types an `sk-...` API key → `step.secretsRedacted === true`
  - AC-P4: the raw typed text is never stored in `StepTrace`, so `JSON.stringify(trace)` cannot contain the credential

**Implementation note on AC-A4:** The `redactSecrets()` call in `agent/index.ts` checks `typedAction.text` for secret patterns. The pattern `\bsk-[A-Za-z0-9\-_]{5,}` triggers on `sk-...` prefixed keys. The typed text itself is never written into `StepTrace`; only `{action, handle, confidence, tokensUsed, latencyMs, result, secretsRedacted}` is recorded.

### H3 — Security hardening

**Files modified:**

- `privacy/index.ts` — three new capabilities:
  1. **AES-256-GCM at-rest encryption** (NFR-44/FR-44): `encryptData(plaintext, key)`, `decryptData(encrypted, key)`, `generateKey()`. Uses Node.js built-in `node:crypto`. Random 12-byte IV per encryption; 16-byte GCM auth tag; throws on tamper.
  2. **Prompt injection sanitization** (SR-2): `sanitizeForLLM(text)` detects and masks 7 injection pattern families: `SYSTEM:` directives, role-overrides (`You are now...`), instruction-overrides (`Ignore previous instructions`), LLaMA `[INST]` tags, chat-template tokens (`<|im_start|>` etc.), markdown system headers (`### System`), act-as overrides. Returns `{sanitized, injectionDetected, patternsFound}`. Masking replaces each character with `*` inside `[...]` rather than deleting.
- `agent/index.ts` — `sanitizeForLLM()` called on the formatted compact view before every model call. If `injectionDetected`, logs a `PROMPT_INJECTION_DETECTED` step event.

**Tests added to `tests/unit/placeholder.test.ts`:**

- 4 AES-256-GCM tests: round-trip, tamper detection, key size (32 bytes), random IV uniqueness
- 6 sanitization tests: clean passthrough, SYSTEM: detection, instruction-override detection, role-override detection, masking behavior, empty string

---

## 4. Deferred items

### AC-F1 / AC-F2 — JA3/JA4 TLS fingerprints

**What:** Verify the TLS ClientHello matches Chrome 130 on Linux x86_64 by connecting to a JA3/JA4 echo server and comparing the computed hash to the expected value.

**Why deferred:** Requires a Chromium binary built from the 4-layer patch stack (`001-ungoogled-chromium` → `002-rebrowser` → `003-boring-ssl-ja3` → `004-profile-coherence`). The build takes multiple hours and is not practical in a standard CI environment.

**How to activate:**

```bash
make chromium-build          # Apply patches, build Chromium → bin/chromium
make test-fingerprint        # AC-F1 and AC-F2 will run (currently .todo)
```

These tests exist in `tests/fingerprint/placeholder.test.ts` as `it.skip(...)` with explicit skip messages. No code change is needed once the binary is available.

### SR-10 — Per-domain rate limiting and robots.txt hooks

**What:** Configurable per-domain minimum interval between requests; optional robots.txt awareness.

**Why deferred:** Both features are disabled by default (per the spec). The config schema already has `security.robotsAwareness` and `security.rateLimitMs` fields. Stub wiring exists; full enforcement hook is deferred to a future maintenance release.

### NFR-6 — 10 concurrent session load test

**What:** Verify ≥ 10 concurrent isolated sessions are supported on a 16GB/8-core machine.

**Why deferred:** The session pool semaphore (`createSessionPool`) is implemented and tested for correctness. A full load test (10 real Chromium processes) requires a beefy CI runner and is excluded from the standard `make ci` gate.

---

## 5. Test count history

| Milestone                  | Tests passing | Todo  |
| -------------------------- | ------------- | ----- |
| M0 scaffolding             | 0 (stubs)     | —     |
| M1–M5 Phase 2 complete     | 71            | 2     |
| Phase 3 hardening complete | **96**        | **2** |

The 2 permanent todos (AC-F1, AC-F2) will convert to passing tests once `make chromium-build` is run.

---

## 6. New exports in Phase 3

### `privacy/index.ts`

```typescript
// AES-256-GCM at-rest encryption (NFR-44)
export interface EncryptedData {
  iv: string;
  ciphertext: string;
  authTag: string;
}
export function encryptData(plaintext: string, key: Buffer): EncryptedData;
export function decryptData(encrypted: EncryptedData, key: Buffer): string;
export function generateKey(): Buffer;

// Prompt injection sanitization (SR-2)
export interface SanitizeResult {
  sanitized: string;
  injectionDetected: boolean;
  patternsFound: string[];
}
export function sanitizeForLLM(text: string): SanitizeResult;
```

---

## 7. Post-Phase 3 additions (2026-07-21)

These changes were made after the Phase 3 gate passed. Test count remains **96 pass, 2 todo**.

### Playwright 1.61 compatibility

Playwright 1.61 ships Chrome 149 headless shell (build 1228) and removed `page.accessibility.snapshot()`.

**Changes made:**

- `engine/index.ts` — replaced `page.accessibility.snapshot()` with CDP `Accessibility.getFullAXTree` via `page.context().newCDPSession(page)`. Added `collectVisible()` to promote ignored wrapper nodes, restoring the same tree structure as the old API (AC-AG1, AC-AG2).
- `fingerprint/index.ts` — added `chrome-149-linux-x86_64` preset matching the actual Playwright 1.61 headless shell (Chrome 149.0.7827.55). Made the UA probe dynamic: uses `preset.chromeVersion.split('.')[0]` instead of the hardcoded `"Chrome/130"` string. Browser tests (AC-F3/F4/F5) now use this preset; unit tests retain `chrome-130-linux-x86_64`.
- `Makefile` + CI — updated `playwright install` to `--only-shell` (required in Playwright 1.61).

### Dependency pins updated to latest stable

All deps upgraded to latest stable as of 2026-07-21: Playwright 1.61.1, TypeScript 5.9.3 (pinned below 6.x for typescript-eslint compat), vitest 3.2.7, Node 24.18.0, all GitHub Actions SHAs updated to Node-24-compatible versions.

### Pre-commit hook (husky + lint-staged)

Added `husky@9.1.7` + `lint-staged@16.1.2`. Pre-commit hook runs ESLint (`--max-warnings=0`) and Prettier `--check` on staged TypeScript/JS files; Prettier `--check` on staged JSON/Markdown. Catches formatting and lint regressions before they reach CI.

---

_End of Phase 3 addendum._
