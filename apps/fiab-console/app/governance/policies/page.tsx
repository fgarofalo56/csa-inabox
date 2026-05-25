'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Subtitle2, Badge,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';

const DLP = [
  { name: 'Block external sharing of Highly Confidential', scope: 'All workspaces', state: 'Enabled', triggers: 4 },
  { name: 'Warn on export of PII to Excel',                scope: 'fin-prod, fin-dev', state: 'Enabled', triggers: 12 },
  { name: 'Block notebook output containing credit cards', scope: 'All notebooks',  state: 'Enabled', triggers: 1 },
];
const MASKING = [
  { col: 'dim_customer.email',     mask: 'Email mask (a***@***.com)', rolesExempt: 'compliance-officers' },
  { col: 'dim_customer.phone',     mask: 'Phone mask (XXX-XXX-1234)', rolesExempt: 'csa-loom-admins' },
  { col: 'fact_sales.account_no',  mask: 'Random hash',               rolesExempt: 'finance-leads' },
];
const RLS = [
  { table: 'fact_sales',           policy: 'region IN current_user_regions()',         tested: 'pass' },
  { table: 'dim_customer',         policy: 'tier <= current_user_max_tier()',          tested: 'pass' },
  { table: 'SecurityEvents',       policy: 'severity IN allowed_severities_for_user', tested: 'pass' },
];

const useStyles = makeStyles({
  section: { marginTop: 24 },
});

export default function PoliciesPage() {
  const s = useStyles();
  return (
    <GovernanceShell sectionTitle="Access policies">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Loom centralizes DLP, dynamic data masking, row-level + column-level security, and Purview access policies. Edits propagate to OneLake, Synapse, Databricks UC, and Azure SQL where supported.
      </Body1>
      <Subtitle2>DLP policies</Subtitle2>
      <Table aria-label="DLP policies">
        <TableHeader><TableRow>
          <TableHeaderCell>Policy</TableHeaderCell><TableHeaderCell>Scope</TableHeaderCell>
          <TableHeaderCell>State</TableHeaderCell><TableHeaderCell>Triggers (7 d)</TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>
          {DLP.map((p) => (
            <TableRow key={p.name}>
              <TableCell>{p.name}</TableCell><TableCell>{p.scope}</TableCell>
              <TableCell><Badge color="success">{p.state}</Badge></TableCell><TableCell>{p.triggers}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Subtitle2 className={s.section}>Dynamic data masking</Subtitle2>
      <Table aria-label="Masking rules">
        <TableHeader><TableRow>
          <TableHeaderCell>Column</TableHeaderCell><TableHeaderCell>Mask</TableHeaderCell>
          <TableHeaderCell>Exempt roles</TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>
          {MASKING.map((m) => (
            <TableRow key={m.col}>
              <TableCell><code>{m.col}</code></TableCell><TableCell>{m.mask}</TableCell>
              <TableCell><Caption1>{m.rolesExempt}</Caption1></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Subtitle2 className={s.section}>Row-level security (RLS)</Subtitle2>
      <Table aria-label="RLS policies">
        <TableHeader><TableRow>
          <TableHeaderCell>Table</TableHeaderCell><TableHeaderCell>Policy</TableHeaderCell>
          <TableHeaderCell>Last test</TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>
          {RLS.map((r) => (
            <TableRow key={r.table}>
              <TableCell>{r.table}</TableCell>
              <TableCell><code>{r.policy}</code></TableCell>
              <TableCell><Badge color="success">{r.tested}</Badge></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </GovernanceShell>
  );
}
