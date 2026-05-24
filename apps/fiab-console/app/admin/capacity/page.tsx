'use client';

import { AdminShell } from '@/lib/components/admin-shell';
import {
  Body1, Caption1, Subtitle2, Badge, Button,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';

/**
 * Capacity — CSA Loom doesn't use Fabric F-SKUs (the whole point of
 * Loom is to deliver Fabric-equivalent UX in tenants where Fabric is
 * not available, e.g. Azure Government, sovereign clouds, on-prem
 * adjacent). "Capacity" in Loom = the underlying Azure compute that
 * Loom orchestrates: Container Apps, AKS, Databricks, Synapse, ADF
 * Data Integration Units, Azure ML, Cosmos DB RU/s, etc.
 *
 * This page rolls up SKU, region, current utilization, monthly cost
 * estimate, and a 'manage' deep link per service.
 */

const POOLS = [
  { service: 'Container Apps environment', sku: 'Consumption + Dedicated D4 plan', region: 'East US 2',
    util: '38% CPU avg / 24h',  cost: '$612 / mo (proj.)', state: 'Healthy' },
  { service: 'Azure Databricks workspace', sku: 'Premium · ml-jobs-cluster (i3.xlarge x4)', region: 'East US 2',
    util: '64% DBU avg / 24h',  cost: '$2,840 / mo (proj.)', state: 'Healthy' },
  { service: 'Azure Synapse workspace', sku: 'Dedicated SQL DW400c + Serverless + Spark Medium pool', region: 'East US 2',
    util: '42% DWU avg / 24h',  cost: '$3,920 / mo (proj.)', state: 'Healthy' },
  { service: 'Azure Data Factory', sku: 'AutoResolveIR + Self-hosted IR (sap-onprem)', region: 'East US 2',
    util: '180 DIUs · 14h / 24h', cost: '$412 / mo (proj.)', state: 'Healthy' },
  { service: 'Azure Data Lake Analytics', sku: 'ADLA legacy · 10 AUs reserved', region: 'East US 2',
    util: '0% — legacy U-SQL only', cost: '$48 / mo (idle)', state: 'Idle' },
  { service: 'Azure Machine Learning', sku: 'Compute cluster (Standard_DS3_v2 x0-6)', region: 'East US 2',
    util: '12% / 24h', cost: '$214 / mo (proj.)', state: 'Healthy' },
  { service: 'Azure Cosmos DB',  sku: 'Serverless · workspace-registry', region: 'East US 2',
    util: '4,120 RU/s peak',  cost: '$36 / mo (proj.)', state: 'Healthy' },
  { service: 'Azure Container Registry', sku: 'Premium · acrloomm56yejezt7bjo', region: 'East US 2',
    util: '12.4 GB / 100 GB', cost: '$167 / mo', state: 'Healthy' },
];

const useStyles = makeStyles({
  card: { padding: 14, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 8, backgroundColor: tokens.colorNeutralBackground1 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12, marginBottom: 16 },
  v: { fontSize: 24, fontWeight: 700, color: tokens.colorBrandForeground1, marginTop: 6 },
});

export default function CapacityPage() {
  const s = useStyles();
  return (
    <AdminShell sectionTitle="Capacity & compute">
      <Body1 style={{ color: tokens.colorNeutralForeground3, marginBottom: 16 }}>
        CSA Loom does <b>not</b> use Microsoft Fabric F-SKUs — Loom exists precisely because Fabric
        isn&apos;t available in your cloud. &quot;Capacity&quot; here = the underlying Azure compute
        services Loom orchestrates: Container Apps, Databricks, Synapse, Data Factory, ADLA, Azure ML,
        Cosmos DB, ACR. Loom rolls SKU, utilization, projected monthly cost, and health into one view.
      </Body1>
      <div className={s.grid}>
        <div className={s.card}><Caption1>Total monthly cost</Caption1><div className={s.v}>$8,249</div><Caption1>Projected from last 24 h</Caption1></div>
        <div className={s.card}><Caption1>Services in scope</Caption1><div className={s.v}>{POOLS.length}</div><Caption1>across 1 region</Caption1></div>
        <div className={s.card}><Caption1>Healthy</Caption1><div className={s.v}>{POOLS.filter((p) => p.state === 'Healthy').length}/{POOLS.length}</div><Caption1>1 idle (legacy U-SQL)</Caption1></div>
        <div className={s.card}><Caption1>Carbon (last 24 h)</Caption1><div className={s.v}>42 kg CO₂e</div><Caption1>per Azure Sustainability Manager</Caption1></div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Subtitle2>Compute pools</Subtitle2>
        <Button appearance="primary">+ Attach Azure service</Button>
      </div>
      <Table aria-label="Compute pools">
        <TableHeader><TableRow>
          <TableHeaderCell>Service</TableHeaderCell><TableHeaderCell>SKU</TableHeaderCell>
          <TableHeaderCell>Region</TableHeaderCell><TableHeaderCell>Utilization</TableHeaderCell>
          <TableHeaderCell>Cost</TableHeaderCell><TableHeaderCell>State</TableHeaderCell>
        </TableRow></TableHeader>
        <TableBody>
          {POOLS.map((p) => (
            <TableRow key={p.service}>
              <TableCell>{p.service}</TableCell>
              <TableCell><Caption1>{p.sku}</Caption1></TableCell>
              <TableCell>{p.region}</TableCell>
              <TableCell>{p.util}</TableCell>
              <TableCell>{p.cost}</TableCell>
              <TableCell>
                <Badge appearance="filled" color={p.state === 'Healthy' ? 'success' : p.state === 'Idle' ? 'subtle' : 'danger'}>{p.state}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Body1 style={{ marginTop: 16, color: tokens.colorNeutralForeground3 }}>
        Cost roll-up uses your Azure Cost Management exports — connect them on{' '}
        <a href="/admin/tenant-settings"><b>Tenant settings</b></a> → Billing connections. Loom never
        sees your invoice; it reads the cost data your Azure billing scope already exposes.
      </Body1>
    </AdminShell>
  );
}
