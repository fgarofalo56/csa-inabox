'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Input,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { useState } from 'react';

const BUILT_IN = [
  { name: 'Email Address',            kind: 'Regex',     hits: 4_120 },
  { name: 'Credit Card Number',       kind: 'Regex',     hits: 372 },
  { name: 'US Social Security Number',kind: 'Regex',     hits: 18 },
  { name: 'IBAN Code',                kind: 'Regex',     hits: 2_204 },
  { name: 'IP Address (v4)',          kind: 'Regex',     hits: 65_002 },
  { name: 'US Passport Number',       kind: 'Regex',     hits: 0 },
  { name: 'Date of Birth',            kind: 'Dictionary',hits: 1_482 },
  { name: 'Driver License (US)',      kind: 'Regex',     hits: 32 },
];
const CUSTOM = [
  { name: 'Employee ID (Contoso)',    kind: 'Regex',     hits: 8_402 },
  { name: 'Project Code',             kind: 'Dictionary',hits: 1_240 },
  { name: 'Customer Tier',            kind: 'Dictionary',hits: 6_018 },
];

const useStyles = makeStyles({
  bar: { display: 'flex', gap: 12, marginBottom: 12 },
});

export default function ClassificationsPage() {
  const s = useStyles();
  const [tab, setTab] = useState<'built' | 'custom' | 'rulesets'>('built');
  const data = tab === 'built' ? BUILT_IN : tab === 'custom' ? CUSTOM : [];
  return (
    <GovernanceShell sectionTitle="Classifications">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Sensitive-information types that scans look for. Loom ships Purview&apos;s 200+ built-ins and lets you author custom regex / dictionary classifiers + scan rule sets that bundle them.
      </Body1>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'built' | 'custom' | 'rulesets')}>
        <Tab value="built">Built-in ({BUILT_IN.length})</Tab>
        <Tab value="custom">Custom ({CUSTOM.length})</Tab>
        <Tab value="rulesets">Scan rule sets (4)</Tab>
      </TabList>
      <div className={s.bar} style={{ marginTop: 12 }}>
        <Input placeholder="Search classifiers" style={{ flex: 1 }} />
        <Button appearance="primary">+ New classifier</Button>
      </div>
      {tab !== 'rulesets' ? (
        <Table aria-label="Classifications">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Recent hits (30 d)</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.name}>
                <TableCell>{c.name}</TableCell>
                <TableCell><Badge appearance="outline">{c.kind}</Badge></TableCell>
                <TableCell>{c.hits.toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div>
          {['Default scan rule set (Microsoft)', 'Finance — strict', 'Engineering — broad', 'Security — paranoid'].map((r) => (
            <div key={r} style={{ padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6, marginBottom: 8 }}>
              <Subtitle2>{r}</Subtitle2>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Applied to 12 sources · 8 file types · 47 classifiers</Caption1>
            </div>
          ))}
        </div>
      )}
    </GovernanceShell>
  );
}
