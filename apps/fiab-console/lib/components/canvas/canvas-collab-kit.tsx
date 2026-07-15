'use client';

/**
 * canvas-collab-kit — the SHARED collaboration visual layer for every Loom
 * canvas (W4 comments/sticky-notes + W5 presence). It sits alongside
 * canvas-node-kit and owns the presentational pieces the collab hooks
 * (use-canvas-comments / use-canvas-presence / use-canvas-suggestion) drive, so
 * ANY @xyflow/react canvas gets a consistent comment + presence surface by
 * registering two node types and dropping in <PresenceBar>:
 *
 *   • StickyCommentNode  — a React Flow node (`type:'comment'`) rendering a
 *     comment / sticky note anchored on the canvas: colour band, author +
 *     relative time, inline edit + delete for the author, resolve toggle.
 *   • PresenceCursorNode — a React Flow node (`type:'presence-cursor'`) drawing
 *     a peer's live cursor beacon (coloured pointer + name chip).
 *   • PresenceBar        — the avatar stack + "N editing" + the honest
 *     "Live co-edit (CRDT) — Preview" note, dropped into a <Panel>.
 *   • AddCommentButton   — the toolbar affordance that arms drop-a-comment mode.
 *
 * Token discipline (web3-ui / no-raw-px): every colour/space/radius/shadow is a
 * Fluent v9 `tokens.*` value or a `--loom-accent-*` var combined via the kit's
 * `accentTint`. No raw px in inline styles — node positions come from React Flow,
 * not inline geometry.
 */

import {
  AvatarGroup, AvatarGroupItem, AvatarGroupPopover, partitionAvatarGroupItems,
  Badge, Button, Caption1, Text, Textarea, Tooltip, Menu, MenuTrigger, MenuPopover,
  MenuList, MenuItem, makeStyles, mergeClasses, tokens,
  type AvatarGroupItemProps,
} from '@fluentui/react-components';
import {
  Comment16Regular, CommentAdd20Regular, Delete16Regular, Edit16Regular,
  Checkmark16Regular, Dismiss16Regular, People20Regular, Color16Regular,
} from '@fluentui/react-icons';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo, useState } from 'react';
import { accentTint } from './canvas-node-kit';
import type { CanvasCommentColor, CanvasCommentView } from '@/lib/collab/canvas-comment-model';
import type { PresenceColorKey, PresencePeer } from '@/lib/collab/canvas-presence-model';

// ── Colour KEY → theme-aware token/var (the kit owns the mapping) ────────────

const COMMENT_ACCENT: Record<CanvasCommentColor, string> = {
  amber: 'var(--loom-accent-amber)',
  blue: 'var(--loom-accent-blue)',
  violet: 'var(--loom-accent-violet)',
  teal: 'var(--loom-accent-teal)',
  magenta: 'var(--loom-accent-magenta)',
};

const PRESENCE_ACCENT: Record<PresenceColorKey, string> = {
  blue: 'var(--loom-accent-blue)',
  violet: 'var(--loom-accent-violet)',
  teal: 'var(--loom-accent-teal)',
  magenta: 'var(--loom-accent-magenta)',
  amber: 'var(--loom-accent-amber)',
  green: tokens.colorPaletteGreenForeground1,
};

/** Fluent Avatar `color` per presence key, so the avatar ring matches the cursor. */
const PRESENCE_AVATAR_COLOR: Record<PresenceColorKey, NonNullable<AvatarGroupItemProps['color']>> = {
  blue: 'royal-blue',
  violet: 'purple',
  teal: 'teal',
  magenta: 'magenta',
  amber: 'marigold',
  green: 'forest',
};

