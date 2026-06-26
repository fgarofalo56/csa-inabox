'use client';

/**
 * free-form-canvas — the ABSOLUTE, Power BI Desktop-style report canvas for the
 * Loom Report Designer. This replaces the wave-0..2 12-column FLOW grid (cards
 * laid out by `gridColumn: span w` / `minHeight: h*40`) with a fixed-aspect,
 * letter-boxed PAGE on which every visual lives at an absolute pixel rect
 * `{ x, y, w, h, z }` — exactly like the real Power BI canvas.
 *
 * Power BI Desktop parity (ui-parity.md), grounded in
 * learn.microsoft.com/power-bi/create-reports/desktop-gridlines-snap-to-grid and
 * .../visuals/power-bi-visualization-move-and-resize:
 *   • MOVE  — "select any area of the visualization, then drag it to the new
 *     location." Here: pointer-down on the visual frame (header/border, never the
 *     live chart body so cross-filter clicks survive) drags x/y. rAF-smooth via a
 *     transient DOM transform; a single layout commit lands on pointer-up.
 *   • RESIZE — "drag the dark frame handles to resize." Here: 8 handles (4 corner
 *     + 4 edge) on the selected visual resize w/h (and shift x/y for top/left
 *     grips), clamped to a min size.
 *   • SNAP-TO-GRID — "visuals you move or resize automatically align to the
 *     nearest grid axis." Toggle-driven (`snapToGrid`); snaps to `gridSize` px.
 *   • SMART GUIDES — "lines appear when you move a visual … for the center,
 *     sides, top, and bottom of the selected visual, with respect to a nearby
 *     visual." Here: live edge/center guides vs every other visual + the page,
 *     drawn as overlay lines; the dragged rect snaps onto a guide within
 *     `GUIDE_SNAP_PX`.
 *   • MULTI-SELECT — "Ctrl+Click to select more than one visual"; plus a
 *     click-drag MARQUEE on empty canvas selects everything it intersects.
 *   • Z-ORDER — overlapping visuals layer by `layout.z` (Selection-pane order).
 *   • KEYBOARD — arrow nudges the selection 1px (Shift = 10px); Delete removes.
 *   • ZOOM — Fit-to-page (default) / Fit-to-width / Actual size + a % control,
 *     the PBI "Page view" settings.
 *
 * Decoupling: this file imports NONE of the designer's private DVisual/DPage
 * types nor the chart components. It is generic over a structural {@link FFVisual}
 * (id + absolute `layout` + optional locked/hidden/groupId) and takes the visual
 * body + header chrome as render-props, so the host wires its existing VisualBody
 * (live `/query` render — unchanged) and card header straight in. The absolute
 * math (snap / guides / marquee / align / distribute / migrate) lives in the pure,
 * unit-testable {@link module:./use-canvas-layout} module and is re-exported there.
 *
 * no-vaporware.md: every affordance MOVES/RESIZES/ALIGNS real persisted state —
 * the host commits each `onLayout` into `visual.config.layout {x,y,w,h,z}` via
 * PUT /definition. no-freeform-config.md: this is direct manipulation on a canvas,
 * not a typed config box. web3-ui.md: Fluent v9 + Loom tokens only; the sole
 * inline styles are behavioural (transform/position/cursor), which no token
 * expresses.
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import type {
  CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent,
  ReactNode, WheelEvent as ReactWheelEvent,
} from 'react';
import {
  Button, Caption1, Tooltip, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import {
  ZoomIn20Regular, ZoomOut20Regular, FullScreenMaximize20Regular,
  ArrowMaximize16Regular,
} from '@fluentui/react-icons';
import {
  type AbsRect, clampRect, snapRect, resizeRect, computeGuides, marqueeHits,
  type ResizeHandle,
} from './use-canvas-layout';

// ── inherent constants (no Fluent token expresses these) ─────────────────────
/** Snap threshold (page px) for smart-guide alignment to another visual/page. */
const GUIDE_SNAP_PX = 6;
/** Default grid cell (page px) for snap-to-grid. */
const DEFAULT_GRID = 8;
/** Zoom bounds for the manual zoom control. */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3;

