'use client';

/**
 * resizable-canvas — the shared Web-5.0 drag-to-resize canvas-height primitive.
 *
 * THE single primitive every CSA Loom canvas editor wraps to make its bounded
 * canvas region user-resizable. It owns the source of truth for the resize
 * mechanic so each surface only swaps a fixed `height`/`minHeight` for the
 * hook's controlled value — canvas behaviour, nodes, and edges are untouched.
 *
 * It mirrors the in-repo divider model (data-pipeline-editor `startResize`:
 * record startY+startH, clamp-to-bounds, drag-to-grow) and upgrades it to:
 *   • Pointer Events + `setPointerCapture` — works for mouse/touch/pen and
 *     survives the pointer leaving the handle;
 *   • `requestAnimationFrame`-coalesced, DOM-direct height writes during drag
 *     (no per-frame React re-render → smooth, no layout thrash);
 *   • commit to React state + `localStorage` on pointer-up (persisted per
 *     surface under `loom.canvasHeight.<storageKey>`);
 *   • full keyboard support (Arrow ±24 / Shift+Arrow ±96 / PageUp/Down ±96 /
 *     Home=min / End=max);
 *   • ARIA (`role="separator"`, `aria-orientation="horizontal"`,
 *     `aria-valuemin/max/now`, focusable handle).
 *
 * Bounds are enforced: height is clamped into `[minPx, maxPx]`, where `maxPx`
 * defaults to 80vh (`window.innerHeight * 0.8`) and is recomputed on window
 * resize. React Flow needs a definite pixel height to frame `fitView`; the hook
 * always supplies one.
 *
 * Token discipline (web3-ui): every colour / spacing / radius / shadow is a
 * Fluent v9 `tokens.*` value. The ONLY raw px are inherent layout dimensions
 * that no token expresses — the resize bounds (`240` min), the drag step sizes
 * (`24` / `96`), and the handle thickness (`8`) — each documented inline. All
 * motion is gated behind `prefers-reduced-motion: reduce`.
 *
 * This file has NO default export.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { makeStyles, mergeClasses, tokens } from '@fluentui/react-components';

// ── Inherent layout dimensions (no Fluent token expresses these) ───────────
/** Floor for any canvas region — below this a graph canvas is unusable. */
const MIN_PX_DEFAULT = 240;
/** Arrow-key resize step (px). */
const STEP = 24;
/** Shift+Arrow / PageUp-Down resize step (px). */
const STEP_LARGE = 96;
/** Drag-grip bar thickness (px) — too thin for a spacing token. */
const HANDLE_THICKNESS_PX = 8;
/** SSR-safe placeholder max; corrected to 80vh on mount (avoids window at render). */
const MAX_PX_FALLBACK = 900;

const STORAGE_PREFIX = 'loom.canvasHeight.';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max));
}

/** Props spread onto the drag handle by {@link ResizableCanvasRegion}. */
export interface ResizableSeparatorProps {
  tabIndex: number;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
}

export interface UseResizableHeightResult {
  /** Current committed height in px (drive `style.height`). */
  height: number;
  /** Effective floor — feed to `aria-valuemin` / `style.minHeight`. */
  minHeight: number;
  /** Effective ceiling (80vh or the explicit `maxPx`) — feed to `aria-valuemax`. */
  maxHeight: number;
  /** Attach to the resizable region element. */
  regionRef: React.RefObject<HTMLDivElement | null>;
  /** Spread onto the drag handle (role=separator). */
  separatorProps: ResizableSeparatorProps;
  /** True while a pointer drag is in progress. */
  isDragging: boolean;
}

/**
 * Controlled, persisted, drag/keyboard-resizable height for a canvas region.
 *
 * @param storageKey  Per-surface key (e.g. `'pipeline-designer'`).
 * @param defaultPx   Initial height — use the surface's current fixed/minHeight.
 * @param minPx       Floor (default 240).
 * @param maxPx       Explicit ceiling; omit to track 80vh of the viewport.
 */
