'use client';

/**
 * useCanvasLayout — drag-resize + drag-to-reposition for the Report Designer canvas.
 *
 * Power BI report-authoring parity (ui-parity.md): in the real Power BI canvas a
 * visual is resized by dragging its corner grip and repositioned by dragging its
 * header. This hook is the Loom-native equivalent for the `report-designer.tsx`
 * 12-column canvas grid. It is intentionally the ONE file that owns this
 * interaction so the designer only has to *mount* the props it returns:
 *
 *   • {@link CanvasLayout.getResizeHandleProps} → spread onto a small corner grip
 *     inside each visual card. Pointer-drag updates the visual's column span
 *     (`w`, clamped to `[minSpan..columns]`) and row-height (`h`, in grid row
 *     units). Arrow keys give a keyboard-accessible resize.
 *   • {@link CanvasLayout.getDragHandleProps} → spread onto a header grab handle.
 *     HTML5 drag with a DISTINCT mime (`application/x-loom-visual`) so it never
 *     collides with the Fields-pane chip drags (which use `application/json`).
 *   • {@link CanvasLayout.getDropTargetProps} → spread onto each visual card. It
 *     also carries the `data-loom-vcard` anchor the resize math measures against.
 *     Dropping a dragged visual before/after this card reorders the list and
 *     repacks `x/y`.
 *
 * Everything is a pure state-mutation that delegates to the designer's own
 * `mutateVisual(id, fn)` / `mutatePage(fn)` — there is NO backend here and no new
 * persistence: `w/h` (and the additive `x/y`) already round-trip through
 * PUT /api/items/report/[id]/definition `layout`. The hook holds only transient
 * pointer/drag bookkeeping in refs.
 *
 * no-vaporware.md: this is wiring over real, already-persisted state — not a
 * stub. The existing S/M/L/XL size buttons and Move-left/right actions in the
 * designer remain as the documented keyboard-accessible fallbacks; this hook
 * ADDS direct manipulation on top (additive, the shipped designer is untouched).
 *
 * Wave-2 (multi-select Arrange) ADDS, all additive + pure where possible:
 *   • {@link alignVisuals}/{@link distributeVisuals}/{@link groupVisuals}/
 *     {@link ungroupVisuals}/{@link moveVisualBlock}/{@link snapToGrid} — pure,
 *     React-free array→array math (unit-testable like `packGridPositions`),
 *     operating on the additive grid `x/y/w/h` + `groupId`. The hook exposes
 *     imperative `alignVisuals`/`distributeVisuals`/`group`/`ungroup` that just
 *     delegate to `mutatePage` with these ops — no new persistence.
 *   • `lockedIds` option → the drag-handle + resize-grip return INERT props and
 *     the keyboard/imperative resize+move are no-ops for a locked id (Lock parity).
 *   • `snapToGrid` option (default true) → wires the designer's "Snap to grid"
 *     toggle: a reposition drag repacks `x/y` into grid flow only when snap is on.
 *   • Group move → dragging any member of a `groupId` relocates the whole group
 *     as a contiguous block (via {@link moveVisualBlock}).
 *
 * web3-ui.md: this file emits NO styling beyond two behavioural inline props
 * (`touchAction`/`cursor`, which no Fluent token expresses) — the grip element
 * and its token-based styling live in the designer. The hook is framework-pure
 * (React only) and generic over the visual/page shape, so it stays decoupled
 * from the designer's private `DVisual`/`DPage` types.
 *
 * This file has NO default export.
 */

import { useCallback, useRef, useState } from 'react';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

// ── Inherent layout constants (no Fluent token expresses these) ──────────────
/** Canvas grid column count — mirrors the designer's `repeat(12, …)` grid. */
const DEFAULT_COLUMNS = 12;
/** Minimum column span for a visual — matches the designer's `Math.max(2, …)`. */
const DEFAULT_MIN_SPAN = 2;
/** Pixels per grid row-height unit, used to translate a vertical drag into `h`
 *  steps (the card's `minHeight:180px` ≈ 4 rows ⇒ ~45px/row; 48 reads cleanly). */
const DEFAULT_ROW_UNIT_PX = 48;
/** Distinct DnD payload type so visual-reorder drags never trip the Fields-pane
 *  chip drops (those use `application/json`) and vice-versa. */
