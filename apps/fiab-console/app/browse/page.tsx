'use client';

import { PageShell } from '@/lib/components/page-shell';
import { RecentItems } from '@/lib/components/recent-items';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { makeStyles, tokens, Spinner } from '@fluentui/react-components';

interface Pin { id: string; label: string; href: string; type?: string; }

const useStyles = makeStyles({
  sectionTitle: { fontSize: 18, fontWeight: 600, marginTop: 28, marginBottom: 14 },
  pinGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: 14,
  },
  pin: {
    padding: 14, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    display: 'block',
    ':hover': { borderColor: tokens.colorBrandStroke1 },
  },
  pinLabel: { fontSize: 14, fontWeight: 600, marginBottom: 4 },
  pinType: { fontSize: 11, color: tokens.colorNeutralForeground3, textTransform: 'uppercase' },
  empty: {
    padding: 20, borderRadius: 10,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: 13, textAlign: 'center', lineHeight: 1.6,
  },
});

export default function BrowsePage() {
  const styles = useStyles();
  const [pins, setPins] = useState<Pin[] | null>(null);
  useEffect(() => {
    fetch('/api/user-prefs?key=pinnedItems').then(r => r.json()).then(d => {
      setPins(Array.isArray(d?.value) ? d.value : []);
    }).catch(() => setPins([]));
  }, []);
  return (
    <PageShell
      title="Browse"
      subtitle="Items pinned to your sidebar plus everything you've recently opened or edited."
    >
      <div className={styles.sectionTitle}>Pinned</div>
      {pins === null && <Spinner size="tiny" label="Loading pins…" />}
      {pins !== null && pins.length === 0 && (
        <div className={styles.empty}>
          Nothing pinned yet. Pin a workspace or item to make it stick here and in the left sidebar.
        </div>
      )}
      {pins !== null && pins.length > 0 && (
        <div className={styles.pinGrid}>
          {pins.map(p => (
            <Link key={p.id} href={p.href} className={styles.pin}>
              <div className={styles.pinLabel}>{p.label}</div>
              {p.type && <div className={styles.pinType}>{p.type}</div>}
            </Link>
          ))}
        </div>
      )}
      <div className={styles.sectionTitle}>Recent</div>
      <RecentItems />
    </PageShell>
  );
}
