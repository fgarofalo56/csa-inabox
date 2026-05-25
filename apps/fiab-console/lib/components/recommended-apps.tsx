'use client';

/**
 * RecommendedApps — renders the curated CSA apps catalog from
 * /api/apps-catalog. Same source as the top-bar AppLauncher; this
 * is the home-page surface so users discover what's available
 * without having to open the launcher.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { makeStyles, tokens, Spinner, Body1 } from '@fluentui/react-components';

interface AppDoc {
  id: string; name: string; description?: string;
  category?: string; publisher?: string;
}

const useStyles = makeStyles({
  row: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: 16,
  },
  card: {
    padding: 20, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    transition: 'border-color 0.15s, transform 0.15s, box-shadow 0.15s',
    display: 'flex', flexDirection: 'column', gap: 4,
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      transform: 'translateY(-2px)',
      boxShadow: tokens.shadow8,
    },
  },
  badge: {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorBrandForeground1, fontWeight: 700,
    marginBottom: 6,
  },
  name: { fontSize: 15, fontWeight: 600, marginBottom: 8, lineHeight: 1.3 },
  desc: { fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.5 },
  empty: {
    padding: 20, borderRadius: 10,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: 13, textAlign: 'center', lineHeight: 1.5,
  },
});

export function RecommendedApps() {
  const styles = useStyles();
  const [apps, setApps] = useState<AppDoc[] | null>(null);

  useEffect(() => {
    fetch('/api/apps-catalog').then(r => r.json()).then(d => {
      setApps(Array.isArray(d?.apps) ? d.apps : []);
    }).catch(() => setApps([]));
  }, []);

  if (apps === null) return <Spinner size="tiny" label="Loading apps…" />;
  if (apps.length === 0) {
    return (
      <div className={styles.empty}>
        Curated apps haven't been seeded into this tenant yet. Run
        <code style={{ padding: '0 6px' }}>scripts/csa-loom/seed-catalogs.sh</code>
        to populate.
      </div>
    );
  }
  return (
    <div className={styles.row}>
      {apps.slice(0, 8).map(a => (
        <Link key={a.id} href={`/apps/${a.id}`} className={styles.card}>
          <div className={styles.badge}>{a.category ?? 'App'}</div>
          <div className={styles.name}>{a.name}</div>
          {a.description && <div className={styles.desc}>{a.description}</div>}
        </Link>
      ))}
    </div>
  );
}
