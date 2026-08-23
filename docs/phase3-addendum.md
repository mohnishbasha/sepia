# Sepia — Phase 3 Hardening Addendum

> **Status: Complete (2026-07-21)**
> This document is an addendum to [`phase1-spec.md`](phase1-spec.md). It records what was built during Phase 3 hardening, deferred items, and the current AC-\* gate state. Do not duplicate into the main spec — cross-reference here instead.

---

## 1. Phase 3 gate

Phase 3 gate (from CLAUDE.md): **All AC-\* tests pass; spec matches code.**

Current result at the end of Phase 3: 96 tests pass, 2 todo. After the post-Phase-3 hardening pass (§8) the suite stands at **231 pass, 2 todo**.

The 2 todo items (AC-F1, AC-F2) are intentionally deferred — they require `make chromium-build` (BoringSSL-patched Chromium binary, not built in standard CI). Everything else passes.

---

## 2. AC-\* coverage matrix

### Serializer (M1)

| AC    | Description                                                                                                            | Status  |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ------- |
| AC-S1 | Median token count ≤ 900 across 20-page corpus                                                                         | ✅ pass |
| AC-S2 | 95th-percentile token count ≤ 1,500                                                                                    | ✅ pass |
| AC-S3 | ≥ 95% of ground-truth interactive elements present                                                                     | ✅ pass |
| AC-S4 | Serializer output is deterministic for same input                                                                      | ✅ pass |
| AC-S5 | DOM-fallback activates when AX tree has < 5 interactive nodes                                                          | ✅ pass |
| AC-S6 | `minimal` strictly smaller than `standard` where a reduction is possible; emits handles only, drops default-only state | ✅ pass |

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
| AC-F1 | JA3 fingerprint matches Chrome 130 on Linux x86_64  | ⏭ **todo** — blocked: `patches/` contains no `.patch` files for `make chromium-build`    |
| AC-F2 | JA4 fingerprint matches Chrome 130 on Linux x86_64  | ⏭ **todo** — blocked: same                                                               |
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

### ~~SR-10 — Per-domain rate limiting and robots.txt hooks~~ ✅ Implemented

See `security/index.ts`, `tests/unit/security.test.ts`, and the `[Unreleased]` CHANGELOG section for full details. Both features remain off by default; enabled via `security.rateLimitMs` / `security.robotsAwareness` config or `SEPIA_RATE_LIMIT_MS` / `SEPIA_ROBOTS_AWARENESS` env vars.

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

---

## 8. Post-Phase-3 hardening pass

A follow-up pass addressing gaps found by re-auditing the code against its own
documentation. Every item below is test-first with a numbered AC.

### New acceptance criteria

