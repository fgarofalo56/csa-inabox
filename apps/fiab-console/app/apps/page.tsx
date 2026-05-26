'use client';

/**
 * /apps — top-level Apps page. Lists every curated CSA app from
 * /api/apps-catalog (Cosmos apps-catalog container, partitioned by
 * tenantId = session.claims.oid). Each card links to /apps/[id].
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Spinner, makeStyles, tokens, Input } from '@fluentui/react-components';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface AppDoc { id: string; name: string; description?: string; category?: string; publisher?: string; }

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
    gap: 14,
  },
  card: {
    padding: 16, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    ':hover': {
      borderColor: tokens.colorBrandStroke1,
      boxShadow: tokens.shadow8,
    },
  },
  cat: {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em',
    color: tokens.colorBrandForeground1, fontWeight: 700,
  },
  name: { fontSize: 15, fontWeight: 600, marginTop: 4, marginBottom: 6 },
  desc: { fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.45 },
  empty: {
    padding: 24, borderRadius: 10,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: 13, textAlign: 'center',
  },
});

export default function AppsPage() {
  const s = useStyles();
  const [apps, setApps] = useState<AppDoc[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/apps-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setApps([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setApps(Array.isArray(d?.apps) ? d.apps : []);
    }).catch(() => setApps([]));
  }, []);

  const filter = q.toLowerCase().trim();
  const visible = (apps ?? []).filter(a =>
    !filter || a.name.toLowerCase().includes(filter) ||
    (a.description ?? '').toLowerCase().includes(filter) ||
    (a.category ?? '').toLowerCase().includes(filter));

  return (
    <PageShell title="Apps" subtitle="Curated CSA solutions that bundle items, dashboards, and pipelines into one click.">
      {unauth && <SignInRequired subject="the apps catalog" />}
      <div className={s.toolbar}>
        <Input placeholder="Filter apps…" value={q} onChange={(_, d) => setQ(d.value)} style={{ flex: 1, maxWidth: 360 }} />
      </div>
      {apps === null && <Spinner label="Loading apps…" />}
      {apps !== null && apps.length === 0 && (
        <div className={s.empty}>
          No apps in this tenant yet. Run <code>scripts/csa-loom/seed-catalogs.sh</code> to seed
          the 10 curated CSA apps; first sign-in also triggers a copy from the GLOBAL seed.
        </div>
      )}
      {apps !== null && apps.length > 0 && (
        <div className={s.grid}>
          {visible.map(a => (
            <Link key={a.id} href={`/apps/${a.id}`} className={s.card}>
              <div className={s.cat}>{a.category ?? 'App'}</div>
              <div className={s.name}>{a.name}</div>
              {a.description && <div className={s.desc}>{a.description}</div>}
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
