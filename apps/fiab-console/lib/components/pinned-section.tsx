'use client';

/**
 * PinnedSection — renders user's pinned items (workspaces, items, pages).
 * Reads /api/user-prefs?key=pinnedItems (Cosmos user-prefs container) on
 * mount; listens for `loom:pin-changed` to re-fetch after a pin/unpin
 * action elsewhere in the UI. Each pinned entry is a real link backed by
 * the same href the user navigates to normally.
 *
 * Pin/unpin lives on workspace + item context menus (later chunks call
 * window.dispatchEvent(new CustomEvent('loom:pin-toggle', { detail: {...} }))
 * which this component handles too — keeping pin state in one place).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { makeStyles, tokens, Button, Tooltip } from '@fluentui/react-components';
import { Pin16Regular, PinOff16Regular, Star16Filled } from '@fluentui/react-icons';

export interface PinnedItem {
  id: string;          // unique key (e.g. workspace id, item id, route path)
  label: string;
  href: string;
  type?: string;       // optional: 'workspace' | 'item' | 'page'
}

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column',
    paddingTop: 4, paddingBottom: 4,
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    marginTop: 4,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 16px 4px',
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorNeutralForeground3, fontWeight: 600,
  },
  item: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 16px', fontSize: 13,
    color: tokens.colorNeutralForeground1, textDecoration: 'none',
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover },
  },
  active: {
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontWeight: 600,
  },
  label: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  unpin: { minWidth: 20, height: 20, padding: 0, opacity: 0.6, ':hover': { opacity: 1 } },
  empty: {
    padding: '0 16px 8px',
    fontSize: 11, color: tokens.colorNeutralForeground3,
    fontStyle: 'italic',
  },
});

export function PinnedSection() {
  const styles = useStyles();
  const pathname = usePathname() || '/';
  const [items, setItems] = useState<PinnedItem[] | null>(null);

  const load = useCallback(() => {
    fetch('/api/user-prefs?key=pinnedItems').then(r => r.json()).then(d => {
      const arr = Array.isArray(d?.value) ? d.value : [];
      setItems(arr);
    }).catch(() => setItems([]));
  }, []);

  useEffect(() => { load(); }, [load]);

  // External pin/unpin requests.
  useEffect(() => {
    const onChanged = () => load();
    const onToggle = (e: Event) => {
      const detail = (e as CustomEvent).detail as PinnedItem | undefined;
      if (!detail?.id || !detail?.href || !detail?.label) return;
      setItems(prev => {
        const cur = prev ?? [];
        const exists = cur.some(p => p.id === detail.id);
        const next = exists
          ? cur.filter(p => p.id !== detail.id)
          : [...cur, { id: detail.id, label: detail.label, href: detail.href, type: detail.type }];
        fetch('/api/user-prefs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'pinnedItems', value: next }),
        }).catch(() => {});
        return next;
      });
    };
    window.addEventListener('loom:pin-changed', onChanged);
    window.addEventListener('loom:pin-toggle', onToggle);
    return () => {
      window.removeEventListener('loom:pin-changed', onChanged);
      window.removeEventListener('loom:pin-toggle', onToggle);
    };
  }, [load]);

  const unpin = (id: string) => {
    setItems(prev => {
      const next = (prev ?? []).filter(p => p.id !== id);
      fetch('/api/user-prefs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'pinnedItems', value: next }),
      }).catch(() => {});
      return next;
    });
  };

  if (items === null) return null; // no flash on initial load

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Star16Filled style={{ color: 'var(--loom-accent-gold)' }} />
        Pinned
      </div>
      {items.length === 0 ? (
        <div className={styles.empty}>Pin a workspace or item to see it here.</div>
      ) : (
        items.map(p => {
          const active = p.href === pathname;
          return (
            <div key={p.id} className={`${styles.item} ${active ? styles.active : ''}`}>
              <Link href={p.href} className={styles.label} title={p.label}
                    style={{ color: 'inherit', textDecoration: 'none' }}>
                {p.label}
              </Link>
              <Tooltip content="Unpin" relationship="label">
                <Button appearance="transparent" size="small" className={styles.unpin}
                  icon={<PinOff16Regular />} onClick={() => unpin(p.id)}
                  aria-label={`Unpin ${p.label}`} />
              </Tooltip>
            </div>
          );
        })
      )}
    </div>
  );
}

/** Helpers for callers that want to pin without writing the fetch. */
export function pinItem(item: PinnedItem) {
  window.dispatchEvent(new CustomEvent('loom:pin-toggle', { detail: item }));
}