| AC     | Description                                                                                                                                             | Where                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| AC-AG5 | A run returns the model's `done` summary as `RunTrace.answer`                                                                                           | `tests/integration/answer.test.ts`               |
| AC-AG6 | `gateHandle()` refuses to act below `agent.confidenceThreshold`                                                                                         | `tests/unit/resolver-gate.test.ts`               |
| AC-AG7 | Exhausted stale/low-confidence retries end the run as `stale_bail`                                                                                      | `tests/integration/stale-bail.test.ts`           |
| AC-AG8 | A rejected model reply is retried WITH corrective feedback                                                                                              | `tests/integration/retry-feedback.test.ts`       |
| AC-A5  | `parseAction()` validates required fields and field types                                                                                               | `tests/contract/action-validation.test.ts`       |
| AC-A6  | `screenshot` capture across engine, action enum, SDK, MCP                                                                                               | `tests/integration/screenshot.test.ts`           |
| AC-A7  | Page prose is retrievable via `text` across engine, action enum, SDK, MCP                                                                               | `tests/integration/page-text.test.ts`            |
| AC-A8  | A decided plan runs in one call, each step still gated                                                                                                  | `tests/integration/action-batch.test.ts`         |
| AC-R6  | N identically-named same-role elements get N distinct handles                                                                                           | `tests/integration/list-handles.test.ts`         |
| AC-R7  | Acting on a handle hits that element, not the first role+name match                                                                                     | `tests/integration/list-handles.test.ts`         |
| AC-R8  | Bounded settle on never-idle pages; handle map is pruned                                                                                                | `tests/integration/settle-budget.test.ts`        |
| AC-R9  | Handle identity uses real DOM attributes joined from `DOM.getDocument`                                                                                  | `tests/integration/stable-attrs.test.ts`         |
| AC-R10 | A handle from a frame acts inside that frame, with per-frame ordinals                                                                                   | `tests/integration/iframes.test.ts`              |
| AC-S7  | Token counts come from `cl100k_base`, not `characters / 4`                                                                                              | `tests/token-budget/tokenizer.test.ts`           |
| AC-S9  | `full` verbosity descends into unnamed containers and emits prose                                                                                       | `tests/integration/page-text.test.ts`            |
| AC-S10 | Child-frame accessibility trees are merged into the view                                                                                                | `tests/integration/iframes.test.ts`              |
| AC-S12 | Repeated controls on a row-structured page are labelled from the row above them; unnamed controls are left alone; distinctness is judged after trimming | `tests/unit/nearby-labels.test.ts`               |
| AC-S11 | `observe` honours a token budget and says what it dropped                                                                                               | `tests/token-budget/observe-budget.test.ts`      |
| AC-F6  | The configured preset is applied and validated before a session is used                                                                                 | `tests/fingerprint/engine-profile.test.ts`       |
| AC-P5  | Secret field values are stripped from the view before it reaches the LLM                                                                                | `tests/data-boundary/view-redaction.test.ts`     |
| AC-P6  | A credential is flagged by the field it went into, not only its shape                                                                                   | `tests/data-boundary/secret-destination.test.ts` |
| AC-P7  | A credential in the goal reaches neither the model nor the trace                                                                                        | `tests/data-boundary/goal-secrets.test.ts`       |
| AC-T1  | Switching tabs retargets every action; tab ids survive a close                                                                                          | `tests/integration/tabs.test.ts`                 |
| SR-11  | HTTP: allowlisted config, mandatory auth, body cap, non-racy concurrency                                                                                | `tests/integration/http-hardening.test.ts`       |
| SR-13  | `security.allowedDomains` restricts navigation, including via links                                                                                     | `tests/integration/allowed-domains.test.ts`      |

### Defects this pass fixed

1. **Handle collision (AC-R6/AC-R7).** `assignHandle()` reused a handle whenever
   a fuzzy score exceeded 0.85, so identically-named same-role elements within
   ~4 ordinal positions collapsed together — 20 "Delete" buttons produced 5
   handles. Execution then used `.first()`, so _every_ one of those handles
   clicked row 1. Handles were not even stable across two observations of an
   unchanged page. Identity is now exact; execution targets the handle's own
   ordinal among identically-named siblings.

2. **`confidenceThreshold` was never read (AC-AG6).** The documented fail-closed
   invariant had no implementation. `gateHandle()` now enforces it.

3. **A run could not return anything (AC-AG5).** The `done` action's `summary`
   was parsed and discarded; `RunTrace` had no answer field.

4. **Retries were byte-identical (AC-AG8).** A model producing unparseable JSON
   was re-sent exactly the same request.

5. **Fingerprint module was unreachable (AC-F6).** Nothing outside tests called
   `getPreset()` or `validateAndStart()`; sessions ran with the stock profile and
   `navigator.webdriver === true`. The default preset also claimed Chrome 130
   while the bundled browser was 149 — it is now 149.

6. **Page content reached the model unredacted (AC-P5).** `redactSecrets()` only
   ran on the model's own output, to set a boolean.

7. **HTTP server accepted arbitrary config (SR-11).** `browser.executablePath`
   (launch any local binary) and `model.endpoint` (exfiltrate page content) were
   caller-controlled. Auth was optional, the body was unbounded, and the
   concurrency check was separated from its increment by an `await`.

8. **Observation cost (AC-R8).** `settle()` waited up to 8s for network-idle on
   every observation; on a page that never goes idle, three observations cost
   24s. Now ~3s. The CDP session is reused rather than reattached per call, and
   the handle map is pruned.

### Known remaining gaps

- **AC-F1/AC-F2 cannot pass from this repository.** `patches/README.md`
  describes a four-patch BoringSSL stack, but no `.patch` files are committed.
  TLS-level fingerprinting is unaddressed; `make chromium-build` has nothing to
  apply.
- **`stableAttrs` are not populated by the default engine path.** The field and
  its scoring weight exist and callers may supply them, but the CDP
  accessibility-tree walk does not extract `id` / `data-testid`.
- **The corpus is 5 synthetic fixtures**, not the 20 pages the docs described.
  Token gates pass with wide headroom and should not be read as a real-world
  benchmark.
- **Prompt-injection sanitization is regex-based.** It is defence in depth, not a
  guarantee, and its broader patterns can mask legitimate page copy.

