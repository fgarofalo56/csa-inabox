/**
 * canvas-comment-model — the PURE (no-Cosmos, no-DOM) logic layer for W4 canvas
 * comments / sticky notes. It owns the doc shape + every decision the store and
 * BFF route depend on, so they can be unit-tested without a Cosmos account:
 *
 *   • the persisted {@link CanvasCommentDoc} shape (PK /itemId, keyed by the
 *     item + the canvas within it + a uuid);
 *   • input validation / normalization ({@link normalizeCommentInput}) — text
 *     trim + length cap, finite coordinate clamp, kind + colour whitelist;
 *   • the retention-cap decision ({@link commentsToPrune}) — oldest-evicted so a
 *     runaway canvas can't grow the partition unbounded;
 *   • the client-facing projection ({@link toCommentView}).
 *
 * No Fluent / React import here on purpose: this module stays import-light so
 * the vitest harness runs it in the node env with zero DOM cost (mirrors
 * canvas-anatomy.ts under the node-kit).
 */

/** A comment can render as a small pin (`comment`) or a full sticky note (`sticky`). */
export type CanvasCommentKind = 'comment' | 'sticky';

/**
 * Sticky accent colour KEY. The store persists only the KEY; the kit (.tsx)
 * maps it to a theme-aware `--loom-accent-*` var so no colour string is ever
 * stored (same key→token discipline as canvas-anatomy's port colours).
 */
export type CanvasCommentColor = 'amber' | 'blue' | 'violet' | 'teal' | 'magenta';

export const CANVAS_COMMENT_COLORS: readonly CanvasCommentColor[] = [
  'amber', 'blue', 'violet', 'teal', 'magenta',
];

export const DEFAULT_CANVAS_COMMENT_COLOR: CanvasCommentColor = 'amber';

/** Max characters in a single comment/sticky body (over-long input is truncated). */
export const MAX_CANVAS_COMMENT_LEN = 2000;

/**
 * Max comments retained per (item, canvas). The oldest are evicted on create
 * beyond this cap so a single canvas partition never grows unbounded. Overridable
 * via LOOM_CANVAS_COMMENT_CAP (an opt-in tuning knob; unset = this default).
 */
export const DEFAULT_CANVAS_COMMENT_CAP = 300;

export function canvasCommentCap(): number {
  const raw = Number(process.env.LOOM_CANVAS_COMMENT_CAP);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_CANVAS_COMMENT_CAP;
}

/**
 * A persisted canvas comment / sticky note. PK is /itemId so every per-item
 * (across all its canvases) list + prune hits a single physical partition. The
 * `canvasKey` distinguishes multiple canvases inside one item (e.g. a report's
 * page canvas vs its model canvas); default hosts pass `'default'`.
 */
