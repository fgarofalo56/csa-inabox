'use client';

import { PageShell } from '@/lib/components/page-shell';
import { RecentItems } from '@/lib/components/recent-items';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { makeStyles, tokens, Spinner, Input, Badge } from '@fluentui/react-components';
import { Search20Regular, Open16Regular } from '@fluentui/react-icons';

interface Pin { id: string; label: string; href: string; type?: string; }
interface WorkspaceLite { id: string; name: string; tenantId?: string; }

const useStyles = makeStyles({
  toolbar: {
    display: 'flex', alignItems: 'center', gap: 12,
    marginTop: 16, marginBottom: 8, flexWrap: 'wrap',
  },
  search: { flex: 1, maxWidth: 380 },
  sectionTitle: { fontSize: 18, fontWeight: 600, marginTop: 28, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 },
  pinGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: 14,
  },
  pin: {
    padding: 14, borderRadius: 10,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    display: 'flex', flexDirection: 'column', gap: 6,
    transition: 'border-color 0.15s, transform 0.15s',
    ':hover': { borderColor: tokens.colorBrandStroke1, transform: 'translateY(-2px)' },
  },
  pinLabel: { fontSize: 14, fontWeight: 600 },
  pinType: { fontSize: 11, color: tokens.colorNeutralForeground3, textTransform: 'uppercase', letterSpacing: '0.06em' },
  pinFooter: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.colorBrandForeground1, marginTop: 'auto' },
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
  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    fetch('/api/user-prefs?key=pinnedItems').then(r => r.json()).then(d => {
      setPins(Array.isArray(d?.value) ? d.value : []);
    }).catch(() => setPins([]));
    fetch('/api/workspaces').then(r => r.json()).then(d => {
      const list = Array.isArray(d) ? d : (d?.workspaces || []);
      setWorkspaces(list);
    }).catch(() => setWorkspaces([]));
  }, []);

  const filter = q.trim().toLowerCase();
  const visiblePins = useMemo(
    () => (pins ?? []).filter(p => !filter || p.label.toLowerCase().includes(filter) || (p.type ?? '').toLowerCase().includes(filter)),
    [pins, filter],
  );
  const visibleWorkspaces = useMemo(
    () => (workspaces ?? []).filter(w => !filter || w.name.toLowerCase().includes(filter)),
    [workspaces, filter],
  );

  // Group pins by type so users find them when the list grows past a few.
  const groupedPins = useMemo(() => {
    const groups = new Map<string, Pin[]>();
    for (const p of visiblePins) {
      const key = (p.type || 'other').toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [visiblePins]);

  return (
    <PageShell
      title="Browse"
      subtitle="Pinned, recent, and every workspace your tenant owns — one filter scans across all of them."
    >
      <div className={styles.toolbar}>
        <Input
          className={styles.search}
          contentBefore={<Search20Regular />}
          placeholder="Filter pinned, recent, and workspaces…"
          value={q}
          onChange={(_, d) => setQ(d.value)}
        />
        {pins !== null && workspaces !== null && (
          <Badge appearance="outline">
            {(pins?.length ?? 0)} pinned · {(workspaces?.length ?? 0)} workspaces
          </Badge>
        )}
      </div>

      <div className={styles.sectionTitle}>Pinned</div>
      {pins === null && <Spinner size="tiny" label="Loading pins…" />}
      {pins !== null && pins.length === 0 && (
        <div className={styles.empty}>
          Nothing pinned yet. Open a workspace or item and click the pin icon to make it stick here
          and in the left sidebar.
        </div>
      )}
      {pins !== null && pins.length > 0 && visiblePins.length === 0 && (
        <div className={styles.empty}>No pinned items match &quot;{q}&quot;.</div>
      )}
      {groupedPins.length > 0 && groupedPins.map(([type, list]) => (
        <div key={type} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: tokens.colorNeutralForeground3, marginBottom: 6 }}>
            {type}
          </div>
          <div className={styles.pinGrid}>
            {list.map(p => (
              <Link key={p.id} href={p.href} className={styles.pin}>
                <div className={styles.pinLabel}>{p.label}</div>
                <div className={styles.pinFooter}>
                  <Open16Regular /> Open
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}

      <div className={styles.sectionTitle}>Recent</div>
      <RecentItems />

      <div className={styles.sectionTitle}>All workspaces</div>
      {workspaces === null && <Spinner size="tiny" label="Loading workspaces…" />}
      {workspaces !== null && workspaces.length === 0 && (
        <div className={styles.empty}>
          No workspaces in this tenant yet. Visit <Link href="/workspaces">/workspaces</Link> to create one.
        </div>
      )}
      {workspaces !== null && workspaces.length > 0 && visibleWorkspaces.length === 0 && filter && (
        <div className={styles.empty}>No workspaces match &quot;{q}&quot;.</div>
      )}
      {visibleWorkspaces.length > 0 && (
        <div className={styles.pinGrid}>
          {visibleWorkspaces.map(w => (
            <Link key={w.id} href={`/workspaces/${w.id}`} className={styles.pin}>
              <div className={styles.pinType}>workspace</div>
              <div className={styles.pinLabel}>{w.name}</div>
              <div className={styles.pinFooter}>
                <Open16Regular /> Open
              </div>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