---

## 9. Issue #5 — `done` always reported success

A follow-up fix for GitHub issue #5: the agent had a single terminal action,
`done`, that unconditionally set `outcome: 'success'`. A model that hit a CAPTCHA,
a paywall, or simply judged the goal impossible had no honest path to say "I
cannot do this" — the run was still reported as a success, and CLI/HTTP callers
saw exit `0` / HTTP `200`.

### New acceptance criteria

| AC     | Description                                                                             | Where                                      |
| ------ | --------------------------------------------------------------------------------------- | ------------------------------------------ |
| AC-A9  | Terminal actions (`done`/`abort`) are validated at the boundary and never dispatched    | `tests/contract/action-validation.test.ts` |
| AC-AG9 | An `abort` action ends the run as `outcome: 'unable'`, surfacing the reason as `answer` | `tests/integration/unable.test.ts`         |

### Changes made

- **`types/index.ts`** — added `'unable'` to the `Outcome` union. CLI
  (`exit 1`) and HTTP (`422`) map any non-`success` outcome to a failure, so no
  caller-side change was required.
- **`actions/index.ts`** — added `TerminalActionName`, `TerminalAction`,
  `isTerminalActionName()`, and `parseTerminalAction()`. `abort` (and `done`)
  are typed and validated at the boundary but stay out of the `ActionName`
  dispatch enum — they are terminal and never reach the engine.
- **`agent/index.ts`** — the observe-act loop now treats `done` and `abort`
  uniformly as terminal actions. `done` → `outcome: 'success'` (unchanged);
  `abort` → `outcome: 'unable'` with the model's `reason` surfaced as
  `RunTrace.answer`. A malformed terminal payload (e.g. non-string `reason`) is
  rejected with corrective feedback and retried (AC-AG8). Both system prompts
  now advertise `abort` with a when-to-use note.

### Defect fixed

`done` was the only terminal action and always produced `success`; there was no
typed way for the model to report an unachievable goal. The new `abort` action
maps to `outcome: 'unable'`, and callers now observe a non-success exit/status
(`exit 1` / HTTP 422) instead of a false success.

---

## 10. Issue #4 — system prompt advertised 4 of 18 implemented actions

### New acceptance criteria

| AC     | Description                                                                                                                   | Where                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| AC-A10 | The system prompt advertises every dispatchable action except `screenshot`; every advertised example is valid at the boundary | `tests/unit/system-prompt.test.ts` |

### Changes made

- **`agent/index.ts`** — `SYSTEM_PROMPT_DEFAULT` and `SYSTEM_PROMPT_MINIMAL` now
  advertise all 18 dispatchable actions (`click`, `type`, `select`, `check`,
  `hover`, `scroll`, `press`, `read`, `text`, `observe`, `wait`, `open`, `back`,
  `forward`, `tabs.new`, `tabs.close`, `tabs.list`, `tabs.switch`) plus the
  terminal actions `done`/`abort`, with a compact field-notes block covering
  required vs. optional fields and valid enum values. `selectSystemPrompt()` is
  exported so the advertised set is testable.
- **`tests/unit/system-prompt.test.ts`** — asserts that every dispatchable
  action except `screenshot` appears in both prompts, that `screenshot` never
  appears in the model context, that every advertised example line parses
  cleanly through `parseAction`/`parseTerminalAction`, and that no unknown
  action name is advertised.

### Defect fixed

The model was only told about `click`, `type`, `open`, `text`, and the terminal
actions. Every other implemented action was dead code from the model's
perspective: dropdowns and checkboxes were unusable (no `select`/`check`),
content below the fold was invisible (no `scroll`), keyboard submission was
impossible (no `press`), truncated prose was unrecoverable (no `read`), and
navigation was one-way (no `back`/`forward`, no tab management). The prompts now
match the actual dispatchable surface. `screenshot` stays deliberately out of
the model prompt — it is an operator/SDK artifact and its base64 must not enter
the LLM context. The prompt grew ~255 tokens; the issue's own measurement shows
a single wasted step (~11.6k tokens) pays that back ~9x over.

---

## 11. Issue #6 — no loop detection; repeated identical actions burn the budget

### New acceptance criteria

| AC      | Description                                                                                                                                 | Where                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| AC-AG10 | A repeated identical action with an unchanged view hash ends the run as `outcome: 'unable'` after `agent.loopThreshold` consecutive repeats | `tests/integration/loop-detection.test.ts` |

### Changes made

