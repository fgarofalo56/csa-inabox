'use client';

/**
 * ItemsByTypePane — generic top-level surface that lists every item of
 * one or more types owned by the caller's tenant. Used by /activator,
 * /realtime-hub, /semantic-model, /onelake, /api-marketplace, etc.
 *
 * Real BFF (/api/items/by-type) — no hardcoded arrays. Empty state is
 * honest: prompts the user to create the first item via +New.
 *
 * Web 3.0: Loom design tokens only (no px/hex literals), the shared TileGrid +
 * ItemTile primitives for the card grid, and EmptyState for the empty / no-match
 * panes (never a bare styled <div>).
 */

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Spinner, Input, Badge, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular, Box24Regular, SearchInfo24Regular } from '@fluentui/react-icons';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { SignInRequired } from '@/lib/components/sign-in-required';
import { EmptyState } from '@/lib/components/empty-state';
import { TileGrid } from '@/lib/components/ui/tile-grid';
import { ItemTile } from '@/lib/components/ui/item-tile';
import { findItemType, type WorkloadCategory } from '@/lib/catalog/fabric-item-types';

interface OwnedItem {
  id: string; itemType: string; workspaceId: string;
  displayName: string; description?: string;
  createdBy: string; createdAt: string; updatedAt: string;
}

interface Props {
  types: string[];
  emptyHint?: string;
  defaultCategoryForNew?: string;
}

const useStyles = makeStyles({
  toolbar: {
    display: 'flex',
    gap: tokens.spacingHorizontalL,
    alignItems: 'center',
    marginBottom: tokens.spacingVerticalXL,
    flexWrap: 'wrap',
  },
  search: { flex: 1, maxWidth: '380px', minWidth: 0 },
  count: { color: tokens.colorNeutralForeground3 },
});

export function ItemsByTypePane({ types, emptyHint, defaultCategoryForNew }: Props) {
  const styles = useStyles();
  const router = useRouter();
  const [items, setItems] = useState<OwnedItem[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    // v3.4: switch from repeated ?type=A&type=B&... to a single
    // ?types=A,B,... param. Azure Front Door Premium DRS 2.1 (managed
    // rule 921180 "HTTP Parameter Pollution") was blocking the
    // 6-value variant on /onelake at the edge with 403, which also
    // poisoned subsequent requests on the page (logo, /api/me, etc.).
    // BFF accepts both forms — see app/api/items/by-type/route.ts.
    const qs = `types=${encodeURIComponent(types.join(','))}`;
    fetch(`/api/items/by-type?${qs}`).then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setItems(Array.isArray(d?.items) ? d.items : []);
    }).catch(() => setItems([]));
  }, [types.join(',')]);

  const filter = q.toLowerCase().trim();
  const visible = useMemo(() =>
    (items ?? []).filter(it =>
      !filter || it.displayName.toLowerCase().includes(filter) ||
      (it.description ?? '').toLowerCase().includes(filter)),
    [items, filter]);

  return (
    <>
      {unauth && <SignInRequired subject="items" />}
      <div className={styles.toolbar}>
        <Input className={styles.search}
          contentBefore={<Search20Regular />}
          placeholder="Filter items by name or description…"
          value={q} onChange={(_, d) => setQ(d.value)} />
        {items !== null && items.length > 0 && (
          <Caption1 className={styles.count}>
            {filter ? `${visible.length} of ${items.length} items` : `${items.length} item${items.length === 1 ? '' : 's'}`}
          </Caption1>
        )}
        <NewItemDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          defaultCategory={defaultCategoryForNew as WorkloadCategory | undefined}
        />
      </div>

      {items === null && <Spinner label="Loading items…" />}

      {items !== null && items.length === 0 && (
        <EmptyState
          icon={<Box24Regular />}
          title="No items yet"
          body={`${emptyHint || 'No items of these types yet.'} Create your first one with + New item — it persists to Cosmos and (when the underlying Azure resource is configured) executes against the real service.`}
          primaryAction={{ label: '+ New item', onClick: () => setNewOpen(true) }}
        />
      )}

      {items !== null && items.length > 0 && visible.length > 0 && (
        <TileGrid>
          {visible.map(it => {
            const meta = findItemType(it.itemType);
            return (
              <ItemTile
                key={`${it.itemType}-${it.id}`}
                type={it.itemType}
                title={it.displayName}
                subtitle={it.description || (meta?.displayName ?? it.itemType.replace(/-/g, ' '))}
                meta={`Updated ${new Date(it.updatedAt || it.createdAt).toLocaleDateString()}`}
                footer={meta?.category ? <Badge appearance="outline" size="small">{meta.category}</Badge> : undefined}
                onClick={() => router.push(`/items/${it.itemType}/${it.id}`)}
              />
            );
          })}
        </TileGrid>
      )}

      {items !== null && items.length > 0 && visible.length === 0 && filter && (
        <EmptyState
          icon={<SearchInfo24Regular />}
          title="No matching items"
          body={`Nothing matches “${q}”. Try a different name or description, or clear the filter.`}
          primaryAction={{ label: 'Clear filter', appearance: 'secondary', onClick: () => setQ('') }}
        />
      )}
    </>
  );
}
