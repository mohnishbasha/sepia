# Phase 0 — Reasoning Note

> Status: **OPEN — awaiting maintainer decisions on flagged questions before Phase 1 spec begins.**

---

## 1. Goal in my own words

Sepia is an agent-grade browser engine. A user (or an upstream LLM orchestrator) states a goal in natural language. Sepia:

1. Renders the target page and distills it to a ~750-token semantic outline — no raw HTML, no screenshots.
2. Exposes stable, semantic handles to every interactive element that survive layout shifts, DOM rewrites, and re-renders.
3. Accepts a small typed action set (click, type, select, scroll …) keyed only to those handles.
4. Presents a coherent, internally-consistent browser fingerprint — TLS ClientHello, UA, JS environment, canvas, fonts — that matches a real Chrome build, controlled at the network-stack level, not via header injection.
5. Keeps all page processing on-device; only the compact view + the user's instruction leave the process, and only to the configured model endpoint.

The audience is AI engineers, agent framework authors, and privacy-conscious power users who need a reliable, auditable browser primitive they can trust not to leak state or break on the next site deploy.

---

## 2. Hard constraints and their tradeoffs

| Constraint | Target | Key tradeoff |
|---|---|---|
| Token footprint | ≤ 900 tokens median per compact view | Aggressive pruning can drop elements needed for the task; requires tunable verbosity |
| Action stability | Handle still resolves after DOM mutation; confidence ≥ 0.8 | Semantic fingerprints are inherently fuzzy; name-collisions on icon-only buttons are a real risk |
| Fingerprint coherence | JA3/JA4 + full cross-signal coherence | Requires patching Chromium at the BoringSSL layer — high build complexity, high maintenance cost per Chromium version bump |

**Priority order matters here:** token footprint is constraint #1. If the serializer is too aggressive and drops a needed element, the agent fails. If the agent fails cleanly (reports it can't find the handle) that is acceptable; silently clicking the wrong element is not. The resolver must fail closed.

---

## 3. Riskiest unknowns and de-risking strategy

### 3a. JA3/JA4 fingerprint coherence at the BoringSSL level

**Why it's risky:** Chromium releases every ~4 weeks. Maintaining a BoringSSL patch set that matches a real Chrome JA3/JA4 value requires:
- Knowing the exact cipher suite order Chrome uses (varies by OS and version).
- Patching `net/ssl/ssl_client_socket_impl.cc` and the ClientHello construction in BoringSSL.
- Rebuilding Chromium from source (~100 GB checkout, 4–8 hour builds).
- Rebasing patches every ~4 weeks.

**De-risk approach:**
- Start from an existing hardened Chromium patch base. Two credible references:
  - **rebrowser-patches** — removes CDP/WebDriver automation leaks from Chromium; does not patch TLS. Use as a baseline for the automation-leak removal layer.
  - **Custom BoringSSL patches** — write our own cipher-suite-order patch, pegged to one stable Chromium version for M4, then automate rebase testing.
- Scope M4 (fingerprint milestone) to a **single platform + single Chrome version** first. Expand to multi-version/multi-OS in a follow-up.
- Ship a validation harness *before* building the patch set so we can test against known JA3/JA4 probes from day one.
- **Decision needed (Q1):** Build on top of ungoogled-chromium or upstream Chromium? ungoogled-chromium already strips Google integrations and has a maintained patch-rebase workflow — using it as the base reduces our maintenance surface.

### 3b. Handle stability under realistic DOM mutation

**Why it's risky:** The semantic fingerprint hash (`role + accessible name + input type + stable attrs + normalized nearby label + ordinal-among-same-role-siblings`) must be collision-resistant in practice:
- Icon-only buttons (no accessible name) exist on many production sites.
- Dynamically loaded content changes ordinals.
- A/B tests swap stable attributes.

**De-risk approach:**
- Build the mutation test suite (CI-checked) *before* finalizing the fingerprint algorithm. Run it against 20+ real pages to find collision patterns.
- Add a fallback chain: if semantic fingerprint is ambiguous, fall back to a secondary signal (visual centroid weighted by role and viewport position) rather than fail entirely — but still surface confidence < 0.8 to the agent.
- Never resolve a stale handle silently. Fail closed.

### 3c. Token budget on diverse real-world sites

**Why it's risky:** The AX tree quality varies drastically:
- SPAs with pure div-based "buttons" may produce a nearly empty AX tree.
- Dense dashboards (e.g. spreadsheet UIs) may produce 200+ interactive nodes even after pruning.
- Sites with broken accessibility (aria-hidden on interactive nodes) will drop needed elements.

