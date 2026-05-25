'use client';

import { useState } from 'react';
import { PageShell } from '@/lib/components/page-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Input,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import Link from 'next/link';

/**
 * API marketplace — the discovery surface every data product, ML
 * endpoint, GraphQL API, and user data function rolls up into via
 * APIM. Mirrors the CSA reference architecture's API-first principle:
 * every produced asset is fronted by APIM, listed here, subscribable
 * with quotas + SLA, governed by Purview.
 */

const PRODUCTS = [
  { name: 'Customer 360',          domain: 'Finance',     owner: 'alice@contoso',
    apis: ['Orders v2.1', 'Customers v1.4', 'Churn v0.9', 'LoyaltyTier v1.0'],
    sla: '99.9% · P95 < 200 ms', subscribers: 12, endorsement: 'Certified', status: 'GA' },
  { name: 'Telemetry stream',      domain: 'Operations',  owner: 'eve@contoso',
    apis: ['Telemetry GraphQL', 'Anomalies v1.0', 'KQL Passthrough'],
    sla: '99.95% streaming', subscribers: 38, endorsement: 'Certified', status: 'GA' },
  { name: 'Supply forecasting',    domain: 'Supply Chain',owner: 'carl@contoso',
    apis: ['Forecast v0.8 (preview)', 'Inventory v1.0'],
    sla: 'best-effort', subscribers: 4, endorsement: 'Promoted', status: 'Preview' },
  { name: 'Workforce insights',    domain: 'HR',          owner: 'hr-data@contoso',
    apis: ['Headcount v2.0', 'Attrition v1.1'],
    sla: '99.5%', subscribers: 6, endorsement: 'Promoted', status: 'GA' },
];

const useStyles = makeStyles({
  bar: { display: 'flex', gap: 12, marginBottom: 12 },
  card: {
    padding: 18, border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 10, backgroundColor: tokens.colorNeutralBackground1,
    transition: 'border-color 0.15s, box-shadow 0.15s',
    ':hover': { borderColor: tokens.colorBrandStroke1, boxShadow: tokens.shadow8 },
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 },
  apiChip: {
    display: 'inline-block', fontSize: 11, padding: '2px 8px', borderRadius: 999,
    backgroundColor: tokens.colorNeutralBackground2, marginRight: 4, marginTop: 4,
  },
  diag: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
    marginBottom: 16, padding: 16, borderRadius: 10,
    backgroundColor: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  diagCard: { padding: 8 },
});

export default function ApiMarketplacePage() {
  const s = useStyles();
  const [tab, setTab] = useState<'products' | 'apis' | 'subscriptions'>('products');
  const [q, setQ] = useState('');
  const filtered = PRODUCTS.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.domain.toLowerCase().includes(q.toLowerCase()));

  return (
    <PageShell
      title="API marketplace"
      subtitle="The discovery surface for every data product, ML endpoint, GraphQL API, and user data function — all fronted through Azure API Management per the CSA API-first methodology."
    >
      <div className={s.diag}>
        <div className={s.diagCard}>
          <Caption1>API-first runtime</Caption1>
          <Subtitle2>Azure API Management</Subtitle2>
          <Caption1>StandardV2 · 2 units · csa-loom-apim</Caption1>
        </div>
        <div className={s.diagCard}>
          <Caption1>What gets fronted</Caption1>
          <Subtitle2>Everything callable</Subtitle2>
          <Caption1>User data functions · ML endpoints · GraphQL APIs · Synapse SQL passthrough · Loom catalog API</Caption1>
        </div>
        <div className={s.diagCard}>
          <Caption1>Why API-first</Caption1>
          <Subtitle2>Data mesh enablement</Subtitle2>
          <Caption1>Domain teams publish data products; consumers subscribe; APIM enforces auth + quota + SLA + observability.</Caption1>
        </div>
      </div>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as typeof tab)}>
        <Tab value="products">Data products ({PRODUCTS.length})</Tab>
        <Tab value="apis">All APIs (16)</Tab>
        <Tab value="subscriptions">Subscriptions (60)</Tab>
      </TabList>
      <div style={{ marginTop: 12 }}>
        <div className={s.bar}>
          <Input contentBefore={<Search20Regular />} placeholder="Search the marketplace" value={q} onChange={(_, d) => setQ(d.value)} style={{ flex: 1 }} />
          <Link href="/items/data-product/new"><Button appearance="primary">+ Publish data product</Button></Link>
          <Link href="/items/apim-api/new"><Button appearance="secondary">+ New APIM API</Button></Link>
        </div>
        {tab === 'products' && (
          <div className={s.grid}>
            {filtered.map((p) => (
              <div key={p.name} className={s.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Subtitle2>{p.name}</Subtitle2>
                  <Badge appearance="filled" color={p.status === 'GA' ? 'success' : 'warning'}>{p.status}</Badge>
                </div>
                <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{p.domain} · {p.owner}</Caption1>
                <Body1 style={{ marginTop: 8 }}>{p.sla}</Body1>
                <div style={{ marginTop: 8 }}>
                  {p.apis.map((a) => <span key={a} className={s.apiChip}>{a}</span>)}
                </div>
                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Caption1>{p.subscribers} subscribers</Caption1>
                  <Badge appearance="outline" color={p.endorsement === 'Certified' ? 'success' : 'brand'}>{p.endorsement}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
        {tab === 'apis' && (
          <Table aria-label="APIs">
            <TableHeader><TableRow>
              <TableHeaderCell>API</TableHeaderCell><TableHeaderCell>Version</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Backend</TableHeaderCell>
              <TableHeaderCell>P95</TableHeaderCell><TableHeaderCell>Errors (24h)</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {[
                ['Orders',         '2.1', 'REST + OpenAPI', 'silver_revenue (Lakehouse)', '140 ms', '0.42%'],
                ['Customers',      '1.4', 'REST',           'fin-warehouse (Synapse)',    '92 ms',  '0.08%'],
                ['Churn',          '0.9', 'REST',           'churn-model (Azure ML)',     '210 ms', '0.18%'],
                ['Telemetry',      '1.0', 'GraphQL',        'KQL Eventhouse',             '88 ms',  '0.02%'],
                ['Forecast',       '0.8', 'REST',           'forecast-model (Databricks)','520 ms', '1.1%'],
              ].map((r) => <TableRow key={r[0] + r[1]}>{r.map((c, i) => <TableCell key={i}>{c}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        )}
        {tab === 'subscriptions' && (
          <Body1>60 active subscriptions across 4 internal teams and 3 partner tenants. Per-subscription quotas, JWT, and per-API rate limits enforced at the APIM gateway.</Body1>
        )}
      </div>
    </PageShell>
  );
}
