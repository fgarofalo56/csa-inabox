'use client';

/**
 * PipelineCanvas — center pane of the Fabric-style pipeline editor.
 *
 * Features:
 *   - Drag from palette → drop on canvas creates a new activity at the
 *     drop coordinates.
 *   - Click activity → fires onSelect (parent opens properties panel).
 *   - Background click clears selection.
 *   - Pan + zoom via wheel + middle-drag (or shift+drag).
 *   - Fit-to-screen + reset-zoom imperative methods exposed via ref.
 *   - Snap-to-grid toggle (default on).
 *   - Minimap in the bottom-right.
 *   - SVG overlay draws all dependsOn[] edges in Fabric's 4 colours.
 *
 * Coordinates: each activity stores x/y in a sibling Map managed by the
 * canvas. When the canvas mounts, any activity without a stored position
 * gets one from the topo-layout algorithm. Positions are NOT persisted
 * in the ADF JSON (ADF doesn't have a viewport concept) — they're
 * computed deterministically from `dependsOn[]` so re-opening shows the
 * same layout.
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import { Caption1, makeStyles, tokens } from '@fluentui/react-components';
import { ActivityNode } from './activity-node';
import { Connector, ConnectorMarkers, type ConnectorCondition } from './connector';
import type { PipelineActivity } from './types';

const useStyles = makeStyles({
  shell: {
    position: 'relative',
    flex: 1,
    minHeight: 400,
    overflow: 'hidden',
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
  },
  viewport: {
    position: 'absolute',
    top: 0, left: 0,
    width: '100%', height: '100%',
    overflow: 'hidden',
  },
  inner: {
    position: 'absolute',
    transformOrigin: '0 0',
    width: 4000,
    height: 3000,
  },
  grid: {
    position: 'absolute',
    inset: 0,
    backgroundImage: `radial-gradient(${tokens.colorNeutralStroke2} 1px, transparent 1px)`,
    backgroundSize: '20px 20px',
    pointerEvents: 'none',
  },
  svg: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    overflow: 'visible',
  },
  minimap: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 160, height: 100,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  hint: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
    color: tokens.colorNeutralForeground3,
  },
  dropping: {
    outline: `2px dashed ${tokens.colorBrandStroke1}`,
    outlineOffset: -2,
  },
});

const NODE_W = 200;
const NODE_H = 80;
const COL_GAP = 80;
const ROW_GAP = 40;
const GRID = 20;

export interface CanvasHandle {
  fitToScreen: () => void;
  resetZoom: () => void;
}

export interface PipelineCanvasProps {
  activities: PipelineActivity[];
  selectedName?: string;
  onSelect: (name: string | null) => void;
  /** Fired when the user drops a palette tile on the canvas. */
  onDropPaletteKey: (key: string, atX: number, atY: number) => void;
  /** Whether the snap-to-grid toggle is on. */
  snapToGrid?: boolean;
  /** Whether the dot grid is visible. */
  showGrid?: boolean;
}

interface Pos { x: number; y: number; }

function computeRanks(activities: PipelineActivity[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const a of activities) ranks.set(a.name, 0);
  const max = activities.length;
  for (let pass = 0; pass < max; pass++) {
    let changed = false;
    for (const a of activities) {
      const ds = a.dependsOn || [];
      let r = 0;
      for (const dep of ds) {
        const dr = ranks.get(dep.activity);
        if (dr !== undefined && dr + 1 > r) r = dr + 1;
      }
      if (r !== ranks.get(a.name)) { ranks.set(a.name, r); changed = true; }
    }
    if (!changed) break;
  }
  return ranks;
}

function autoLayout(activities: PipelineActivity[], existing: Map<string, Pos>): Map<string, Pos> {
  const ranks = computeRanks(activities);
  const cols = new Map<number, PipelineActivity[]>();
  for (const a of activities) {
    const r = ranks.get(a.name) ?? 0;
    if (!cols.has(r)) cols.set(r, []);
    cols.get(r)!.push(a);
  }
  const out = new Map<string, Pos>();
  const orderedCols = [...cols.entries()].sort((a, b) => a[0] - b[0]);
  for (const [rank, list] of orderedCols) {
    list.forEach((a, idx) => {
      // Keep existing position if user already moved this node.
      const prev = existing.get(a.name);
      if (prev) { out.set(a.name, prev); return; }
      out.set(a.name, {
        x: 40 + rank * (NODE_W + COL_GAP),
        y: 40 + idx * (NODE_H + ROW_GAP),
      });
    });
  }
  return out;
}

