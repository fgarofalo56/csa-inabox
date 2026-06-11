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
  Spinner, Input, Badge, Caption1, makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { NewItemDialog } from '@/lib/components/new-item-dialog';
import { SignInRequired } from '@/lib/components/sign-in-required';
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
  toolbar: { display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap' },
  search: { flex: 1, maxWidth: '380px' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: '16px',
  },
  card: {
    paddingTop: '18px', paddingRight: '18px', paddingBottom: '18px', paddingLeft: '18px',
    borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    display: 'flex', flexDirection: 'column',
    transition: 'border-color 0.15s, box-shadow 0.15s, transform 0.15s',
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      boxShadow: tokens.shadow8,
      transform: 'translateY(-2px)',
    },
  },
  type: {
    fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600, marginBottom: '4px',
  },
  name: { fontSize: '15px', fontWeight: 600, lineHeight: 1.3, marginBottom: '4px' },
  desc: { fontSize: '13px', color: tokens.colorNeutralForeground2, lineHeight: 1.45 },
  meta: { fontSize: '11px', color: tokens.colorNeutralForeground3, marginTop: '8px' },
  empty: {
    paddingTop: '32px', paddingRight: '32px', paddingBottom: '32px', paddingLeft: '32px',
    borderRadius: '12px',
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    fontSize: '14px', textAlign: 'center', lineHeight: 1.6,
  },
});

export function ItemsByTypePane({ types, emptyHint, defaultCategoryForNew }: Props) {
  const styles = useStyles();
  const [items, setItems] = useState<OwnedItem[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');

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
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {filter ? `${visible.length} of ${items.length} items` : `${items.length} item${items.length === 1 ? '' : 's'}`}
          </Caption1>
        )}
        <NewItemDialog defaultCategory={defaultCategoryForNew as WorkloadCategory | undefined} />
      </div>
      {items === null && <Spinner label="Loading items…" />}
      {items !== null && items.length === 0 && (
        <div className={styles.empty}>
          {emptyHint || 'No items of these types yet.'}<br />
          Click <b>+ New item</b> above to create your first one — it persists to
          Cosmos and (when the underlying Azure resource is configured) executes against the real service.
        </div>
      )}
      {items !== null && items.length > 0 && visible.length > 0 && (
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
        </div>
      )}
      {items !== null && items.length > 0 && visible.length === 0 && filter && (
        <div className={styles.empty}>No items match &ldquo;{q}&rdquo;.</div>
      )}
    </>
  );
}
