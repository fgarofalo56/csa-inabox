'use client';

/**
 * RecentItems — pulls /api/items/recent (audit-log-backed) for the
 * current user and renders a row of cards linking back to the item.
 * Real data; empty state is honest when the user hasn't opened
 * anything yet.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Body1, Caption1, makeStyles, tokens, Spinner } from '@fluentui/react-components';

interface Recent { id: string; type: string; displayName?: string; workspaceId?: string; lastTouchedAt: string; }

const useStyles = makeStyles({
  row: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: 12,
  },
  card: {
    padding: 14, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    transition: 'border-color 0.15s, transform 0.15s',
    ':hover': { borderColor: tokens.colorBrandStroke1, transform: 'translateY(-2px)' },
  },
  type: {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600,
  },
  name: { fontSize: 14, fontWeight: 600, marginTop: 4, marginBottom: 4 },
  empty: {
    padding: 14, borderRadius: 10,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: 13, textAlign: 'center',
  },
});

export function RecentItems() {
  const styles = useStyles();
  const [items, setItems] = useState<Recent[] | null>(null);

  useEffect(() => {
    fetch('/api/items/recent?n=8').then(r => r.json()).then(d => {
      setItems(Array.isArray(d?.items) ? d.items : []);
    }).catch(() => setItems([]));
  }, []);

  if (items === null) return <Spinner size="tiny" label="Loading recent…" />;
  if (items.length === 0) {
    return (
      <div className={styles.empty}>
        No recent items yet. Open or edit an item to see it here.
      </div>
    );
  }
  return (
    <div className={styles.row}>
      {items.map(it => (
        <Link key={`${it.type}/${it.id}`} href={`/items/${it.type}/${it.id}`} className={styles.card}>
          <div className={styles.type}>{it.type.replace(/-/g, ' ')}</div>
          <div className={styles.name}>{it.displayName ?? it.id.slice(0, 12)}</div>
          <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
            {new Date(it.lastTouchedAt).toLocaleString()}
          </Caption1>
        </Link>
      ))}
    </div>
  );
}