/** Compact relative-time label (kit-local so no date lib is pulled in). */
function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const useStyles = makeStyles({
  // ── Sticky comment node ────────────────────────────────────────────────────
  sticky: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    width: '184px',
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderTopWidth: tokens.strokeWidthThick,
    boxShadow: tokens.shadow8,
    color: tokens.colorNeutralForeground1,
    transitionProperty: 'box-shadow, transform',
    transitionDuration: tokens.durationFast,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': { boxShadow: tokens.shadow16 },
    '& .loom-sticky-actions': {
      opacity: 0,
      transitionProperty: 'opacity',
      transitionDuration: tokens.durationFast,
    },
    ':hover .loom-sticky-actions': { opacity: 1 },
    '@media (prefers-reduced-motion: reduce)': { transitionDuration: '0.01ms' },
  },
  stickySelected: {
    boxShadow: tokens.shadow16,
    border: `1px solid ${tokens.colorBrandStroke1}`,
    borderTopWidth: tokens.strokeWidthThick,
  },
  stickyResolved: { opacity: 0.6 },
  stickyHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
  },
  stickyIcon: { flexShrink: 0, display: 'inline-flex' },
  stickyAuthor: {
    flex: 1,
    minWidth: 0,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  stickyActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    flexShrink: 0,
  },
  stickyText: {
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  stickyMeta: { color: tokens.colorNeutralForeground3 },
  editRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  editActions: { display: 'flex', gap: tokens.spacingHorizontalXS, justifyContent: 'flex-end' },
  // ── Presence cursor beacon ────────────────────────────────────────────────
  cursor: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    pointerEvents: 'none',
    userSelect: 'none',
  },
  cursorDot: {
    width: '10px',
    height: '10px',
    borderRadius: tokens.borderRadiusCircular,
    border: `2px solid ${tokens.colorNeutralBackground1}`,
    boxShadow: tokens.shadow4,
    flexShrink: 0,
  },
  cursorChip: {
    paddingTop: '1px',
    paddingBottom: '1px',
    paddingLeft: tokens.spacingHorizontalXS,
    paddingRight: tokens.spacingHorizontalXS,
    borderRadius: tokens.borderRadiusSmall,
    fontSize: tokens.fontSizeBase100,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForegroundOnBrand,
    whiteSpace: 'nowrap',
    boxShadow: tokens.shadow4,
  },
  // ── Presence bar ──────────────────────────────────────────────────────────
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    paddingTop: tokens.spacingVerticalXS,
    paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusLarge,
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    boxShadow: tokens.shadow8,
  },
  barLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXS,
    color: tokens.colorNeutralForeground2,
    fontWeight: tokens.fontWeightMedium,
  },
});

// ── W4: sticky-note / comment React Flow node ────────────────────────────────

/** Data carried on a comment React Flow node (`type:'comment'`). */
export interface CommentNodeData {
  comment: CanvasCommentView;
  /** Author-only edit — persists the new text. */
  onEditText?: (id: string, text: string) => void;
  /** Author-only resolve/unresolve toggle. */
  onToggleResolved?: (id: string, resolved: boolean) => void;
  /** Author-only delete. */
  onDelete?: (id: string) => void;
  [k: string]: unknown;
}

/**
 * Presentational sticky/comment card — no React Flow dependency, so it renders
 * BOTH as a React Flow node (StickyCommentNode) AND in the viewport-transformed
 * overlay (CanvasCollabLayer). Owns its own inline-edit state.
 */
