'use client';

/**
 * /workloads — top-level Workloads page. Lists the per-tenant workloads
 * catalog from /api/workloads-catalog. Workloads bundle related item
 * types (e.g. Data Engineering = Synapse + ADF + Spark) and define
 * what a workspace can contain.
 */

import { useEffect, useState } from 'react';
import { Spinner, makeStyles, tokens, Badge, Input } from '@fluentui/react-components';
import { PageShell } from '@/lib/components/page-shell';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface Workload {
  id: string; name: string; description?: string;
  category?: string; included?: boolean;
  featureSlugs?: string[];
}

const useStyles = makeStyles({
  toolbar: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
    gap: 14,
  },
  card: {
    padding: 16, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  name: { fontSize: 15, fontWeight: 600, flex: 1 },
  desc: { fontSize: 13, color: tokens.colorNeutralForeground2, lineHeight: 1.45 },
  features: { display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 },
  pill: {
    fontSize: 11, padding: '2px 8px', borderRadius: 999,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
  },
  empty: {
    padding: 24, borderRadius: 10,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    color: tokens.colorNeutralForeground3,
    fontSize: 13, textAlign: 'center',
  },
});

export default function WorkloadsPage() {
  const s = useStyles();
  const [items, setItems] = useState<Workload[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/workloads-catalog').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setItems([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setItems(Array.isArray(d?.workloads) ? d.workloads : []);
    }).catch(() => setItems([]));
  }, []);

  const filter = q.toLowerCase().trim();
  const visible = (items ?? []).filter(w =>
    !filter || w.name.toLowerCase().includes(filter) ||
    (w.description ?? '').toLowerCase().includes(filter) ||
    (w.category ?? '').toLowerCase().includes(filter));

  return (
    <PageShell title="Workloads"
      subtitle="Each workload groups item types that solve a problem together. Pick what you need; everything else stays out of the way.">
      {unauth && <SignInRequired subject="workloads" />}
      <div className={s.toolbar}>
        <Input placeholder="Filter workloads…" value={q} onChange={(_, d) => setQ(d.value)} style={{ flex: 1, maxWidth: 360 }} />
      </div>
      {items === null && <Spinner label="Loading workloads…" />}
      {items !== null && items.length === 0 && (
        <div className={s.empty}>
          No workloads in this tenant yet. POST <code>/api/admin/bootstrap-catalogs</code>
          once per environment to seed GLOBAL; first <code>/api/workloads-catalog</code> GET
          copies into your tenant automatically.
        </div>
      )}
      {items !== null && items.length > 0 && (
        <div className={s.grid}>
          {visible.map(w => (
            <div key={w.id} className={s.card}>
              <div className={s.cardHeader}>
                <div className={s.name}>{w.name}</div>
                <Badge appearance={w.included ? 'filled' : 'outline'}
                       color={w.category === 'CSA' ? 'brand' : 'informative'}>
                  {w.category ?? 'Org'}
                </Badge>
              </div>
              {w.description && <div className={s.desc}>{w.description}</div>}
              {w.featureSlugs && w.featureSlugs.length > 0 && (
                <div className={s.features}>
                  {w.featureSlugs.slice(0, 8).map(f => <span key={f} className={s.pill}>{f}</span>)}
                  {w.featureSlugs.length > 8 && (
                    <span className={s.pill}>+{w.featureSlugs.length - 8} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </PageShell>
  );
}