export interface CanvasCommentDoc {
  id: string;                    // `cc:<itemId>:<canvasKey>:<uuid>`
  docType: 'canvas-comment';
  itemId: string;                // partition key
  itemType: string;              // owning item slug (for audit / cross-check)
  canvasKey: string;             // which canvas within the item
  kind: CanvasCommentKind;
  text: string;
  /** React Flow flow-coordinates the note is anchored at. */
  x: number;
  y: number;
  color: CanvasCommentColor;
  /** Author identity (Entra oid) — only the author may edit / delete. */
  authorOid: string;
  authorName?: string;
  /** Marked resolved (kept for history; the kit renders it dimmed + checked). */
  resolved?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The client-facing projection (identical fields today; a seam for future trims). */
export interface CanvasCommentView {
  id: string;
  canvasKey: string;
  kind: CanvasCommentKind;
  text: string;
  x: number;
  y: number;
  color: CanvasCommentColor;
  authorOid: string;
  authorName?: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  /** True when the reading session is the author (drives edit/delete affordances). */
  mine: boolean;
}

/** Raw create/patch input off the request body (all optional at the type level). */
export interface CanvasCommentInput {
  kind?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  color?: unknown;
  resolved?: unknown;
}

/** Normalized, validated fields ready to persist. */
export interface NormalizedCommentFields {
  kind: CanvasCommentKind;
  text: string;
  x: number;
  y: number;
  color: CanvasCommentColor;
  resolved: boolean;
}

/** Clamp a coordinate to a finite number (defaults to 0), rounding to 2dp. */
function clampCoord(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // Keep coordinates sane so a bad client can't push a note to ±1e300.
  const clamped = Math.max(-1_000_000, Math.min(1_000_000, n));
  return Math.round(clamped * 100) / 100;
}

function normColor(v: unknown): CanvasCommentColor {
  return CANVAS_COMMENT_COLORS.includes(v as CanvasCommentColor)
    ? (v as CanvasCommentColor)
    : DEFAULT_CANVAS_COMMENT_COLOR;
}

function normKind(v: unknown): CanvasCommentKind {
  return v === 'sticky' ? 'sticky' : 'comment';
}

/** Trim + cap the body. Returns '' when nothing usable was supplied. */
export function normalizeCommentText(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  return t.length > MAX_CANVAS_COMMENT_LEN ? t.slice(0, MAX_CANVAS_COMMENT_LEN) : t;
}

/**
 * Normalize a CREATE input. Returns null when the text is empty (a comment with
 * no body is rejected 422 by the route). Coordinates default to 0,0.
 */
export function normalizeCommentInput(input: CanvasCommentInput): NormalizedCommentFields | null {
  const text = normalizeCommentText(input.text);
  if (!text) return null;
  return {
    kind: normKind(input.kind),
    text,
    x: clampCoord(input.x),
    y: clampCoord(input.y),
    color: normColor(input.color),
    resolved: input.resolved === true,
  };
}

/**
 * Apply a PATCH input onto an existing doc, returning the fields to write.
 * Only the fields present in the patch are changed; text (when present) must be
 * non-empty. Returns null when a supplied text is blank (route → 422).
 */
export function applyCommentPatch(
  existing: CanvasCommentDoc,
  patch: CanvasCommentInput,
): Partial<NormalizedCommentFields> | null {
  const out: Partial<NormalizedCommentFields> = {};
  if (patch.text !== undefined) {
    const text = normalizeCommentText(patch.text);
    if (!text) return null;
    out.text = text;
  }
  if (patch.x !== undefined) out.x = clampCoord(patch.x);
  if (patch.y !== undefined) out.y = clampCoord(patch.y);
  if (patch.color !== undefined) out.color = normColor(patch.color);
  if (patch.kind !== undefined) out.kind = normKind(patch.kind);
  if (patch.resolved !== undefined) out.resolved = patch.resolved === true;
  return out;
}

/** Build the id for a new comment doc. */
export function newCommentId(itemId: string, canvasKey: string, uuid: string): string {
  return `cc:${itemId}:${canvasKey}:${uuid}`;
}

/**
 * PURE cap decision: given all comments for one (item, canvas) and a cap, return
 * the ids to DELETE so only the newest `cap` remain. Sorts by createdAt ascending
 * (oldest first), tie-broken by id for determinism. Exported for unit testing.
 */
export function commentsToPrune(
  all: ReadonlyArray<{ id: string; createdAt: string }>,
  cap: number,
): string[] {
  const c = cap < 1 ? 1 : cap;
  if (all.length <= c) return [];
  const sorted = [...all].sort((a, b) => {
    if (a.createdAt < b.createdAt) return -1;
    if (a.createdAt > b.createdAt) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return sorted.slice(0, all.length - c).map((v) => v.id);
}

/** Project a stored doc to its client view for a given reader oid. */
export function toCommentView(doc: CanvasCommentDoc, readerOid: string): CanvasCommentView {
  return {
    id: doc.id,
    canvasKey: doc.canvasKey,
    kind: doc.kind,
    text: doc.text,
    x: doc.x,
    y: doc.y,
    color: doc.color,
    authorOid: doc.authorOid,
    authorName: doc.authorName,
    resolved: doc.resolved === true,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    mine: doc.authorOid === readerOid,
  };
}
