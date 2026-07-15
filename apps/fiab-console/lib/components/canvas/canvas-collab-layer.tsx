'use client';

/**
 * CanvasCollabLayer — the ONE-LINE, drop-in collaboration overlay every Loom
 * canvas mounts (W4 comments/sticky-notes + W5 presence). Rendered as a CHILD of
 * `<ReactFlow>` (so it lives inside the flow's provider context) it needs NO
 * changes to the host's `nodes` / `nodeTypes` state:
 *
 *   <ReactFlow …>
 *     …host nodes/edges/controls…
 *     <CanvasCollabLayer itemType="eventstream" itemId={itemId} />
 *   </ReactFlow>
 *
 * It reads the live viewport (useViewport) to position comment cards + peer
 * cursor beacons in an absolute overlay that tracks pan/zoom, drives the
 * heartbeat/poll + comment CRUD through the shared hooks (REAL BFF calls), and
 * surfaces the PresenceBar. The overlay itself is pointer-events:none; only the
 * interactive pieces (cards, composer, panels, the arm-to-place capture layer)
 * opt back in — so it never steals the canvas's own pan/drag.
 *
 * Token discipline (web3-ui / no-raw-px): all spacing/colour via `tokens.*`; the
 * only inline numerics are dynamic `left/top/transform` from the viewport (not a
 * flagged spacing prop).
 */

import { Panel, useReactFlow, useViewport } from '@xyflow/react';
import {
  Button, Textarea, Caption1, makeStyles, mergeClasses, tokens,
} from '@fluentui/react-components';
import { Checkmark16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCanvasComments } from '@/lib/collab/use-canvas-comments';
import { useCanvasPresence } from '@/lib/collab/use-canvas-presence';
import type { CanvasCommentColor } from '@/lib/collab/canvas-comment-model';
import {
  StickyCommentCard, PresenceBar, PresenceCursorBeacon, AddCommentButton,
  type CommentNodeData,
} from './canvas-collab-kit';

const useStyles = makeStyles({
  overlay: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: 5,
  },
  positioned: {
    position: 'absolute',
    top: 0,
    left: 0,
    pointerEvents: 'auto',
  },
  cursorPositioned: {
    position: 'absolute',
    top: 0,
    left: 0,
    pointerEvents: 'none',
    transitionProperty: 'transform',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveLinear,
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  captureArm: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'auto',
    cursor: 'crosshair',
    zIndex: 6,
  },
  composer: {
    position: 'absolute',
    top: 0,
    left: 0,
    pointerEvents: 'auto',
    zIndex: 7,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
    width: '220px',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow16,
  },
  composerActions: {
    display: 'flex',
    gap: tokens.spacingHorizontalXS,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  composerHint: { color: tokens.colorNeutralForeground3 },
});

export interface CanvasCollabLayerProps {
  itemType: string;
  itemId?: string;
  /** Distinguishes multiple canvases inside one item (default 'default'). */
  canvasKey?: string;
  /** Turn comments off (presence stays). Default on. */
  comments?: boolean;
  /** Turn presence off (comments stay). Default on. */
  presence?: boolean;
}

/** flow-coords → overlay-local screen px via the live viewport transform. */
function flowToScreen(x: number, y: number, vp: { x: number; y: number; zoom: number }) {
  return { left: x * vp.zoom + vp.x, top: y * vp.zoom + vp.y };
}

