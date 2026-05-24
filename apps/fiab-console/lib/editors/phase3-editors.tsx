'use client';

/**
 * Phase 3 editors — Real-Time Intelligence, Data Warehouse, Power BI.
 * Each follows the per-item anatomy from the inventory.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  monaco: {
    width: '100%',
    minHeight: '180px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '13px',
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  pad: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center' },
  card: {
    padding: '12px', border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '6px', backgroundColor: tokens.colorNeutralBackground1,
  },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
});

// ----- Eventhouse -----
const EH_CARDS = [
  { title: 'Storage', value: '124.7 GB', sub: 'across 3 KQL databases' },
  { title: 'Compute usage', value: '38%', sub: 'last 1h, CU avg' },
  { title: 'Ingestion rate', value: '2.4M rows/min', sub: 'rolling 1h' },
  { title: 'Top user (min)', value: 'alice@contoso', sub: '128 min last 24h' },
  { title: 'Top queried DB', value: 'security_logs', sub: '42% of queries' },
  { title: 'Top ingested DB', value: 'app_traces', sub: '1.1B rows /day' },
];
const EH_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'New', actions: [{ label: 'New KQL database' }, { label: 'New dashboard' }] },
    { label: 'Query', actions: [{ label: 'Query with code' }, { label: 'Get data' }] },
    { label: 'Manage', actions: [{ label: 'Data policies' }, { label: 'OneLake availability' }] },
  ]},
];
export function EventhouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={EH_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>System overview</Subtitle2>
        <div className={s.cardGrid}>
          {EH_CARDS.map((c) => (
            <div key={c.title} className={s.card}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{c.title}</Caption1>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{c.value}</div>
              <Caption1>{c.sub}</Caption1>
            </div>
          ))}
        </div>
      </div>
    } />
  );
}

// ----- KQL Database -----
const KQL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'New', actions: [{ label: 'Table' }, { label: 'Materialized view' }, { label: 'Function' }, { label: 'Update policy' }, { label: 'Shortcut' }] },
    { label: 'Data', actions: [{ label: 'Get data' }, { label: 'Query with code' }] },
    { label: 'Manage', actions: [{ label: 'Data policies' }, { label: 'OneLake availability' }] },
  ]},
];
export function KqlDatabaseEditor({ item, id }: { item: FabricItemType; id: string }) {
  return (
    <ItemEditorChrome item={item} id={id} ribbon={KQL_RIBBON}
      leftPanel={
        <Tree aria-label="KQL DB explorer" defaultOpenItems={['tables']}>
          <TreeItem itemType="branch" value="tables">
            <TreeItemLayout iconBefore={<Database20Regular />}>Tables (5)</TreeItemLayout>
            <Tree>
              {['SecurityEvents', 'AppTraces', 'HeartBeat', 'IngestionLog', 'CapacityEvents'].map((t) =>
                <TreeItem key={t} itemType="leaf"><TreeItemLayout iconBefore={<DocumentTable20Regular />}>{t}</TreeItemLayout></TreeItem>)}
            </Tree>
          </TreeItem>
          <TreeItem itemType="branch" value="mv">
            <TreeItemLayout>Materialized views (2)</TreeItemLayout>
          </TreeItem>
          <TreeItem itemType="branch" value="fn">
            <TreeItemLayout>Functions (8)</TreeItemLayout>
          </TreeItem>
          <TreeItem itemType="branch" value="sc">
            <TreeItemLayout>Shortcuts (1)</TreeItemLayout>
          </TreeItem>
        </Tree>
      }
      main={
        <div style={{ padding: 16 }}>
          <Subtitle2>SecurityEvents · preview</Subtitle2>
          <Caption1>Last refresh: 12 seconds ago · 412M rows · Hot cache: 30 days</Caption1>
        </div>
      }
    />
  );
}

// ----- KQL Queryset -----
const KQLQS_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Run' }, { label: 'Cancel' }] },
    { label: 'Save', actions: [{ label: 'Save query' }, { label: 'Save to dashboard' }, { label: 'Set alert' }] },
  ]},
];
const SAMPLE_KQL = `SecurityEvents\n| where Timestamp > ago(1h)\n| where EventID == 4625\n| summarize FailedLogins = count() by bin(Timestamp, 5m), Account\n| render timechart`;
export function KqlQuerysetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={KQLQS_RIBBON} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled" color="brand">SecurityEvents</Badge>
          <Button appearance="primary" icon={<Play20Regular />}>Run (Shift+Enter)</Button>
        </div>
        <textarea className={s.monaco} defaultValue={SAMPLE_KQL} spellCheck={false} aria-label="KQL query" />
        <Subtitle2>Results</Subtitle2>
        <Caption1>5 rows returned · 142 ms · Hot cache hit</Caption1>
      </div>
    } />
  );
}

// ----- KQL Dashboard -----
const KQLD_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Edit', actions: [{ label: 'Add tile' }, { label: 'Add data source' }, { label: 'Parameters' }] },
    { label: 'View', actions: [{ label: 'Auto-refresh' }, { label: 'Time range' }, { label: 'Share' }] },
  ]},
];
export function KqlDashboardEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={KQLD_RIBBON} main={
      <div className={s.pad}>
        <div className={s.toolbar}>
          <Badge appearance="filled">Auto-refresh: 30 s</Badge>
          <Badge appearance="outline">Last 1 hour</Badge>
        </div>
        <div className={s.cardGrid}>
          {['Failed logins', 'Top accounts (10)', 'Throughput timeline', 'Geo distribution'].map((t) => (
            <div key={t} className={s.card} style={{ minHeight: 160 }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{t}</Caption1>
              <div style={{
                height: 100, marginTop: 8, borderRadius: 4,
                background: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground3})`,
              }} />
            </div>
          ))}
        </div>
      </div>
    } />
  );
}

// ----- Eventstream -----
const ES_SOURCES = ['Azure Event Hubs', 'IoT Hub', 'SQL CDC', 'PostgreSQL CDC', 'Cosmos DB CDC', 'Kafka', 'Kinesis', 'Pub/Sub', 'MQTT', 'Workspace events', 'OneLake events'];
const ES_TRANS = ['Filter', 'Aggregate', 'Group by', 'Union', 'Manage fields', 'Expand'];
const ES_DEST = ['Lakehouse', 'Eventhouse', 'Activator', 'Custom endpoint', 'Stream (derived)'];
const ES_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Source', actions: [{ label: 'Add source' }, { label: 'Sample data' }] },
    { label: 'Transform', actions: [{ label: 'Filter' }, { label: 'Aggregate' }, { label: 'Group by' }] },
    { label: 'Destination', actions: [{ label: 'Add destination' }] },
    { label: 'Publish', actions: [{ label: 'Save' }, { label: 'Publish' }] },
  ]},
];
export function EventstreamEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ES_RIBBON} main={
      <div className={s.pad}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <div>
            <Subtitle2>Sources</Subtitle2>
            {ES_SOURCES.map((x) => <div key={x} className={s.card} style={{ marginTop: 6 }}>{x}</div>)}
          </div>
          <div>
            <Subtitle2>Transformations</Subtitle2>
            {ES_TRANS.map((x) => <div key={x} className={s.card} style={{ marginTop: 6 }}>{x}</div>)}
          </div>
          <div>
            <Subtitle2>Destinations</Subtitle2>
            {ES_DEST.map((x) => <div key={x} className={s.card} style={{ marginTop: 6 }}>{x}</div>)}
          </div>
        </div>
      </div>
    } />
  );
}

// ----- Activator -----
const ACT_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Rules', actions: [{ label: 'New rule' }, { label: 'Start' }, { label: 'Stop' }] },
    { label: 'Actions', actions: [{ label: 'Email' }, { label: 'Teams' }, { label: 'Run pipeline' }, { label: 'Run notebook' }, { label: 'Power Automate' }] },
  ]},
];
export function ActivatorEditor({ item, id }: { item: FabricItemType; id: string }) {
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ACT_RIBBON}
      leftPanel={
        <Tree aria-label="Activator explorer" defaultOpenItems={['obj']}>
          <TreeItem itemType="branch" value="obj">
            <TreeItemLayout>Objects (3)</TreeItemLayout>
            <Tree>
              {['Freezer', 'DeliveryTruck', 'Package'].map((x) =>
                <TreeItem key={x} itemType="leaf"><TreeItemLayout>{x}</TreeItemLayout></TreeItem>)}
            </Tree>
          </TreeItem>
          <TreeItem itemType="branch" value="ev"><TreeItemLayout>Events (2)</TreeItemLayout></TreeItem>
          <TreeItem itemType="branch" value="pr"><TreeItemLayout>Properties (8)</TreeItemLayout></TreeItem>
          <TreeItem itemType="branch" value="ru"><TreeItemLayout>Rules (4)</TreeItemLayout></TreeItem>
        </Tree>
      }
      main={
        <div style={{ padding: 16 }}>
          <Subtitle2>Rule: Too hot for medicine</Subtitle2>
          <Body1 style={{ marginTop: 8 }}>Monitor <b>Package.Temperature</b> · Condition <b>is greater than 20 °C</b> · Action <b>Send Teams message to assigned technician</b></Body1>
          <Badge appearance="filled" color="success" style={{ marginTop: 12 }}>Active · last triggered 4 min ago</Badge>
        </div>
      }
    />
  );
}

// ----- Warehouse -----
const WH_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Query', actions: [{ label: 'New SQL query' }, { label: 'Run' }, { label: 'Save as table' }, { label: 'Open in Excel' }] },
    { label: 'Modeling', actions: [{ label: 'New measure' }, { label: 'Manage relationships' }] },
    { label: 'Manage', actions: [{ label: 'Permissions' }, { label: 'Source control' }] },
  ]},
];
const SAMPLE_SQL = `SELECT TOP 100\n  c.CustomerName,\n  SUM(o.Amount) AS TotalRevenue\nFROM dbo.Orders o\nJOIN dbo.Customers c ON c.CustomerID = o.CustomerID\nWHERE o.OrderDate >= DATEADD(MONTH, -3, GETDATE())\nGROUP BY c.CustomerName\nORDER BY TotalRevenue DESC;`;
export function WarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={WH_RIBBON}
      leftPanel={
        <Tree aria-label="Warehouse explorer" defaultOpenItems={['schemas']}>
          <TreeItem itemType="branch" value="schemas">
            <TreeItemLayout iconBefore={<Database20Regular />}>Schemas (2)</TreeItemLayout>
            <Tree>
              {['dbo.Orders', 'dbo.Customers', 'dbo.Products', 'fin.Ledger'].map((t) =>
                <TreeItem key={t} itemType="leaf"><TreeItemLayout iconBefore={<DocumentTable20Regular />}>{t}</TreeItemLayout></TreeItem>)}
            </Tree>
          </TreeItem>
          <TreeItem itemType="branch" value="sp"><TreeItemLayout>Stored procedures (12)</TreeItemLayout></TreeItem>
          <TreeItem itemType="branch" value="fn"><TreeItemLayout>Functions (4)</TreeItemLayout></TreeItem>
        </Tree>
      }
      main={
        <div className={s.pad}>
          <div className={s.toolbar}>
            <Button appearance="primary" icon={<Play20Regular />}>Run</Button>
            <Badge appearance="outline">Query 1</Badge>
            <Badge appearance="outline">Query 2</Badge>
          </div>
          <textarea className={s.monaco} defaultValue={SAMPLE_SQL} spellCheck={false} aria-label="T-SQL editor" />
          <Subtitle2>Results</Subtitle2>
          <Table aria-label="Query results">
            <TableHeader><TableRow><TableHeaderCell>CustomerName</TableHeaderCell><TableHeaderCell>TotalRevenue</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {[['Contoso Logistics', '$248,510'], ['Fabrikam Foods', '$192,180'], ['Northwind Traders', '$144,605']].map(([a, b]) =>
                <TableRow key={a}><TableCell>{a}</TableCell><TableCell>{b}</TableCell></TableRow>)}
            </TableBody>
          </Table>
          <Caption1>3 rows · 124 ms · 0 errors</Caption1>
        </div>
      }
    />
  );
}

// ----- Semantic model -----
const SM_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Model', actions: [{ label: 'New measure' }, { label: 'New role' }, { label: 'New perspective' }] },
    { label: 'Source', actions: [{ label: 'Refresh' }, { label: 'Direct Lake' }, { label: 'Import' }] },
  ]},
];
export function SemanticModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState('tables');
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SM_RIBBON} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="tables">Tables</Tab>
            <Tab value="relationships">Relationships</Tab>
            <Tab value="measures">Measures (DAX)</Tab>
            <Tab value="roles">Roles (RLS)</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          {tab === 'tables' && (
            <Table aria-label="Tables">
              <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Columns</TableHeaderCell></TableRow></TableHeader>
              <TableBody>
                {[['fact_sales', 'Fact', 12], ['dim_customer', 'Dimension', 24], ['dim_product', 'Dimension', 31], ['dim_date', 'Dimension', 9]].map(([n, t, c]) =>
                  <TableRow key={n as string}><TableCell>{n}</TableCell><TableCell>{t}</TableCell><TableCell>{c}</TableCell></TableRow>)}
              </TableBody>
            </Table>
          )}
          {tab === 'relationships' && (<Body1>4 active relationships · 1 inactive (role-playing dim_date.ship_date)</Body1>)}
          {tab === 'measures' && (
            <textarea className={s.monaco} defaultValue={`Total Revenue =\nCALCULATE(\n  SUM(fact_sales[Amount]),\n  REMOVEFILTERS(dim_date[IsHoliday])\n)`} spellCheck={false} aria-label="DAX measure" />
          )}
          {tab === 'roles' && (<Body1>2 roles defined: Sales (regional filter), Exec (all-access)</Body1>)}
        </div>
      </>
    } />
  );
}

// ----- Report / Dashboard / Paginated / Scorecard shells -----
function genericShell(title: string, body: string, ribbon: RibbonTab[]) {
  return function Shell({ item, id }: { item: FabricItemType; id: string }) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
        <div style={{ padding: 24, textAlign: 'center' }}>
          <Subtitle2>{title}</Subtitle2>
          <Body1 style={{ marginTop: 8, color: tokens.colorNeutralForeground3 }}>{body}</Body1>
        </div>
      } />
    );
  };
}
const REPORT_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Pages', actions: [{ label: 'New page' }, { label: 'Duplicate' }] },
  { label: 'Visuals', actions: [{ label: 'New visual' }, { label: 'Format' }, { label: 'Bookmark' }] },
  { label: 'Data', actions: [{ label: 'Refresh' }, { label: 'Filters' }] },
]}];
export const ReportEditor = genericShell('Power BI report canvas', 'Visual canvas, Visualizations / Fields / Filters panes, page tabs. Embedded Power BI iframe lands here in Phase 6.', REPORT_RIBBON);
export const DashboardEditor = genericShell('Power BI dashboard', 'Pin tiles from reports and Q&A. Tile grid renders here.', REPORT_RIBBON);
export const PaginatedReportEditor = genericShell('Paginated report', 'Pixel-perfect RDL report. Renderer placeholder + parameter bar.', REPORT_RIBBON);
export const ScorecardEditor = genericShell('Scorecard', 'KPI tree with targets, owners, status. Metadata-only — no Fabric REST API today.', REPORT_RIBBON);
