import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type {
  Verbosity,
  CompactView,
  CompactNode,
  NodeState,
  StableAttrs,
} from '../types/index.js';

// Re-export the shared types so callers can import from serializer/ or types/
export type { Verbosity, CompactView, CompactNode, NodeState };

export interface AXSnapshot {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  disabled?: boolean;
  required?: boolean;
  selected?: boolean;
  hidden?: boolean;
  /**
   * Identifying DOM attributes, joined in from `DOM.getDocument`. The
   * accessibility tree alone does not carry `id` or `data-testid`, so without
   * this join handle identity can only be positional.
   */
  attrs?: StableAttrs;
  /** Frame this node's document belongs to; absent for the top-level document. */
  frameId?: string;
  children?: AXSnapshot[];
}

export interface SerializerOptions {
  verbosity?: Verbosity;
  /**
   * Cap on the returned view, in cl100k tokens. Nodes are dropped from the end
   * until the outline fits and the view says so (AC-S11). Absent, zero or
   * negative means no budget.
   */
  maxTokens?: number;
  url?: string;
  title?: string;
}

// Roles that get a handle assigned (interactive)
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'menuitem',
  'tab',
  'switch',
  'spinbutton',
  'searchbox',
  'slider',
]);

// Roles that are included as content (no handle)
const CONTENT_ROLES = new Set([
  'heading',
  'label',
  'cell',
  'columnheader',
  'rowheader',
  'caption',
  'term',
  'definition',
  'status',
  'alert',
]);

// Roles that should be skipped (unless they have interactive children)
const SKIP_ROLES = new Set(['generic', 'none', 'presentation', 'separator']);

// Roles included in 'full' verbosity beyond standard
const FULL_VERBOSITY_ROLES = new Set(['paragraph', 'text']);

/**
 * Check whether a subtree contains any interactive nodes.
 */
function hasInteractiveDescendant(node: AXSnapshot): boolean {
  if (INTERACTIVE_ROLES.has(node.role)) return true;
  if (node.children) {
    for (const child of node.children) {
      if (hasInteractiveDescendant(child)) return true;
    }
  }
  return false;
}

/**
 * Build NodeState from an AX node.
 */
function buildState(node: AXSnapshot): NodeState | undefined {
  const state: NodeState = {};
  let hasState = false;

  if (!node.disabled) {
    state.enabled = true;
    hasState = true;
  } else {
    state.enabled = false;
    hasState = true;
  }

  if (node.checked === true) {
    state.checked = true;
    hasState = true;
  }

  if (node.required) {
    state.required = true;
    hasState = true;
  }

  if (node.expanded !== undefined) {
    state.expanded = node.expanded;
    hasState = true;
  }

  if (node.selected !== undefined) {
    state.selected = node.selected;
    hasState = true;
  }

  return hasState ? state : undefined;
}

/**
 * Context candidates for each emitted node, keyed by identity. Kept beside the
 * walk rather than on CompactNode because most nodes never need one, and the
 * decision requires seeing the whole page.
 */
const candidatesByNode = new WeakMap<CompactNode, string[]>();

/** Longest context we will attach; enough to identify a row, not a paragraph. */
const MAX_CONTEXT_CHARS = 48;

/**
 * An ancestor label is only trustworthy if it is short.
 *
 * An explicit `aria-label` ("Toolbar", "Row actions") is a deliberate name and
 * identifies its subtree. A long ancestor name is almost always a *computed*
 * one — the accessibility tree concatenating every descendant's text — which
 * says nothing specific and reads as garbage once truncated. Sibling text has
 * no such problem, so only ancestors are held to this limit.
 */
const MAX_ANCESTOR_LABEL_CHARS = 40;

/** Collapse whitespace and trim, so a label reads as one clean phrase. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Is this string worth spending tokens on?
 *
 * Real pages surround links with divider punctuation and one-word scraps —
 * "|", "by", "·" — which identify nothing. A label that carries no words is
 * worse than no label: it costs tokens and invites the model to believe it has
 * disambiguated when it has not.
 */
function isUsefulContext(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const letters = words.join('');
  return letters.length >= 4 && words.some((w) => w.length >= 3);
}

/**
 * Text from a node's siblings that could identify it — the "Item 3" sitting
 * next to a "Delete" button inside the same list row. Text before the node is
 * preferred, since that is how rows are usually written.
 */