export function CanvasCollabLayer({
  itemType,
  itemId,
  canvasKey = 'default',
  comments = true,
  presence = true,
}: CanvasCollabLayerProps) {
  const styles = useStyles();
  const rf = useReactFlow();
  const vp = useViewport();
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const commentsApi = useCanvasComments(itemType, comments ? itemId : undefined, canvasKey);
  const presenceApi = useCanvasPresence(itemType, presence ? itemId : undefined, canvasKey, presence);

  const [armed, setArmed] = useState(false);
  const [color, setColor] = useState<CanvasCommentColor>('amber');
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');

  // Report the local cursor to peers (throttled via rAF) whenever the pointer is
  // over the canvas. Uses a window listener + the overlay bounds so it never
  // intercepts the canvas's own pan/drag handlers.
  useEffect(() => {
    if (!presence || !itemId) return;
    let raf = 0;
    const onMove = (e: MouseEvent) => {
      const el = overlayRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        presenceApi.reportCursor(null);
        return;
      }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try {
          const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
          presenceApi.reportCursor({ x: p.x, y: p.y });
        } catch {
          /* provider not ready */
        }
      });
    };
    window.addEventListener('mousemove', onMove);
    return () => { window.removeEventListener('mousemove', onMove); if (raf) cancelAnimationFrame(raf); };
  }, [presence, itemId, rf, presenceApi]);

  const onArmClick = useCallback((e: React.MouseEvent) => {
    try {
      const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setPending({ x: p.x, y: p.y });
      setDraft('');
    } catch {
      /* provider not ready */
    }
    setArmed(false);
  }, [rf]);

  const submitPending = useCallback(async () => {
    if (!pending) return;
    const text = draft.trim();
    if (!text) { setPending(null); return; }
    await commentsApi.add({ text, x: pending.x, y: pending.y, kind: 'sticky', color });
    setPending(null);
    setDraft('');
  }, [pending, draft, color, commentsApi]);

  if (!itemId) return null;

  return (
    <>
      {/* Toolbar: comment toggle + colour (presence bar lives top-center). */}
      {comments && (
        <Panel position="top-right">
          <AddCommentButton
            armed={armed}
            onToggle={() => setArmed((v) => !v)}
            color={color}
            onColorChange={setColor}
          />
        </Panel>
      )}
      {presence && (
        <Panel position="top-center">
          <PresenceBar peers={presenceApi.peers} />
        </Panel>
      )}

      {/* The viewport-tracking overlay: comment cards + peer cursor beacons. */}
      <div className={styles.overlay} ref={overlayRef} data-canvas-collab={canvasKey}>
        {comments && commentsApi.comments.map((c) => {
          const pos = flowToScreen(c.x, c.y, vp);
          const data: CommentNodeData = {
            comment: c,
            onEditText: (id, text) => commentsApi.edit(id, { text }),
            onToggleResolved: (id, resolved) => commentsApi.edit(id, { resolved }),
            onDelete: (id) => commentsApi.remove(id),
          };
          return (
            <div key={c.id} className={styles.positioned} style={{ transform: `translate(${pos.left}px, ${pos.top}px)` }}>
              <StickyCommentCard data={data} />
            </div>
          );
        })}

        {presence && presenceApi.peers.map((p) => {
          if (!p.cursor) return null;
          const pos = flowToScreen(p.cursor.x, p.cursor.y, vp);
          return (
            <div key={p.oid} className={styles.cursorPositioned} style={{ transform: `translate(${pos.left}px, ${pos.top}px)` }}>
              <PresenceCursorBeacon name={p.name || 'Teammate'} color={p.color} />
            </div>
          );
        })}

        {/* In-place composer for a newly placed comment. */}
        {pending && (() => {
          const pos = flowToScreen(pending.x, pending.y, vp);
          return (
            <div className={styles.composer} style={{ transform: `translate(${pos.left}px, ${pos.top}px)` }}>
              <Caption1 className={styles.composerHint}>New comment</Caption1>
              <Textarea
                value={draft}
                onChange={(_, v) => setDraft(v.value)}
                placeholder="Type a comment…"
                size="small"
                resize="vertical"
                autoFocus
                aria-label="New comment text"
              />
              <div className={styles.composerActions}>
                <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Cancel" onClick={() => setPending(null)} />
                <Button size="small" appearance="primary" icon={<Checkmark16Regular />} onClick={submitPending}>Add</Button>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Arm-to-place capture layer — only present while armed. Captures the next
          click, converts it to flow-coords, and opens the composer there. */}
      {armed && <div className={styles.captureArm} onClick={onArmClick} data-canvas-comment-arm />}
    </>
  );
}
