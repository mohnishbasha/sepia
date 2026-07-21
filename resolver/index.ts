import type { CompactNode, CompactView } from '../types/index.js';

export interface StableAttrs {
  id?: string;
  name?: string;
  dataTestId?: string;
  ariaLabel?: string;
}

export interface SemanticFingerprint {
  role: string;
  accessibleName: string;
  inputType?: string;
  stableAttrs: StableAttrs;
  normalizedNearbyLabel?: string;
  ordinalAmongSameRole: number;
}

export interface HandleRecord {
  handle: string;
  fingerprint: SemanticFingerprint;
  confidence: number;
  stale: boolean;
  lastSeenMs: number;
}

export type HandleMap = Map<string, HandleRecord>;

export interface ResolveResult {
  record: HandleRecord;
  confidence: number;
  stale: boolean;
}

// Per-map counter stored as a property on the Map instance
const counterKey = Symbol('handleCounter');

type HandleMapWithCounter = HandleMap & { [counterKey]?: number };

export function createHandleMap(): HandleMap {
  return new Map<string, HandleRecord>();
}

/**
 * Tokenize a string into lowercase words by splitting on whitespace and punctuation.
 */
function tokenize(str: string): Set<string> {
  if (!str) return new Set<string>();
  const tokens = str.split(/[\s\p{P}]+/u).filter((t) => t.length > 0);
  return new Set(tokens.map((t) => t.toLowerCase()));
}

/**
 * Jaccard similarity between two token sets.
 * |intersection| / |union|
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;

  let intersectionSize = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersectionSize++;
    }
  }

  const unionSize = a.size + b.size - intersectionSize;
  return unionSize === 0 ? 1.0 : intersectionSize / unionSize;
}

/**
 * Score two semantic fingerprints for similarity. Returns 0.0–1.0.
 */
export function scoreFingerprints(a: SemanticFingerprint, b: SemanticFingerprint): number {
  // roleMatch: 1 if same role, else 0
  const roleMatch = a.role === b.role ? 1.0 : 0.0;

  // nameMatch: Jaccard similarity of tokenized accessible names
  const nameMatch = jaccardSimilarity(tokenize(a.accessibleName), tokenize(b.accessibleName));

  // attrsMatch: check stable attrs
  const aHasAttrs =
    a.stableAttrs.id !== undefined ||
    a.stableAttrs.name !== undefined ||
    a.stableAttrs.dataTestId !== undefined ||
    a.stableAttrs.ariaLabel !== undefined;
  const bHasAttrs =
    b.stableAttrs.id !== undefined ||
    b.stableAttrs.name !== undefined ||
    b.stableAttrs.dataTestId !== undefined ||
    b.stableAttrs.ariaLabel !== undefined;

  let attrsMatch: number;
  if (!aHasAttrs && !bHasAttrs) {
    // Both have no stable attrs — neutral
    attrsMatch = 0.5;
  } else if (aHasAttrs && bHasAttrs) {
    // Check if any attr matches
    const anyMatch =
      (a.stableAttrs.id !== undefined && a.stableAttrs.id === b.stableAttrs.id) ||
      (a.stableAttrs.name !== undefined && a.stableAttrs.name === b.stableAttrs.name) ||
      (a.stableAttrs.dataTestId !== undefined &&
        a.stableAttrs.dataTestId === b.stableAttrs.dataTestId) ||
      (a.stableAttrs.ariaLabel !== undefined &&
        a.stableAttrs.ariaLabel === b.stableAttrs.ariaLabel);
    attrsMatch = anyMatch ? 1.0 : 0.0;
  } else {
    // One has attrs, other doesn't — neutral-ish, treat as no overlap
    attrsMatch = 0.5;
  }

  // ordinalSimilarity: 1 - min(1, |diff| / 5)
  const ordinalSimilarity =
    1.0 - Math.min(1.0, Math.abs(a.ordinalAmongSameRole - b.ordinalAmongSameRole) / 5.0);

  // Weighted sum
  const score = 0.4 * roleMatch + 0.35 * nameMatch + 0.15 * attrsMatch + 0.1 * ordinalSimilarity;

  return score;
}

/**
 * Derive a semantic fingerprint from a CompactNode and its siblings list.
 * The siblings list is the flat array in which this node appears.
 */