function siblingText(siblings: AXSnapshot[], index: number): string {
  // Bullets and numbering are decoration, not identity.
  const DECORATIVE = new Set(['ListMarker', 'listmarker', 'image', 'img']);
  const textOf = (n: AXSnapshot): string =>
    !INTERACTIVE_ROLES.has(n.role) && !hasInteractiveDescendant(n) && !DECORATIVE.has(n.role)
      ? tidy(n.name ?? '')
      : '';

  const before = siblings.slice(0, index).map(textOf).filter(Boolean);
  const after = siblings
    .slice(index + 1)
    .map(textOf)
    .filter(Boolean);
  return [...before, ...after].join(' ');
}

/**
 * Candidate labels for a node, nearest first: its siblings' text, then the
 * names of its ancestors. The first one that is not just a repeat of the
 * control's own name gets used.
 */
function contextCandidates(parents: AXSnapshot[], siblings: AXSnapshot[], index: number): string[] {
  const out: string[] = [];
  const sib = siblingText(siblings, index);
  if (sib !== '') out.push(sib);
  for (let i = parents.length - 1; i >= 0; i--) {
    const name = tidy(parents[i]?.name ?? '');
    if (name !== '' && name.length <= MAX_ANCESTOR_LABEL_CHARS) out.push(name);
  }
  return out;
}

/**
 * Walk the AX tree depth-first and produce CompactNode[].
 * counter is a single-element array so it can be mutated by reference.
 *
 * `parents` and the sibling list are carried down so an interactive node can
 * remember what text surrounded it; whether that text is actually emitted is
 * decided later, once we know which names collide (AC-S8).
 */
function walkAX(
  node: AXSnapshot,
  depth: number,
  counter: [number],
  verbosity: Verbosity,
  parents: AXSnapshot[] = [],
  siblings: AXSnapshot[] = [],
  index = 0,
): CompactNode[] {
  const results: CompactNode[] = [];

  // Skip hidden nodes
  if (node.hidden === true) return results;

  const role = node.role;
  const name = node.name ?? '';

  if (INTERACTIVE_ROLES.has(role)) {
    // Interactive node — assign handle
    counter[0]++;
    const handle = `e${counter[0]}`;

    const compactNode: CompactNode = {
      handle,
      role,
      name,
      indent: depth,
    };

    if (node.value !== undefined && node.value !== '') {
      compactNode.value = node.value;
    }

    const state = buildState(node);
    if (state !== undefined) compactNode.state = state;

    if (node.attrs !== undefined && Object.keys(node.attrs).length > 0) {
      compactNode.attrs = node.attrs;
    }

    if (node.frameId !== undefined) compactNode.frameId = node.frameId;

    candidatesByNode.set(compactNode, contextCandidates(parents, siblings, index));

    results.push(compactNode);

    // Walk children
    if (node.children) {
      for (const child of node.children) {
        const childNodes = walkAX(
          child,
          depth + 1,
          counter,
          verbosity,
          [...parents, node],
          node.children ?? [],
          node.children?.indexOf(child) ?? 0,
        );
        results.push(...childNodes);
      }
    }
  } else if (CONTENT_ROLES.has(role)) {
    // Content node — include if it has a name, or has interactive children
    const hasInteractive = hasInteractiveDescendant(node);
    if (name !== '' || hasInteractive) {
      const compactNode: CompactNode = {
        role,
        name,
        indent: depth,
      };

      if (node.value !== undefined && node.value !== '') {
        compactNode.value = node.value;
      }

      results.push(compactNode);

      // Walk children
      if (node.children) {
        for (const child of node.children) {
          const childNodes = walkAX(
            child,
            depth + 1,
            counter,
            verbosity,
            [...parents, node],
            node.children ?? [],
            node.children?.indexOf(child) ?? 0,
          );
          results.push(...childNodes);
        }
      }
    }
  } else if (SKIP_ROLES.has(role)) {
    // Skip this node, but walk children if it has interactive descendants
    if (hasInteractiveDescendant(node)) {
      if (node.children) {
        for (const child of node.children) {
          const childNodes = walkAX(
            child,
            depth,
            counter,
            verbosity,
            [...parents, node],
            node.children ?? [],
            node.children?.indexOf(child) ?? 0,
          );
          results.push(...childNodes);
        }
      }
    }
    // Else: skip entirely
  } else if (FULL_VERBOSITY_ROLES.has(role) && verbosity === 'full') {
    // Emit the node only when it has a name, but ALWAYS descend. A <p> has no
    // accessible name, so gating the recursion on the name dropped the element
    // and every word inside it — which is why prose appeared at no verbosity
    // at all (issue #27).
    if (name !== '') {
      results.push({ role, name, indent: depth });
    }
    if (node.children) {
      for (const child of node.children) {
        const childNodes = walkAX(
          child,
          depth + 1,
          counter,
          verbosity,
          [...parents, node],
          node.children,
          node.children.indexOf(child),
        );
        results.push(...childNodes);
      }
    }
  } else {
    // Other roles: include if has interactive descendants or is a named node in standard+
    const hasInteractive = hasInteractiveDescendant(node);
    if (hasInteractive) {
      // Descend without emitting the container
      if (node.children) {
        for (const child of node.children) {
          const childNodes = walkAX(
            child,
            depth,
            counter,
            verbosity,
            [...parents, node],
            node.children ?? [],
            node.children?.indexOf(child) ?? 0,
          );
          results.push(...childNodes);
        }
      }
    } else if (name !== '' && verbosity === 'full') {
      // Same trap as the paragraph branch: emitting a named container without
      // descending silently drops everything inside it. Emit, then descend.
      results.push({ role, name, indent: depth });
      if (node.children) {
        for (const child of node.children) {
          results.push(...walkAX(child, depth + 1, counter, verbosity));
        }
      }
    } else if (node.children) {
      // Descend regardless
      for (const child of node.children) {
        const childNodes = walkAX(
          child,
          depth,
          counter,
          verbosity,
          [...parents, node],
          node.children ?? [],
          node.children?.indexOf(child) ?? 0,
        );
        results.push(...childNodes);
      }
    }
  }

  return results;
}

