'use client';

/**
 * Phase 4 editors — Data Science, APIs / Functions, Fabric IQ.
 */

import { useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';

const useStyles = makeStyles({
  pad: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  monaco: {
    width: '100%', minHeight: '180px',
    fontFamily: 'Consolas, "Cascadia Code", monospace',
    fontSize: '13px', padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: '4px',
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  card: { padding: '12px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '6px' },
  cardGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' },
});

// ----- ML Model -----
const ML_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Versions', actions: [{ label: 'Register new version' }, { label: 'Compare versions' }] },
    { label: 'Apply', actions: [{ label: 'Apply (PREDICT)' }, { label: 'Real-time endpoint' }] },
  ]},
];
export function MlModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ML_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Versions</Subtitle2>
        <Table aria-label="Model versions">
          <TableHeader><TableRow><TableHeaderCell>Version</TableHeaderCell><TableHeaderCell>Created</TableHeaderCell><TableHeaderCell>Run</TableHeaderCell><TableHeaderCell>ROC AUC</TableHeaderCell><TableHeaderCell>Stage</TableHeaderCell></TableRow></TableHeader>
          <TableBody>
            {[['3', '2026-05-22', 'run-9f2a', '0.91', 'Production'], ['2', '2026-04-30', 'run-7c11', '0.88', 'Staging'], ['1', '2026-04-12', 'run-3b04', '0.83', 'Archived']].map((r) =>
              <TableRow key={r[0]}>{r.map((c, i) => <TableCell key={i}>{c}</TableCell>)}</TableRow>)}
          </TableBody>
        </Table>
      </div>
    } />
  );
}

// ----- ML Experiment -----
const MLE_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Runs', actions: [{ label: 'Compare' }, { label: 'Register model' }, { label: 'Delete' }] },
    { label: 'Charts', actions: [{ label: 'Parallel coordinates' }, { label: 'Scatter' }] },
  ]},
];
export function MlExperimentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={MLE_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Runs (12)</Subtitle2>
        <Table aria-label="Experiment runs">
          <TableHeader><TableRow><TableHeaderCell>Run ID</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell><TableHeaderCell>learning_rate</TableHeaderCell><TableHeaderCell>num_leaves</TableHeaderCell><TableHeaderCell>R²</TableHeaderCell></TableRow></TableHeader>
          <TableBody>
            {[['run-9f2a', 'FINISHED', '0.05', '127', '0.91'], ['run-7c11', 'FINISHED', '0.1', '63', '0.88'], ['run-3b04', 'FAILED', '0.2', '31', '—']].map((r) =>
              <TableRow key={r[0]}>{r.map((c, i) => <TableCell key={i}>{c}</TableCell>)}</TableRow>)}
          </TableBody>
        </Table>
      </div>
    } />
  );
}

// ----- GraphQL API -----
const GQL_SAMPLE = `query {\n  customers(filter: { region: "EMEA" }, first: 10) {\n    id\n    name\n    orders { id total }\n  }\n}`;
const GQL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Schema', actions: [{ label: 'Add data source' }, { label: 'Generate schema' }, { label: 'Publish' }] },
    { label: 'Auth', actions: [{ label: 'Authorizer function' }, { label: 'Roles' }] },
  ]},
];
export function GraphqlApiEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={GQL_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Connected data sources</Subtitle2>
        <div className={s.cardGrid}>
          {['fin-warehouse (Warehouse)', 'ldn-gold-lakehouse (SQL endpoint)', 'orders-mirror (Mirrored DB)'].map((x) =>
            <div key={x} className={s.card}>{x}</div>)}
        </div>
        <Subtitle2 style={{ marginTop: 8 }}>Test query</Subtitle2>
        <textarea className={s.monaco} defaultValue={GQL_SAMPLE} spellCheck={false} aria-label="GraphQL query" />
        <Button appearance="primary" style={{ alignSelf: 'flex-start' }}>Run query</Button>
      </div>
    } />
  );
}

// ----- User Data Function -----
const UDF_SAMPLE = `import fabric.functions as fn\nudf = fn.UserDataFunctions()\n\n@udf.function()\ndef compute_score(user_id: str, weight: float = 1.0) -> dict:\n    return {"user": user_id, "score": weight * 42}`;
const UDF_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Function', actions: [{ label: 'New function' }, { label: 'Test' }, { label: 'Deploy' }] },
    { label: 'Connections', actions: [{ label: 'Add connection' }, { label: 'Libraries' }] },
  ]},
];
export function UserDataFunctionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={UDF_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>function_app.py</Subtitle2>
        <textarea className={s.monaco} defaultValue={UDF_SAMPLE} spellCheck={false} aria-label="Function source" />
        <Subtitle2 style={{ marginTop: 8 }}>Connected items</Subtitle2>
        <Body1>fin-warehouse · ldn-gold-lakehouse · variable-library/prod</Body1>
      </div>
    } />
  );
}