export function deriveFingerprint(node: CompactNode, siblings: CompactNode[]): SemanticFingerprint {
  const accessibleName = (node.name ?? '').toLowerCase().trim();

  // Count siblings with the same role appearing BEFORE this node
  let ordinalAmongSameRole = 0;
  for (const sibling of siblings) {
    if (sibling === node) break;
    if (sibling.role === node.role) {
      ordinalAmongSameRole++;
    }
  }

  return {
    role: node.role,
    accessibleName,
    stableAttrs: {},
    ordinalAmongSameRole,
  };
}

/**
 * Find an existing handle with score > 0.85, or create a new one.
 * Returns the handle string.
 */
export function assignHandle(fingerprint: SemanticFingerprint, map: HandleMap): string {
  const mapWithCounter = map as HandleMapWithCounter;

  // Search for a matching existing handle
  let bestHandle: string | null = null;
  let bestScore = 0;

  for (const [handle, record] of map) {
    const score = scoreFingerprints(fingerprint, record.fingerprint);
    if (score > bestScore) {
      bestScore = score;
      bestHandle = handle;
    }
  }

  if (bestHandle !== null && bestScore > 0.85) {
    // Update lastSeenMs on existing record
    const existing = map.get(bestHandle);
    if (existing) {
      map.set(bestHandle, {
        ...existing,
        lastSeenMs: Date.now(),
      });
    }
    return bestHandle;
  }

  // Create a new handle
  const counter = (mapWithCounter[counterKey] ?? 0) + 1;
  mapWithCounter[counterKey] = counter;
  const handle = `e${counter}`;

  map.set(handle, {
    handle,
    fingerprint,
    confidence: 1.0,
    stale: false,
    lastSeenMs: Date.now(),
  });

  return handle;
}

/**
 * Resolve a stored handle against current DOM nodes.
 * Returns a ResolveResult with stale flag and confidence score.
 */
export function resolveHandle(
  handle: string,
  currentNodes: CompactNode[],
  map: HandleMap,
): ResolveResult {
  const record = map.get(handle);

  if (!record) {
    const emptyRecord: HandleRecord = {
      handle,
      fingerprint: {
        role: '',
        accessibleName: '',
        stableAttrs: {},
        ordinalAmongSameRole: 0,
      },
      confidence: 0,
      stale: true,
      lastSeenMs: 0,
    };
    return {
      stale: true,
      confidence: 0,
      record: emptyRecord,
    };
  }

  const storedFingerprint = record.fingerprint;

  let bestScore = 0;
  let bestNode: CompactNode | null = null;

  for (const node of currentNodes) {
    const fp = deriveFingerprint(node, currentNodes);
    const score = scoreFingerprints(storedFingerprint, fp);
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  void bestNode; // used for finding bestScore

  if (bestScore >= 0.6) {
    const updatedRecord: HandleRecord = {
      ...record,
      stale: false,
      confidence: bestScore,
      lastSeenMs: Date.now(),
    };
    map.set(handle, updatedRecord);
    return {
      stale: false,
      confidence: bestScore,
      record: updatedRecord,
    };
  } else {
    const updatedRecord: HandleRecord = {
      ...record,
      stale: true,
      confidence: bestScore,
      lastSeenMs: Date.now(),
    };
    map.set(handle, updatedRecord);
    return {
      stale: true,
      confidence: bestScore,
      record: updatedRecord,
    };
  }
}

/**
 * Walk a flat list of CompactNodes, assign/re-resolve handles for all
 * interactive nodes (those with a handle field set), and return updated nodes.
 */
export function processNodes(nodes: CompactNode[], map: HandleMap): CompactNode[] {
  return nodes.map((node) => {
    if (node.handle === undefined) {
      // Non-interactive node — pass through
      return node;
    }

    const fingerprint = deriveFingerprint(node, nodes);
    const handle = assignHandle(fingerprint, map);

    return { ...node, handle };
  });
}

/**
 * Apply processNodes to a CompactView's nodes, return a new CompactView.
 */
export function processCompactView(view: CompactView, map: HandleMap): CompactView {
  return {
    ...view,
    nodes: processNodes(view.nodes, map),
  };
}
