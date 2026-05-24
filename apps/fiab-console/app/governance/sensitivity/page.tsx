'use client';

import { GovernanceShell } from '@/lib/components/governance-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';

const LABELS = [
  { name: 'Public',               color: '#737373', encryption: 'No',  protection: 'None',                 coverage: '8%',  items: 42  },
  { name: 'General',              color: '#117865', encryption: 'No',  protection: 'None',                 coverage: '32%', items: 172 },
  { name: 'Confidential',         color: '#d89f3d', encryption: 'Yes', protection: 'Internal-only access', coverage: '46%', items: 247 },
  { name: 'Highly Confidential',  color: '#b91c4b', encryption: 'Yes', protection: 'Named-group access',   coverage: '12%', items: 64  },
  { name: 'Top Secret (custom)',  color: '#3d2e80', encryption: 'Yes', protection: 'CEO + Legal only',     coverage: '2%',  items: 9   },
];
const POLICIES = [
  'Auto-apply Confidential to any item containing PII or Financial classifications',
  'Auto-apply Highly Confidential to any item in the security-* workspaces',
  'Block downgrade of Highly Confidential without compliance officer approval',
  'Inherit label from upstream when a lineage edge crosses a workspace boundary',
];

const useStyles = makeStyles({
  swatch: { display: 'inline-block', width: 16, height: 16, borderRadius: 3, marginRight: 8, verticalAlign: 'middle' },
  policy: { padding: '10px 12px', backgroundColor: tokens.colorNeutralBackground2, borderRadius: 6, marginBottom: 6 },
});

export default function SensitivityPage() {
  const s = useStyles();
  return (
    <GovernanceShell sectionTitle="Sensitivity labels">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 12 }}>
        Labels travel with the data. A sensitivity label set in Loom propagates downstream through every lineage edge and is enforced by Purview / Microsoft Information Protection at the storage layer.
      </Body1>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Subtitle2>Label taxonomy</Subtitle2>
        <Button appearance="primary">+ New label</Button>
      </div>
      <Table aria-label="Sensitivity labels">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Label</TableHeaderCell><TableHeaderCell>Encryption</TableHeaderCell>
            <TableHeaderCell>Protection</TableHeaderCell><TableHeaderCell>Coverage</TableHeaderCell>
            <TableHeaderCell>Items</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {LABELS.map((l) => (
            <TableRow key={l.name}>
              <TableCell><span className={s.swatch} style={{ background: l.color }} />{l.name}</TableCell>
              <TableCell>{l.encryption}</TableCell>
              <TableCell>{l.protection}</TableCell>
              <TableCell>{l.coverage}</TableCell>
              <TableCell>{l.items}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Subtitle2 style={{ marginTop: 24, marginBottom: 8 }}>Auto-labeling policies</Subtitle2>
      {POLICIES.map((p, i) => (
        <div key={i} className={s.policy}>{p}</div>
      ))}
      <Badge appearance="outline" color="success" style={{ marginTop: 12 }}>4 policies active · last evaluated 8 min ago</Badge>
    </GovernanceShell>
  );
}