**De-risk approach:**
- Check in a 20-page corpus covering: login flows, search + results, checkout funnels, dashboards, form-heavy pages. Run the serializer budget acceptance test in CI from day one.
- Implement a verbosity knob (`minimal / standard / full`) so the agent can re-observe at higher verbosity if an action fails.
- Implement DOM-fallback mode: if AX tree is thin (< N nodes), merge in DOM interactive elements directly with role inference.

---

## 4. Component boundaries and data flow

```
[User / Upstream LLM]
        │ plain-language goal
        ▼
    [agent]  ← the ONLY LLM-touching module
        │
        ├─ observe()  ──────────────────────────────────────────────────┐
        │                                                                │
        │       [engine]                                                 │
        │       ┌──────────────────────────────────────────┐            │
        │       │ Chromium (patched) via CDP/Playwright     │            │
        │       │   - page lifecycle / settle detection     │            │
        │       │   - fingerprint layer (BoringSSL patches) │            │
        │       └──────────┬───────────────────────────────┘            │
        │                  │ AX tree snapshot + DOM delta                │
        │                  ▼                                             │
        │       [serializer]  (pure, deterministic, no LLM)             │
        │       prunes → compact outline (~750 tok)                     │
        │                  │                                             │
        │                  ▼                                             │
        │       [resolver]  (pure, deterministic, no LLM)              │
        │       assigns/resolves semantic handles                        │
        │                  │ compact view + handle map                   │
        └──────────────────┘ compact view returned ──────────────────── ┘
        │
        │ LLM call: compact view + goal → action(handle, params)
        │
        ▼
    [actions]  (typed enum, validated, no eval)
        │
        ▼
    [engine]  executes → {ok, viewDelta, confidence}
        │
    [privacy]  audits every outbound byte (test-gated)
        │
    [telemetry]  structured log (off by default)
```

**One-way dependency rule:**
- `serializer`, `resolver`, `actions`, `engine`, `fingerprint`, `privacy` → no imports from `agent` or `interfaces/*`
- `agent` imports `serializer`, `resolver`, `actions`, `engine`, `privacy`
- `interfaces/sdk` and `interfaces/mcp` import `agent` only

---

## 5. Explicit assumptions

| # | Assumption | Confidence | Notes |
|---|---|---|---|
| A1 | License is MIT (LICENSE file already committed) | High | Build prompt suggested Apache-2.0 or AGPL — **see Q2 below** |
| A2 | TypeScript is the primary language for all layers | Medium | See Q3 below |
| A3 | Playwright is the browser driver (CDP sessions via `page.context().newCDPSession()`) | Medium | See Q4 below |
| A4 | Target: Chromium/Chrome (not Firefox) | High | JA3/JA4 targets a Chrome profile |
| A5 | Local-model path uses Ollama-compatible inference (OpenAI-compatible REST API) | Medium | Widest compatibility with self-hosted models |
| A6 | Initial target platform: macOS + Linux x86_64 | Medium | Windows support in a later milestone |
| A7 | The 20-page corpus is assembled in Phase 2 (M1), not Phase 0 | High | Must include login, search, checkout, dashboard, form-heavy |

---

## 6. Open questions — decisions needed before Phase 1

### Q1. Chromium hardening base
**Question:** Do we base on **upstream Chromium**, **ungoogled-chromium**, or another hardened fork?
- **upstream Chromium**: maximum control; maximum maintenance burden (rebase patches every ~4 weeks).
- **ungoogled-chromium**: maintained patch-rebase workflow, strips Google integrations. Still requires our BoringSSL + automation-removal patches on top.
- **rebrowser-patches applied to upstream Playwright Chromium**: lowest build complexity; CDP/WebDriver leaks removed; no JA3/JA4 TLS control (would need to add).

*Recommendation: ungoogled-chromium as base, plus our BoringSSL cipher-suite patch set and rebrowser-patches automation-removal layer. Scoped to a single Chromium major version for M4.*

### Q2. License
**Question:** The LICENSE file is already MIT. The build prompt mentioned Apache-2.0 or AGPL as alternatives. Which is definitive?
- **MIT**: maximum permissiveness; hosted forks do not need to open source.
- **Apache-2.0**: adds explicit patent grant; generally preferred for OSS infra projects.
- **AGPL**: ensures hosted forks (browser-as-a-service) must publish source.

