'use client';

/**
 * EditorCollabBar (A14) — presence avatars for NON-canvas editors (notebook,
 * report designer, semantic model, unified SQL). The canvas surfaces already
 * carry PresenceBar inside CanvasCollabLayer; this is the same real presence
 * (the TTL-enabled Cosmos beacon store via useCanvasPresence, canvasKey
 * 'editor') rendered as a compact header chip that fits the editor chrome's
 * action row — Fabric's co-authoring avatar stack, Loom-themed.
 *
 * Deliberately does NOT import canvas-collab-kit: that module pulls
 * @xyflow/react, and this chip mounts through the shared ItemEditorChrome —
 * every editor bundle would pay the flow dependency. The avatar colour mapping
 * mirrors the kit's (same PresenceColorKey → Fluent avatar colour) so a peer
 * reads the same colour on a canvas and in an editor header.
 *
 * States (clean first-open per ux-baseline): zero peers renders a subtle
 * people icon with an honest tooltip — no banner, no noise; peers render the
 * avatar stack + count. Presence transport (push/poll) is owned by the hook.
 */

import {
  AvatarGroup, AvatarGroupItem, AvatarGroupPopover, partitionAvatarGroupItems,
  Caption1, Tooltip, makeStyles, tokens,
  type AvatarGroupItemProps,
} from '@fluentui/react-components';
import { People20Regular } from '@fluentui/react-icons';
import { useCanvasPresence } from '@/lib/collab/use-canvas-presence';
import type { PresenceColorKey } from '@/lib/collab/canvas-presence-model';

/** Same mapping as canvas-collab-kit's PRESENCE_AVATAR_COLOR (kept in sync so
 *  a peer's colour matches between a canvas and an editor header). */
const AVATAR_COLOR: Record<PresenceColorKey, NonNullable<AvatarGroupItemProps['color']>> = {
  blue: 'royal-blue',
  violet: 'purple',
  teal: 'teal',
  magenta: 'magenta',
  amber: 'marigold',
  green: 'forest',
};

const useStyles = makeStyles({
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  idle: { color: tokens.colorNeutralForeground3, display: 'inline-flex', alignItems: 'center' },
  count: { color: tokens.colorNeutralForeground2, whiteSpace: 'nowrap' },
});

export interface EditorCollabBarProps {
  itemType: string;
  itemId: string;
}

export function EditorCollabBar({ itemType, itemId }: EditorCollabBarProps) {
  const styles = useStyles();
  const { peers } = useCanvasPresence(itemType, itemId, 'editor');

  if (peers.length === 0) {
    return (
      <Tooltip
        relationship="description"
        content="Live presence is on — teammates who open this item will appear here."
      >
        <span className={styles.idle} data-editor-presence="empty" aria-label="No one else is here">
          <People20Regular aria-hidden />
        </span>
      </Tooltip>
    );
  }

  const { inlineItems, overflowItems } = partitionAvatarGroupItems({
    items: peers.map((p) => p.oid),
    maxInlineItems: 4,
  });
  const byOid = new Map(peers.map((p) => [p.oid, p]));

  return (
    <span className={styles.chip} role="group" aria-label="People on this item" data-editor-presence={peers.length}>
      <AvatarGroup size={20} aria-label="Active collaborators">
        {inlineItems.map((oid) => {
          const p = byOid.get(oid)!;
          return (
            <Tooltip key={oid} content={p.name || 'Teammate'} relationship="label">
              <AvatarGroupItem name={p.name || 'Teammate'} color={AVATAR_COLOR[p.color]} />
            </Tooltip>
          );
        })}
        {overflowItems && (
          <AvatarGroupPopover>
            {overflowItems.map((oid) => {
              const p = byOid.get(oid)!;
              return <AvatarGroupItem key={oid} name={p.name || 'Teammate'} color={AVATAR_COLOR[p.color]} />;
            })}
          </AvatarGroupPopover>
        )}
      </AvatarGroup>
      <Caption1 className={styles.count}>{peers.length} here</Caption1>
    </span>
  );
}
