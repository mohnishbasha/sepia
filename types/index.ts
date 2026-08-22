// Shared primitive types — zero sepia-internal dependencies.
// All other modules may import from here; nothing here imports from other sepia modules.

// ── Primitive scalars ────────────────────────────────────────────────────────

export type Verbosity = 'minimal' | 'standard' | 'full';

export type ErrorCode =
  | 'STALE_HANDLE'
  | 'LOW_CONFIDENCE'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_DISABLED'
  | 'NAVIGATION_FAILED'
  | 'TIMEOUT'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_URL'
  | 'INVALID_ACTION'
  | 'ROBOTS_DISALLOWED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'PROMPT_INJECTION_DETECTED'
  | 'UNKNOWN';

export type WaitConditionType =
  { type: 'url'; pattern: string } | { type: 'element'; handle: string } | { type: 'networkIdle' };

export type Outcome = 'success' | 'budget_exceeded' | 'error' | 'stale_bail' | 'unable';

// ── Compact view (defined here so engine/ and actions/ can reference it) ─────

export interface NodeState {
  enabled?: boolean;
  checked?: boolean;
  required?: boolean;
  expanded?: boolean;
  selected?: boolean;
}

/**
 * Attributes that identify an element more durably than its position.
 * Optional: not every source can supply them.
 */
export interface StableAttrs {
  id?: string;
  name?: string;
  dataTestId?: string;
  ariaLabel?: string;
}

export interface CompactNode {
  handle?: string;
  role: string;
  name: string;
  value?: string;
  state?: NodeState;
  indent: number;
  /**
   * Surrounding text that tells this control apart from others with the same
   * role and name — a row label, a section heading, a toolbar name. Present
   * only where the role+name alone is ambiguous.
   */
  context?: string;
  attrs?: StableAttrs;
  /**
   * The frame this element lives in, absent for the top-level document. Set by
   * the engine and never shown to the model: it is what lets execution root a
   * locator in the right frame, and what keeps two identically named buttons in
   * different frames from sharing a handle.
   */
  frameId?: string;
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

export interface ScreenshotResult {
  ok: boolean;
  /** Filesystem path written, when a path was requested. */
  path?: string;
  /** Base64-encoded PNG, when no path was requested. */
  base64?: string;
  error?: ActionError;
}

export interface TextResult {
  ok: boolean;
  /** The page's readable text, capped at the requested length. */
  text?: string;
  /** True when the cap cut the text short, so a caller knows there is more. */
  truncated?: boolean;
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