/**
 * State with nothing left beyond what the absence of a state object already
 * implies. `buildState()` stamps `enabled` on every interactive node, so a
 * bare `{ enabled: true }` says only "this control is ordinary" while spending
 * tokens saying it on each line of the view.
 *
 * Non-default state survives untouched: disabled / checked / required /
 * expanded / selected change what an action means, and a minimal view that
 * hides them makes the model act blind.
 */
function stripDefaultState(state: NodeState | undefined): NodeState | undefined {
  if (state === undefined) return undefined;
  const meaningful: NodeState = {};
  if (state.enabled === false) meaningful.enabled = false;
  if (state.checked !== undefined) meaningful.checked = state.checked;
  if (state.required !== undefined) meaningful.required = state.required;
  if (state.expanded !== undefined) meaningful.expanded = state.expanded;
  if (state.selected !== undefined) meaningful.selected = state.selected;
  return Object.keys(meaningful).length > 0 ? meaningful : undefined;
}

/**
 * Apply minimal verbosity filter (AC-S6).
 *
 * Keeps handle-bearing nodes only. The previous rule — "handles plus headings"
 * — was no cut at all: on list-like pages nearly every node standard keeps is
 * interactive or a heading, so both levels produced identical output
 * (issue #18). Dropping every content-only node is safe for disambiguation:
 * a control's `context` label was captured during the walk and attached after
 * this filter runs, so the surrounding prose node goes while the label that
 * tells identical controls apart stays (AC-S8). `value` and non-default state
 * are likewise preserved by this filter — see `stripDefaultState`.
 */
function applyMinimalFilter(nodes: CompactNode[]): CompactNode[] {
  return nodes.filter((n) => n.handle !== undefined);
}

/**
 * DOM fallback: walk AX tree again and include generic/unknown nodes with non-empty names
 * that would otherwise have been skipped.
 */
function domFallbackWalk(
  node: AXSnapshot,
  depth: number,
  counter: [number],
  existingNodes: CompactNode[],
): CompactNode[] {
  const results: CompactNode[] = [];

  if (node.hidden === true) return results;

  const role = node.role;
  const name = node.name ?? '';

  if ((role === 'generic' || role === 'unknown') && name !== '') {
    // Check if this node is already represented (by name match)
    const alreadyCovered = existingNodes.some((n) => n.name.toLowerCase() === name.toLowerCase());
    if (!alreadyCovered) {
      counter[0]++;
      const handle = `e${counter[0]}`;
      const compactNode: CompactNode = {
        handle,
        role,
        name,
        indent: depth,
      };
      const state = buildState(node);
      if (state !== undefined) compactNode.state = state;
      results.push(compactNode);
    }
  }

  if (node.children) {
    for (const child of node.children) {
      const childFallback = domFallbackWalk(child, depth + 1, counter, existingNodes);
      results.push(...childFallback);
    }
  }

  return results;
}