// ----- Variable Library -----
const VL_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Variables', actions: [{ label: 'New variable' }, { label: 'Delete' }] },
    { label: 'Value sets', actions: [{ label: 'New value set' }, { label: 'Compare' }] },
  ]},
];
export function VariableLibraryEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [tab, setTab] = useState('vars');
  return (
    <ItemEditorChrome item={item} id={id} ribbon={VL_RIBBON} main={
      <>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="vars">Variables</Tab>
            <Tab value="dev">dev</Tab>
            <Tab value="test">test</Tab>
            <Tab value="prod">prod</Tab>
          </TabList>
        </div>
        <div className={s.pad}>
          <Table aria-label="Variables">
            <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Default</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {[['ENV', 'string', 'dev'], ['LakehouseId', 'string', 'guid-…-aaaa'], ['BatchSize', 'int', '5000'], ['EnableCopilot', 'bool', 'true']].map((r) =>
                <TableRow key={r[0]}>{r.map((c, i) => <TableCell key={i}>{c}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        </div>
      </>
    } />
  );
}

// ----- Fabric IQ shells -----
function shell(title: string, body: string, ribbon: RibbonTab[]) {
  return function Shell({ item, id }: { item: FabricItemType; id: string }) {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
        <div style={{ padding: 24 }}>
          <Subtitle2>{title}</Subtitle2>
          <Body1 style={{ marginTop: 8, color: tokens.colorNeutralForeground3 }}>{body}</Body1>
        </div>
      } />
    );
  };
}
const IQ_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Author', actions: [{ label: 'Add entity' }, { label: 'Add relationship' }, { label: 'Add rule' }] },
  { label: 'Bind', actions: [{ label: 'Bind data' }, { label: 'Validate' }] },
]}];
export const OntologyEditor = shell('Ontology — entity types & relationships', 'Define business entities (Customer, Order, Flight), their properties, relationships, and condition→action rules. Bind each entity type to a Lakehouse / Warehouse / Eventhouse table.', IQ_RIBBON);
export const GraphModelEditor = shell('Graph model — nodes & edges', 'Native graph storage with GQL queries. Pattern matching, traversal, and graph algorithms.', IQ_RIBBON);
export const PlanEditor = shell('Plan — collaborative planning sheets', 'Connect dimensions and measures from a semantic model, define planning workflows with approvals and writeback.', IQ_RIBBON);
export const MapEditor = shell('Map — geospatial layers', 'Layer KQL, Lakehouse, Eventhouse, and Ontology entities on a map. Supports up to 100k features per layer.', IQ_RIBBON);
export const OperationsAgentEditor = shell('Operations agent (preview)', 'Monitor real-time data from an Eventhouse, reason against your Ontology, and trigger Activator actions.', IQ_RIBBON);

// ----- Data Agent -----
const DA_RIBBON: RibbonTab[] = [{ id: 'home', label: 'Home', groups: [
  { label: 'Sources', actions: [{ label: 'Add data source' }, { label: 'Add Ontology' }] },
  { label: 'Instructions', actions: [{ label: 'AI instructions' }, { label: 'Per-source instructions' }, { label: 'Example queries' }] },
  { label: 'Test', actions: [{ label: 'Chat preview' }, { label: 'Publish' }] },
]}];
export function DataAgentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DA_RIBBON} main={
      <div className={s.pad}>
        <Subtitle2>Data sources</Subtitle2>
        <div className={s.cardGrid}>
          {['fin-warehouse (Warehouse)', 'orders semantic model', 'ldn-gold-lakehouse', 'ontology-finance'].map((x) =>
            <div key={x} className={s.card}>{x}</div>)}
        </div>
        <Subtitle2 style={{ marginTop: 8 }}>AI instructions</Subtitle2>
        <Textarea rows={4} defaultValue="You are a finance analyst. Always use the latest dim_date and roll metrics by quarter unless asked otherwise." />
        <Subtitle2 style={{ marginTop: 8 }}>Example queries</Subtitle2>
        <Body1>Top 10 customers by revenue last quarter — Monthly recurring revenue trend — Forecast next quarter.</Body1>
      </div>
    } />
  );
}
