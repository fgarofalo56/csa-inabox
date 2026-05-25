'use client';

/**
 * ItemsByTypePane — generic top-level surface that lists every item of
 * one or more types owned by the caller's tenant. Used by /activator,
 * /realtime-hub, /semantic-model, /onelake, /api-marketplace, etc.
 *
 * Real BFF (/api/items/by-type) — no hardcoded arrays. Empty state is
 * honest: prompts the user to create the first item via +New.
 */

import { useEffect, useState, useMemo } from 'react';
import Link from 'next/link';
import {
  Spinner, Input, Badge, makeStyles, tokens,
} from '@fluentui/react-components';
import { Add20Regular, Search20Regular } from '@fluentui/react-icons';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { findItemType } from '@/lib/catalog/fabric-item-types';

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
  toolbar: { display: 'flex', gap: 16, alignItems: 'center', marginBottom: 20, flexWrap: 'wrap' },
  search: { flex: 1, maxWidth: 380 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 16,
  },
  card: {
    padding: 18, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    display: 'flex', flexDirection: 'column', gap: 6,
    transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
    },
  },
  type: {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600, marginBottom: 4,
  },
  name: { fontSize: 15, fontWeight: 600, lineHeight: 1.3, marginBottom: 4 },
  desc: { fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.45 },
  meta: { fontSize: 11, color: tokens.colorNeutralForeground3, marginTop: 8 },
  empty: {
    padding: 32, borderRadius: 12,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    fontSize: 14, textAlign: 'center', lineHeight: 1.6,
  },
});

export function ItemsByTypePane({ types, emptyHint }: Props) {
  const styles = useStyles();
  const [items, setItems] = useState<OwnedItem[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const qs = types.map(t => `type=${encodeURIComponent(t)}`).join('&');
    fetch(`/api/items/by-type?${qs}`).then(r => r.json()).then(d => {
      setItems(Array.isArray(d?.items) ? d.items : []);
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
      <div className={styles.toolbar}>
        <Input className={styles.search}
          contentBefore={<Search20Regular />}
          placeholder="Filter items by name or description…"
          value={q} onChange={(_, d) => setQ(d.value)} />
        <NewItemDialog />
      </div>
      {items === null && <Spinner label="Loading items…" />}
      {items !== null && items.length === 0 && (
        <div className={styles.empty}>
          {emptyHint || 'No items of these types yet.'}<br />
          Click <b>+ New item</b> above to create your first one — it persists to
          Cosmos and (when the underlying Azure resource is configured) executes against the real service.
        </div>
      )}
      {items !== null && items.length > 0 && (
        <div className={styles.grid}>
          {visible.map(it => {
            const meta = findItemType(it.itemType);
            return (
              <Link key={`${it.itemType}-${it.id}`}
                href={`/items/${it.itemType}/${it.id}`}
                className={styles.card}>
                <div className={styles.type}>
                  {meta?.displayName ?? it.itemType.replace(/-/g, ' ')}
                </div>
                <div className={styles.name}>{it.displayName}</div>
                {it.description && <div className={styles.desc}>{it.description}</div>}
                <div className={styles.meta}>
                  Updated {new Date(it.updatedAt || it.createdAt).toLocaleDateString()}
                  {meta?.category && <> · <Badge appearance="outline" size="small">{meta.category}</Badge></>}
                </div>
              </Link>
            );
          })}
          {visible.length === 0 && filter && (
            <div className={styles.empty}>No items match "{q}".</div>
          )}
        </div>
      )}
    </>
  );
}