export const StickyCommentCard: React.FC<{ data: CommentNodeData; selected?: boolean }> = ({ data, selected }) => {
  const styles = useStyles();
  const c = data.comment;
  const accent = COMMENT_ACCENT[c.color] ?? COMMENT_ACCENT.amber;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.text);

  const save = () => {
    const t = draft.trim();
    if (t && t !== c.text) data.onEditText?.(c.id, t);
    setEditing(false);
  };

  return (
    <div
      className={mergeClasses(
        styles.sticky,
        selected && styles.stickySelected,
        c.resolved && styles.stickyResolved,
      )}
      style={{ background: accentTint(accent, 12), borderTopColor: accent }}
      data-comment-node={c.id}
      data-comment-mine={c.mine ? '1' : '0'}
      aria-label={`Comment by ${c.authorName || 'teammate'}`}
    >
      <div className={styles.stickyHead}>
        <span className={styles.stickyIcon} style={{ color: accent }} aria-hidden>
          <Comment16Regular />
        </span>
        <span className={styles.stickyAuthor} title={c.authorName}>{c.authorName || 'Teammate'}</span>
        {c.mine && !editing && (
          <span className={mergeClasses(styles.stickyActions, 'loom-sticky-actions', 'nodrag', 'nopan')}>
            <Tooltip content="Edit" relationship="label">
              <Button size="small" appearance="subtle" icon={<Edit16Regular />} aria-label="Edit comment" onClick={() => { setDraft(c.text); setEditing(true); }} />
            </Tooltip>
            <Tooltip content={c.resolved ? 'Reopen' : 'Resolve'} relationship="label">
              <Button size="small" appearance="subtle" icon={<Checkmark16Regular />} aria-label={c.resolved ? 'Reopen comment' : 'Resolve comment'} onClick={() => data.onToggleResolved?.(c.id, !c.resolved)} />
            </Tooltip>
            <Tooltip content="Delete" relationship="label">
              <Button size="small" appearance="subtle" icon={<Delete16Regular />} aria-label="Delete comment" onClick={() => data.onDelete?.(c.id)} />
            </Tooltip>
          </span>
        )}
      </div>

      {editing ? (
        <div className={mergeClasses(styles.editRow, 'nodrag', 'nopan')}>
          <Textarea
            value={draft}
            onChange={(_, v) => setDraft(v.value)}
            resize="vertical"
            size="small"
            aria-label="Edit comment text"
          />
          <div className={styles.editActions}>
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Cancel edit" onClick={() => setEditing(false)} />
            <Button size="small" appearance="primary" icon={<Checkmark16Regular />} onClick={save}>Save</Button>
          </div>
        </div>
      ) : (
        <>
          <Caption1 className={styles.stickyText}>{c.text}</Caption1>
          <Caption1 className={styles.stickyMeta}>{relTime(c.updatedAt || c.createdAt)}{c.resolved ? ' · resolved' : ''}</Caption1>
        </>
      )}
    </div>
  );
};

function StickyCommentNodeImpl({ data, selected }: NodeProps) {
  const d = data as CommentNodeData;
  return (
    <>
      {/* An off-screen target handle keeps React Flow happy if an edge ever
          points here; comments are normally free-floating (no connections). */}
      <Handle id="in" type="target" position={Position.Top} style={{ opacity: 0 }} isConnectable={false} />
      <StickyCommentCard data={d} selected={selected} />
    </>
  );
}
export const StickyCommentNode = memo(StickyCommentNodeImpl);

// ── W5: presence cursor beacon React Flow node ───────────────────────────────

/** Data carried on a presence-cursor node (`type:'presence-cursor'`). */
export interface PresenceCursorNodeData {
  name: string;
  color: PresenceColorKey;
  [k: string]: unknown;
}

/** Presentational cursor beacon (no React Flow dependency) — used by both the
 *  RF node and the viewport-transformed overlay (CanvasCollabLayer). */
export const PresenceCursorBeacon: React.FC<{ name: string; color: PresenceColorKey }> = ({ name, color }) => {
  const styles = useStyles();
  const accent = PRESENCE_ACCENT[color] ?? PRESENCE_ACCENT.blue;
  return (
    <div className={styles.cursor} aria-hidden>
      <span className={styles.cursorDot} style={{ background: accent }} />
      <span className={styles.cursorChip} style={{ background: accent }}>{name}</span>
    </div>
  );
};

function PresenceCursorNodeImpl({ data }: NodeProps) {
  const d = data as PresenceCursorNodeData;
  return <PresenceCursorBeacon name={d.name} color={d.color} />;
}
export const PresenceCursorNode = memo(PresenceCursorNodeImpl);

// ── W5: presence avatar bar ──────────────────────────────────────────────────

export interface PresenceBarProps {
  peers: PresencePeer[];
}