/**
 * Attach disambiguating context, but only where it earns its tokens (AC-S8).
 *
 * A control whose role+name is already unique on the page needs nothing. Where
 * several share both, each gets the nearest surrounding text that is not just a
 * repeat of its own name — the row label, the section, the toolbar it sits in.
 * Nodes with nothing useful nearby are left alone rather than given a made-up
 * label; they remain separately addressable by handle.
 */
/**
 * How far back to look for text that identifies a control's row (AC-S12).
 *
 * Bounded because the walk is per colliding node and because text far from a
 * control is unlikely to describe it.
 */
const CONTEXT_LOOKBACK_NODES = 30;

/**
 * Text from the nearest thing *above* this node in the tree that is not simply
 * a restatement of the node's own subtree.
 *
 * The candidates gathered during the walk — sibling text and named ancestors —
 * find nothing on a page built out of rows (issue #44). Measured on Hacker
 * News: a `hide` link's siblings are all links, which `siblingText()` excludes;
 * its only named ancestor is the cell whose name concatenates the whole row
 * (`"149 points by vanpra 2 hours ago | hide | 58 comments"`), which restates
 * the link itself and is over the ancestor length limit anyway; and the story
 * title lives in a *different* table row, so it is neither sibling nor
 * ancestor. Thirty identical `link "hide"` and nothing to tell them apart.
 *
 * The view is flat and in document order, so the row's identity is reachable by
 * walking back to the first node shallower than this one. That is the title
 * cell, and it labels all thirty correctly.
 *
 * Two guards keep it honest:
 *
 * - A candidate containing this node's own name is skipped: that is an ancestor
 *   whose accessible name is the concatenation of its descendants, describing
 *   this control rather than distinguishing it.
 * - The walk stops at another member of the same colliding group, because past
 *   it we are in a different row and its text describes that row, not this one.
 *
 * Only for nodes that have a name of their own. An unnamed control — Hacker
 * News's upvote arrows are `link ""` — is identified by what comes *after* it,
 * and measuring the backward walk on those produced the previous row's text
 * every time. Confidently wrong is worse than blank, so they are left alone.
 */
/** Identity of a colliding group: same role, same accessible name. */
function contextKey(n: CompactNode): string {
  return `${n.role}\u0000${n.name.toLowerCase().trim()}`;
}

function precedingRowText(
  nodes: CompactNode[],
  index: number,
  groupKey: string,
): string | undefined {
  const self = nodes[index];
  if (self === undefined) return undefined;
  const own = self.name.toLowerCase().trim();
  if (own === '') return undefined;

  const stop = Math.max(0, index - CONTEXT_LOOKBACK_NODES);
  for (let i = index - 1; i >= stop; i--) {
    const node = nodes[i];
    if (node === undefined) continue;
    if (node.handle !== undefined && contextKey(node) === groupKey) return undefined;
    if (node.indent >= self.indent) continue;

    const name = tidy(node.name);
    if (name === '' || !isUsefulContext(name)) continue;
    if (name.toLowerCase().includes(own)) continue;
    return name;
  }
  return undefined;
}

