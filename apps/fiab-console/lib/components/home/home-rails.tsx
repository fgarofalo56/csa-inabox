'use client';

/**
 * Home rails — the Fabric-Home-parity bands on the Loom landing page:
 *
 *   • QuickCreateRail — branded per-item-type "new item" shortcuts (Fabric's
 *     quick-create strip). Each shortcut opens the REAL New-item gallery
 *     pre-scoped to that workload category — no dead tiles.
 *   • FavoritesRail  — the user's pinned items as branded cards, read from the
 *     shared pin-store (real Cosmos persistence via /api/user-prefs). Unpin is
 *     available right on the card; the rail stays in sync with the left-nav
 *     Pinned section because both subscribe to the same store.
 *
 * Real data only: pins come from the store (empty = honest guided hint),
 * loading renders Skeleton tiles, and every shortcut runs a real action.
 */

import * as React from 'react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { makeStyles, shorthands, tokens, mergeClasses, Text, Caption1 } from '@fluentui/react-components';
import { Star24Regular } from '@fluentui/react-icons';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { BrandedItemIcon } from '@/lib/components/ui/branded-item-icon';
import { itemVisual } from '@/lib/components/ui/item-type-visual';
import { EmptyState } from '@/lib/components/empty-state';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { usePins } from '@/lib/components/pin-store';
import { TileRailSkeleton } from '@/lib/components/recent-items';
import type { WorkloadCategory } from '@/lib/catalog/fabric-item-types';

const useStyles = makeStyles({
  // Quick-create strip: compact branded shortcut chips that wrap, never overlap.
  strip: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalM,
    minWidth: 0,
  },
  shortcut: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
    paddingBottom: tokens.spacingVerticalS,
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    // Native <button>: without an explicit color, text inherits UA ButtonText (black-on-dark).
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow2,
    cursor: 'pointer',
    minWidth: 0,
    maxWidth: '260px',
    transitionProperty: 'box-shadow, transform, border-color',
    transitionDuration: tokens.durationNormal,
    transitionTimingFunction: tokens.curveEasyEase,
    ':hover': {
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
      ...shorthands.borderColor(tokens.colorBrandStroke1),
    },
    ':focus-visible': {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: '2px',
    },
    '@media (prefers-reduced-motion: reduce)': {
      transitionDuration: '0.01ms',
      ':hover': { transform: 'none' },
    },
  },
  shortcutText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  shortcutTitle: {
    fontWeight: tokens.fontWeightSemibold,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  shortcutHint: {
    color: tokens.colorNeutralForeground3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
});

/** One quick-create shortcut: an item type + the create-gallery category it opens. */
interface QuickCreate {
  type: string;
  category: WorkloadCategory;
}

/** Fabric Home's quick-create set, mapped to Loom's create-gallery categories. */
const QUICK_CREATES: QuickCreate[] = [
  { type: 'lakehouse', category: 'Data Engineering' },
  { type: 'notebook', category: 'Data Engineering' },
  { type: 'data-pipeline', category: 'Data Factory' },
  { type: 'warehouse', category: 'Data Warehouse' },
  { type: 'eventstream', category: 'Real-Time Intelligence' },
  { type: 'kql-database', category: 'Real-Time Intelligence' },
  { type: 'semantic-model', category: 'Power BI' },
  { type: 'report', category: 'Power BI' },
];

/**
 * QuickCreateRail — branded new-item shortcuts. Clicking a shortcut opens the
 * real New-item dialog pre-scoped to that shortcut's workload category.
 */
export function QuickCreateRail(): React.ReactElement {
  const s = useStyles();
  const [openCategory, setOpenCategory] = useState<WorkloadCategory | null>(null);

  return (
    <>
      <div className={s.strip} role="group" aria-label="Quick create shortcuts">
        {QUICK_CREATES.map((q) => {
          const visual = itemVisual(q.type);
          return (
            <button
              key={q.type}
              type="button"
              className={mergeClasses(s.shortcut)}
              onClick={() => setOpenCategory(q.category)}
              aria-label={`New ${visual.label}`}
            >
              <BrandedItemIcon type={q.type} size="md" />
              <span className={s.shortcutText}>
                <Text size={300} className={s.shortcutTitle}>{visual.label}</Text>
                <Caption1 className={s.shortcutHint}>{q.category}</Caption1>
              </span>
            </button>
          );
        })}
      </div>
      {/* One controlled instance of the REAL create gallery, re-keyed per pick so
          the pre-selected category applies each time a shortcut is clicked. */}
      {openCategory !== null && (
        <NewItemDialog
          key={openCategory}
          hideTrigger
          defaultCategory={openCategory}
          open
          onOpenChange={(o) => { if (!o) setOpenCategory(null); }}
        />
      )}
    </>
  );
}

/**
 * FavoritesRail — the user's pinned items as branded cards (Fabric Home
 * "Favorites" parity). Backed by the shared pin-store; unpin toggles live on
 * each card and the rail re-renders the moment pin state changes anywhere.
 */
export function FavoritesRail(): React.ReactElement {
  const router = useRouter();
  const { pins, loading } = usePins();

  if (loading) return <TileRailSkeleton count={3} label="Loading favorites" />;
  const items = pins ?? [];
  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Star24Regular />}
        title="No favorites yet"
        body="Pin any item or workspace — use the star on an item card or the Browse list — and it shows up here and in the left-nav Pinned section."
        primaryAction={{ label: 'Browse items to pin', href: '/browse', appearance: 'secondary' }}
      />
    );
  }
  return (
    <TileGrid minTileWidth={240}>
      {items.map((p) => {
        const visual = itemVisual(p.type);
        return (
          <ItemTile
            key={p.id}
            type={p.type ?? 'page'}
            title={p.label}
            subtitle={p.type ? visual.label : undefined}
            pinTarget={p}
            onClick={() => router.push(p.href)}
          />
        );
      })}
    </TileGrid>
  );
}
