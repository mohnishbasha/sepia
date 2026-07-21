# SKILLS.md — Sepia agent skills catalog

A **skill** is a reusable, parameterized task the Sepia agent can perform. Skills compose the typed action primitives into higher-level workflows. Each skill has a typed interface, well-defined preconditions, and documented failure handling.

---

## How to add a new skill

A skill must satisfy this contract before it can be added to the catalog:

1. **Typed I/O** — Define `SkillInput` and `SkillOutput` interfaces. No `any`.
2. **Deterministic where possible** — The skill must not embed randomness or non-determinism unless the use case requires it (e.g. human-timing jitter).
3. **Test required** — A corresponding integration test in `tests/integration/` that exercises the skill against a fixture page.
4. **Failure/stale handling documented** — State what happens on `stale` handle, network error, and budget exhaustion.
5. **No direct selector use** — Skills compose actions by handle only.
6. **Registered in this file** — Add an entry to the catalog below.

---

## Skill: `login`

**Purpose:** Authenticate to a web service using stored credentials.

**Inputs:**
```typescript
interface LoginInput {
  url: string;          // login page URL
  credentialKey: string; // key in the encrypted credential store
}
```

**Outputs:**
```typescript
interface LoginOutput {
  ok: boolean;
  sessionActive: boolean;
  redirectedTo?: string;
  error?: string;
}
```

**Actions composed:** `open`, `observe`, `type` (×2 for email + password), `click` (submit button)

**Preconditions:** Credentials exist in the encrypted profile store under `credentialKey`.

**Failure handling:**
- `stale` on the submit button → re-observe, retry up to `maxRetries`.
- No password field found → return `ok: false, error: 'PASSWORD_FIELD_NOT_FOUND'`.
- Budget exhausted → return `ok: false, error: 'BUDGET_EXCEEDED'`.

**Example invocation:**
```typescript
const result = await agent.run('Sign in to app.example.com using my stored credentials');
```

---

## Skill: `search-and-extract`

**Purpose:** Submit a search query and return the first N results as structured data.

**Inputs:**
```typescript
interface SearchInput {
  url: string;       // search page URL
  query: string;     // search term
  maxResults: number; // how many results to return (default: 5)
}
```

**Outputs:**
```typescript
interface SearchOutput {
  ok: boolean;
  results: Array<{ title: string; url: string; snippet: string }>;
  totalFound?: number;
  error?: string;
}
```

**Actions composed:** `open`, `observe`, `type` (search box), `press` (Enter or click Search), `observe` (results page), `read` (result nodes)

**Preconditions:** The target page has a visible search input field.

**Failure handling:**
- No search box found → return `ok: false, error: 'SEARCH_BOX_NOT_FOUND'`.
- Zero results → return `ok: true, results: []`.
- `stale` on search box → re-observe, retry.

**Example invocation:**
```typescript
const result = await agent.run('Search for "TypeScript async patterns" on MDN and return the first 3 results');
```

---

## Skill: `fill-form`

**Purpose:** Fill a multi-field form and optionally submit it.

**Inputs:**
```typescript
interface FillFormInput {
  url: string;
  fields: Array<{ label: string; value: string }>;
  submit: boolean;
}
```

**Outputs:**
```typescript
interface FillFormOutput {
  ok: boolean;
  submitted: boolean;
  confirmedUrl?: string;
  error?: string;
}
```

**Actions composed:** `open`, `observe`, `type` (×N), `select` (for dropdowns), `check` (for checkboxes), `click` (submit button)

**Preconditions:** All field labels exist as accessible names on the page.

**Failure handling:**
- Field not found by label → skip and log warning; return `ok: false` if `submit: true` and required field was skipped.
- Submit button stale → re-observe, retry.

**Example invocation:**
```typescript
const result = await agent.run(
  'Fill in the contact form: name="Alice", email="alice@example.com", message="Hello" and submit'
);
```

---

## Skill: `paginate-collect`

**Purpose:** Collect data across multiple pages of paginated results.

**Inputs:**
```typescript
interface PaginateInput {
  url: string;
  extractGoal: string;   // what to extract from each page
  maxPages: number;       // hard cap (default: 10)
}
```

**Outputs:**
```typescript
interface PaginateOutput {
  ok: boolean;
  pages: number;
  items: unknown[];
  stopped: 'max_pages' | 'no_next' | 'budget' | 'error';
}
```

**Actions composed:** `open`, `observe`, `read` (data nodes), `click` (Next button), repeat.

**Preconditions:** The page has a "Next" or equivalent pagination control with an accessible name.

**Failure handling:**
- No "Next" button → stop, return `stopped: 'no_next'`.
- Budget exhausted → return `stopped: 'budget'`.
- `stale` on Next → re-observe, retry once, then stop.

---

## Skill: `scale-across-inputs`

**Purpose:** Run the same parameterized task across N inputs or URLs concurrently.

**Inputs:**
```typescript
interface ScaleInput {
  goalTemplate: string;   // e.g. "Search for {{query}} and return the first result"
  inputs: Array<Record<string, string>>;
  concurrency: number;    // max concurrent sessions (default: 5, max: 10)
}
```

**Outputs:**
```typescript
interface ScaleOutput {
  ok: boolean;
  results: Array<{ input: Record<string, string>; trace: RunTrace }>;
  failures: number;
}
```

**Actions composed:** Delegates to other skills per input, each in an isolated session.

**Preconditions:** `concurrency` ≤ 10 (enforced; above this returns validation error).

**Failure handling:**
- Individual run failure → record in `results` with `outcome: 'error'`, continue other runs.
- Session pool exhausted → queue remaining inputs; process as sessions free up.

**Example invocation** (via research-assistant example):
```bash
make run-example QUERIES="TypeScript generics,Rust ownership,Go channels"
```