export function useResizableHeight(
  storageKey: string,
  defaultPx: number,
  minPx: number = MIN_PX_DEFAULT,
  maxPx?: number,
): UseResizableHeightResult {
  // Height init = defaultPx so server and first client render match; the
  // persisted value is read in an effect below (avoids a hydration mismatch).
  const [height, setHeight] = useState<number>(defaultPx);
  const [maxHeight, setMaxHeight] = useState<number>(
    () => maxPx ?? Math.max(MAX_PX_FALLBACK, defaultPx),
  );
  const [isDragging, setIsDragging] = useState(false);

  const regionRef = useRef<HTMLDivElement | null>(null);
  const key = `${STORAGE_PREFIX}${storageKey}`;

  // Render-synced mirrors so pointer/keyboard handlers read live values
  // without being torn down and rebuilt on every height change.
  const heightRef = useRef(height);
  heightRef.current = height;
  const maxRef = useRef(maxHeight);
  maxRef.current = maxHeight;
  const draggingRef = useRef(false);

  // Drag bookkeeping.
  const startYRef = useRef(0);
  const startHRef = useRef(0);
  const pendingYRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Commit a new height: clamp → state → localStorage. Returns the clamped px.
  const commit = useCallback((next: number): number => {
    const clamped = clamp(next, minPx, maxRef.current);
    setHeight(clamped);
    try {
      window.localStorage.setItem(key, String(clamped));
    } catch {
      /* storage unavailable (private mode / quota) — height still applies */
    }
    return clamped;
  }, [key, minPx]);

  // Recompute the 80vh ceiling (only when maxPx is not explicitly pinned).
  useEffect(() => {
    if (maxPx !== undefined) {
      setMaxHeight(maxPx);
      return;
    }
    const recompute = () => setMaxHeight(Math.round(window.innerHeight * 0.8));
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [maxPx]);

  // Apply the persisted height once, after mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw != null) {
        const parsed = parseInt(raw, 10);
        if (Number.isFinite(parsed)) setHeight(clamp(parsed, minPx, maxRef.current));
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Re-clamp the current height whenever the bounds change (e.g. viewport shrank).
  useEffect(() => {
    setHeight((h) => clamp(h, minPx, maxHeight));
  }, [minPx, maxHeight]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* pointer capture best-effort */
    }
    startYRef.current = e.clientY;
    startHRef.current = regionRef.current?.offsetHeight ?? heightRef.current;
    draggingRef.current = true;
    setIsDragging(true);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    // Suppress the keyboard transition so direct DOM writes never lag the drag.
    if (regionRef.current) regionRef.current.style.transition = 'none';
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    pendingYRef.current = e.clientY;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const dy = pendingYRef.current - startYRef.current;
      const next = clamp(startHRef.current + dy, minPx, maxRef.current);
      // Write height DIRECTLY — no setState during drag → smooth, no thrash.
      if (regionRef.current) regionRef.current.style.height = `${next}px`;
    });
  }, [minPx]);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setIsDragging(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Read back what the drag actually painted, then restore the transition
    // (revert inline override to the stylesheet) and commit to state + storage.
    const committed = regionRef.current?.offsetHeight ?? heightRef.current;
    if (regionRef.current) regionRef.current.style.transition = '';
    commit(committed);
  }, [commit]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        next = heightRef.current + (e.shiftKey ? STEP_LARGE : STEP);
        break;
      case 'ArrowUp':
        next = heightRef.current - (e.shiftKey ? STEP_LARGE : STEP);
        break;
      case 'PageDown':
        next = heightRef.current + STEP_LARGE;
        break;
      case 'PageUp':
        next = heightRef.current - STEP_LARGE;
        break;
      case 'Home':
        next = minPx;
        break;
      case 'End':
        next = maxRef.current;
        break;
      default:
        return;
    }
    e.preventDefault();
    commit(next);
  }, [commit, minPx]);

  // Cancel any in-flight rAF on unmount and restore body styles defensively.
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    if (draggingRef.current) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  }, []);

  return {
    height,
    minHeight: minPx,
    maxHeight,
    regionRef,
    isDragging,
    separatorProps: {
      tabIndex: 0,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onLostPointerCapture: endDrag,
      onKeyDown,
    },
  };
}

