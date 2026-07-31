import { createRequire } from 'node:module';
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
 * Apply minimal verbosity filter: keep only interactive nodes and headings.
 */
function applyMinimalFilter(nodes: CompactNode[]): CompactNode[] {
  return nodes.filter((n) => n.handle !== undefined || n.role === 'heading');
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
function attachContext(nodes: CompactNode[]): void {
  const key = (n: CompactNode): string => `${n.role}\u0000${n.name.toLowerCase().trim()}`;

  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.handle === undefined) continue;
    counts.set(key(n), (counts.get(key(n)) ?? 0) + 1);
  }

  // Pick a candidate per colliding node, grouped so the choice can be checked.
  const groups = new Map<string, Array<{ node: CompactNode; label: string }>>();

  for (const n of nodes) {
    if (n.handle === undefined) continue;
    if ((counts.get(key(n)) ?? 0) < 2) continue;

    const own = n.name.toLowerCase().trim();
    const chosen = (candidatesByNode.get(n) ?? []).find(
      (c) => c !== '' && c.toLowerCase().trim() !== own && isUsefulContext(c),
    );
    if (chosen === undefined) continue;

    const label =
      chosen.length > MAX_CONTEXT_CHARS ? `${chosen.slice(0, MAX_CONTEXT_CHARS - 1)}…` : chosen;
    const bucket = groups.get(key(n)) ?? [];
    bucket.push({ node: n, label });
    groups.set(key(n), bucket);
  }

  // Only keep labels that tell members of a group apart. A label shared by every
  // "Delete" on the page — a section heading, a site name — is true of all of
  // them and separates none, so it is pure cost and a false reassurance that the
  // choice has been narrowed.
  //
  // A member with no label counts as its own identity: when one button is
  // labelled "Toolbar" and the rest are not, that label is still doing work.
  for (const [groupKey, bucket] of groups) {
    const unlabelled = (counts.get(groupKey) ?? 0) - bucket.length;
    const identities = new Set(bucket.map((b) => b.label)).size + (unlabelled > 0 ? 1 : 0);
    if (identities < 2) continue;
    for (const { node, label } of bucket) node.context = label;
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