export const PipelineCanvas = forwardRef<CanvasHandle, PipelineCanvasProps>(function PipelineCanvas(
  { activities, selectedName, onSelect, onDropPaletteKey, snapToGrid = true, showGrid = true },
  ref,
) {
  const s = useStyles();
  const shellRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const positionsRef = useRef<Map<string, Pos>>(new Map());
  const [, force] = useState({});
  const tick = () => force({});

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dropping, setDropping] = useState(false);

  // Sync layout whenever activities change. Existing positions kept; new
  // nodes get autoLayout slots.
  useEffect(() => {
    const next = autoLayout(activities, positionsRef.current);
    positionsRef.current = next;
    tick();
  }, [activities]);

  const fitToScreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell || activities.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of activities) {
      const p = positionsRef.current.get(a.name);
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + NODE_H);
    }
    if (!Number.isFinite(minX)) return;
    const w = shell.clientWidth, h = shell.clientHeight;
    const bw = maxX - minX + 80, bh = maxY - minY + 80;
    const z = Math.min(1, Math.min(w / bw, h / bh));
    setZoom(z);
    setPan({ x: -minX * z + 40, y: -minY * z + 40 });
  }, [activities]);

  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  useImperativeHandle(ref, () => ({ fitToScreen, resetZoom }), [fitToScreen, resetZoom]);

  // Drag/drop from palette
  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/x-fiab-activity')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDropping(true);
    }
  };
  const onDragLeave = () => setDropping(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const key = e.dataTransfer.getData('application/x-fiab-activity');
    if (!key) return;
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const localX = (e.clientX - rect.left - pan.x) / zoom;
    const localY = (e.clientY - rect.top - pan.y) / zoom;
    const x = snapToGrid ? Math.round(localX / GRID) * GRID : localX;
    const y = snapToGrid ? Math.round(localY / GRID) * GRID : localY;
    onDropPaletteKey(key, x, y);
  };

  // Pan with shift+drag (or middle button); zoom with wheel (ctrl+wheel
  // for desktop precision; bare wheel still scrolls but on canvas we
  // override to zoom for Fabric parity).
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return; // bare wheel reserved for scroll-passthrough
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom((z) => Math.max(0.25, Math.min(2, z + delta)));
  };
  const panStateRef = useRef<{ panning: boolean; lastX: number; lastY: number }>({ panning: false, lastX: 0, lastY: 0 });
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      e.preventDefault();
      panStateRef.current = { panning: true, lastX: e.clientX, lastY: e.clientY };
    } else if (e.button === 0 && e.target === e.currentTarget) {
      onSelect(null);
    }
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!panStateRef.current.panning) return;
      const dx = e.clientX - panStateRef.current.lastX;
      const dy = e.clientY - panStateRef.current.lastY;
      panStateRef.current.lastX = e.clientX;
      panStateRef.current.lastY = e.clientY;
      setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
    };
    const onUp = () => { panStateRef.current.panning = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  // Node drag-to-reposition
  const draggingNodeRef = useRef<{ name: string; offsetX: number; offsetY: number } | null>(null);
  const onNodeMouseDown = (name: string) => (e: React.MouseEvent) => {
    if (e.button !== 0 || e.shiftKey) return;
    e.stopPropagation();
    const pos = positionsRef.current.get(name);
    if (!pos) return;
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const localX = (e.clientX - rect.left - pan.x) / zoom;
    const localY = (e.clientY - rect.top - pan.y) / zoom;
    draggingNodeRef.current = { name, offsetX: localX - pos.x, offsetY: localY - pos.y };
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const dragging = draggingNodeRef.current;
      if (!dragging) return;
      const shell = shellRef.current;
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      const localX = (e.clientX - rect.left - pan.x) / zoom;
      const localY = (e.clientY - rect.top - pan.y) / zoom;
      let x = localX - dragging.offsetX;
      let y = localY - dragging.offsetY;
      if (snapToGrid) { x = Math.round(x / GRID) * GRID; y = Math.round(y / GRID) * GRID; }
      positionsRef.current.set(dragging.name, { x: Math.max(0, x), y: Math.max(0, y) });
      tick();
    };
    const onUp = () => { draggingNodeRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [pan.x, pan.y, zoom, snapToGrid]);

  // Build edges from dependsOn — one path per (from, cond) pair.
  const edges = useMemo(() => {
    const list: Array<{ from: string; to: string; cond?: ConnectorCondition; key: string }> = [];
    for (const a of activities) {
      for (const dep of a.dependsOn || []) {
        const conds = dep.dependencyConditions || [];
        if (conds.length === 0) {
          list.push({ from: dep.activity, to: a.name, key: `${dep.activity}->${a.name}` });
        } else {
          for (const c of conds) {
            list.push({ from: dep.activity, to: a.name, cond: c as ConnectorCondition, key: `${dep.activity}->${a.name}:${c}` });
          }
        }
      }
    }
    return list;
  }, [activities]);

  // Minimap — single SVG that maps the whole inner space into 160x100.
  const minimapBounds = useMemo(() => {
    let maxX = 200, maxY = 200;
    for (const p of positionsRef.current.values()) {
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + NODE_H);
    }
    return { w: maxX + 40, h: maxY + 40 };
  // recompute when activities change
  }, [activities, force]);

  return (
    <div
      ref={shellRef}
      className={`${s.shell} ${dropping ? s.dropping : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      data-testid="pipeline-canvas"
    >
      <div className={s.viewport}>
        <div
          ref={innerRef}
          className={s.inner}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {showGrid && <div className={s.grid} />}
          <svg className={s.svg} width="100%" height="100%" aria-hidden="true">
            <ConnectorMarkers />
            {edges.map((e) => {
              const fp = positionsRef.current.get(e.from);
              const tp = positionsRef.current.get(e.to);
              if (!fp || !tp) return null;
              const sx = fp.x + NODE_W;
              const sy = fp.y + NODE_H / 2;
              const ex = tp.x;
              const ey = tp.y + NODE_H / 2;
              return <Connector key={e.key} id={e.key} sx={sx} sy={sy} ex={ex} ey={ey} condition={e.cond} />;
            })}
          </svg>
          {activities.map((a) => {
            const p = positionsRef.current.get(a.name);
            if (!p) return null;
            return (
              <ActivityNode
                key={a.name}
                activity={a}
                x={p.x}
                y={p.y}
                selected={selectedName === a.name}
                onSelect={() => onSelect(a.name)}
                onMouseDown={onNodeMouseDown(a.name)}
              />
            );
          })}
          {activities.length === 0 && (
            <div className={s.hint}>
              <Caption1>Drag an activity from the left palette onto the canvas to begin.</Caption1>
            </div>
          )}
        </div>
      </div>
      {activities.length > 0 && (
        <div className={s.minimap} aria-hidden="true">
          <svg viewBox={`0 0 ${minimapBounds.w} ${minimapBounds.h}`} width="160" height="100" preserveAspectRatio="xMidYMid meet">
            {activities.map((a) => {
              const p = positionsRef.current.get(a.name);
              if (!p) return null;
              return (
                <rect
                  key={a.name}
                  x={p.x} y={p.y}
                  width={NODE_W} height={NODE_H}
                  fill={selectedName === a.name ? tokens.colorBrandBackground : tokens.colorNeutralForeground3}
                />
              );
            })}
          </svg>
        </div>
      )}
      <div style={{ position: 'absolute', left: 12, bottom: 12 }}>
        <Caption1 style={{ color: tokens.colorNeutralForeground3, backgroundColor: tokens.colorNeutralBackground1, padding: '2px 6px', borderRadius: 4, border: `1px solid ${tokens.colorNeutralStroke2}` }}>
          {Math.round(zoom * 100)}% · shift+drag to pan · ctrl+wheel to zoom
        </Caption1>
      </div>
    </div>
  );
});
