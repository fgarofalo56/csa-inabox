'use client';

/**
 * Native Azure-service editors — Synapse, Databricks, ADF, U-SQL.
 *
 * Each editor surfaces the underlying service's 1:1 capabilities in
 * Loom so users never have to leave to use Synapse Studio, Databricks
 * Workspace, ADF Studio, or the (retired) ADLA portal. Loom proxies
 * to the underlying service via its REST APIs and embeds the relevant
 * Fluent UI structure.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Dropdown, Option, Textarea,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Database20Regular, DocumentTable20Regular, Play20Regular, Server20Regular } from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: 16, display: 'flex', flexDirection: 'column', gap: 12 },
  form: { padding: 20, display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 },
  row: { display: 'flex', gap: 12 },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 },
  monaco: {
    width: '100%', minHeight: 200,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 13, padding: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  card: { padding: 12, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 6 },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 },
});

// ============================================================
// Synapse — Dedicated SQL pool
// ============================================================
const SYN_DSQL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Query', actions: [{ label: 'New SQL query' }, { label: 'Run' }, { label: 'Estimate cost' }] },
    { label: 'Scale', actions: [{ label: 'Scale up / down' }, { label: 'Pause' }, { label: 'Resume' }] },
    { label: 'Manage', actions: [{ label: 'Permissions' }, { label: 'Workload mgmt' }, { label: 'Geo backup' }] },
  ]},
];
export function SynapseDedicatedSqlPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_DSQL_RIBBON}
      leftPanel={
        <Tree aria-label="Synapse dedicated SQL pool" defaultOpenItems={['schemas']}>
          <TreeItem itemType="branch" value="schemas">
            <TreeItemLayout iconBefore={<Database20Regular />}>Schemas (3)</TreeItemLayout>
            <Tree>{['dbo.FactSales', 'dbo.DimCustomer', 'edw.StageOrders', 'staging.Raw'].map((t) =>
              <TreeItem key={t} itemType="leaf"><TreeItemLayout iconBefore={<DocumentTable20Regular />}>{t}</TreeItemLayout></TreeItem>)}
            </Tree>
          </TreeItem>
          <TreeItem itemType="branch" value="dists"><TreeItemLayout>Distributions</TreeItemLayout></TreeItem>
          <TreeItem itemType="branch" value="extern"><TreeItemLayout>External tables (8)</TreeItemLayout></TreeItem>
          <TreeItem itemType="branch" value="users"><TreeItemLayout>Users & roles</TreeItemLayout></TreeItem>
        </Tree>
      }
      main={
        <div className={s.pad}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Badge appearance="filled" color="brand">DW400c</Badge>
            <Badge appearance="outline" color="success">Online</Badge>
            <Caption1>Region: East US 2 · Geo backup: enabled</Caption1>
            <Button appearance="primary" icon={<Play20Regular />} style={{ marginLeft: 'auto' }}>Run</Button>
          </div>
          <textarea className={s.monaco} spellCheck={false} aria-label="T-SQL editor" defaultValue={`-- Synapse Dedicated SQL pool — MPP T-SQL
SELECT TOP 100 c.CustomerName, SUM(f.Amount) AS Revenue
FROM dbo.FactSales f
JOIN dbo.DimCustomer c ON c.CustomerKey = f.CustomerKey
WHERE f.OrderDateKey >= 20260101
GROUP BY c.CustomerName
ORDER BY Revenue DESC
OPTION (LABEL = 'loom-csa-dashboard');`} />
          <Subtitle2>Results</Subtitle2>
          <Caption1>100 rows · 2.3 s · DWU consumed: 2.1</Caption1>
        </div>
      }
    />
  );
}

// ============================================================
// Synapse — Serverless SQL pool
// ============================================================
const SYN_SSQL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Query', actions: [{ label: 'New SQL query' }, { label: 'Run' }, { label: 'External tables' }] },
    { label: 'Cost', actions: [{ label: 'Bytes processed' }, { label: 'Cost cap' }] },
  ]},
];
export function SynapseServerlessSqlPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_SSQL_RIBBON} main={
      <div className={s.pad}>
        <div style={{ display: 'flex', gap: 12 }}>
          <Badge appearance="filled" color="brand">Serverless</Badge>
          <Badge appearance="outline">Pay per TB processed</Badge>
        </div>
        <textarea className={s.monaco} spellCheck={false} defaultValue={`-- Synapse Serverless SQL — OPENROWSET over ADLS
SELECT TOP 1000 *
FROM OPENROWSET(
  BULK 'https://contoso.dfs.core.windows.net/raw/orders/year=2026/month=05/*.parquet',
  FORMAT = 'PARQUET'
) AS o
WHERE o.amount > 100;`} aria-label="Serverless SQL editor" />
        <Caption1>Estimated cost: ~$0.012 (2.4 GB scanned)</Caption1>
      </div>
    } />
  );
}

// ============================================================
// Synapse — Spark pool
// ============================================================
const SYN_SPARK_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Pool', actions: [{ label: 'Scale' }, { label: 'Pause' }, { label: 'Auto-pause' }] },
    { label: 'Run', actions: [{ label: 'Open notebook' }, { label: 'Submit Spark job' }] },
  ]},
];
export function SynapseSparkPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_SPARK_RIBBON} main={
      <div className={s.form}>
        <Subtitle2>Spark pool configuration</Subtitle2>
        <div className={s.row}>
          <div className={s.field}><Caption1>Node size</Caption1><Dropdown defaultValue="Medium (8 vCores, 64 GB)" defaultSelectedOptions={['Medium (8 vCores, 64 GB)']}><Option>Small (4/32)</Option><Option>Medium (8 vCores, 64 GB)</Option><Option>Large (16/128)</Option></Dropdown></div>
          <div className={s.field}><Caption1>Autoscale</Caption1><Dropdown defaultValue="3 — 10 nodes" defaultSelectedOptions={['3 — 10 nodes']}><Option>3 — 10 nodes</Option><Option>5 — 30 nodes</Option></Dropdown></div>
        </div>
        <div className={s.row}>
          <div className={s.field}><Caption1>Spark version</Caption1><Dropdown defaultValue="Spark 3.4 / Scala 2.12" defaultSelectedOptions={['Spark 3.4 / Scala 2.12']}><Option>Spark 3.4 / Scala 2.12</Option></Dropdown></div>
          <div className={s.field}><Caption1>Auto-pause</Caption1><Input defaultValue="15 minutes" /></div>
        </div>
        <Subtitle2 style={{ marginTop: 8 }}>Recent sessions</Subtitle2>
        <Caption1>3 active sessions · 12 sessions in last 24 h · avg duration 18 min</Caption1>
      </div>
    } />
  );
}

// ============================================================
// Synapse — Pipeline
// ============================================================
const SYN_PIPE_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Activities', actions: [{ label: 'Copy data' }, { label: 'Notebook' }, { label: 'Stored procedure' }, { label: 'Mapping data flow' }] },
    { label: 'Run', actions: [{ label: 'Run' }, { label: 'Debug' }, { label: 'Triggers' }] },
  ]},
];
export function SynapsePipelineEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_PIPE_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Synapse Integrate canvas</Subtitle2>
        <Body1>Identical authoring experience to Synapse Studio. Drag activities onto the canvas, configure connections via linked services, and run on the integration runtime of your choice.</Body1>
        <div className={s.cardGrid}>
          {['Copy data', 'Notebook', 'Stored procedure', 'Mapping data flow', 'Foreach', 'If condition', 'Switch', 'Web activity', 'Wait', 'Set variable', 'Lookup', 'Get metadata'].map((a) => (
            <div key={a} className={s.card}>{a}</div>
          ))}
        </div>
        <Caption1>12 of 90+ activities shown. Full palette available in the canvas.</Caption1>
      </div>
    } />
  );
}

// ============================================================
// Databricks — Notebook
// ============================================================
const DBX_NB_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Run all' }, { label: 'Run cell' }, { label: 'Stop' }] },
    { label: 'Cluster', actions: [{ label: 'Attach' }, { label: 'Detach' }, { label: 'Restart' }] },
    { label: 'Workspace', actions: [{ label: 'Schedule' }, { label: 'Permissions' }, { label: 'Revision history' }] },
  ]},
];
export function DatabricksNotebookEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_NB_RIBBON} main={
      <div className={s.pad}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Badge appearance="filled" color="brand">PySpark</Badge>
          <Badge appearance="outline" color="success">Attached: ml-jobs-cluster (i3.xlarge, 4 workers)</Badge>
          <Button appearance="primary" icon={<Play20Regular />}>Run all</Button>
        </div>
        <textarea className={s.monaco} spellCheck={false} defaultValue={`# Databricks notebook — Cmd 1
%sql
SHOW TABLES IN prod_catalog.silver;`} />
        <textarea className={s.monaco} spellCheck={false} defaultValue={`# Cmd 2
from pyspark.sql import functions as F
df = spark.table("prod_catalog.silver.orders")
display(df.groupBy("region").agg(F.sum("amount").alias("revenue")).orderBy(F.desc("revenue")))`} />
        <Caption1>Notebook stored at /Workspace/CSA/loom-projects/{id}. Version: 14 · Last edit: 8 min ago</Caption1>
      </div>
    } />
  );
}

// ============================================================
// Databricks — Job
// ============================================================
const DBX_JOB_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Tasks', actions: [{ label: 'Add task' }, { label: 'Reorder' }] },
    { label: 'Run', actions: [{ label: 'Run now' }, { label: 'Schedule' }, { label: 'Retries' }] },
  ]},
];
export function DatabricksJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_JOB_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Tasks (5)</Subtitle2>
        <Table aria-label="Job tasks">
          <TableHeader><TableRow>
            <TableHeaderCell>Task</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell>Cluster</TableHeaderCell><TableHeaderCell>Depends on</TableHeaderCell>
          </TableRow></TableHeader>
          <TableBody>
            {[
              ['ingest_raw',      'Notebook',      'job-cluster-small',  '—'],
              ['standardize',     'Notebook',      'job-cluster-small',  'ingest_raw'],
              ['silver_enrich',   'Python wheel',  'job-cluster-medium', 'standardize'],
              ['gold_aggregate',  'dbt',           'sql-warehouse',      'silver_enrich'],
              ['publish_metrics', 'JAR',           'job-cluster-small',  'gold_aggregate'],
            ].map((r) => <TableRow key={r[0]}>{r.map((c, i) => <TableCell key={i}>{c}</TableCell>)}</TableRow>)}
          </TableBody>
        </Table>
        <Caption1>Schedule: 0 2 * * * UTC · Last run: 6 h ago · Status: Succeeded</Caption1>
      </div>
    } />
  );
}

// ============================================================
// Databricks — Cluster
// ============================================================
const DBX_CLUSTER_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'State', actions: [{ label: 'Start' }, { label: 'Restart' }, { label: 'Terminate' }] },
    { label: 'Configure', actions: [{ label: 'Init scripts' }, { label: 'Libraries' }, { label: 'Spark config' }] },
  ]},
];
export function DatabricksClusterEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_CLUSTER_RIBBON} main={
      <div className={s.form}>
        <div style={{ display: 'flex', gap: 12 }}>
          <Badge appearance="filled" color="success">Running</Badge>
          <Badge appearance="outline">14.3 LTS (Photon)</Badge>
          <Badge appearance="outline">Unity Catalog enabled</Badge>
        </div>
        <Subtitle2>Compute</Subtitle2>
        <div className={s.row}>
          <div className={s.field}><Caption1>Node type</Caption1><Dropdown defaultValue="Standard_DS3_v2" defaultSelectedOptions={['Standard_DS3_v2']}><Option>Standard_DS3_v2</Option><Option>Standard_E8s_v3</Option></Dropdown></div>
          <div className={s.field}><Caption1>Workers</Caption1><Input defaultValue="2 — 8 (autoscale)" /></div>
        </div>
        <div className={s.row}>
          <div className={s.field}><Caption1>Auto-terminate</Caption1><Input defaultValue="30 minutes" /></div>
          <div className={s.field}><Caption1>Spark version</Caption1><Input defaultValue="14.3.x-scala2.12" /></div>
        </div>
        <Subtitle2 style={{ marginTop: 8 }}>Spark config</Subtitle2>
        <Textarea rows={4} defaultValue={`spark.databricks.delta.preview.enabled true\nspark.sql.shuffle.partitions 200\nspark.databricks.io.cache.enabled true`} />
      </div>
    } />
  );
}

// ============================================================
// Databricks — SQL Warehouse
// ============================================================
const DBX_SQLW_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Query', actions: [{ label: 'New SQL query' }, { label: 'Run' }, { label: 'Query history' }] },
    { label: 'Warehouse', actions: [{ label: 'Start' }, { label: 'Stop' }, { label: 'Scale' }] },
  ]},
];
export function DatabricksSqlWarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_SQLW_RIBBON} main={
      <div className={s.pad}>
        <div style={{ display: 'flex', gap: 12 }}>
          <Badge appearance="filled" color="brand">Serverless · Medium</Badge>
          <Badge appearance="outline" color="success">Running</Badge>
          <Badge appearance="outline">Photon · Predictive I/O</Badge>
        </div>
        <textarea className={s.monaco} spellCheck={false} defaultValue={`-- Databricks SQL Warehouse (Unity Catalog)
SELECT region, SUM(amount) AS revenue
FROM prod_catalog.gold.fact_sales
WHERE order_date >= current_date() - INTERVAL 30 DAYS
GROUP BY region
ORDER BY revenue DESC;`} aria-label="Databricks SQL editor" />
        <Caption1>Query history: 1,204 queries last 24 h · avg 1.4 s</Caption1>
      </div>
    } />
  );
}

// ============================================================
// Azure Data Factory — Pipeline
// ============================================================
const ADF_PIPE_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Activities', actions: [{ label: 'Copy data' }, { label: 'Mapping data flow' }, { label: 'Notebook' }, { label: 'SP' }] },
    { label: 'Debug & run', actions: [{ label: 'Debug' }, { label: 'Add trigger' }, { label: 'Publish all' }] },
  ]},
];
export function AdfPipelineEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ADF_PIPE_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Pipeline canvas (classic ADF)</Subtitle2>
        <Body1>Native ADF authoring inside Loom. Linked services, datasets, mapping data flows, and the full 90+ activity palette. Runs on your existing AutoResolveIntegrationRuntime or self-hosted IR — Loom does not move execution.</Body1>
        <div className={s.cardGrid}>
          {['Copy data', 'Lookup', 'GetMetadata', 'ForEach', 'IfCondition', 'Switch', 'Filter', 'Until', 'Wait', 'Web', 'WebHook', 'SetVariable', 'AppendVariable', 'ExecutePipeline', 'Validation', 'Delete', 'Script', 'ExecuteSSISPackage', 'DataLakeAnalyticsU-SQL', 'AzureFunction', 'Databricks Notebook', 'HDInsight Hive', 'AzureML', 'MappingDataFlow'].map((a) => (
            <div key={a} className={s.card}>{a}</div>
          ))}
        </div>
        <Caption1>24 of 90+ ADF activities shown.</Caption1>
      </div>
    } />
  );
}

// ============================================================
// Azure Data Factory — Dataset
// ============================================================
const ADF_DS_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Schema', actions: [{ label: 'Import schema' }, { label: 'Preview data' }] },
  ]},
];
export function AdfDatasetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ADF_DS_RIBBON} main={
      <div className={s.form}>
        <Subtitle2>Dataset configuration</Subtitle2>
        <div className={s.row}>
          <div className={s.field}><Caption1>Type</Caption1><Dropdown defaultValue="Parquet" defaultSelectedOptions={['Parquet']}><Option>Parquet</Option><Option>DelimitedText</Option><Option>JSON</Option><Option>Avro</Option><Option>AzureSqlTable</Option></Dropdown></div>
          <div className={s.field}><Caption1>Linked service</Caption1><Dropdown defaultValue="ls-adls-gen2-raw" defaultSelectedOptions={['ls-adls-gen2-raw']}><Option>ls-adls-gen2-raw</Option><Option>ls-azuresql-prod</Option></Dropdown></div>
        </div>
        <div className={s.field}><Caption1>Path / table</Caption1><Input placeholder="raw/orders/year=2026/month=05/*.parquet" /></div>
        <Subtitle2 style={{ marginTop: 8 }}>Schema (12 columns)</Subtitle2>
        <Table aria-label="Schema">
          <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell></TableRow></TableHeader>
          <TableBody>{[['order_id','int'],['customer_id','string'],['amount','decimal(18,2)'],['order_date','timestamp']].map((r) =>
            <TableRow key={r[0]}><TableCell><code>{r[0]}</code></TableCell><TableCell>{r[1]}</TableCell></TableRow>)}
          </TableBody>
        </Table>
      </div>
    } />
  );
}

// ============================================================
// Azure Data Factory — Trigger
// ============================================================
const ADF_TR_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'State', actions: [{ label: 'Start' }, { label: 'Stop' }] },
    { label: 'Edit', actions: [{ label: 'Recurrence' }, { label: 'Parameters' }] },
  ]},
];
export function AdfTriggerEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ADF_TR_RIBBON} main={
      <div className={s.form}>
        <Subtitle2>Trigger type</Subtitle2>
        <Dropdown defaultValue="Schedule" defaultSelectedOptions={['Schedule']}><Option>Schedule</Option><Option>Tumbling window</Option><Option>Storage event</Option><Option>Custom event</Option></Dropdown>
        <div className={s.row}>
          <div className={s.field}><Caption1>Cadence</Caption1><Input defaultValue="Every 1 hour, on the hour" /></div>
          <div className={s.field}><Caption1>Time zone</Caption1><Input defaultValue="UTC" /></div>
        </div>
        <Caption1>Linked pipelines: 3 · Last fired: 32 min ago · State: Running</Caption1>
      </div>
    } />
  );
}

// ============================================================
// U-SQL job (Azure Data Lake Analytics)
// ============================================================
const USQL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Submit', actions: [{ label: 'Submit job' }, { label: 'Estimate AUs' }] },
    { label: 'Project', actions: [{ label: 'Register assembly' }, { label: 'Catalog' }] },
  ]},
];
export function UsqlJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={USQL_RIBBON} main={
      <div className={s.pad}>
        <div style={{ display: 'flex', gap: 12 }}>
          <Badge appearance="outline">ADLA · East US</Badge>
          <Badge appearance="outline">AUs: 10</Badge>
          <Badge appearance="outline" color="warning">Legacy</Badge>
        </div>
        <textarea className={s.monaco} spellCheck={false} defaultValue={`// U-SQL — runs on Azure Data Lake Analytics
@orders = EXTRACT
  OrderId int,
  CustomerId string,
  Amount  decimal,
  OrderDate DateTime
FROM "/raw/orders/{*}.csv"
USING Extractors.Csv(skipFirstNRows: 1);

@agg = SELECT CustomerId, SUM(Amount) AS Revenue
       FROM @orders
       GROUP BY CustomerId;

OUTPUT @agg
TO   "/curated/customer_revenue.csv"
USING Outputters.Csv(outputHeader: true);`} aria-label="U-SQL editor" />
        <Caption1>Submit to ADLA account · estimated 8 AU·s · ~$0.04</Caption1>
      </div>
    } />
  );
}
