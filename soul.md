# soul.md — The design philosophy of Sepia

This document captures *why* Sepia is built the way it is. The spec describes what it does. This describes what it believes.

---

## The compact view is the core insight

Every other browser automation tool gives the model too much. A raw HTML dump is 8,700 tokens of noise. A screenshot is opaque. A JSON DOM tree is structure without meaning.

The compact view is the opposite: one line per element that matters, in the natural reading order of a human scanning the page. `[e12] button "Sign in"` is everything the model needs to know about that button. Nothing else belongs in the context window.

Token efficiency is not a performance optimization. It is the product. A model that sees 750 tokens reasons faster, costs less, and makes fewer mistakes than one drowning in 8,700. Every design decision in the serializer flows from this.

---

## Handles are semantic, not structural

A CSS selector breaks the moment someone renames a class. An XPath breaks when a wrapper `<div>` is added. These are structural identifiers — they describe where something is, not what it is.

Sepia handles are semantic. `[e12]` is derived from `{role: "button", name: "Sign in", ordinal: 0}`. When the site ships a redesign that moves the button to a different container, the handle is the same. When the element is gone entirely, Sepia marks it stale and stops.

The invariant is: **act on meaning, not position**. If you can't identify an element by what it is, you shouldn't be interacting with it.

---

## Fail closed, always

Automation that silently acts on the wrong element is worse than automation that stops. A false click on a "Delete account" button because the layout shifted is not a recoverable error — it is a user trust violation.

Sepia's confidence threshold (`0.7` by default) is not a magic number. It is a commitment: if we are less than 70% confident that this handle refers to this element, we stop and report. The operator can lower the threshold if they understand the risk. We will not lower it for them.

This extends to every ambiguous case: unknown action type → stop. Model output that isn't valid JSON → stop. Stale handle after `maxRetries` → stop. The default answer to ambiguity is always "stop and tell the caller."

---

## Source-level fingerprinting, not header patching

Header-level User-Agent spoofing is a known evasion technique. It has been known for years. Anti-bot systems fingerprint TLS ClientHello, HTTP/2 frame ordering, Canvas, WebGL, font metrics, and a dozen other signals — and they cross-correlate them. A Chrome 130 UA with a Firefox TLS fingerprint is detectable in milliseconds.

Sepia patches at the BoringSSL layer, not the HTTP layer. The JA3/JA4 fingerprint matches a real Chrome build because it **is** built from Chrome's TLS stack. The full profile is coherent: TLS, UA, Client Hints, jsProbes all describe the same machine. The validation harness checks this before every session starts. If coherence fails, the session doesn't start.

This is the hard path. It requires patching Chromium source and a multi-hour build. We chose it because the easy path doesn't work.

---

## Privacy by design, not by policy

Credentials never touch the model context. The `privacy/` module is a hard gate, not a best-effort filter. The serializer strips secrets before the compact view is built. `redactSecrets()` runs on every typed text before it is recorded in the trace. `sanitizeForLLM()` runs on every page view before it enters the LLM context.

The audit log records *what left the process*, not what was on the page. The trace records *that a secret was redacted*, not what it was. These are not privacy features bolted on after the fact — they are the architecture.

At-rest encryption (AES-256-GCM with random IV per write) is the default for profile credentials. There is no "store plaintext" mode.

---

## Pure core, side effects at the edge

The serializer and resolver are pure functions. They take data in, return data out, call no APIs, touch no disk, produce no side effects. This is not just testability hygiene — it is a constraint on where reasoning happens.

If you need to call a model inside the serializer, you are solving the wrong problem. If you need to make a network call inside the resolver, you have the wrong abstraction. These modules are deterministic so they can be tested exhaustively, reasoned about mathematically, and trusted to behave identically in test and production.

The agent is the only module allowed to have side effects. Everything else is a function.

---

## One dependency direction

Lower layers never import from higher layers. `types/` knows nothing about `serializer/`. `serializer/` knows nothing about `agent/`. This is enforced by ESLint rules and fails CI — it is not a convention, it is a constraint.

The reason is containment. If `resolver/` imports from `agent/`, then testing `resolver/` requires bootstrapping the agent, which requires a model endpoint, which means your unit tests need network access. The one-way rule keeps each layer independently testable with no mocking infrastructure.

---

## The model is a caller, not a god

The model's output is a JSON string. Sepia parses it, validates it against a typed enum, and dispatches it through a typed switch table. The model cannot call arbitrary code. It cannot pass raw selectors. It cannot inject instructions into the next model call.

`sanitizeForLLM()` runs on every page view before it enters the context. Prompt injection from a malicious page is detected and masked before the model sees it. The model is a caller in a well-typed system — it has exactly the permissions Sepia grants it and no more.

---

## Simplicity over cleverness

The compact view is indented text, not a graph. Handles are opaque short strings, not URIs with embedded structure. The agent loop is a `for` loop with a `break`, not a state machine. Config is a flat typed object, not a plugin system.

Every abstraction in Sepia earns its place by solving a problem that couldn't be solved more simply. When a simpler solution works, that is the one we ship. The reader of the code in five years should find it obvious, not clever.

---

*Sepia is built to last. The web will keep changing. The model will keep improving. The token budget will keep shrinking. We build the parts that outlast all of this — and keep everything else as simple as possible.*