/** The minimal structural visual the canvas positions. A designer DVisual (which
 *  carries an absolute `layout`) satisfies this; the canvas never reads wells. */
export interface FFVisual {
  id: string;
  /** Absolute page rect (px). The single source of truth for position + size. */
  layout: AbsRect;
  /** Locked: drag + resize disabled (Arrange → Lock / Lock objects). */
  locked?: boolean;
  /** Hidden: skipped from paint (Selection-pane eye-toggle). */
  hidden?: boolean;
  /** Group id (members select + move together). */
  groupId?: string;
}

/** Page dimensions in canvas px (default 1280×720 16:9). */
export interface FFPage { width: number; height: number; background?: CSSProperties }

export interface FreeFormCanvasProps<V extends FFVisual> {
  /** Active-page visuals. Paint order is by `layout.z` (fallback: array order). */
  visuals: V[];
  /** Fixed page size (letter-boxed + scaled to fit). */
  page: FFPage;
  /** Primary selection (the Build/Format panes follow this). */
  selectedId: string | null;
  /** Multi-selection set (Arrange toolbar + Ctrl/Shift-click + marquee). */
  selectedIds: Set<string>;
  /** Snap-to-grid toggle (PBI "Snap objects to grid"). */
  snapToGrid: boolean;
  /** Grid cell size (px). Default {@link DEFAULT_GRID}. */
  gridSize?: number;
  /** Show the grid overlay (PBI "Show gridlines"). */
  showGrid?: boolean;
  /** Reading/personalize mode → no move/resize/marquee (definition read-only). */
  readOnly?: boolean;
  /** Select one (additive=false) or toggle into the multi-set (additive=true). */
  onSelect: (id: string | null, additive: boolean) => void;
  /** Marquee result: the intersecting ids (additive merges with the current set). */
  onMarquee: (ids: string[], additive: boolean) => void;
  /** Commit moved/resized rects (ONE call on pointer-up → one history entry). */
  onLayout: (moves: Array<{ id: string; layout: AbsRect }>) => void;
  /** Delete the given ids (keyboard Delete). */
  onDelete?: (ids: string[]) => void;
  /** Render a visual's live body (the host's VisualBody — unchanged `/query`). */
  renderVisual: (v: V) => ReactNode;
  /** Render a visual's header chrome (title, badges, lock/hide/remove buttons).
   *  Anything inside `[data-ff-nodrag]` never starts a move (buttons/menus). The
   *  header bar itself is the move grip. */
  renderChrome: (v: V) => ReactNode;
  /** Optional per-visual frame style override (Format pane: background / border /
   *  shadow). Merged over the default frame chrome so wave-3 formatting survives. */
  frameStyle?: (v: V) => CSSProperties;
}

