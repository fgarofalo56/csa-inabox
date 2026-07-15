'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * RecentItems — pulls /api/items/recent (audit-log-backed) for the
 * current user and renders a rail of BRANDED item cards linking back to the
 * item (Fabric Home "Recent" parity: per-type branded icon + type label +
 * relative time, pinnable straight from the card).
 *
 * Real data only: the recents store is the audit log; the empty state is an
 * honest guided launcher, and loading renders stable Skeleton tiles (no
 * spinner flash, no mock rows).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  makeStyles, tokens, Skeleton, SkeletonItem, Tooltip,
} from '@fluentui/react-components';
import { History24Regular } from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { EmptyState } from '@/lib/components/empty-state';

interface Recent { id: string; type: string; displayName?: string; workspaceId?: string; lastTouchedAt: string; }

// ── relative time ("2 hours ago") — matches the OneLake catalog idiom ──
const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relative(iso?: string): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return RTF.format(Math.round(diffSec), 'second');
  if (abs < 3600) return RTF.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return RTF.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 2592000) return RTF.format(Math.round(diffSec / 86400), 'day');
  if (abs < 31536000) return RTF.format(Math.round(diffSec / 2592000), 'month');
  return RTF.format(Math.round(diffSec / 31536000), 'year');
}

const useStyles = makeStyles({
  skeletonTile: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusXLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  skeletonBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flex: 1, minWidth: 0 },
});

/** Stable branded-card skeleton row matching the loaded tile layout. */
export function TileRailSkeleton({ count = 4, label = 'Loading recent items' }: { count?: number; label?: string }) {
  const styles = useStyles();
  return (
    <Skeleton aria-label={label}>
      <TileGrid minTileWidth={240}>
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className={styles.skeletonTile}>
            <SkeletonItem shape="square" size={40} />
            <div className={styles.skeletonBody}>
              <SkeletonItem shape="rectangle" style={{ width: '70%', height: 14 }} />
              <SkeletonItem shape="rectangle" style={{ width: '45%', height: 10 }} />
            </div>
          </div>
        ))}
      </TileGrid>
    </Skeleton>
  );
}

export function RecentItems() {
  const router = useRouter();
  const [items, setItems] = useState<Recent[] | null>(null);

  useEffect(() => {
    clientFetch('/api/items/recent?n=8').then(r => r.json()).then(d => {
      setItems(Array.isArray(d?.items) ? d.items : []);
    }).catch(() => setItems([]));
  }, []);

  if (items === null) return <TileRailSkeleton />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<History24Regular />}
        title="Nothing opened yet"
        body="Items you open or edit show up here so you can jump straight back in. Browse the catalog or create your first item to get going."
        primaryAction={{ label: 'Create an item', href: '/new' }}
        secondaryAction={{ label: 'Browse all items', href: '/browse', appearance: 'secondary' }}
      />
    );
  }
  return (
    <TileGrid minTileWidth={240}>
      {items.map(it => {
        const visual = itemVisual(it.type);
        const href = `/items/${it.type}/${it.id}`;
        return (
          <Tooltip key={`${it.type}/${it.id}`} content={`Opened ${relative(it.lastTouchedAt)}`} relationship="description">
            <ItemTile
              type={it.type}
              title={it.displayName ?? it.id.slice(0, 12)}
              subtitle={visual.label}
              meta={relative(it.lastTouchedAt)}
              pinTarget={{
                id: it.id,
                label: it.displayName ?? it.id.slice(0, 12),
                href,
                type: it.type,
              }}
              onClick={() => router.push(href)}
            />
          </Tooltip>
        );
      })}
    </TileGrid>
  );
}
