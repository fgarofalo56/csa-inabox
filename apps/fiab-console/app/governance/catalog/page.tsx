'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Badge, Input,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Search20Regular } from '@fluentui/react-icons';
import { useState } from 'react';

const ASSETS = [
  { name: 'fact_sales',          source: 'OneLake · fin-prod',          type: 'Delta table',  owner: 'alice', classifications: ['PII', 'Financial'], label: 'Confidential' },
  { name: 'dim_customer',        source: 'OneLake · fin-prod',          type: 'Delta table',  owner: 'alice', classifications: ['PII', 'Email'], label: 'Confidential' },
  { name: 'SecurityEvents',      source: 'Eventhouse · sec-prod',       type: 'KQL table',    owner: 'eve',   classifications: ['PII', 'IP address'], label: 'Highly Confidential' },
  { name: 'prod-sales',          source: 'Azure SQL DB · East US 2',    type: 'SQL database', owner: 'bob',   classifications: ['Financial'], label: 'Confidential' },
  { name: 'churn-features',      source: 'ADLS Gen2 · ds-prod',         type: 'Parquet',      owner: 'carl',  classifications: ['Anonymized'], label: 'General' },
  { name: 'orders-mirror',       source: 'Mirrored · Snowflake',        type: 'Delta table',  owner: 'alice', classifications: ['Financial', 'PII'], label: 'Confidential' },
  { name: 'silver_telemetry',    source: 'Databricks UC · prod-cat',    type: 'Delta table',  owner: 'devops',classifications: [], label: 'General' },
  { name: 'sap_orders_extract',  source: 'On-prem · SAP S/4',           type: 'Extract',      owner: 'sap-team', classifications: ['Financial'], label: 'Confidential' },
];

const useStyles = makeStyles({
  bar: { display: 'flex', gap: 12, marginBottom: 12 },
  rowHover: { ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover, cursor: 'pointer' } },
  chips: { display: 'flex', gap: 4, flexWrap: 'wrap' },
});

export default function GovernanceCatalogPage() {
  const s = useStyles();
  const [q, setQ] = useState('');
  const filtered = ASSETS.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()) || a.source.toLowerCase().includes(q.toLowerCase()));
  return (
    <GovernanceShell sectionTitle="Data catalog" sectionBadge={`${filtered.length} assets`}>
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Single inventory across OneLake, Mirrored DBs, Synapse, Databricks Unity Catalog, ADLS, and registered on-prem sources. Backed by Purview scans.
      </Body1>
      <div className={s.bar}>
        <Input contentBefore={<Search20Regular />} placeholder="Search assets, owners, classifications" value={q} onChange={(_, d) => setQ(d.value)} style={{ flex: 1 }} />
      </div>
      <Table aria-label="Catalog assets">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Source</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Owner</TableHeaderCell>
            <TableHeaderCell>Classifications</TableHeaderCell><TableHeaderCell>Sensitivity</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.map((a) => (
            <TableRow key={a.name} className={s.rowHover}>
              <TableCell>{a.name}</TableCell>
              <TableCell><Caption1>{a.source}</Caption1></TableCell>
              <TableCell>{a.type}</TableCell>
              <TableCell>{a.owner}</TableCell>
              <TableCell>
                <div className={s.chips}>
                  {a.classifications.map((c) => <Badge key={c} appearance="outline" color="informative">{c}</Badge>)}
                </div>
              </TableCell>
              <TableCell>
                <Badge appearance="filled" color={a.label === 'Highly Confidential' ? 'danger' : a.label === 'Confidential' ? 'warning' : 'subtle'}>{a.label}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </GovernanceShell>
  );
}