const VISUAL_DND_MIME = 'application/x-loom-visual';
/** The card anchor attribute the resize math measures column-width against. */
const CARD_ATTR = 'data-loom-vcard';

// ── Public shapes (structural — a designer `DVisual`/`DPage` satisfies these) ─

/** The minimal visual contract this hook reads/writes. `x/y` are additive and
 *  optional — the hook sets them on reorder; consumers that don't read them keep
 *  working off list order alone. `groupId` is additive too (Arrange → Group):
 *  members carrying the same id move together on a reposition drag. */
export interface CanvasVisualLike {
  id: string;
  /** Column span on the canvas grid. */
  w: number;
  /** Row-height hint, in grid row units. */
  h: number;
  /** Optional grid column origin (packed on reorder). */
  x?: number;
  /** Optional grid row origin (packed on reorder). */
  y?: number;
  /** Optional group id (Arrange → Group). Members reposition together. */
  groupId?: string;
}

/** The minimal page contract — anything carrying an ordered `visuals` array. */
export interface CanvasPageLike<V extends CanvasVisualLike> {
  visuals: V[];
}

export interface UseCanvasLayoutOptions<
  V extends CanvasVisualLike,
  P extends CanvasPageLike<V>,
> {
  /** The active page's visuals (read for keyboard nudges + clamping). */
  visuals: V[];
  /** The designer's per-visual mutator (already marks the report dirty). */
  mutateVisual: (id: string, fn: (v: V) => V) => void;
  /** The designer's active-page mutator (used for reorder + repack). */
  mutatePage: (fn: (p: P) => P) => void;
  /** Grid columns (default 12). */
  columns?: number;
  /** Minimum column span (default 2). */
  minSpan?: number;
  /** Pixels per row-height unit for the vertical resize math (default 48). */
  rowUnitPx?: number;
  /** When true (default) reorder also repacks `x/y` into grid flow positions. */
  assignPositions?: boolean;
  /** Snap-to-grid toggle (default true). When ON, a reposition drag reflows the
   *  cards into the 12-col grid flow (repacks `x/y`). When OFF, the dragged
   *  visual still reorders, but `x/y` are left untouched so manually-tuned
   *  positions survive — wiring the designer's "Snap to grid" toggle to a real
   *  effect (the column-step resize is intrinsic to the integer grid either way).
   *  Composes with {@link assignPositions}: packing happens only when BOTH are on. */
  snapToGrid?: boolean;
  /** Ids whose card is locked (Arrange → Lock). The reposition drag-handle and
   *  the resize grip return inert props for a locked id, and the keyboard/
   *  imperative resize + move are no-ops — full Lock parity. Unset = nothing
   *  locked (the shipped default, so existing callers are unaffected). */
  lockedIds?: Set<string>;
}

/** Where a hovered drop would land relative to the target card. */
export type DropSide = 'before' | 'after';

/** Spread onto the corner resize grip element. */
export interface ResizeHandleProps {
  role: 'slider';
  tabIndex: number;
  'aria-label': string;
  'aria-orientation': 'horizontal';
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-valuenow': number;
  'aria-valuetext': string;
  /** True when the visual is locked — the grip renders but does nothing. */
  'aria-disabled'?: boolean;
  style: CSSProperties;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onClick: (e: ReactMouseEvent<HTMLElement>) => void;
}

/** Spread onto the header grab handle that starts a reposition drag. */
export interface DragHandleProps {
  /** `false` when the visual is locked (drag disabled), else `true`. */
  draggable: boolean;
  'aria-label': string;
  /** True when the visual is locked — the handle renders but can't start a drag. */
  'aria-disabled'?: boolean;
  style: CSSProperties;
  onDragStart: (e: ReactDragEvent<HTMLElement>) => void;
  onDragEnd: (e: ReactDragEvent<HTMLElement>) => void;
  onClick: (e: ReactMouseEvent<HTMLElement>) => void;
}

