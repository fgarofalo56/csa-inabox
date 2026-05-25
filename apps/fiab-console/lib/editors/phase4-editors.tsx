'use client';

/**
 * Phase 4 editors — Data Science, APIs / Functions, Fabric IQ.
 *
 * MlModelEditor and MlExperimentEditor are wired live to the AI Foundry hub
 * (Microsoft.MachineLearningServices/workspaces) via the BFF:
 *   GET /api/items/ml-model/[id]      → model + versions
 *   GET /api/items/ml-experiment/[id] → job OR experiment grouping of runs
 * No mock data; errors surface in MessageBar.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Textarea, Spinner,
  Tab, TabList,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  Tree, TreeItem, TreeItemLayout,
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
    { label: 'Versions', actions: [{ label: 'Reload' }, { label: 'Compare versions' }] },
    { label: 'Apply', actions: [{ label: 'Apply (PREDICT)' }, { label: 'Real-time endpoint' }] },
  ]},
];

interface ModelSummary {
  id: string; name: string; description?: string; latestVersion?: string;
  tags?: Record<string, string>; properties?: Record<string, string>;
}
interface ModelVersion {
  id: string; name: string; version: string; description?: string;
  modelType?: string; modelUri?: string; createdAt?: string;
  tags?: Record<string, string>; properties?: Record<string, string>;
}

export function MlModelEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<ModelSummary | null>(null);
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/ml-model/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setLoading(false); return; }
      setModel(j.model);
      setVersions(j.versions || []);
      setSelected(j.versions?.[0]?.version || null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const current = versions.find((v) => v.version === selected) || versions[0];

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={ML_RIBBON}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Caption1 style={{ padding: '4px 8px', color: tokens.colorNeutralForeground3 }}>
            Versions ({versions.length})
          </Caption1>
          {versions.length === 0 && !loading && (
            <Body1 style={{ padding: 8, color: tokens.colorNeutralForeground3 }}>No versions registered.</Body1>
          )}
          <Tree aria-label="Model versions">
            {versions.map((v) => (
              <TreeItem
                itemType="leaf"
                key={v.version}
                onClick={() => setSelected(v.version)}
                style={{ background: v.version === selected ? tokens.colorNeutralBackground2 : undefined }}
              >
                <TreeItemLayout>
                  v{v.version}
                  {model?.latestVersion === v.version && (
                    <Badge appearance="tint" color="brand" style={{ marginLeft: 8 }}>latest</Badge>
                  )}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading model…" labelPosition="after" />}
          {error && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody>
            </MessageBar>
          )}
          {model && !loading && !error && (
            <>
              <Subtitle2>{model.name}</Subtitle2>
              {model.description && <Body1>{model.description}</Body1>}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Badge appearance="tint">Latest: v{model.latestVersion || '—'}</Badge>
                <Badge appearance="tint">{versions.length} version(s)</Badge>
              </div>
              <Subtitle2 style={{ marginTop: 8 }}>Versions</Subtitle2>
              <Table aria-label="Model versions" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Version</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Created</TableHeaderCell>
                  <TableHeaderCell>URI</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {versions.map((v) => (
                    <TableRow key={v.version}>
                      <TableCell><strong>v{v.version}</strong></TableCell>
                      <TableCell>{v.modelType || '—'}</TableCell>
                      <TableCell>{v.createdAt || '—'}</TableCell>
                      <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{v.modelUri || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {current && (
                <>
                  <Subtitle2 style={{ marginTop: 8 }}>Selected: v{current.version}</Subtitle2>
                  {current.description && <Body1>{current.description}</Body1>}
                  {current.tags && Object.keys(current.tags).length > 0 && (
                    <div>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Tags</Caption1>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                        {Object.entries(current.tags).map(([k, v]) => (
                          <Badge key={k} appearance="outline">{k}={String(v)}</Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      }
    />
  );
}

// ----- ML Experiment -----
const MLE_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Runs', actions: [{ label: 'Reload' }, { label: 'Register model' }] },
    { label: 'Charts', actions: [{ label: 'Parallel coordinates' }, { label: 'Scatter' }] },
  ]},
];

interface FoundryJob {
  id: string; name: string; displayName?: string; jobType?: string;
  experimentName?: string; status?: string; startTimeUtc?: string; endTimeUtc?: string;
  computeId?: string; description?: string;
  tags?: Record<string, string>; properties?: Record<string, string>;
}

export function MlExperimentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'job' | 'experiment' | null>(null);
  const [job, setJob] = useState<FoundryJob | null>(null);
  const [runs, setRuns] = useState<FoundryJob[]>([]);
  const [expName, setExpName] = useState<string>('');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/ml-experiment/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setLoading(false); return; }
      setKind(j.kind);
      if (j.kind === 'job') {
        setJob(j.job); setRuns([j.job]); setSelectedRun(j.job?.name || null);
      } else {
        setJob(null); setRuns(j.runs || []); setExpName(j.experimentName || '');
        setSelectedRun(j.runs?.[0]?.name || null);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const current = runs.find((r) => r.name === selectedRun) || runs[0] || job;

  return (
    <ItemEditorChrome
      item={item}
      id={id}
      ribbon={MLE_RIBBON}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Caption1 style={{ padding: '4px 8px', color: tokens.colorNeutralForeground3 }}>
            Runs ({runs.length})
          </Caption1>
          <Tree aria-label="Runs">
            {runs.map((r) => (
              <TreeItem
                itemType="leaf"
                key={r.name}
                onClick={() => setSelectedRun(r.name)}
                style={{ background: r.name === selectedRun ? tokens.colorNeutralBackground2 : undefined }}
              >
                <TreeItemLayout>
                  <span style={{ fontSize: 12 }}>{r.displayName || r.name}</span>
                  {r.status && (
                    <Badge
                      appearance="tint"
                      color={r.status === 'Completed' ? 'success' : r.status === 'Failed' ? 'danger' : 'informative'}
                      style={{ marginLeft: 8 }}
                    >
                      {r.status}
                    </Badge>
                  )}
                </TreeItemLayout>
              </TreeItem>
            ))}
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          {loading && <Spinner size="small" label="Loading runs…" labelPosition="after" />}
          {error && (
            <MessageBar intent="error">
              <MessageBarBody><MessageBarTitle>Load failed</MessageBarTitle>{error}</MessageBarBody>
            </MessageBar>
          )}
          {!loading && !error && kind === 'experiment' && (
            <>
              <Subtitle2>Experiment: {expName || '(unnamed)'}</Subtitle2>
              <Caption1>{runs.length} run(s)</Caption1>
            </>
          )}
          {!loading && !error && kind === 'job' && job && (
            <>
              <Subtitle2>{job.displayName || job.name}</Subtitle2>
              {job.experimentName && <Caption1>Experiment: {job.experimentName}</Caption1>}
            </>
          )}
          {!loading && !error && runs.length > 0 && (
            <>
              <Table aria-label="Runs" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Run</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Ended</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.name}>
                      <TableCell><strong>{r.displayName || r.name}</strong></TableCell>
                      <TableCell>{r.jobType || '—'}</TableCell>
                      <TableCell>{r.status || '—'}</TableCell>
                      <TableCell>{r.startTimeUtc || '—'}</TableCell>
                      <TableCell>{r.endTimeUtc || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {current && (
                <>
                  <Subtitle2 style={{ marginTop: 8 }}>Selected run: {current.displayName || current.name}</Subtitle2>
                  {current.description && <Body1>{current.description}</Body1>}
                  {current.properties && Object.keys(current.properties).length > 0 && (
                    <>
                      <Caption1 style={{ color: tokens.colorNeutralForeground3, marginTop: 8 }}>Properties / metrics</Caption1>
                      <Table aria-label="Properties" size="small">
                        <TableHeader><TableRow><TableHeaderCell>Key</TableHeaderCell><TableHeaderCell>Value</TableHeaderCell></TableRow></TableHeader>
                        <TableBody>
                          {Object.entries(current.properties).map(([k, v]) => (
                            <TableRow key={k}>
                              <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{k}</TableCell>
                              <TableCell style={{ fontFamily: 'monospace', fontSize: 12 }}>{String(v)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      }
    />
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