- **`serializer/index.ts`** — new `hashView(view: CompactView): string`.
  SHA-256 over `{url, title, nodes}`, deliberately excluding `timestampMs` and
  `tokenCount` so re-observations of an unchanged page hash identically. Pure
  and deterministic, consistent with the serializer's invariants.
- **`config/index.ts`** — new `agent.loopThreshold?: number` (default `3`,
  bounded to `[2, 20]` by `mergeConfig`). The counter resets to 1 when either
  the action key or the view hash changes.
- **`agent/index.ts`** — after dispatching a non-terminal step and after the
  stale-handle bail, the agent compares the step's action key and
  `hashView(view)` against the previous step's. `loopThreshold` consecutive
  identical pairs end the run with `outcome: 'unable'` and a diagnostic
  `answer` ("Loop detected: …"), before the step-budget check.

  The key is the whole validated action, serialized. Keying on `(action,
handle)` alone was measurably wrong: half the actions carry no handle, so
  `scroll down 200` and `scroll up 900` shared a key, as did every `press`
  whatever key was pressed. Neither moves the view hash either — the AX tree
  spans the whole document irrespective of scroll offset, and focus is not part
  of a node's state — so the unchanged-view half of the guard did not catch it,
  and legitimate runs (varied scrolling; Tab, Tab, Enter) ended as `unable` with
  the final action already dispatched. Erring wide is the right direction here:
  a false positive kills a working run, whereas a false negative merely costs
  steps until `maxSteps`, which is the behaviour loop detection replaced.

- **`docs/phase1-spec.md`** — FR-50 now lists loop exhaustion as a
  termination condition.

### Defect fixed

An agent stuck on an unresponsive element (a dead button, a modal that never
opened, a CAPTCHA it keeps clicking) re-issued the same action until
`maxSteps` ran out and reported `budget_exceeded`/`error`. The run now stops
after three identical no-ops with an honest `unable` outcome and a diagnostic
`answer`, pairing with issue #5's `unable` path; CLI/HTTP callers see
`exit 1` / HTTP `422` with zero caller-side changes.

---

## 12. Issue #19 — `/metrics` does not count authentication failures

### New acceptance criteria

| AC    | Description                                                                                                                                   | Where                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| AC-I1 | Auth-rejected requests to `POST /run` increment `totalUnauthorized` on `/metrics`; `totalRequests`/`totalErrors` count accepted requests only | `tests/integration/http-metrics-auth.test.ts` |

### Changes made

- **`interfaces/http/index.ts`** — new `totalUnauthorized` counter,
  incremented on every `checkAuth()` rejection before the 401 is written, and
  exposed in the `GET /metrics` payload alongside `totalRequests` and
  `totalErrors`.
- **Semantics decision:** auth-rejected requests deliberately do NOT count
  toward `totalRequests` or `totalErrors`. Those counters keep their existing
  meaning — accepted requests, and failures of processed runs — so existing
  dashboards and error-rate alerts are unaffected, and credential-stuffing
  traffic cannot pollute either signal. The issue asked for a separate
  counter; it stays fully separate.

### Defect fixed

`checkAuth()` returned before `totalRequests++`, so a rejected request was
counted nowhere: three 401s left every counter unchanged (verified in the
issue), and an operator watching `/metrics` could not see credential stuffing
against `POST /run`. Rejections are now visible as `totalUnauthorized`.

---

## 13. Issue #15 — CLI cannot run headed; only the HTTP server can

### New acceptance criteria

| AC    | Description                                                                                                                         | Where                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| AC-I2 | Explicit `--headed` forces `browser.headless=false`                                                                                 | `tests/unit/cli-headed.test.ts` |
| AC-I3 | `SEPIA_HEADLESS` alone works both ways (`false`/`0` headed, `true`/`1` headless); unset or empty means no effect                    | `tests/unit/cli-headed.test.ts` |
| AC-I4 | Explicit `--headed` beats a contradicting `SEPIA_HEADLESS`                                                                          | `tests/unit/cli-headed.test.ts` |
| AC-I5 | Neither set → the configured default (`browser.headless: true`) stands                                                              | `tests/unit/cli-headed.test.ts` |
| AC-I6 | A nonsense `SEPIA_HEADLESS` value fails loudly (stderr diagnostic naming accepted values, exit 2) instead of being silently ignored | `tests/unit/cli-headed.test.ts` |

### Changes made

- **`cli/headless.ts`** — new pure module exporting `parseHeadlessEnv()` and
  `resolveHeadless()`, the single implementation of the precedence chain and
  the env-value grammar.