const useStyles = makeStyles({
  region: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    // Hold the user-set height; let the outer chrome scroll. The region is a
    // direct flex-column child of item-editor-chrome's mainPanel (display:flex/
    // column, overflow:auto). With the default flex-shrink:1, dragging the
    // canvas taller than the panel's natural height gets absorbed by shrink
    // instead of letting the panel scroll — capping the effective resize. Every
    // local copy sets this deliberately (e.g. lineage-canvas.tsx:110).
    flexShrink: 0,
    width: '100%',
    minWidth: 0,
    overflow: 'hidden',
    borderRadius: tokens.borderRadiusMedium,
    // Smooth keyboard-driven height changes; during a pointer drag the
    // transition is suppressed inline (see onPointerDown) so dragging is direct.
    transitionProperty: 'height',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    '@media (prefers-reduced-motion: reduce)': { transitionProperty: 'none' },
  },
  // The canvas itself fills all space above the handle (children are expected
  // to use flex:1 / height:100%, exactly as they did at their old fixed height).
  canvasFill: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  handle: {
    flexShrink: 0,
    height: `${HANDLE_THICKNESS_PX}px`, // inherent: drag-grip bar thickness
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    columnGap: tokens.spacingHorizontalXXS,
    cursor: 'ns-resize',
    backgroundColor: tokens.colorNeutralBackground3,
    borderBottomLeftRadius: tokens.borderRadiusMedium,
    borderBottomRightRadius: tokens.borderRadiusMedium,
    transitionProperty: 'background-color',
    transitionDuration: tokens.durationFaster,
    ':hover': { backgroundColor: tokens.colorNeutralBackground3Hover },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '-2px',
    },
    '@media (prefers-reduced-motion: reduce)': { transitionProperty: 'none' },
  },
  handleActive: {
    backgroundColor: tokens.colorNeutralBackground3Pressed,
  },
  // Centered grip — a row of three short bars (à la ReOrderDotsHorizontal),
  // sized from spacing tokens so it fits inside the thin handle.
  gripBar: {
    width: tokens.spacingHorizontalS,
    height: tokens.spacingHorizontalXXS,
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralStroke1,
    pointerEvents: 'none',
  },
});

export interface ResizableCanvasRegionProps {
  /** Per-surface persistence key (e.g. `'mapping-dataflow'`). */
  storageKey: string;
  /** Initial height — use the surface's current fixed/minHeight (400–560). */
  defaultPx: number;
  /** Floor (default 240). */
  minPx?: number;
  /** Explicit ceiling; omit to track 80vh of the viewport. */
  maxPx?: number;
  /** Accessible label for the resize handle. */
  ariaLabel?: string;
  /** Optional extra class on the region wrapper. */
  className?: string;
  /** The canvas (fills via flex:1 / height:100%). */
  children: React.ReactNode;
}

/**
 * Wraps a canvas in a flex column whose height the user can drag (or keyboard-
 * resize) via a bottom grip, persisted per surface. Drop-in: replace a fixed
 * `height` container with this and render the canvas as its child.
 */
export function ResizableCanvasRegion({
  storageKey,
  defaultPx,
  minPx = MIN_PX_DEFAULT,
  maxPx,
  ariaLabel,
  className,
  children,
}: ResizableCanvasRegionProps) {
  const styles = useStyles();
  const { height, minHeight, maxHeight, regionRef, separatorProps, isDragging } =
    useResizableHeight(storageKey, defaultPx, minPx, maxPx);

  return (
    <div
      ref={regionRef}
      className={mergeClasses(styles.region, className)}
      style={{ height: `${height}px`, minHeight: `${minHeight}px` }}
    >
      <div className={styles.canvasFill}>{children}</div>
      <div
        {...separatorProps}
        role="separator"
        aria-orientation="horizontal"
        aria-valuemin={minHeight}
        aria-valuemax={maxHeight}
        aria-valuenow={height}
        aria-label={ariaLabel ?? 'Resize canvas height. Use Arrow Up and Arrow Down keys.'}
        className={mergeClasses(styles.handle, isDragging && styles.handleActive)}
      >
        <span className={styles.gripBar} />
        <span className={styles.gripBar} />
        <span className={styles.gripBar} />
      </div>
    </div>
  );
}
