'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import { Body1, Caption1, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  card: { padding: 14, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, backgroundColor: tokens.colorNeutralBackground1 },
  v: { fontSize: 24, fontWeight: 700, color: tokens.colorBrandForeground1, marginTop: 6 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 16 },
});

export default function InsightsPage() {
  const s = useStyles();
  const cards = [
    { t: 'Items with owner',       v: '88%',   sub: '12% missing — 64 items' },
    { t: 'Items with description', v: '54%',   sub: '46% empty — drive curation' },
    { t: 'Endorsement coverage',   v: '23%',   sub: '124 items endorsed' },
    { t: 'Glossary linkage',       v: '41%',   sub: '218 items linked to business terms' },
    { t: 'PII items unlabeled',    v: '17',    sub: 'down from 42 last week' },
    { t: 'Sources scanned 30 d',   v: '38/38', sub: 'all sources current' },
  ];
  return (
    <GovernanceShell sectionTitle="Governance insights">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Tenant-wide compliance and curation metrics, refreshed every hour. Use these scores in your CSA scorecard reviews.
      </Body1>
      <div className={s.grid}>
        {cards.map((c) => (
          <div key={c.t} className={s.card}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c.t}</Caption1>
            <div className={s.v}>{c.v}</div>
            <Caption1>{c.sub}</Caption1>
          </div>
        ))}
      </div>
    </GovernanceShell>
  );
}
