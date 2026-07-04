'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * ActivityFeedPane — real tenant activity rendered from /api/activity
 * (joins audit-log + comments + shares). Used by /governance + /monitor.
 *
 * Stats are computed client-side from the live feed — no hardcoded
 * numbers, no fake users. Empty state is honest.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { shorthands,
  Spinner, Badge, Button, Dropdown, Option, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  History20Regular, Comment20Regular, Share20Regular, ArrowSync20Regular,
} from '@fluentui/react-icons';
import { SignInRequired } from '@/lib/components/sign-in-required';

interface Entry {
  kind: 'audit' | 'comment' | 'share';
  at: string;
  who: string;
  summary: string;
  link: string;
}

const useStyles = makeStyles({
  stats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    gap: '16px',
    marginBottom: '24px',
  },
  stat: {
    paddingTop: '18px', paddingRight: '18px', paddingBottom: '18px', paddingLeft: '18px',
    borderRadius: '10px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    display: 'flex', flexDirection: 'column', gap: '6px',
  },
  statLabel: { fontSize: '12px', color: tokens.colorNeutralForeground3, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.06em' },
  statValue: { fontSize: '28px', fontWeight: 700, color: tokens.colorNeutralForeground1, lineHeight: 1.1 },
  statHint: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  sectionTitle: { fontSize: '18px', fontWeight: 600, marginBottom: '12px', marginTop: '8px' },
  list: { display: 'flex', flexDirection: 'column', gap: '10px' },
  row: {
    display: 'flex', alignItems: 'flex-start', gap: '12px',
    paddingTop: '14px', paddingRight: '14px', paddingBottom: '14px', paddingLeft: '14px',
    borderRadius: '8px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    textDecoration: 'none', color: tokens.colorNeutralForeground1,
    ':hover': { ...shorthands.borderColor(tokens.colorBrandStroke1) },
  },
  rowIcon: {
    width: '36px', height: '36px', borderRadius: '8px',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowSummary: { fontSize: '14px', lineHeight: 1.45, marginBottom: '4px' },
  rowMeta: { fontSize: '11px', color: tokens.colorNeutralForeground3 },
  empty: {
    paddingTop: '32px', paddingRight: '32px', paddingBottom: '32px', paddingLeft: '32px',
    borderRadius: '12px',
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    color: tokens.colorNeutralForeground2,
    fontSize: '14px', textAlign: 'center', lineHeight: 1.6,
  },
});

type RangeKey = '24h' | '7d' | '30d' | 'all';
const RANGE_MS: Record<RangeKey, number | null> = {
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  all: null,
};

export function ActivityFeedPane({ showStats = true }: { showStats?: boolean }) {
  const styles = useStyles();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [unauth, setUnauth] = useState(false);
  const [tick, setTick] = useState(0);
  const [range, setRange] = useState<RangeKey>('all');

  useEffect(() => {
    setEntries(null);
    clientFetch('/api/activity?n=50').then(r => {
      if (r.status === 401 || r.status === 403) { setUnauth(true); setEntries([]); return null; }
      return r.json();
    }).then(d => {
      if (d) setEntries(Array.isArray(d?.entries) ? d.entries : []);
    }).catch(() => setEntries([]));
  }, [tick]);

  const filtered = useMemo(() => {
    const e = entries ?? [];
    const ms = RANGE_MS[range];
    if (ms == null) return e;
    const cutoff = Date.now() - ms;
    return e.filter(x => new Date(x.at).getTime() >= cutoff);
  }, [entries, range]);

  const stats = useMemo(() => {
    const e = filtered;
    const last24h = e.filter(x => Date.now() - new Date(x.at).getTime() < 86_400_000).length;
    const uniqueActors = new Set(e.map(x => x.who?.toLowerCase()).filter(Boolean)).size;
    return [
      { label: 'Recent events', value: String(e.length), hint: 'Across audit, comments, shares' },
      { label: 'In last 24 h', value: String(last24h), hint: 'Touch frequency' },
      { label: 'Active users', value: String(uniqueActors), hint: 'Distinct UPNs in feed' },
    ];
  }, [filtered]);

  if (entries === null) return <Spinner label="Loading activity…" />;

  return (
    <>
      {unauth && <SignInRequired subject="activity" />}
      <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'center', marginBottom: tokens.spacingVerticalL }}>
        <Button
          appearance="primary"
          icon={<ArrowSync20Regular />}
          onClick={() => setTick(t => t + 1)}
        >
          Refresh
        </Button>
        <Dropdown
          aria-label="Time range"
          value={range === '24h' ? 'Last 24 hours' : range === '7d' ? 'Last 7 days' : range === '30d' ? 'Last 30 days' : 'All time'}
          selectedOptions={[range]}
          onOptionSelect={(_, d) => d.optionValue && setRange(d.optionValue as RangeKey)}
        >
          <Option value="24h">Last 24 hours</Option>
          <Option value="7d">Last 7 days</Option>
          <Option value="30d">Last 30 days</Option>
          <Option value="all">All time</Option>
        </Dropdown>
      </div>
      {showStats && (
        <div className={styles.stats}>
          {stats.map(s => (
            <div key={s.label} className={styles.stat}>
              <span className={styles.statLabel}>{s.label}</span>
              <span className={styles.statValue}>{s.value}</span>
              <span className={styles.statHint}>{s.hint}</span>
            </div>
          ))}
        </div>
      )}
      <div className={styles.sectionTitle}>Recent activity</div>
      {filtered.length === 0 ? (
        <div className={styles.empty}>
          No activity yet. As items are created, commented on, audited, or shared,
          they'll appear here in real time.
        </div>
      ) : (
        <div className={styles.list}>
          {filtered.map((e, i) => {
            const Icon = e.kind === 'comment' ? Comment20Regular
              : e.kind === 'share' ? Share20Regular
              : History20Regular;
            return (
              <Link key={i} href={e.link} className={styles.row}>
                <div className={styles.rowIcon}><Icon /></div>
                <div className={styles.rowBody}>
                  <div className={styles.rowSummary}>
                    <strong>{e.who}</strong> {e.summary}
                  </div>
                  <div className={styles.rowMeta}>
                    {new Date(e.at).toLocaleString()} · <Badge appearance="outline" size="small">{e.kind}</Badge>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
