/**
 * PURE `loom:` URI helpers (no `vscode` import) — parse + build the paths the
 * FileSystemProvider serves, so the routing is unit-testable in isolation.
 *
 * Scheme layout (authority intentionally EMPTY — VS Code lower-cases authorities,
 * which would corrupt a case-sensitive deployment id, so the id lives in the
 * PATH):
 *
 *   loom:/<deploymentId>/<itemType>/<itemId>/<slug>.definition.json
 *         └── segment 0 ──┘└── seg 1 ─┘└─ seg 2 ┘└──── cosmetic basename ────┘
 *
 * The first three segments are the stable key (the basename is cosmetic — it
 * gives the editor tab a friendly title but is ignored when routing). A
 * three-segment path with no basename is the item's directory.
 */

/** The canonical suffix of an item-definition file. */
export const DEFINITION_SUFFIX = '.definition.json';

/** A resolved reference into the `loom:` filesystem. */
export interface LoomRef {
  deploymentId: string;
  itemType: string;
  itemId: string;
  /** Present for a file path; absent for the item directory. */
  filename?: string;
}

/** True when a basename is an item-definition file. */
export function isDefinitionFile(filename: string): boolean {
  return filename.toLowerCase().endsWith(DEFINITION_SUFFIX);
}

/** URL-safe slug for a display name (cosmetic basename component). */
export function slugForName(displayName: string): string {
  const s = (displayName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'item';
}

/**
 * Build the `loom:` PATH (leading slash, no scheme) for an item's definition
 * file. The caller wraps it in a `vscode.Uri` with scheme `loom`.
 */
export function buildDefinitionPath(ref: {
  deploymentId: string;
  itemType: string;
  itemId: string;
  displayName?: string;
}): string {
  const filename = `${slugForName(ref.displayName ?? ref.itemId)}${DEFINITION_SUFFIX}`;
  return (
    '/' +
    [ref.deploymentId, ref.itemType, ref.itemId, filename]
      .map((s) => encodeURIComponent(s))
      .join('/')
  );
}

/** Build the item's directory PATH (three segments, no basename). */
export function buildItemDirPath(ref: {
  deploymentId: string;
  itemType: string;
  itemId: string;
}): string {
  return (
    '/' +
    [ref.deploymentId, ref.itemType, ref.itemId].map((s) => encodeURIComponent(s)).join('/')
  );
}

/** Thrown when a path is not a valid `loom:` reference. */
export class LoomPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoomPathError';
  }
}

/**
 * Parse a `loom:` URI PATH into a {@link LoomRef}. Accepts the item directory
 * (3 segments) or a definition file (4 segments). Anything else throws — P2
 * does not model deeper subtrees (e.g. notebook `builtin/`; see report).
 */
export function parseLoomRef(path: string): LoomRef {
  const segments = path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s));
  if (segments.length === 3) {
    return { deploymentId: segments[0], itemType: segments[1], itemId: segments[2] };
  }
  if (segments.length === 4) {
    return {
      deploymentId: segments[0],
      itemType: segments[1],
      itemId: segments[2],
      filename: segments[3],
    };
  }
  throw new LoomPathError(
    `Not a loom: item path (expected /<deployment>/<type>/<id>[/<file>], got ${segments.length} segments)`,
  );
}