- **`cli/commands.ts`** — the subcommands moved here from `cli/index.ts`
  (which is now a thin bin entry) so tests can drive them directly.
  `runCommand` parses `--headed`, resolves it against `SEPIA_HEADLESS`, and
  threads the result into the `browser` block of the merged config; the help
  text documents the flag.
- **`sepia mcp` now shares the rule.** It previously treated any value other
  than exactly `false` as headless, so `SEPIA_HEADLESS=0` ran headless and a
  typo like `flase` failed silently into headless mode. Both now resolve via
  the same function.

### Semantics decision

Precedence strongest-first: explicit `--headed` flag > `SEPIA_HEADLESS` >
configured default. Accepted values are exact and case-sensitive:
`true`/`1` → headless, `false`/`0` → headed; unset or empty has no effect.
Anything else exits 2 with a diagnostic rather than being ignored — an
inverted or typoed value silently producing the opposite of what was asked is
precisely the ambiguity the repo's fail-closed philosophy forbids. The four
accepted spellings match common dotenv/supervisor conventions without
admitting case-variant surprises like `False`.

### Defect fixed

`runCommand` never touched the browser config block, so `browser.headless`
was pinned to its default and every `sepia run` was invisible, while the HTTP
server's per-request allowlist could flip the same field freely — backwards,
since interactive mode is where watching matters most.

---

## 14. Issue #7 — conversation history re-sends the full page outline every turn

### New acceptance criteria

| AC      | Description                                                                                                                                                                                                                                                                                                 | Where                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| AC-AG11 | Prior history turns keep the model's action verbatim with their outline replaced by a `[page state at step N]` stub; only the current turn carries the full compact view; `maxHistorySteps` still truncates; prompt growth on an unchanged page stays flat; retained content stays inside the data boundary | `tests/integration/history-stubs.test.ts` |
| AC-AG12 | A prior step's outcome (action, result code, and whether the page changed) is reported on the next turn's stub; the first stub stays bare; two messages per retained step; no secret literal                                                                                                                | `tests/integration/history-stubs.test.ts` |

### Changes made