function attachContext(nodes: CompactNode[]): void {
  const key = contextKey;

  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.handle === undefined) continue;
    counts.set(key(n), (counts.get(key(n)) ?? 0) + 1);
  }

  // Every member of every colliding group, with its position, so a group whose
  // labels turn out useless can be reconsidered as a whole.
  const groups = new Map<string, Array<{ node: CompactNode; index: number }>>();
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === undefined || node.handle === undefined) continue;
    if ((counts.get(key(node)) ?? 0) < 2) continue;
    const bucket = groups.get(key(node)) ?? [];
    bucket.push({ node, index: i });
    groups.set(key(node), bucket);
  }

  /** The candidate gathered during the walk: sibling text, then named ancestors. */
  function walkCandidate(node: CompactNode): string | undefined {
    const own = node.name.toLowerCase().trim();
    return (candidatesByNode.get(node) ?? []).find(
      (c) => c !== '' && c.toLowerCase().trim() !== own && isUsefulContext(c),
    );
  }

  /**
   * Does this set of labels actually tell the group apart?
   *
   * A label shared by every "Delete" on the page — a section heading, a site
   * name — is true of all of them and separates none, so it is pure cost and a
   * false reassurance that the choice has been narrowed. A member with no label
   * counts as its own identity: when one button is labelled "Toolbar" and the
   * rest are not, that label is still doing work.
   */
  function distinguishes(labels: Array<string | undefined>): boolean {
    const named = labels.filter((l): l is string => l !== undefined);
    if (named.length === 0) return false;
    return new Set(named).size + (named.length < labels.length ? 1 : 0) >= 2;
  }

  /**
   * Trim a label to its budget *before* distinctness is judged.
   *
   * Truncating afterwards can merge two labels that the check just certified as
   * different — two headlines sharing an opening clause — and hand back a group
   * that looks narrowed and is not.
   */
  function trim(label: string | undefined): string | undefined {
    if (label === undefined) return undefined;
    return label.length > MAX_CONTEXT_CHARS ? `${label.slice(0, MAX_CONTEXT_CHARS - 1)}…` : label;
  }

  for (const [groupKey, group] of groups) {
    const fromWalk = group.map(({ node }) => trim(walkCandidate(node)));

    // Falling back only when the walk's answer is useless is deliberate. On
    // Hacker News the walk *does* find something for all thirty `hide` links —
    // the page name, "Hacker News" — which is true of every one of them. Left
    // as-is it satisfied the `??` and pre-empted the row text, then lost to the
    // check below, so the group ended up with no labels at all (issue #44).
    const chosen = distinguishes(fromWalk)
      ? fromWalk
      : group.map(({ index }) => trim(precedingRowText(nodes, index, groupKey)));

    if (!distinguishes(chosen)) continue;

    for (let i = 0; i < group.length; i++) {
      const label = chosen[i];
      const target = group[i]?.node;
      if (label === undefined || target === undefined) continue;
      target.context = label;
    }
  }
}

/**
 * Serialize an AX snapshot into a CompactView.
 *
 * Pure and deterministic: given the same inputs, always returns the same output.
 * No async, no network, no LLM calls.
 */
export function serialize(
  axSnapshot: AXSnapshot | null,
  _domFallback: unknown,
  opts?: SerializerOptions,
): CompactView {
  const verbosity: Verbosity = opts?.verbosity ?? 'standard';
  const url = opts?.url ?? '';
  const title = opts?.title ?? '';

  const counter: [number] = [0];
  let nodes: CompactNode[] = [];

  if (axSnapshot !== null) {
    nodes = walkAX(axSnapshot, 0, counter, verbosity);
  }

  // Apply verbosity filter
  let filteredNodes: CompactNode[];
  if (verbosity === 'minimal') {
    filteredNodes = applyMinimalFilter(nodes);
  } else {
    filteredNodes = nodes;
  }

  // DOM fallback (FR-8): if fewer than 5 interactive nodes, do a second pass
  const interactiveCount = filteredNodes.filter((n) => n.handle !== undefined).length;
  if (interactiveCount < 5 && axSnapshot !== null) {
    const fallbackNodes = domFallbackWalk(axSnapshot, 0, counter, filteredNodes);
    filteredNodes = [...filteredNodes, ...fallbackNodes];
  }

  attachContext(filteredNodes);

  // Minimal strips state that only restates the default, including on nodes
  // the DOM fallback synthesized. Runs after `attachContext` because the
  // context candidates are held in a WeakMap keyed by node identity — replacing
  // nodes earlier would orphan every control's label (AC-S8). Spreading keeps
  // the attached `context`; nothing shared is mutated, so purity holds.
  if (verbosity === 'minimal') {
    filteredNodes = filteredNodes.map((n) => {
      if (n.state === undefined) return n;
      const stripped = stripDefaultState(n.state);
      if (stripped !== undefined) return { ...n, state: stripped };
      const withoutState = { ...n };
      delete withoutState.state;
      return withoutState;
    });
  }

  const budgeted = applyTokenBudget(filteredNodes, opts?.maxTokens);

  return {
    url,
    title,
    verbosity,
    tokenCount: budgeted.tokenCount,
    timestampMs: Date.now(),
    nodes: budgeted.nodes,
    truncated: budgeted.dropped > 0,
    ...(budgeted.dropped > 0 ? { droppedNodes: budgeted.dropped } : {}),
  };
}