/** Spread onto a visual card so it is a reorder drop target + resize anchor. */
export interface DropTargetProps {
  [CARD_ATTR]: string;
  onDragOver: (e: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (e: ReactDragEvent<HTMLElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLElement>) => void;
}

export interface CanvasLayout {
  /** Id of the visual being pointer-resized, else null (for an active affordance). */
  resizingId: string | null;
  /** True while a pointer resize is in progress. */
  isResizing: boolean;
  /** Id of the visual being dragged to reposition, else null. */
  draggingId: string | null;
  /** Current hovered drop position (for an insertion indicator), else null. */
  dropIndicator: { id: string; side: DropSide } | null;
  /** Props for the corner resize grip of `visual`. */
  getResizeHandleProps: (visual: CanvasVisualLike) => ResizeHandleProps;
  /** Props for the header grab handle of `visual`. */
  getDragHandleProps: (visual: CanvasVisualLike) => DragHandleProps;
  /** Props for `visual`'s card (drop target + `data-loom-vcard` anchor). */
  getDropTargetProps: (visual: CanvasVisualLike) => DropTargetProps;
  /** Keyboard/imperative: set an absolute column span (clamped). */
  setWidth: (id: string, w: number) => void;
  /** Keyboard/imperative: set an absolute row-height (≥1). */
  setHeight: (id: string, h: number) => void;
  /** Keyboard/imperative: nudge span/height by deltas (clamped). */
  resizeBy: (id: string, dW: number, dH: number) => void;
  /** Keyboard/imperative: move a visual one slot earlier (-1) or later (+1). */
  move: (id: string, dir: -1 | 1) => void;
  /** Whether snap-to-grid is active (reflects the `snapToGrid` option). */
  snapEnabled: boolean;
  /** True when `id` is in the locked set (drag/resize disabled). */
  isLocked: (id: string) => boolean;
  /** Arrange → Align: align the selected ids' left/center/right (x) or
   *  top/middle/bottom (y) to the selection's bounding box. */
  alignVisuals: (ids: Iterable<string>, edge: AlignEdge) => void;
  /** Arrange → Distribute: equalize the gaps between the selected ids along the axis. */
  distributeVisuals: (ids: Iterable<string>, axis: DistributeAxis) => void;
  /** Arrange → Group: stamp one new shared `groupId` on the selected ids. */
  group: (ids: Iterable<string>) => void;
  /** Arrange → Ungroup: clear the given `groupId` from every member. */
  ungroup: (groupId: string) => void;
}

// ── pure helpers (exported for unit-testing the math without React) ───────────

/** Round + clamp a column span into `[min..max]`. */
export function clampSpan(w: number, min: number, max: number): number {
  const n = Math.round(Number(w));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Clamp a row-height to a whole number ≥ 1. */
export function clampRows(h: number): number {
  const n = Math.round(Number(h));
  return Number.isFinite(n) ? Math.max(1, n) : 1;
}

/**
 * Pack visuals into left-to-right grid-flow `x/y` origins given their spans —
 * the Azure-native equivalent of an absolute-position layout, derived purely
 * from order + span so it stays consistent with the document-flow grid the
 * designer renders. Additive: `x/y` are stamped via an `as V` assertion so a
 * `DVisual` without declared `x/y` still type-checks and round-trips at runtime.
 */
export function packGridPositions<V extends CanvasVisualLike>(
  visuals: V[],
  columns: number = DEFAULT_COLUMNS,
  minSpan: number = DEFAULT_MIN_SPAN,
): V[] {
  let col = 0;
  let row = 0;
  return visuals.map((v) => {
    const span = clampSpan(v.w, minSpan, columns);
    if (col + span > columns) {
      col = 0;
      row += 1;
    }
    const placed = { ...v, x: col, y: row } as V;
    col += span;
    return placed;
  });
}

/** Move `draggedId` to just before/after `targetId`, preserving every other
 *  element's order. Returns the original array if the move is a no-op. */
export function reorderVisuals<V extends CanvasVisualLike>(
  visuals: V[],
  draggedId: string,
  targetId: string,
  side: DropSide,
): V[] {
  if (draggedId === targetId) return visuals;
  const from = visuals.findIndex((v) => v.id === draggedId);
  if (from < 0) return visuals;
  const next = visuals.slice();
  const [moved] = next.splice(from, 1);
  let to = next.findIndex((v) => v.id === targetId);
  if (to < 0) return visuals;
  if (side === 'after') to += 1;
  next.splice(to, 0, moved);
  return next;
}

// ── multi-select ARRANGE math (pure, React-free, unit-testable) ───────────────
// These operate on the additive grid coords (x/y/w/h) that `packGridPositions`
// stamps. They are the Loom-native equivalent of Power BI's Format → Align /
// Distribute / Group commands, kept as pure array→array transforms (like
// `packGridPositions`/`reorderVisuals`) so they can be unit-tested without React
// and reused by the designer's Arrange toolbar. No backend, no new persistence —
// x/y/groupId already round-trip through /definition `layout`.

/** Which edge an {@link alignVisuals} call snaps the selection to. */
export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
/** Axis a {@link distributeVisuals} call equalizes gaps along. */
export type DistributeAxis = 'horizontal' | 'vertical';

/** Read the grid origin/size, tolerating an unpacked visual (undefined ⇒ 0/1). */
const gx = (v: CanvasVisualLike): number => (Number.isFinite(Number(v.x)) ? Number(v.x) : 0);
const gy = (v: CanvasVisualLike): number => (Number.isFinite(Number(v.y)) ? Number(v.y) : 0);
const gw = (v: CanvasVisualLike): number => Math.max(1, Number(v.w) || 1);
const gh = (v: CanvasVisualLike): number => Math.max(1, Number(v.h) || 1);

/**
 * Align the selected visuals to the selection's bounding box on one edge.
 * Horizontal edges move `x` (`left`→minLeft, `right`→maxRight−w,
 * `center`→box-center−w/2); vertical edges move `y` (`top`/`bottom`/`middle`).
 * Non-selected visuals are returned untouched (same reference); a selected
 * visual already on the target keeps its reference too, so this never churns
 * unchanged cards. A selection smaller than 2 is a no-op (nothing to align to).
 */
export function alignVisuals<V extends CanvasVisualLike>(
  visuals: V[],
  ids: Set<string>,
  edge: AlignEdge,
): V[] {
  const selected = visuals.filter((v) => ids.has(v.id));
  if (selected.length < 2) return visuals;
  const minLeft = Math.min(...selected.map(gx));
  const maxRight = Math.max(...selected.map((v) => gx(v) + gw(v)));
  const minTop = Math.min(...selected.map(gy));
  const maxBottom = Math.max(...selected.map((v) => gy(v) + gh(v)));
  const cx = (minLeft + maxRight) / 2;
  const cy = (minTop + maxBottom) / 2;
  return visuals.map((v) => {
    if (!ids.has(v.id)) return v;
    switch (edge) {
      case 'left':   { const nx = Math.max(0, minLeft); return nx === gx(v) ? v : { ...v, x: nx }; }
      case 'right':  { const nx = Math.max(0, maxRight - gw(v)); return nx === gx(v) ? v : { ...v, x: nx }; }
      case 'center': { const nx = Math.max(0, Math.round(cx - gw(v) / 2)); return nx === gx(v) ? v : { ...v, x: nx }; }
      case 'top':    { const ny = Math.max(0, minTop); return ny === gy(v) ? v : { ...v, y: ny }; }
      case 'bottom': { const ny = Math.max(0, maxBottom - gh(v)); return ny === gy(v) ? v : { ...v, y: ny }; }
      case 'middle': { const ny = Math.max(0, Math.round(cy - gh(v) / 2)); return ny === gy(v) ? v : { ...v, y: ny }; }
      default:       return v;
    }
  });
}

/**
 * Equalize the gaps between the selected visuals along `axis`. The outermost two
 * (by their start coord) keep their position; the inner ones are re-spaced so
 * every inter-visual gap is equal (`(span − Σsizes) / (n−1)`), matching Power
 * BI's "Distribute horizontally/vertically". Needs ≥3 selected (with <3 there is
 * no interior gap to equalize) — otherwise a no-op. Coords stay whole grid cells
 * (rounded); unchanged visuals keep their reference.
 */
export function distributeVisuals<V extends CanvasVisualLike>(
  visuals: V[],
  ids: Set<string>,
  axis: DistributeAxis,
): V[] {
  const selected = visuals.filter((v) => ids.has(v.id));
  if (selected.length < 3) return visuals;
  const horiz = axis === 'horizontal';
  const start = (v: CanvasVisualLike) => (horiz ? gx(v) : gy(v));
  const size = (v: CanvasVisualLike) => (horiz ? gw(v) : gh(v));
  const sorted = selected.slice().sort((a, b) => start(a) - start(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = (start(last) + size(last)) - start(first);
  const sumSizes = sorted.reduce((acc, v) => acc + size(v), 0);
  const gap = (span - sumSizes) / (sorted.length - 1);
  const placed = new Map<string, number>();
  let cursor = start(first);
  for (const v of sorted) {
    placed.set(v.id, Math.max(0, Math.round(cursor)));
    cursor += size(v) + gap;
  }
  return visuals.map((v) => {
    if (!ids.has(v.id)) return v;
    const s = placed.get(v.id);
    if (s == null) return v;
    if (horiz) return s === gx(v) ? v : { ...v, x: s };
    return s === gy(v) ? v : { ...v, y: s };
  });
}

/** Mint a short, collision-resistant group id (uid). */
function makeGroupId(): string {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stamp one new shared `groupId` on every selected visual (Arrange → Group).
 * A group needs ≥2 members, else this is a no-op. The id is generated unless
 * `gid` is supplied (the override keeps the op deterministic for unit tests).
 */
export function groupVisuals<V extends CanvasVisualLike>(
  visuals: V[],
  ids: Set<string>,
  gid: string = makeGroupId(),
): V[] {
  let count = 0;
  for (const v of visuals) if (ids.has(v.id)) count += 1;
  if (count < 2) return visuals;
  return visuals.map((v) => (ids.has(v.id) ? ({ ...v, groupId: gid } as V) : v));
}

/** Clear `groupId` from every member of `groupId` (Arrange → Ungroup). No-op
 *  (same array reference) when no visual carries that id. */
export function ungroupVisuals<V extends CanvasVisualLike>(
  visuals: V[],
  groupId: string,
): V[] {
  if (!visuals.some((v) => v.groupId === groupId)) return visuals;
  return visuals.map((v) => (v.groupId === groupId ? ({ ...v, groupId: undefined } as V) : v));
}

/**
 * Move a contiguous BLOCK of visuals (all `blockIds`, in their current relative
 * order) to just before/after `targetId`, preserving every non-member's order —
 * the group-aware generalization of {@link reorderVisuals}. Dropping a block
 * onto one of its own members is a no-op. Returns the original array reference on
 * any no-op so callers can skip the repack/mutation.
 */
export function moveVisualBlock<V extends CanvasVisualLike>(
  visuals: V[],
  blockIds: Set<string>,
  targetId: string,
  side: DropSide,
): V[] {
  if (blockIds.has(targetId)) return visuals; // can't drop a group onto itself
  const block = visuals.filter((v) => blockIds.has(v.id));
  if (!block.length) return visuals;
  const rest = visuals.filter((v) => !blockIds.has(v.id));
  let to = rest.findIndex((v) => v.id === targetId);
  if (to < 0) return visuals;
  if (side === 'after') to += 1;
  const next = rest.slice();
  next.splice(to, 0, ...block);
  return next;
}

/** Snap `value` to the nearest multiple of `cell` (cell ≥ 1). The standalone
 *  grid-snap clamp behind the designer's "Snap to grid" affordance. */
export function snapToGrid(value: number, cell: number): number {
  const c = Math.max(1, Math.round(Number(cell)) || 1);
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / c) * c;
}

/** True when a drag event is a visual-reorder drag (not a Fields-pane chip). */
function isVisualDrag(e: ReactDragEvent<HTMLElement>): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i += 1) {
    if (types[i] === VISUAL_DND_MIME) return true;
  }
  return false;
}

/** Insert before/after based on the pointer's horizontal position over a card. */
function sideFromEvent(e: ReactDragEvent<HTMLElement>): DropSide {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
}

// ── transient pointer-resize bookkeeping ──────────────────────────────────────

interface ResizeDrag {
  id: string;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  /** Measured card width per column at grab time — the resize sensitivity. */
  pxPerCol: number;
  /** Last committed span/height during this drag (avoids redundant mutations). */
  curW: number;
  curH: number;
}

/**
 * Wire drag-resize + drag-to-reposition for the report canvas grid.
 *
 * @example
 * const layout = useCanvasLayout({ visuals: page.visuals, mutateVisual, mutatePage });
 * // card:   <div {...layout.getDropTargetProps(v)} style={{ gridColumn: `span ${v.w}` }}>
 * // header: <span {...layout.getDragHandleProps(v)} aria-hidden><DotsIcon/></span>
 * // grip:   <span {...layout.getResizeHandleProps(v)} className={styles.grip} />
 */
export function useCanvasLayout<
  V extends CanvasVisualLike,
  P extends CanvasPageLike<V> = CanvasPageLike<V>,
>(opts: UseCanvasLayoutOptions<V, P>): CanvasLayout {
  const {
    visuals,
    mutateVisual,
    mutatePage,
    columns = DEFAULT_COLUMNS,
    minSpan = DEFAULT_MIN_SPAN,
    rowUnitPx = DEFAULT_ROW_UNIT_PX,
    assignPositions = true,
    snapToGrid: snapEnabled = true,
    lockedIds,
  } = opts;

  const [resizingId, setResizingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: string; side: DropSide } | null>(null);

  // Render-synced mirrors so pointer/keyboard handlers read live values without
  // tearing down and rebuilding on every state change.
  const visualsRef = useRef(visuals);
  visualsRef.current = visuals;
  const resizeRef = useRef<ResizeDrag | null>(null);
  // Live locked-set mirror so the handle short-circuits + imperative guards read
  // the current set without forcing every getter callback to re-create.
  const lockedRef = useRef<Set<string> | undefined>(lockedIds);
  lockedRef.current = lockedIds;

  /** True when `id` is locked (drag/resize disabled). */
  const isLocked = useCallback((id: string): boolean => !!lockedRef.current?.has(id), []);
  // Reposition repacks `x/y` only when BOTH auto-positioning AND snap are on —
  // turning the designer's "Snap to grid" toggle off preserves manual positions.
  const doPack = assignPositions && snapEnabled;

  // ── imperative / keyboard primitives ───────────────────────────────────────
  const resizeBy = useCallback((id: string, dW: number, dH: number) => {
    if (lockedRef.current?.has(id)) return; // locked: no resize (Lock parity)
    const v = visualsRef.current.find((x) => x.id === id);
    if (!v) return;
    const w = clampSpan((Number(v.w) || minSpan) + dW, minSpan, columns);
    const h = clampRows((Number(v.h) || 1) + dH);
    mutateVisual(id, (cur) => (cur.w === w && cur.h === h ? cur : { ...cur, w, h }));
  }, [mutateVisual, columns, minSpan]);

  const setWidth = useCallback((id: string, w: number) => {
    if (lockedRef.current?.has(id)) return;
    const span = clampSpan(w, minSpan, columns);
    mutateVisual(id, (cur) => (cur.w === span ? cur : { ...cur, w: span }));
  }, [mutateVisual, columns, minSpan]);

  const setHeight = useCallback((id: string, h: number) => {
    if (lockedRef.current?.has(id)) return;
    const rows = clampRows(h);
    mutateVisual(id, (cur) => (cur.h === rows ? cur : { ...cur, h: rows }));
  }, [mutateVisual]);

  const move = useCallback((id: string, dir: -1 | 1) => {
    if (lockedRef.current?.has(id)) return; // locked: position is fixed
    mutatePage((p) => {
      const idx = p.visuals.findIndex((v) => v.id === id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= p.visuals.length) return p;
      const next = p.visuals.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(to, 0, moved);
      return { ...p, visuals: doPack ? packGridPositions(next, columns, minSpan) : next };
    });
  }, [mutatePage, doPack, columns, minSpan]);

  // ── resize grip (pointer + keyboard) ────────────────────────────────────────
  const getResizeHandleProps = useCallback((visual: CanvasVisualLike): ResizeHandleProps => {
    // Locked: the grip still renders for layout parity but does nothing — inert
    // props (no pointer/keyboard mutation, tabIndex −1, aria-disabled).
    if (isLocked(visual.id)) {
      const span = clampSpan(visual.w, minSpan, columns);
      const noop = () => { /* locked — inert */ };
      return {
        role: 'slider',
        tabIndex: -1,
        'aria-label': 'Resize disabled — visual is locked.',
        'aria-orientation': 'horizontal',
        'aria-valuemin': minSpan,
        'aria-valuemax': columns,
        'aria-valuenow': span,
        'aria-valuetext': `Locked at width ${span} of ${columns} columns`,
        'aria-disabled': true,
        style: { touchAction: 'none', cursor: 'not-allowed' },
        onPointerDown: noop,
        onPointerMove: noop,
        onPointerUp: noop,
        onLostPointerCapture: noop,
        onPointerCancel: noop,
        onKeyDown: noop,
        onClick: (e) => e.stopPropagation(),
      };
    }
    const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button > 0) return; // primary button / touch / pen only
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget;
      const card = grip.closest(`[${CARD_ATTR}]`) as HTMLElement | null;
      const startW = clampSpan(visual.w, minSpan, columns);
      const rect = card?.getBoundingClientRect();
      // Width-per-column measured at grab time. Fall back to an even split of the
      // grip's owner viewport when the card anchor is absent.
      const pxPerCol = rect && startW > 0
        ? rect.width / startW
        : Math.max(1, (grip.ownerDocument?.documentElement.clientWidth ?? 960) / columns);
      resizeRef.current = {
        id: visual.id,
        startX: e.clientX,
        startY: e.clientY,
        startW,
        startH: clampRows(visual.h),
        pxPerCol,
        curW: startW,
        curH: clampRows(visual.h),
      };
      try { grip.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
      setResizingId(visual.id);
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
      const d = resizeRef.current;
      if (!d || d.id !== visual.id) return;
      const nextW = clampSpan(d.startW + Math.round((e.clientX - d.startX) / d.pxPerCol), minSpan, columns);
      const nextH = clampRows(d.startH + Math.round((e.clientY - d.startY) / rowUnitPx));
      if (nextW === d.curW && nextH === d.curH) return; // only on a whole-step change
      d.curW = nextW;
      d.curH = nextH;
      // Commit on each step (cheap: w/h are not in the visual's query signature,
      // so this never re-queries the model). React re-renders the card at the new
      // span — no direct DOM writes, no post-drag flash, no cleanup leak.
      mutateVisual(visual.id, (v) => (v.w === nextW && v.h === nextH ? v : { ...v, w: nextW, h: nextH }));
    };

    const endResize = (e: ReactPointerEvent<HTMLElement>) => {
      const d = resizeRef.current;
      if (!d || d.id !== visual.id) return;
      resizeRef.current = null;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      setResizingId(null);
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
      let handled = true;
      switch (e.key) {
        case 'ArrowRight': resizeBy(visual.id, 1, 0); break;
        case 'ArrowLeft': resizeBy(visual.id, -1, 0); break;
        case 'ArrowDown': resizeBy(visual.id, 0, 1); break;
        case 'ArrowUp': resizeBy(visual.id, 0, -1); break;
        case 'Home': setWidth(visual.id, minSpan); break;
        case 'End': setWidth(visual.id, columns); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };

    const span = clampSpan(visual.w, minSpan, columns);
    return {
      role: 'slider',
      tabIndex: 0,
      'aria-label': 'Resize visual. Left/Right arrows change width, Up/Down change height.',
      'aria-orientation': 'horizontal',
      'aria-valuemin': minSpan,
      'aria-valuemax': columns,
      'aria-valuenow': span,
      'aria-valuetext': `Width ${span} of ${columns} columns, height ${clampRows(visual.h)} rows`,
      style: { touchAction: 'none', cursor: 'nwse-resize' },
      onPointerDown,
      onPointerMove,
      onPointerUp: endResize,
      onLostPointerCapture: endResize,
      onPointerCancel: endResize,
      onKeyDown,
      onClick: (e) => e.stopPropagation(), // never toggle card selection from the grip
    };
  }, [mutateVisual, resizeBy, setWidth, columns, minSpan, rowUnitPx, isLocked]);

  // ── reposition: header grab handle ──────────────────────────────────────────
  const getDragHandleProps = useCallback((visual: CanvasVisualLike): DragHandleProps => {
    // Locked: the handle renders but can't start a drag (inert, non-draggable).
    if (isLocked(visual.id)) {
      const noop = () => { /* locked — inert */ };
      return {
        draggable: false,
        'aria-label': 'Reposition disabled — visual is locked.',
        'aria-disabled': true,
        style: { cursor: 'not-allowed' },
        onDragStart: noop,
        onDragEnd: noop,
        onClick: (e) => e.stopPropagation(),
      };
    }
    return {
      draggable: true,
      'aria-label': 'Reorder visual (drag), or use the Move actions.',
      style: { cursor: 'grab' },
      onDragStart: (e) => {
        e.stopPropagation();
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(VISUAL_DND_MIME, visual.id);
          e.dataTransfer.setData('text/plain', visual.id); // some engines require a payload
        } catch { /* ignore */ }
        setDraggingId(visual.id);
      },
      onDragEnd: () => {
        setDraggingId(null);
        setDropIndicator(null);
      },
      onClick: (e) => e.stopPropagation(),
    };
  }, [isLocked]);

  // ── reposition: card drop target (+ resize measurement anchor) ──────────────
  const getDropTargetProps = useCallback((visual: CanvasVisualLike): DropTargetProps => ({
    [CARD_ATTR]: visual.id,
    onDragOver: (e) => {
      if (!isVisualDrag(e)) return; // ignore Fields-pane chip drags entirely
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
      const side = sideFromEvent(e);
      setDropIndicator((prev) =>
        prev && prev.id === visual.id && prev.side === side ? prev : { id: visual.id, side });
    },
    onDragLeave: (e) => {
      // Only clear when the pointer actually left this card (not a child enter).
      const related = e.relatedTarget as Node | null;
      if (related && e.currentTarget.contains(related)) return;
      setDropIndicator((prev) => (prev && prev.id === visual.id ? null : prev));
    },
    onDrop: (e) => {
      if (!isVisualDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const draggedId = e.dataTransfer.getData(VISUAL_DND_MIME) || e.dataTransfer.getData('text/plain');
      const side = sideFromEvent(e);
      setDropIndicator(null);
      setDraggingId(null);
      if (!draggedId || draggedId === visual.id) return;
      mutatePage((p) => {
        const dragged = p.visuals.find((v) => v.id === draggedId);
        // Group-aware: dragging any member of a group relocates the whole group
        // as a contiguous block (the others follow); a lone visual reorders alone.
        const gid = dragged?.groupId;
        const reordered = gid
          ? moveVisualBlock(p.visuals, new Set(p.visuals.filter((v) => v.groupId === gid).map((v) => v.id)), visual.id, side)
          : reorderVisuals(p.visuals, draggedId, visual.id, side);
        if (reordered === p.visuals) return p;
        return { ...p, visuals: doPack ? packGridPositions(reordered, columns, minSpan) : reordered };
      });
    },
  }), [mutatePage, doPack, columns, minSpan]);

  // ── imperative Arrange (Align / Distribute / Group / Ungroup) ────────────────
  // Each delegates to `mutatePage` with the matching pure op, so the math is the
  // same array→array transform unit tests exercise. They mutate the persisted
  // x/y/groupId (which round-trip through /definition `layout`), never re-query.
  const asSet = (ids: Iterable<string>): Set<string> => (ids instanceof Set ? ids : new Set(ids));

  const alignSelection = useCallback((ids: Iterable<string>, edge: AlignEdge) => {
    const set = asSet(ids);
    if (set.size < 2) return;
    mutatePage((p) => {
      const next = alignVisuals(p.visuals, set, edge);
      return next === p.visuals ? p : { ...p, visuals: next };
    });
  }, [mutatePage]);

  const distributeSelection = useCallback((ids: Iterable<string>, axis: DistributeAxis) => {
    const set = asSet(ids);
    if (set.size < 3) return;
    mutatePage((p) => {
      const next = distributeVisuals(p.visuals, set, axis);
      return next === p.visuals ? p : { ...p, visuals: next };
    });
  }, [mutatePage]);

  const groupSelection = useCallback((ids: Iterable<string>) => {
    const set = asSet(ids);
    if (set.size < 2) return;
    mutatePage((p) => {
      const next = groupVisuals(p.visuals, set);
      return next === p.visuals ? p : { ...p, visuals: next };
    });
  }, [mutatePage]);

  const ungroupSelection = useCallback((groupId: string) => {
    if (!groupId) return;
    mutatePage((p) => {
      const next = ungroupVisuals(p.visuals, groupId);
      return next === p.visuals ? p : { ...p, visuals: next };
    });
  }, [mutatePage]);

  return {
    resizingId,
    isResizing: resizingId !== null,
    draggingId,
    dropIndicator,
    getResizeHandleProps,
    getDragHandleProps,
    getDropTargetProps,
    setWidth,
    setHeight,
    resizeBy,
    move,
    snapEnabled,
    isLocked,
    alignVisuals: alignSelection,
    distributeVisuals: distributeSelection,
    group: groupSelection,
    ungroup: ungroupSelection,
  };
}