const useStyles = makeStyles({
  // Outer viewport: scrolls, hosts the toolbar + the letter-boxed stage.
  root: {
    position: 'relative', display: 'flex', flexDirection: 'column',
    minHeight: '70vh', flex: 1, gap: tokens.spacingVerticalS,
  },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  zoomLabel: { minWidth: '44px', textAlign: 'center', color: tokens.colorNeutralForeground2 },
  spacer: { flex: 1 },
  // The scroll viewport that letterboxes the page.
  viewport: {
    position: 'relative', flex: 1, minHeight: 0, overflow: 'auto',
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    padding: tokens.spacingVerticalL,
    backgroundColor: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusLarge,
    // subtle inset so the page "floats" like the PBI workspace
    boxShadow: `inset 0 0 0 1px ${tokens.colorNeutralStroke2}`,
  },
  // The fixed-aspect page surface (the white sheet).
  page: {
    position: 'relative', flexShrink: 0,
    transformOrigin: 'top center',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow28,
    outline: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  gridOverlay: {
    position: 'absolute', inset: 0, pointerEvents: 'none',
    // grid drawn with theme-correct neutral stroke (legible in light AND dark)
  },
  // A positioned visual frame.
  frame: {
    position: 'absolute', boxSizing: 'border-box',
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorTransparentStroke}`,
    borderRadius: tokens.borderRadiusMedium,
    boxShadow: tokens.shadow4,
    // overflow stays VISIBLE so the 8 resize grips — which sit ON the border at
    // negative offsets (the PBI look + the full-size grab target) — are never
    // clipped. The live chart body is rounded/clipped by `content` instead, so a
    // frame with `overflow:hidden` can't swallow the outer half of each handle.
    transitionProperty: 'box-shadow, border-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { boxShadow: tokens.shadow8, border: `1px solid ${tokens.colorNeutralStroke2}` },
  },
  // Clipped content layer (header + body). Fills the frame inside its border and
  // rounds the corners; the resize handles live OUTSIDE this layer (as frame
  // children, so they still follow the live DOM resize) and are thus never cut.
  content: {
    position: 'absolute', inset: 0,
    display: 'flex', flexDirection: 'column',
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  frameSelected: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    boxShadow: `0 0 0 1px ${tokens.colorBrandStroke1}, ${tokens.shadow16}`,
  },
  frameMulti: { border: `1px solid ${tokens.colorBrandStroke2}` },
  frameHidden: { opacity: 0.4 },
  frameLocked: { cursor: 'default' },
  frameDragging: { boxShadow: tokens.shadow28, opacity: 0.92, transitionDuration: '0ms' },
  // The header (also the MOVE grip).
  header: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalXS}`,
    minHeight: '28px', cursor: 'move', userSelect: 'none',
    backgroundColor: tokens.colorNeutralBackground1,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  headerLocked: { cursor: 'default' },
  body: { flex: 1, minHeight: 0, minWidth: 0, overflow: 'auto', position: 'relative' },
  // 8 resize handles around the selected frame.
  handle: {
    position: 'absolute', width: '10px', height: '10px', zIndex: 5,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1.5px solid ${tokens.colorBrandStroke1}`,
    borderRadius: tokens.borderRadiusSmall,
    boxShadow: tokens.shadow2,
  },
  // smart-guide lines (overlay)
  guideV: {
    position: 'absolute', top: 0, width: '0px',
    borderLeft: `1px dashed ${tokens.colorBrandStroke1}`, pointerEvents: 'none', zIndex: 50,
  },
  guideH: {
    position: 'absolute', left: 0, height: '0px',
    borderTop: `1px dashed ${tokens.colorBrandStroke1}`, pointerEvents: 'none', zIndex: 50,
  },
  // marquee rectangle
  marquee: {
    position: 'absolute', pointerEvents: 'none', zIndex: 60,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
    opacity: 0.5, borderRadius: tokens.borderRadiusSmall,
  },
  // a px-size readout chip that follows an active drag/resize
  sizeChip: {
    position: 'absolute', zIndex: 70, pointerEvents: 'none',
    padding: `2px ${tokens.spacingHorizontalXS}`,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackgroundInverted,
    color: tokens.colorNeutralForegroundInverted,
    fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap',
  },
});

/** Resize-handle geometry: position offsets + cursor, keyed by handle id. */
const HANDLES: Array<{ h: ResizeHandle; style: CSSProperties; cursor: string }> = [
  { h: 'nw', style: { left: -5, top: -5 }, cursor: 'nwse-resize' },
  { h: 'n', style: { left: 'calc(50% - 5px)', top: -5 }, cursor: 'ns-resize' },
  { h: 'ne', style: { right: -5, top: -5 }, cursor: 'nesw-resize' },
  { h: 'e', style: { right: -5, top: 'calc(50% - 5px)' }, cursor: 'ew-resize' },
  { h: 'se', style: { right: -5, bottom: -5 }, cursor: 'nwse-resize' },
  { h: 's', style: { left: 'calc(50% - 5px)', bottom: -5 }, cursor: 'ns-resize' },
  { h: 'sw', style: { left: -5, bottom: -5 }, cursor: 'nesw-resize' },
  { h: 'w', style: { left: -5, top: 'calc(50% - 5px)' }, cursor: 'ew-resize' },
];

type Mode =
  | { kind: 'idle' }
  | { kind: 'move'; ids: string[]; startX: number; startY: number; origin: Map<string, AbsRect> }
  | { kind: 'resize'; id: string; handle: ResizeHandle; startX: number; startY: number; origin: AbsRect }
  | { kind: 'marquee'; startX: number; startY: number; curX: number; curY: number; additive: boolean };

interface Guides { v: number[]; h: number[] }

/** Order visuals back-to-front by z (fallback to array order). */
function paintOrder<V extends FFVisual>(visuals: V[]): V[] {
  return visuals
    .map((v, i) => ({ v, i, z: Number.isFinite(Number(v.layout?.z)) ? Number(v.layout.z) : i }))
    .sort((a, b) => (a.z - b.z) || (a.i - b.i))
    .map((x) => x.v);
}

/**
 * The free-form absolute canvas. See file header for the full parity contract.
 */
export function FreeFormCanvas<V extends FFVisual>(props: FreeFormCanvasProps<V>): ReactNode {
  const {
    visuals, page, selectedId, selectedIds, snapToGrid, gridSize = DEFAULT_GRID,
    showGrid = false, readOnly = false, onSelect, onMarquee, onLayout, onDelete,
    renderVisual, renderChrome, frameStyle,
  } = props;
  const styles = useStyles();

  // ── zoom / fit ──────────────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [fitMode, setFitMode] = useState<'fit' | 'width' | 'actual' | 'manual'>('fit');
  const [manualZoom, setManualZoom] = useState(1);
  const [vpSize, setVpSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setVpSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const PAD = 48; // viewport padding budget (matches styles.viewport padding ×2-ish)
  const zoom = useMemo(() => {
    const availW = Math.max(1, vpSize.w - PAD);
    const availH = Math.max(1, vpSize.h - PAD);
    if (fitMode === 'actual') return 1;
    if (fitMode === 'width') return availW / page.width;
    if (fitMode === 'manual') return manualZoom;
    return Math.min(availW / page.width, availH / page.height); // fit
  }, [fitMode, manualZoom, vpSize, page.width, page.height]);
  const zClamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));

  const setZoom = useCallback((z: number) => {
    setManualZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
    setFitMode('manual');
  }, []);

  // ── transient drag/resize/marquee bookkeeping (refs → no re-render thrash) ────
  const mode = useRef<Mode>({ kind: 'idle' });
  const draftRef = useRef<Map<string, AbsRect>>(new Map());     // live rects mid-gesture
  const frameEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const [guides, setGuides] = useState<Guides>({ v: [], h: [] });
  const [marquee, setMarquee] = useState<null | { x: number; y: number; w: number; h: number }>(null);
  const [chip, setChip] = useState<null | { x: number; y: number; text: string }>(null);
  const [activeIds, setActiveIds] = useState<Set<string>>(new Set()); // mid-gesture (for styling)

  const visualsRef = useRef(visuals);
  visualsRef.current = visuals;
  const zoomRef = useRef(zClamped);
  zoomRef.current = zClamped;

  /** Convert a client delta into PAGE px (undo the zoom scale). */
  const toPage = useCallback((dClient: number) => dClient / zoomRef.current, []);

  /** Apply the current draft rects to the DOM (rAF-batched, no React state). */
  const flushDraft = useCallback(() => {
    rafRef.current = null;
    for (const [id, r] of draftRef.current) {
      const el = frameEls.current.get(id);
      if (!el) continue;
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    }
  }, []);
  const scheduleFlush = useCallback(() => {
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushDraft);
  }, [flushDraft]);

  // ── MOVE ──────────────────────────────────────────────────────────────────────
  const startMove = useCallback((e: ReactPointerEvent, v: V) => {
    if (readOnly || v.locked) return;
    // Select on grab (additive with ctrl/shift) so the move targets the right set.
    onSelect(v.id, e.ctrlKey || e.metaKey || e.shiftKey);
    // Which ids move: the whole multi-set if v is in it, else its group, else solo.
    const set = selectedIds.has(v.id) && selectedIds.size > 1
      ? [...selectedIds]
      : v.groupId
        ? visualsRef.current.filter((x) => x.groupId === v.groupId).map((x) => x.id)
        : [v.id];
    const origin = new Map<string, AbsRect>();
    for (const x of visualsRef.current) if (set.includes(x.id)) origin.set(x.id, { ...x.layout });
    draftRef.current = new Map(origin);
    mode.current = { kind: 'move', ids: set, startX: e.clientX, startY: e.clientY, origin };
    setActiveIds(new Set(set));
    // Capture on the STAGE (it owns onPointerMove/Up) so events keep flowing there.
    try { stageRef.current?.setPointerCapture(e.pointerId); } catch { /* best effort */ }
    e.stopPropagation();
  }, [readOnly, selectedIds, onSelect]);

  // ── RESIZE ──────────────────────────────────────────────────────────────────
  const startResize = useCallback((e: ReactPointerEvent, v: V, handle: ResizeHandle) => {
    if (readOnly || v.locked) return;
    draftRef.current = new Map([[v.id, { ...v.layout }]]);
    mode.current = { kind: 'resize', id: v.id, handle, startX: e.clientX, startY: e.clientY, origin: { ...v.layout } };
    setActiveIds(new Set([v.id]));
    try { stageRef.current?.setPointerCapture(e.pointerId); } catch { /* best effort */ }
    e.preventDefault();
    e.stopPropagation();
  }, [readOnly]);

  // ── MARQUEE (empty-canvas select) ─────────────────────────────────────────────
  const startMarquee = useCallback((e: ReactPointerEvent) => {
    if (readOnly) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const x = toPage(e.clientX - rect.left);
    const y = toPage(e.clientY - rect.top);
    mode.current = { kind: 'marquee', startX: x, startY: y, curX: x, curY: y, additive: e.shiftKey || e.ctrlKey || e.metaKey };
    setMarquee({ x, y, w: 0, h: 0 });
    if (!(e.shiftKey || e.ctrlKey || e.metaKey)) onSelect(null, false);
    try { stage.setPointerCapture(e.pointerId); } catch { /* best effort */ }
  }, [readOnly, toPage, onSelect]);

  // ── global pointer move/up (capture-phase so it works over child frames) ──────
  const onStagePointerMove = useCallback((e: ReactPointerEvent) => {
    const m = mode.current;
    if (m.kind === 'idle') return;
    const others = (excludeIds: Set<string>) =>
      visualsRef.current.filter((x) => !x.hidden && !excludeIds.has(x.id)).map((x) => x.layout);

    if (m.kind === 'move') {
      const dx = toPage(e.clientX - m.startX);
      const dy = toPage(e.clientY - m.startY);
      const moving = new Set(m.ids);
      // The bounding rect of the moved block drives snapping/guides as one unit.
      const blk = [...m.origin.values()];
      const bx = Math.min(...blk.map((r) => r.x)) + dx;
      const by = Math.min(...blk.map((r) => r.y)) + dy;
      const bw = Math.max(...blk.map((r) => r.x + r.w)) - Math.min(...blk.map((r) => r.x));
      const bh = Math.max(...blk.map((r) => r.y + r.h)) - Math.min(...blk.map((r) => r.y));
      let block: AbsRect = { x: bx, y: by, w: bw, h: bh };
      if (snapToGrid) block = { ...block, x: Math.round(block.x / gridSize) * gridSize, y: Math.round(block.y / gridSize) * gridSize };
      const g = computeGuides(block, others(moving), page, GUIDE_SNAP_PX);
      block = g.snapped; // guide snap wins over grid for that axis
      setGuides({ v: g.vLines, h: g.hLines });
      const ddx = block.x - Math.min(...blk.map((r) => r.x));
      const ddy = block.y - Math.min(...blk.map((r) => r.y));
      const next = new Map<string, AbsRect>();
      for (const [id, o] of m.origin) next.set(id, clampRect({ ...o, x: o.x + ddx, y: o.y + ddy }, page));
      draftRef.current = next;
      setChip({ x: block.x, y: Math.max(0, block.y - 22), text: `${Math.round(block.x)}, ${Math.round(block.y)}` });
      scheduleFlush();
    } else if (m.kind === 'resize') {
      const dx = toPage(e.clientX - m.startX);
      const dy = toPage(e.clientY - m.startY);
      let r = resizeRect(m.origin, m.handle, dx, dy);
      if (snapToGrid) r = snapRect(r, gridSize);
      const g = computeGuides(r, others(new Set([m.id])), page, GUIDE_SNAP_PX, m.handle);
      r = clampRect(g.snapped, page);
      setGuides({ v: g.vLines, h: g.hLines });
      draftRef.current = new Map([[m.id, r]]);
      setChip({ x: r.x, y: Math.max(0, r.y - 22), text: `${Math.round(r.w)} × ${Math.round(r.h)}` });
      scheduleFlush();
    } else if (m.kind === 'marquee') {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const cx = toPage(e.clientX - rect.left);
      const cy = toPage(e.clientY - rect.top);
      mode.current = { ...m, curX: cx, curY: cy };
      setMarquee({ x: Math.min(m.startX, cx), y: Math.min(m.startY, cy), w: Math.abs(cx - m.startX), h: Math.abs(cy - m.startY) });
    }
  }, [toPage, snapToGrid, gridSize, page, scheduleFlush]);

  const endGesture = useCallback(() => {
    const m = mode.current;
    if (m.kind === 'idle') return;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (m.kind === 'move' || m.kind === 'resize') {
      const moves: Array<{ id: string; layout: AbsRect }> = [];
      for (const [id, r] of draftRef.current) {
        const orig = m.kind === 'move' ? m.origin.get(id) : m.origin;
        // preserve z; only commit when something actually changed
        const layout: AbsRect = { ...r, z: orig?.z };
        if (!orig || orig.x !== r.x || orig.y !== r.y || orig.w !== r.w || orig.h !== r.h) moves.push({ id, layout });
      }
      if (moves.length) onLayout(moves);
    } else if (m.kind === 'marquee') {
      // Read the rect straight off mode.current (not the React `marquee` state,
      // which may lag a frame) so the hit-test is exact at pointer-up.
      const rect: AbsRect = {
        x: Math.min(m.startX, m.curX), y: Math.min(m.startY, m.curY),
        w: Math.abs(m.curX - m.startX), h: Math.abs(m.curY - m.startY),
      };
      if (rect.w > 3 || rect.h > 3) {
        const ids = marqueeHits(rect, visualsRef.current.filter((v) => !v.hidden).map((v) => ({ id: v.id, layout: v.layout })));
        onMarquee(ids, m.additive);
      }
      setMarquee(null);
    }
    mode.current = { kind: 'idle' };
    draftRef.current = new Map();
    setGuides({ v: [], h: [] });
    setChip(null);
    setActiveIds(new Set());
  }, [onLayout, onMarquee]);

  // ── keyboard: nudge + delete on the selection ────────────────────────────────
  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (readOnly) return;
    const ids = selectedIds.size ? [...selectedIds] : selectedId ? [selectedId] : [];
    if (!ids.length) return;
    const step = e.shiftKey ? 10 : 1;
    let dx = 0; let dy = 0;
    switch (e.key) {
      case 'ArrowLeft': dx = -step; break;
      case 'ArrowRight': dx = step; break;
      case 'ArrowUp': dy = -step; break;
      case 'ArrowDown': dy = step; break;
      case 'Delete': case 'Backspace':
        if (onDelete) { e.preventDefault(); onDelete(ids); } return;
      default: return;
    }
    e.preventDefault();
    const set = new Set(ids);
    const moves = visualsRef.current
      .filter((v) => set.has(v.id) && !v.locked)
      .map((v) => ({ id: v.id, layout: clampRect({ ...v.layout, x: v.layout.x + dx, y: v.layout.y + dy }, page) }));
    if (moves.length) onLayout(moves);
  }, [readOnly, selectedIds, selectedId, onDelete, onLayout, page]);

  // cleanup any pending rAF on unmount
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  const onZoomWheel = useCallback((e: ReactWheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return; // ctrl+wheel = zoom (PBI/Office convention)
    e.preventDefault();
    setZoom(zoomRef.current * (e.deltaY < 0 ? 1.1 : 0.9));
  }, [setZoom]);

  const ordered = useMemo(() => paintOrder(visuals), [visuals]);

  // ── render ──────────────────────────────────────────────────────────────────
  const stageStyle: CSSProperties = {
    width: page.width, height: page.height,
    transform: `scale(${zClamped})`,
    ...(page.background || {}),
  };

  return (
    <div className={styles.root}>
      {/* Zoom / page-view toolbar (PBI "Page view" settings) */}
      <div className={styles.toolbar} role="toolbar" aria-label="Canvas zoom">
        <Tooltip content="Zoom out" relationship="label">
          <Button size="small" appearance="subtle" icon={<ZoomOut20Regular />} onClick={() => setZoom(zClamped - 0.1)} aria-label="zoom out" />
        </Tooltip>
        <Caption1 className={styles.zoomLabel}>{Math.round(zClamped * 100)}%</Caption1>
        <Tooltip content="Zoom in" relationship="label">
          <Button size="small" appearance="subtle" icon={<ZoomIn20Regular />} onClick={() => setZoom(zClamped + 0.1)} aria-label="zoom in" />
        </Tooltip>
        <Tooltip content="Fit to page" relationship="label">
          <Button size="small" appearance={fitMode === 'fit' ? 'primary' : 'subtle'} icon={<FullScreenMaximize20Regular />} onClick={() => setFitMode('fit')}>Fit</Button>
        </Tooltip>
        <Tooltip content="Fit to width" relationship="label">
          <Button size="small" appearance={fitMode === 'width' ? 'primary' : 'subtle'} icon={<ArrowMaximize16Regular />} onClick={() => setFitMode('width')}>Width</Button>
        </Tooltip>
        <Tooltip content="Actual size (100%)" relationship="label">
          <Button size="small" appearance={fitMode === 'actual' ? 'primary' : 'subtle'} onClick={() => setFitMode('actual')}>100%</Button>
        </Tooltip>
        <span className={styles.spacer} />
        <Caption1 className={styles.zoomLabel}>{page.width}×{page.height}</Caption1>
      </div>

      <div ref={viewportRef} className={styles.viewport} onWheel={onZoomWheel}>
        <div
          ref={stageRef}
          className={styles.page}
          style={stageStyle}
          tabIndex={0}
          role="group"
          aria-label="Report canvas — drag to move, drag a handle to resize, arrow keys to nudge"
          onKeyDown={onKeyDown}
          onPointerDown={(e) => { if (e.target === stageRef.current) startMarquee(e); }}
          onPointerMove={onStagePointerMove}
          onPointerUp={endGesture}
          onLostPointerCapture={endGesture}
          onPointerCancel={endGesture}
        >
          {showGrid && (
            <div
              className={styles.gridOverlay}
              style={{
                backgroundImage:
                  `linear-gradient(to right, ${tokens.colorNeutralStroke3} 1px, transparent 1px),`
                  + `linear-gradient(to bottom, ${tokens.colorNeutralStroke3} 1px, transparent 1px)`,
                backgroundSize: `${gridSize * 4}px ${gridSize * 4}px`,
              }}
            />
          )}

          {ordered.map((v, paintIdx) => {
            if (v.hidden && readOnly) return null; // hidden visuals don't paint in reading mode
            const sel = selectedId === v.id;
            const multi = selectedIds.has(v.id);
            const r = v.layout;
            const frameCss: CSSProperties = {
              left: r.x, top: r.y, width: r.w, height: r.h, zIndex: paintIdx + 1,
              ...(frameStyle?.(v) || {}),
            };
            return (
              <div
                key={v.id}
                ref={(el) => { if (el) frameEls.current.set(v.id, el); else frameEls.current.delete(v.id); }}
                className={mergeClasses(
                  styles.frame,
                  sel && styles.frameSelected,
                  multi && styles.frameMulti,
                  v.hidden && styles.frameHidden,
                  v.locked && styles.frameLocked,
                  activeIds.has(v.id) && styles.frameDragging,
                )}
                style={frameCss}
                data-ff-frame={v.id}
                onPointerDown={(e) => {
                  // selection on any pointer-down (additive with ctrl/shift)
                  if (e.button === 0) onSelect(v.id, e.ctrlKey || e.metaKey || e.shiftKey);
                }}
              >
                {/* Clipped content layer: header (move grip) + live body. The
                    resize handles are siblings of this layer (direct frame
                    children) so the frame's rounded clip never swallows them. */}
                <div className={styles.content}>
                  {/* HEADER = move grip. Buttons inside carry data-ff-nodrag so they
                      never start a move. */}
                  <div
                    className={mergeClasses(styles.header, v.locked && styles.headerLocked)}
                    onPointerDown={(e) => {
                      const t = e.target as HTMLElement;
                      if (t.closest('[data-ff-nodrag]')) return; // let the button act
                      startMove(e, v);
                    }}
                  >
                    {renderChrome(v)}
                  </div>

                  {/* BODY = the live visual (host VisualBody → /query). Untouched. */}
                  <div className={styles.body}>{renderVisual(v)}</div>
                </div>

                {/* 8 resize handles — only on the single selection, unlocked, edit mode. */}
                {sel && !v.locked && !readOnly && HANDLES.map((hd) => (
                  <div
                    key={hd.h}
                    className={styles.handle}
                    style={{ ...hd.style, cursor: hd.cursor }}
                    role="slider"
                    aria-label={`Resize ${hd.h}`}
                    aria-valuenow={hd.h === 'e' || hd.h === 'w' ? Math.round(r.w) : Math.round(r.h)}
                    onPointerDown={(e) => startResize(e, v, hd.h)}
                  />
                ))}
              </div>
            );
          })}

          {/* smart-guide overlay lines */}
          {guides.v.map((x, i) => (
            <div key={`gv${i}`} className={styles.guideV} style={{ left: x, height: page.height }} />
          ))}
          {guides.h.map((y, i) => (
            <div key={`gh${i}`} className={styles.guideH} style={{ top: y, width: page.width }} />
          ))}

          {/* marquee rectangle */}
          {marquee && (
            <div className={styles.marquee} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
          )}

          {/* live size/position readout */}
          {chip && (
            <div className={styles.sizeChip} style={{ left: chip.x, top: chip.y }}>{chip.text}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FreeFormCanvas;
