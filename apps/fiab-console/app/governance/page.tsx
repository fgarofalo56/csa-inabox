'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button,
  makeStyles, tokens,
} from '@fluentui/react-components';

const STATS = [
  { t: 'Sensitivity coverage', v: '78%', s: '417 of 534 items labeled', tone: 'brand' },
  { t: 'Lineage scanned',       v: '94%', s: '5,180 lineage edges discovered', tone: 'success' },
  { t: 'DLP scanned',           v: '94%', s: '2 violations in last 7 days', tone: 'warning' },
  { t: 'Inactive items',        v: '67',  s: 'no activity in last 30 days', tone: 'subtle' },
  { t: 'Endorsed items',        v: '124', s: '32 Certified · 92 Promoted', tone: 'success' },
  { t: 'Sources registered',    v: '38',  s: 'across 6 source types', tone: 'subtle' },
];
const ACTIVITY = [
  { when: '5 min ago',  who: 'system',           what: 'Scan finished: ldn-gold-lakehouse', status: 'Success' },
  { when: '32 min ago', who: 'alice@contoso',    what: 'Applied Confidential label to fact_sales', status: 'Applied' },
  { when: '2 hr ago',   who: 'bob@contoso',      what: 'Promoted CustomerSemantic to Certified', status: 'Endorsed' },
  { when: '6 hr ago',   who: 'system',           what: 'DLP violation flagged: SecurityEvents.Email', status: 'Violation' },
  { when: '14 hr ago',  who: 'eve@contoso',      what: 'Registered Azure SQL DB: prod-sales', status: 'Registered' },
];
const ACTIONS = [
  'Apply default Confidential label to 117 unlabeled items in Finance domain',
  'Review 2 DLP violations from yesterday\'s scan of ldn-bronze-lakehouse',
  'Re-scan 12 sources whose schemas changed in the past 7 days',
  'Archive 67 inactive items (no reads or writes in 30 days)',
];

const useStyles = makeStyles({
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 24 },
  card: { padding: 14, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, backgroundColor: tokens.colorNeutralBackground1 },
  v: { fontSize: 28, fontWeight: 700, color: tokens.colorBrandForeground1, marginTop: 6 },
  twocol: { display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 },
  row: { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  rec: { padding: '8px 12px', backgroundColor: tokens.colorNeutralBackground2, borderRadius: 6, marginBottom: 8 },
});

export default function GovernanceOverviewPage() {
  const s = useStyles();
  return (
    <GovernanceShell sectionTitle="Governance overview">
      <div className={s.grid}>
        {STATS.map((c) => (
          <div key={c.t} className={s.card}>
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c.t}</Caption1>
            <div className={s.v}>{c.v}</div>
            <Caption1>{c.s}</Caption1>
          </div>
        ))}
      </div>
      <div className={s.twocol}>
        <div>
          <Subtitle2 style={{ marginBottom: 8 }}>Recent activity</Subtitle2>
          <div className={s.card}>
            {ACTIVITY.map((a, i) => (
              <div key={i} className={s.row}>
                <div>
                  <Body1>{a.what}</Body1>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{a.when} · {a.who}</Caption1>
                </div>
                <Badge appearance="outline"
                  color={a.status === 'Violation' ? 'danger' : a.status === 'Success' || a.status === 'Endorsed' ? 'success' : 'brand'}>
                  {a.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
        <div>
          <Subtitle2 style={{ marginBottom: 8 }}>Recommended actions</Subtitle2>
          {ACTIONS.map((a, i) => (
            <div key={i} className={s.rec}>{a}</div>
          ))}
          <Button appearance="primary" style={{ marginTop: 8 }} as="a" href="/governance/scans">Schedule a scan</Button>
        </div>
      </div>
    </GovernanceShell>
  );
}