- **`agent/index.ts`** — when a completed step is appended to history, its
  user message is rebuilt as `[page state at step N]` instead of storing
  `Goal + full outline`; the assistant message (the model's own action JSON)
  is stored verbatim as before. The current turn is unaffected: it is built
  fresh each step from the live observation and always carries the full
  redacted/sanitized compact view. The goal line is dropped from prior turns
  too — it is invariant for the whole run and always present in the current
  turn's message.
- **Composition with `maxHistorySteps` (unchanged semantics):** the window
  still keeps the last N user/assistant pairs; stubbing changes what a pair
  costs, not how many are kept. Count-bounded turns × non-repeating outlines
  = bounded prompt growth, instead of the previous quadratic accumulation.
- **Loop detection (`hashView`) and the data-boundary pipeline
  (`redactCompactView` → `sanitizeForLLM`) are untouched.** Stubbing strictly
  reduces exposure: the only page-derived content ever persisted to history is
  gone outright, so what remains in retained turns (goal placeholder text in
  the model's own action JSON) was already inside the boundary.

### Defect fixed

Each history entry carried the entire page outline, so turn n re-sent
everything from turns 1..n-1: measured on a 10-field registration form,
prompt tokens grew 192 → 3,205 over 13 calls (~24k tokens total, 16.7x) for
a page whose structure never changed. `maxHistorySteps` bounded the growth
but only at a level above where most tasks finish. The model needs the
current page plus a record of what it did — not ten copies of the same form.
Prior outlines now collapse to one-line stubs while actions stay verbatim,
cutting unchanged-page prompt cost roughly k×→constant per call.

---

## Follow-up: outcomes in the history stub (AC-AG12)

Stubbing prior outlines (AC-AG11) removed the only way an action's outcome
reached the model. Results were never in the conversation — the model inferred
them by diffing one turn's outline against the next, and stubs ended that
without replacing it. Measured on a dead control: three consecutive failing
clicks, each returning `ELEMENT_NOT_FOUND`, with the prompt showing the model
only what it had asked for. Loop detection (AC-AG10) then ends such a run as
`unable`, where the model might otherwise have noticed and tried something else.

Each stub after the first now carries the preceding step's action, its result
code, and whether the page moved:

```
[page state at step 1] — previous action click e1 → ok, page unchanged
```

`ok, page unchanged` is the case worth having: the action reported success and
the page is byte-identical afterwards, which is exactly the dead-control signal
no error code carries. The comparison is free — `hashView()` was already being
computed for loop detection, and is now computed once per step and shared.

The note rides on the next step's stub rather than adding a third message,
because that is both where it is true (the hash is of the page observed _before_
that step's action, so comparing it with the previous step's answers "did the
last action change anything?") and what keeps `windowedMessages` pairing turns
correctly. Cost is 11-13 tokens per retained turn, roughly 1% of what AC-AG11
saved.

---

## MCP-16 — element state reaches the host (issue #43)

`observe` reported handle/role/name/value/context and nothing else, so a host could not tell a disabled button from an enabled one: it clicked, got `ok`, and nothing happened. The engine had the state all along — `agent/index.ts`'s `formatNode()` renders it and the MCP surfaces did not.

Both now render it, omitting `enabled: true` because it is stamped on every interactive node and printing it spends tokens per line to say "ordinary" (the AC-S6 reasoning). `selected` was in `NodeState` and rendered by neither surface, so an option already chosen looked identical to one that was not; `formatNode()` is fixed too.

---

## AC-S12 — labels on row-structured pages (issue #44)

`attachContext` labelled nothing on Hacker News: thirty `link "hide"`, none
distinguishable. Three things had to be true at once for that.

A `hide` link's siblings are all links, and `siblingText()` excludes interactive
ones. Its only named ancestor is the cell whose accessible name concatenates the
whole row — `"149 points by vanpra 2 hours ago | hide | 58 comments"` — which
restates the link rather than distinguishing it, and exceeds the ancestor length
limit anyway. And the story title, the one thing that identifies the row, lives
in a _different_ `<tr>`, so it is neither sibling nor ancestor.

What the walk did find was the page name, `"Hacker News"`. Being true of all
thirty, it lost to the distinctness rule — but not before satisfying the lookup
and pre-empting anything better. So the group ended with no labels at all, and
the diagnosis is really two bugs: no candidate reaches a row, and a useless
candidate crowds out the search for one.

Both are fixed. Candidate selection now runs per group rather than per node, so
a set of labels that fails distinctness falls back to `precedingRowText()` —
the nearest node _above_ this one in the flat, document-ordered view. On Hacker
News that is the title cell, and it labels all thirty correctly.

Two guards keep it honest. A candidate containing the node's own name is skipped
as a restatement of its own subtree. The walk stops at another member of the
same group, because past it we are in a different row.

It applies only to nodes that have a name. An unnamed control — Hacker News's
upvote arrows are `link ""` — is identified by what comes _after_ it, and the
backward walk produced the previous row's text every time. Confidently wrong is
worse than blank, so those are left alone and the second half of #44 stands.

Trimming now happens _before_ distinctness is judged. Two headlines sharing an
opening clause could previously pass the check and then collapse to the same
string, handing back a group that looked narrowed and was not.

**Cost.** Hacker News goes 3,902 → 4,818 tokens (+23%) for 62 labels across 12
groups. That is the price of being able to address a row at all; without it the
model cannot pick one. Shortening `MAX_CONTEXT_CHARS` is a cheap lever if the
trade needs revisiting — measured at 32 chars it is 4,602 and at 24 chars 4,474,
with no group losing distinctness at either. It is left at 48 so #25's behaviour
is unchanged. A page whose controls do not collide is untouched: the GitHub
issues list measured 1,206 tokens before and after.

---

## AC-C1 — declared config reaches what it configures (issue #20)

`model.maxTokensPerStep` was declared in `ModelConfig`, defaulted, clamped by
`mergeConfig` and written up in the README, while `agent/index.ts` sent
`max_tokens: 1024` on every call. Setting it did nothing. The hardcoded value
also matters on its own: 1024 is tight for a reasoning model, which spends part
of the budget before it emits any JSON, so a run fails in a way the operator has
no configuration route out of.

It is now sent on every call, and the default drops from 100,000 to 8,192. The
old default was safe only because it was dead — sending it would be rejected
outright by providers that cap `max_tokens` well below it.

`browser.humanTiming` was the same shape of claim with no behaviour anywhere
behind it. It is removed rather than implemented: typing and pointer jitter is
an anti-detection feature belonging with the fingerprint work (AC-F\*), with a
spec of its own about what is randomised and over what distribution. Inventing
that inside a config cleanup would be guessing at a contract, and a knob that
silently does nothing is exactly the "believed and absent" problem SR-13 was
opened for.
