import type { Verbosity, CompactView, CompactNode, NodeState } from '../types/index.js';

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
  children?: AXSnapshot[];
}

export interface SerializerOptions {
  verbosity?: Verbosity;
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
 * Walk the AX tree depth-first and produce CompactNode[].
 * counter is a single-element array so it can be mutated by reference.
 */
function walkAX(
  node: AXSnapshot,
  depth: number,
  counter: [number],
  verbosity: Verbosity,
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

    results.push(compactNode);

    // Walk children
    if (node.children) {
      for (const child of node.children) {
        const childNodes = walkAX(child, depth + 1, counter, verbosity);
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
          const childNodes = walkAX(child, depth + 1, counter, verbosity);
          results.push(...childNodes);
        }
      }
    }
  } else if (SKIP_ROLES.has(role)) {
    // Skip this node, but walk children if it has interactive descendants
    if (hasInteractiveDescendant(node)) {
      if (node.children) {
        for (const child of node.children) {
          const childNodes = walkAX(child, depth, counter, verbosity);
          results.push(...childNodes);
        }
      }
    }
    // Else: skip entirely
  } else if (FULL_VERBOSITY_ROLES.has(role) && verbosity === 'full') {
    // Full verbosity includes paragraph/text with non-empty names
    if (name !== '') {
      const compactNode: CompactNode = {
        role,
        name,
        indent: depth,
      };
      results.push(compactNode);

      if (node.children) {
        for (const child of node.children) {
          const childNodes = walkAX(child, depth + 1, counter, verbosity);
          results.push(...childNodes);
        }
      }
    }
  } else {
    // Other roles: include if has interactive descendants or is a named node in standard+
    const hasInteractive = hasInteractiveDescendant(node);
    if (hasInteractive) {
      // Descend without emitting the container
      if (node.children) {
        for (const child of node.children) {
          const childNodes = walkAX(child, depth, counter, verbosity);
          results.push(...childNodes);
        }
      }
    } else if (name !== '' && verbosity === 'full') {
      // In full verbosity, include named nodes
      const compactNode: CompactNode = {
        role,
        name,
        indent: depth,
      };
      results.push(compactNode);
    } else if (node.children) {
      // Descend regardless
      for (const child of node.children) {
        const childNodes = walkAX(child, depth, counter, verbosity);
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
  return nodes.filter(
    (n) => n.handle !== undefined || n.role === 'heading',
  );
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
    const alreadyCovered = existingNodes.some(
      (n) => n.name.toLowerCase() === name.toLowerCase(),
    );
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

  // Compute token count
  const outlineText = filteredNodes
    .map((n) => {
      const indent = '  '.repeat(n.indent);
      const handleStr = n.handle ? `[${n.handle}] ` : '';
      const valueStr = n.value ? ` value="${n.value}"` : '';
      return `${indent}${handleStr}${n.role} "${n.name}"${valueStr}`;
    })
    .join('\n');

  const tokenCount = estimateTokens(outlineText);

  return {
    url,
    title,
    verbosity,
    tokenCount,
    timestampMs: Date.now(),
    nodes: filteredNodes,
  };
}

/**
 * Estimate token count using the cl100k_base approximation:
 * tokens ≈ characters / 4.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
