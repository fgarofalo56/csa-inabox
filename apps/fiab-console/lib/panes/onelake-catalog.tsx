'use client';

/**
 * OneLakeCatalogPane — Explore + Govern tabs, domain selector,
 * item list, lineage + monitor + permissions sub-tabs on item details.
 * Mirrors the OneLake catalog described in the inventory §2.2.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input,
  Tab, TabList, Dropdown, Option,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular, Building20Regular, Database20Regular } from '@fluentui/react-icons';

const DOMAINS = ['(All)', 'Finance', 'Operations', 'Sales', 'Engineering'];
const ITEMS = [
  { name: 'fact_sales', type: 'Lakehouse table', owner: 'alice@contoso', refreshed: '2 hr ago', location: 'fin-prod', endorsement: 'Certified', sensitivity: 'Confidential' },
  { name: 'CustomerSemantic', type: 'Semantic model', owner: 'bob@contoso', refreshed: '15 min ago', location: 'sales-prod', endorsement: 'Promoted', sensitivity: 'General' },
  { name: 'SecurityEvents', type: 'KQL database', owner: 'eve@contoso', refreshed: 'Live', location: 'sec-prod', endorsement: '—', sensitivity: 'Highly Confidential' },
  { name: 'orders-mirror', type: 'Mirrored database', owner: 'alice@contoso', refreshed: '30 sec ago', location: 'fin-prod', endorsement: '—', sensitivity: 'Confidential' },
  { name: 'ml-churn-model', type: 'ML model', owner: 'carl@contoso', refreshed: '4 hr ago', location: 'ds-prod', endorsement: 'Promoted', sensitivity: 'General' },
];

const useStyles = makeStyles({
  bar: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: 12 },
  layout: { display: 'grid', gridTemplateColumns: '220px 1fr', gap: 16, minHeight: '50vh' },
  side: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4, padding: 12, overflow: 'auto',
  },
  main: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: 4, padding: 12,
  },
  rowHover: { ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' } },
  govCards: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
});

export function OneLakeCatalogPane() {
  const s = useStyles();
  const [tab, setTab] = useState('explore');
  const [domain, setDomain] = useState('(All)');
  const [q, setQ] = useState('');
  const filtered = ITEMS.filter((i) => !q || i.name.toLowerCase().includes(q.toLowerCase()) || i.type.toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
        <Tab value="explore">Explore</Tab>
        <Tab value="govern">Govern</Tab>
      </TabList>
      <div style={{ marginTop: 12 }}>
        {tab === 'explore' && (
          <div>
            <div className={s.bar}>
              <Building20Regular />
              <Dropdown value={domain} selectedOptions={[domain]} onOptionSelect={(_, d) => setDomain(d.optionValue ?? domain)}>
                {DOMAINS.map((d) => <Option key={d} value={d}>{d}</Option>)}
              </Dropdown>
              <Input contentBefore={<Search20Regular />} placeholder="Search items" value={q} onChange={(_, d) => setQ(d.value)} style={{ flex: 1 }} />
              <Button appearance="subtle">Filters</Button>
            </div>
            <div className={s.layout}>
              <aside className={s.side}>
                <Subtitle2>Workspaces</Subtitle2>
                <Tree aria-label="Workspaces tree" defaultOpenItems={['fin', 'sales']}>
                  {['fin-prod', 'sales-prod', 'sec-prod', 'ds-prod', 'mkt-dev'].map((w) =>
                    <TreeItem key={w} itemType="branch" value={w}>
                      <TreeItemLayout iconBefore={<Database20Regular />}>{w}</TreeItemLayout>
                    </TreeItem>)}
                </Tree>
              </aside>
              <div className={s.main}>
                <Table aria-label="Catalog items">
                  <TableHeader>
                    <TableRow>
                      <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
                      <TableHeaderCell>Owner</TableHeaderCell><TableHeaderCell>Refreshed</TableHeaderCell>
                      <TableHeaderCell>Location</TableHeaderCell><TableHeaderCell>Endorsement</TableHeaderCell>
                      <TableHeaderCell>Sensitivity</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((i) => (
                      <TableRow key={i.name} className={s.rowHover}>
                        <TableCell>{i.name}</TableCell><TableCell>{i.type}</TableCell>
                        <TableCell>{i.owner}</TableCell><TableCell>{i.refreshed}</TableCell>
                        <TableCell>{i.location}</TableCell>
                        <TableCell>{i.endorsement !== '—' && <Badge appearance="outline" color={i.endorsement === 'Certified' ? 'success' : 'brand'}>{i.endorsement}</Badge>}</TableCell>
                        <TableCell><Badge appearance="outline" color={i.sensitivity === 'Highly Confidential' ? 'danger' : 'informative'}>{i.sensitivity}</Badge></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: 8 }}>{filtered.length} items</Caption1>
              </div>
            </div>
          </div>
        )}
        {tab === 'govern' && (
          <div>
            <Subtitle2>Insights — tenant-wide</Subtitle2>
            <div className={s.govCards} style={{ marginTop: 8 }}>
              {[
                { t: 'Sensitivity coverage', v: '78%', s: '417 of 534 items labeled' },
                { t: 'Endorsed items', v: '124', s: '32 Certified · 92 Promoted' },
                { t: 'DLP scanned', v: '94%', s: '2 violations in last 7 days' },
                { t: 'Inactive items', v: '67', s: 'no activity in last 30 days' },
              ].map((c) => (
                <div key={c.t} className={s.card}>
                  <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c.t}</Caption1>
                  <div style={{ fontSize: 24, fontWeight: 600 }}>{c.v}</div>
                  <Caption1>{c.s}</Caption1>
                </div>
              ))}
            </div>
            <Subtitle2 style={{ marginTop: 16 }}>Recommended actions</Subtitle2>
            <Body1>Apply default sensitivity to 117 unlabeled items · Review 2 DLP violations · Archive 67 inactive items</Body1>
          </div>
        )}
      </div>
    </div>
  );
}