*Recommendation: Keep MIT unless patent protection or hosted-fork disclosure is a priority. Flag if the goal is to keep commercial hosted forks open (use AGPL) or just ensure patents aren't weaponized (Apache-2.0).*

### Q3. Primary language
**Question:** TypeScript for all layers, or Go for orchestration + TypeScript for browser layers?
- The build prompt suggests TypeScript or Python for serializer/resolver. The user's CLAUDE.md prefers Go for backend services.
- Go has `chromedp` for CDP but the TypeScript/Playwright ecosystem for browser automation is mature and has better AX tree support.
- A split-language repo adds CI complexity.

*Recommendation: **TypeScript (Node.js 22 LTS)** as the primary language for all layers. The browser control plane is TypeScript's domain; the Playwright + CDP ecosystem is the strongest fit. Go can be considered for a future high-throughput scheduler layer if concurrency becomes a bottleneck, but that is out of scope for M1–M3.*

### Q4. Browser driver: Playwright vs raw CDP
**Question:** Use Playwright as the high-level driver (with CDP session access for AX tree and low-level network inspection) vs. implement directly against raw CDP?

- **Playwright**: `page.accessibility.snapshot()` for AX tree, well-tested, active maintenance, CDP sessions available for low-level access. However Playwright's Chromium distribution is what we'd need to replace with the patched build.
- **Raw CDP**: maximum control, thinner dependency, but we implement page lifecycle, event handling, and AX tree traversal ourselves.

*Recommendation: **Playwright as the driver**, but use a patched Chromium binary rather than Playwright's bundled Chromium. Playwright supports `executablePath` to point to a custom browser. This gives us the ergonomic Playwright API while keeping the fingerprint-patched binary.*

### Q5. JA3/JA4 implementation scope for M4
**Question:** M4 is "Fingerprint layer: patched build passing JA3/JA4 + coherence harness." Should M4 scope to:
- (a) A single Chrome version on a single OS, or
- (b) Multiple Chrome version profiles?

*Recommendation: Start with option (a): one pinned Chrome major version (e.g. Chrome 130 on Linux x86_64) for M4. Add more profiles iteratively.*

### Q6. MCP server interface
**Question:** Which MCP spec version and transport should `interfaces/mcp` implement?
- Model Context Protocol 2024-11 (current stable) with `stdio` transport for local use; `SSE` or `streamable-HTTP` for remote deployment.

*Recommendation: Target MCP 2024-11, `stdio` transport for the initial MCP server; add SSE in a later milestone.*

---

## 7. Summary of risks by severity

| Severity | Risk | Mitigation |
|---|---|---|
| High | BoringSSL patch maintenance across Chromium releases | Pin to one Chromium version per milestone; automate rebase CI |
| High | Token budget failure on accessible-tree-poor sites | DOM-fallback mode in serializer; verbosity knob; corpus CI |
| Medium | Handle collision on icon-only / unlabeled elements | Fallback fingerprint chain; confidence score; fail-closed |
| Medium | Playwright-bundled Chromium vs. patched binary incompatibility | Use `executablePath` override; test in CI with patched binary |
| Low | Split-language complexity | Avoid: go all-TypeScript |
| Low | MCP spec instability | Pin to 2024-11; version the MCP surface |

---

## 8. Proposed milestone order (for Phase 1 ratification)

| Milestone | Output | Key acceptance test |
|---|---|---|
| Scaffolding | Repo layout, Makefile, README, CLAUDE.md, SKILLS.md, CONTRIBUTING, SECURITY, LICENSE; `make ci` green on empty skeleton | `make ci` passes |
| M1 — Serializer | AX+DOM → compact view ≤ 900 tokens median on 20-page corpus; ≥ 95% clickable elements present | Token budget + coverage CI test |
| M2 — Resolver | Stable handles, mutation suite passing with confidence ≥ 0.8 | Mutation test suite CI |
| M3 — Action API + Agent loop | End-to-end natural-language task completion; contract + integration tests | Contract tests + E2E fixture tests |
| M4 — Fingerprint layer | Patched Chromium build passing JA3/JA4 probe + cross-signal coherence harness | Fingerprint harness CI |
| M5 — Privacy, security, scale | Local-model path, ephemeral profiles, auditable data boundary, concurrent runs, full security suite | Data-boundary test + cross-profile leak test |

---

*Phase 0 complete. Awaiting maintainer decisions on Q1–Q6 before drafting the Phase 1 Product Requirements & Technical Specification.*
