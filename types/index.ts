// Shared primitive types — zero sepia-internal dependencies.
// All other modules may import from here; nothing here imports from other sepia modules.

// ── Primitive scalars ────────────────────────────────────────────────────────

export type Verbosity = 'minimal' | 'standard' | 'full';

export type ErrorCode =
  | 'STALE_HANDLE'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_DISABLED'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_URL'
  | 'PROMPT_INJECTION_DETECTED'
  | 'UNKNOWN';

export type WaitConditionType =
  { type: 'url'; pattern: string } | { type: 'element'; handle: string } | { type: 'networkIdle' };

export type Outcome = 'success' | 'budget_exceeded' | 'error' | 'stale_bail';

// ── Compact view (defined here so engine/ and actions/ can reference it) ─────

export interface NodeState {
  enabled?: boolean;
  checked?: boolean;
  required?: boolean;
  expanded?: boolean;
  selected?: boolean;
}

export interface CompactNode {
  handle?: string;
  role: string;
  name: string;
  value?: string;
  state?: NodeState;
  indent: number;
  children?: CompactNode[];
}

export interface CompactView {
  url: string;
  title: string;
  verbosity: Verbosity;
  tokenCount: number;
  timestampMs: number;
  nodes: CompactNode[];
}

// ── Action result types (shared between actions/ and engine/) ────────────────

export interface ActionError {
  code: ErrorCode;
  message: string;
  handle?: string;
}

export interface ActionResult {
  ok: boolean;
  viewDelta?: CompactView;
  confidence: number;
  error?: ActionError;
}

export interface ReadResult {
  ok: boolean;
  text?: string;
  error?: ActionError;
}

export interface WaitResult {
  ok: boolean;
  timedOut: boolean;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}