/**
 * Avatar stack of the peers currently on this canvas + the honest
 * "Live co-edit (CRDT) — Preview" note. Presence (who's here + live cursors) is
 * REAL; full CRDT co-editing is a Preview seam — the badge tooltip says so
 * plainly (no vaporware).
 */
export function PresenceBar({ peers }: PresenceBarProps) {
  const styles = useStyles();
  const { inlineItems, overflowItems } = partitionAvatarGroupItems({
    items: peers.map((p) => p.oid),
    maxInlineItems: 5,
  });
  const byOid = new Map(peers.map((p) => [p.oid, p]));

  return (
    <div className={styles.bar} role="group" aria-label="People on this canvas" data-presence-bar>
      <span className={styles.barLabel}>
        <People20Regular aria-hidden />
        <Text size={200}>{peers.length === 0 ? 'Only you' : `${peers.length} more here`}</Text>
      </span>
      {peers.length > 0 && (
        <AvatarGroup size={24} aria-label="Active collaborators">
          {inlineItems.map((oid) => {
            const p = byOid.get(oid)!;
            return (
              <Tooltip key={oid} content={p.name || 'Teammate'} relationship="label">
                <AvatarGroupItem name={p.name || 'Teammate'} color={PRESENCE_AVATAR_COLOR[p.color]} />
              </Tooltip>
            );
          })}
          {overflowItems && (
            <AvatarGroupPopover>
              {overflowItems.map((oid) => {
                const p = byOid.get(oid)!;
                return <AvatarGroupItem key={oid} name={p.name || 'Teammate'} color={PRESENCE_AVATAR_COLOR[p.color]} />;
              })}
            </AvatarGroupPopover>
          )}
        </AvatarGroup>
      )}
      <Tooltip
        relationship="description"
        content="Live presence + cursors are real. Full simultaneous CRDT co-editing (conflict-free merge) is in Preview — edits still save per author."
      >
        <Badge appearance="tint" color="informative" size="small">Live co-edit (CRDT) · Preview</Badge>
      </Tooltip>
    </div>
  );
}

// ── W4: add-comment toolbar affordance ───────────────────────────────────────

export interface AddCommentButtonProps {
  /** True while "drop a comment" mode is armed (next canvas click places one). */
  armed: boolean;
  onToggle: () => void;
  /** Optional colour picker — pick the sticky colour for the next comment. */
  color?: CanvasCommentColor;
  onColorChange?: (c: CanvasCommentColor) => void;
}

const COMMENT_COLOR_LABEL: Record<CanvasCommentColor, string> = {
  amber: 'Amber', blue: 'Blue', violet: 'Violet', teal: 'Teal', magenta: 'Magenta',
};

/** The "Comment" toggle for a canvas toolbar — arms drop-a-comment mode. */
export function AddCommentButton({ armed, onToggle, color, onColorChange }: AddCommentButtonProps) {
  return (
    <>
      <Tooltip content={armed ? 'Click the canvas to place a comment' : 'Add a comment'} relationship="label">
        <Button
          size="small"
          appearance={armed ? 'primary' : 'subtle'}
          icon={<CommentAdd20Regular />}
          aria-pressed={armed}
          onClick={onToggle}
          data-add-comment
        >
          Comment
        </Button>
      </Tooltip>
      {onColorChange && (
        <Menu positioning="below">
          <MenuTrigger disableButtonEnhancement>
            <Tooltip content="Sticky colour" relationship="label">
              <Button size="small" appearance="subtle" icon={<Color16Regular />} aria-label="Sticky colour" />
            </Tooltip>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              {(Object.keys(COMMENT_COLOR_LABEL) as CanvasCommentColor[]).map((c) => (
                <MenuItem
                  key={c}
                  icon={<span style={{ color: COMMENT_ACCENT[c] }}><Comment16Regular /></span>}
                  onClick={() => onColorChange(c)}
                  data-comment-color={c}
                >
                  {COMMENT_COLOR_LABEL[c]}{c === color ? ' ✓' : ''}
                </MenuItem>
              ))}
            </MenuList>
          </MenuPopover>
        </Menu>
      )}
    </>
  );
}
