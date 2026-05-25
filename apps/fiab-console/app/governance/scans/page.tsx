'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button, Input,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { useState } from 'react';

const SOURCES = [
  { name: 'ldn-gold-lakehouse',  type: 'OneLake Lakehouse',       runtime: 'Managed',           lastScan: '5 min ago',  status: 'Success' },
  { name: 'prod-sales',          type: 'Azure SQL DB',            runtime: 'Managed',           lastScan: '32 min ago', status: 'Success' },
  { name: 'sap-s4',              type: 'SAP S/4HANA',             runtime: 'Self-hosted IR',    lastScan: '2 hr ago',   status: 'Success' },
  { name: 'analytics-cluster',   type: 'Databricks Unity Catalog',runtime: 'Managed',           lastScan: '1 hr ago',   status: 'Success' },
  { name: 'archive-bucket',      type: 'Amazon S3',               runtime: 'VNet IR',           lastScan: '6 hr ago',   status: 'Failed' },
  { name: 'fileshare-onprem',    type: 'SMB / on-prem file share',runtime: 'Self-hosted IR',    lastScan: '14 hr ago',  status: 'Success' },
  { name: 'orders-mirror',       type: 'Mirrored DB (Snowflake)', runtime: 'Managed',           lastScan: 'Live',       status: 'Success' },
];
const RECENT_SCANS = [
  { source: 'ldn-gold-lakehouse',  ruleset: 'Default',          duration: '00:04:12', assets: 412, classified: 198, started: '5 min ago' },
  { source: 'prod-sales',          ruleset: 'Finance — strict', duration: '00:01:38', assets: 47,  classified: 47,  started: '32 min ago' },
  { source: 'analytics-cluster',   ruleset: 'Default',          duration: '00:08:01', assets: 1_204, classified: 612, started: '1 hr ago' },
  { source: 'archive-bucket',      ruleset: 'Engineering — broad', duration: '00:00:22', assets: 0, classified: 0, started: '6 hr ago' },
];

const useStyles = makeStyles({
  bar: { display: 'flex', gap: 12, marginBottom: 12 },
});

export default function ScansPage() {
  const s = useStyles();
  const [tab, setTab] = useState<'sources' | 'history'>('sources');
  return (
    <GovernanceShell sectionTitle="Scans & sources">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Register Azure-native, cross-cloud, and on-prem data sources, schedule recurring scans, and monitor scan history. Loom uses Purview managed integration runtime for cloud sources and self-hosted IR for on-prem.
      </Body1>
      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'sources' | 'history')}>
        <Tab value="sources">Registered sources ({SOURCES.length})</Tab>
        <Tab value="history">Recent scans</Tab>
      </TabList>
      <div className={s.bar} style={{ marginTop: 12 }}>
        <Input placeholder="Search sources" style={{ flex: 1 }} />
        <Button appearance="primary">+ Register source</Button>
        <Button appearance="secondary">+ New scan</Button>
      </div>
      {tab === 'sources' ? (
        <Table aria-label="Sources">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Integration runtime</TableHeaderCell><TableHeaderCell>Last scan</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SOURCES.map((s) => (
              <TableRow key={s.name}>
                <TableCell>{s.name}</TableCell><TableCell>{s.type}</TableCell>
                <TableCell><Caption1>{s.runtime}</Caption1></TableCell><TableCell>{s.lastScan}</TableCell>
                <TableCell><Badge appearance="filled" color={s.status === 'Failed' ? 'danger' : 'success'}>{s.status}</Badge></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Table aria-label="Recent scans">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Source</TableHeaderCell><TableHeaderCell>Rule set</TableHeaderCell>
              <TableHeaderCell>Duration</TableHeaderCell><TableHeaderCell>Assets discovered</TableHeaderCell>
              <TableHeaderCell>Classified</TableHeaderCell><TableHeaderCell>Started</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {RECENT_SCANS.map((r) => (
              <TableRow key={r.source + r.started}>
                <TableCell>{r.source}</TableCell><TableCell>{r.ruleset}</TableCell>
                <TableCell>{r.duration}</TableCell><TableCell>{r.assets.toLocaleString()}</TableCell>
                <TableCell>{r.classified.toLocaleString()}</TableCell><TableCell>{r.started}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </GovernanceShell>
  );
}