/** One outline line, exactly as the token count and the formatters render it. */
function renderLine(n: CompactNode): string {
  const indent = '  '.repeat(n.indent);
  const handleStr = n.handle ? `[${n.handle}] ` : '';
  const valueStr = n.value ? ` value="${n.value}"` : '';
  const contextStr = n.context ? ` (${n.context})` : '';
  return `${indent}${handleStr}${n.role} "${n.name}"${valueStr}${contextStr}`;
}

function countFor(nodes: CompactNode[]): number {
  return estimateTokens(nodes.map(renderLine).join('\n'));
}

/**
 * Trim the view to a token budget, keeping the start of the document (AC-S11).
 *
 * Dropping from the end preserves reading order and keeps the part of a page a
 * caller is most likely to want. The alternative — letting the host truncate —
 * cuts at an arbitrary byte with no notice, which is how an outline silently
 * loses half its handles.
 *
 * The notice is a node, not just metadata, because the model reads the outline.
 * Without it a truncated page is indistinguishable from a short one, and an
 * agent concludes the thing it was looking for is not there.
 *
 * Binary search rather than a linear walk: token counting is the expensive part
 * and BPE is not additive across lines, so each candidate prefix is counted for
 * real instead of summed from per-line estimates.
 */
function applyTokenBudget(
  nodes: CompactNode[],
  maxTokens: number | undefined,
): { nodes: CompactNode[]; tokenCount: number; dropped: number } {
  const full = countFor(nodes);

  const budgetRequested = maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0;
  if (!budgetRequested || full <= (maxTokens as number)) {
    return { nodes, tokenCount: full, dropped: 0 };
  }
  const budget = maxTokens as number;

  const notice = (dropped: number): CompactNode => ({
    role: 'note',
    name: `[${String(dropped)} of ${String(nodes.length)} nodes omitted to fit maxTokens=${String(budget)}]`,
    indent: 0,
  });

  // Largest prefix that still fits once the notice is accounted for.
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    const candidate = [...nodes.slice(0, mid), notice(nodes.length - mid)];
    if (countFor(candidate) <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const kept = nodes.slice(0, low);
  const dropped = nodes.length - low;
  const withNotice = [...kept, notice(dropped)];
  const withNoticeCount = countFor(withNotice);

  // A budget too small for even the notice: return the notice alone rather than
  // an empty view that looks like a page with nothing on it.
  if (low === 0 && withNoticeCount > budget) {
    const alone = [notice(nodes.length)];
    return { nodes: alone, tokenCount: countFor(alone), dropped: nodes.length };
  }

  return { nodes: withNotice, tokenCount: withNoticeCount, dropped };
}

// Lazily-resolved cl100k_base encoder. `undefined` = not yet attempted,
// `null` = unavailable on this platform (fall back to the approximation).
let encoder: { encode: (text: string) => ArrayLike<number> } | null | undefined;

function getEncoder(): { encode: (text: string) => ArrayLike<number> } | null {
  if (encoder === undefined) {
    try {
      const require = createRequire(import.meta.url);
      const { get_encoding } = require('tiktoken') as {
        get_encoding: (name: string) => { encode: (text: string) => ArrayLike<number> };
      };
      encoder = get_encoding('cl100k_base');
    } catch {
      encoder = null;
    }
  }
  return encoder;
}

/**
 * Count tokens in `text` using the cl100k_base tokenizer.
 *
 * Pure and deterministic: local table lookup, no network. Falls back to the
 * old characters/4 approximation only if the tokenizer cannot be loaded, since
 * a rough number beats crashing a run over token accounting.
 *
 * cl100k_base is exact for OpenAI-compatible models and a close proxy for
 * others; it is not Claude's tokenizer.
 */
export function estimateTokens(text: string): number {
  if (text === '') return 0;
  const enc = getEncoder();
  if (enc === null) return Math.ceil(text.length / 4);
  try {
    return enc.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * Deterministic content hash of a compact view, used for loop detection
 * (AC-AG10).
 *
 * Hashes the page's identity — URL, title, and the serialized node tree — and
 * deliberately excludes `timestampMs` (changes on every observation) and
 * `tokenCount` (derived from the nodes, so redundant). Two observations of an
 * unchanged page therefore produce the same hash; an action that actually
 * altered the page will produce a different one.
 *
 * Pure and deterministic (no LLM, no network), consistent with the serializer
 * contract.
 */
export function hashView(view: CompactView): string {
  const canonical = JSON.stringify({
    url: view.url,
    title: view.title,
    nodes: view.nodes,
  });
  return createHash('sha256').update(canonical).digest('hex');
}
