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

import { useCallback, useEffect, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Dropdown, Option, Textarea,
  Tab, TabList, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Server20Regular,
  Pause20Regular, ArrowSync20Regular, Save20Regular,
} from '@fluentui/react-icons';
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
interface SparkPoolDTO {
  name: string;
  properties: {
    nodeSize?: string;
    sparkVersion?: string;
    nodeCount?: number;
    provisioningState?: string;
    autoScale?: { enabled: boolean; minNodeCount: number; maxNodeCount: number };
    autoPause?: { enabled: boolean; delayInMinutes: number };
  };
}
interface SparkBatchDTO {
  id: number;
  name?: string;
  state?: string;
  result?: string;
  appId?: string | null;
  submitterName?: string;
}

export function SynapseSparkPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [pools, setPools] = useState<SparkPoolDTO[]>([]);
  const [selected, setSelected] = useState<string>(id);
  const [pool, setPool] = useState<SparkPoolDTO | null>(null);
  const [batches, setBatches] = useState<SparkBatchDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('config');

  // submit-batch form
  const [jobName, setJobName] = useState('loom-smoke');
  const [jobFile, setJobFile] = useState('abfss://jobs@<storage>.dfs.core.windows.net/smoke.py');
  const [jobClass, setJobClass] = useState('');
  const [jobArgs, setJobArgs] = useState('');

  const loadPools = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch('/api/items/synapse-spark-pool/list');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'list failed');
      setPools(j.pools || []);
      if (j.pools?.length && !j.pools.find((p: SparkPoolDTO) => p.name === selected)) {
        setSelected(j.pools[0].name);
      }
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [selected]);

  const loadPool = useCallback(async (name: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'get failed');
      setPool(j.pool);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  const loadBatches = useCallback(async (name: string) => {
    try {
      const r = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(name)}/runs?size=20`);
      const j = await r.json();
      if (!j.ok) { setBatches([]); return; }
      setBatches(j.sessions || []);
    } catch { setBatches([]); }
  }, []);

  useEffect(() => { loadPools(); }, [loadPools]);
  useEffect(() => { if (selected) { loadPool(selected); loadBatches(selected); } }, [selected, loadPool, loadBatches]);

  const submit = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(selected)}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: jobName,
          file: jobFile,
          className: jobClass || undefined,
          args: jobArgs ? jobArgs.split(/\s+/).filter(Boolean) : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'submit failed');
      await loadBatches(selected);
      setTab('runs');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, jobName, jobFile, jobClass, jobArgs, loadBatches]);

  const setAutoPause = useCallback(async (action: 'pause' | 'resume') => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(selected)}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `${action} failed`);
      await loadPool(selected);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, loadPool]);

  const state = pool?.properties.provisioningState || 'Unknown';

  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_SPARK_RIBBON}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="Spark pools" defaultOpenItems={['pools']}>
            <TreeItem itemType="branch" value="pools">
              <TreeItemLayout iconBefore={<Server20Regular />}>Pools ({pools.length})</TreeItemLayout>
              <Tree>
                {pools.map((p) => (
                  <TreeItem key={p.name} itemType="leaf" value={`p-${p.name}`} onClick={() => setSelected(p.name)}>
                    <TreeItemLayout iconBefore={<Server20Regular />}>
                      {p.name} {selected === p.name && '·'}
                    </TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Badge appearance="filled" color={state === 'Succeeded' ? 'success' : state === 'Provisioning' ? 'warning' : 'informative'}>{state}</Badge>
            <Badge appearance="outline">{pool?.properties.nodeSize || '—'}</Badge>
            <Badge appearance="outline">{pool?.properties.sparkVersion || 'Spark —'}</Badge>
            <Badge appearance="outline">
              {pool?.properties.autoScale?.enabled
                ? `${pool.properties.autoScale.minNodeCount}-${pool.properties.autoScale.maxNodeCount} nodes`
                : `${pool?.properties.nodeCount ?? 0} nodes`}
            </Badge>
            <Button appearance="outline" icon={<Pause20Regular />} disabled={busy || !selected} onClick={() => setAutoPause('pause')}>Force pause</Button>
            <Button appearance="outline" icon={<ArrowSync20Regular />} disabled={busy || !selected} onClick={() => setAutoPause('resume')}>Reset auto-pause</Button>
            <Button appearance="outline" onClick={() => { if (selected) { loadPool(selected); loadBatches(selected); } }} style={{ marginLeft: 'auto' }}>Refresh</Button>
          </div>
          {loading && <Spinner size="tiny" label="Loading Spark pools…" labelPosition="after" />}
          {error && (
            <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Spark API error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
          )}
          <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
              <Tab value="config">Configuration</Tab>
              <Tab value="submit">Submit batch job</Tab>
              <Tab value="runs">Recent batches ({batches.length})</Tab>
            </TabList>
          </div>
          {tab === 'config' && (
            <div className={s.form}>
              <div className={s.row}>
                <div className={s.field}><Caption1>Pool name</Caption1><Input value={pool?.name || ''} readOnly /></div>
                <div className={s.field}><Caption1>Node size</Caption1><Input value={pool?.properties.nodeSize || ''} readOnly /></div>
              </div>
              <div className={s.row}>
                <div className={s.field}><Caption1>Spark version</Caption1><Input value={pool?.properties.sparkVersion || ''} readOnly /></div>
                <div className={s.field}><Caption1>Auto-pause (min)</Caption1><Input value={String(pool?.properties.autoPause?.delayInMinutes ?? '—')} readOnly /></div>
              </div>
              <div className={s.row}>
                <div className={s.field}><Caption1>Autoscale min</Caption1><Input value={String(pool?.properties.autoScale?.minNodeCount ?? '—')} readOnly /></div>
                <div className={s.field}><Caption1>Autoscale max</Caption1><Input value={String(pool?.properties.autoScale?.maxNodeCount ?? '—')} readOnly /></div>
              </div>
              <Caption1>Edit via Synapse Studio for now; v2.2 wires inline PUT.</Caption1>
            </div>
          )}
          {tab === 'submit' && (
            <div className={s.form}>
              <div className={s.field}><Caption1>Job name</Caption1><Input value={jobName} onChange={(_, d) => setJobName(d.value)} /></div>
              <div className={s.field}><Caption1>File (abfss:// or wasbs:// URI to .py / .jar)</Caption1><Input value={jobFile} onChange={(_, d) => setJobFile(d.value)} /></div>
              <div className={s.row}>
                <div className={s.field}><Caption1>Main class (JAR only)</Caption1><Input value={jobClass} onChange={(_, d) => setJobClass(d.value)} placeholder="com.example.Main" /></div>
                <div className={s.field}><Caption1>Args (space-separated)</Caption1><Input value={jobArgs} onChange={(_, d) => setJobArgs(d.value)} /></div>
              </div>
              <Button appearance="primary" icon={<Play20Regular />} disabled={busy || !selected} onClick={submit}>
                {busy ? 'Submitting…' : 'Submit batch'}
              </Button>
            </div>
          )}
          {tab === 'runs' && (
            <div style={{ overflow: 'auto' }}>
              <Table aria-label="Recent batches" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Id</TableHeaderCell>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                  <TableHeaderCell>Result</TableHeaderCell>
                  <TableHeaderCell>App</TableHeaderCell>
                  <TableHeaderCell>Submitter</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {batches.length === 0 && (
                    <TableRow><TableCell colSpan={6}><Caption1>No recent batches.</Caption1></TableCell></TableRow>
                  )}
                  {batches.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell>{b.id}</TableCell>
                      <TableCell>{b.name || '—'}</TableCell>
                      <TableCell>{b.state || '—'}</TableCell>
                      <TableCell>
                        {b.result && (
                          <Badge appearance="filled" color={b.result === 'Succeeded' ? 'success' : b.result === 'Failed' ? 'danger' : 'informative'}>{b.result}</Badge>
                        )}
                      </TableCell>
                      <TableCell><code>{b.appId || '—'}</code></TableCell>
                      <TableCell>{b.submitterName || '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      }
    />
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
interface PipelineDTO {
  name: string;
  properties: { activities?: unknown[]; description?: string; parameters?: Record<string, { type: string; defaultValue?: unknown }> };
}
interface PipelineRunDTO {
  runId: string;
  pipelineName: string;
  status?: string;
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  message?: string;
  invokedBy?: { name?: string; invokedByType?: string };
}

export function SynapsePipelineEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [pipelines, setPipelines] = useState<PipelineDTO[]>([]);
  const [selected, setSelected] = useState<string>(id);
  const [spec, setSpec] = useState<string>('');
  const [origSpec, setOrigSpec] = useState<string>('');
  const [runs, setRuns] = useState<PipelineRunDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'json' | 'runs'>('json');

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/items/synapse-pipeline/list');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'list failed');
      setPipelines(j.pipelines || []);
      if (j.pipelines?.length && !j.pipelines.find((p: PipelineDTO) => p.name === selected)) {
        setSelected(j.pipelines[0].name);
      }
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [selected]);

  const loadPipeline = useCallback(async (name: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'get failed');
      const txt = JSON.stringify(j.pipeline, null, 2);
      setSpec(txt); setOrigSpec(txt);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  const loadRuns = useCallback(async (name: string) => {
    try {
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(name)}/runs`);
      const j = await r.json();
      if (!j.ok) { setRuns([]); return; }
      setRuns(j.runs || []);
    } catch { setRuns([]); }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (selected) { loadPipeline(selected); loadRuns(selected); } }, [selected, loadPipeline, loadRuns]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const parsed = JSON.parse(spec);
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(selected)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      setOrigSpec(spec);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, spec]);

  const run = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(selected)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'run failed');
      // give Synapse a beat to register, then refresh runs
      setTimeout(() => loadRuns(selected), 1500);
      setTab('runs');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, loadRuns]);

  const dirty = spec !== origSpec;
  const activityCount = (() => {
    try { return (JSON.parse(spec)?.properties?.activities || []).length; } catch { return 0; }
  })();

  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_PIPE_RIBBON}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="Pipelines" defaultOpenItems={['p']}>
            <TreeItem itemType="branch" value="p">
              <TreeItemLayout iconBefore={<Server20Regular />}>Pipelines ({pipelines.length})</TreeItemLayout>
              <Tree>
                {pipelines.map((p) => (
                  <TreeItem key={p.name} itemType="leaf" value={`pl-${p.name}`} onClick={() => setSelected(p.name)}>
                    <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{p.name} {selected === p.name && '·'}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
        </div>
      }
      main={
        <div className={s.pad}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge appearance="filled" color="brand">{selected || '(no pipeline)'}</Badge>
            <Badge appearance="outline">{activityCount} activities</Badge>
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
            <Button appearance="outline" icon={<Save20Regular />} disabled={busy || !dirty} onClick={save}>Save</Button>
            <Button appearance="primary" icon={<Play20Regular />} disabled={busy || !selected || dirty} onClick={run}>Run</Button>
            <Button appearance="outline" onClick={() => { if (selected) { loadPipeline(selected); loadRuns(selected); } }} style={{ marginLeft: 'auto' }}>Refresh</Button>
          </div>
          {error && (
            <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Pipeline API error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
          )}
          <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'json' | 'runs')}>
              <Tab value="json">Spec (JSON)</Tab>
              <Tab value="runs">Run history ({runs.length})</Tab>
            </TabList>
          </div>
          {tab === 'json' && (
            <textarea
              className={s.monaco}
              spellCheck={false}
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              aria-label="Pipeline spec editor"
              style={{ minHeight: 360 }}
            />
          )}
          {tab === 'runs' && (
            <div style={{ overflow: 'auto' }}>
              <Table aria-label="Pipeline runs" size="small">
                <TableHeader><TableRow>
                  <TableHeaderCell>Run ID</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Start</TableHeaderCell>
                  <TableHeaderCell>Duration</TableHeaderCell>
                  <TableHeaderCell>Invoked by</TableHeaderCell>
                </TableRow></TableHeader>
                <TableBody>
                  {runs.length === 0 && (
                    <TableRow><TableCell colSpan={5}><Caption1>No runs in last 7 days.</Caption1></TableCell></TableRow>
                  )}
                  {runs.map((r) => (
                    <TableRow key={r.runId}>
                      <TableCell><code style={{ fontSize: 11 }}>{r.runId.slice(0, 8)}…</code></TableCell>
                      <TableCell>
                        <Badge appearance="filled" color={r.status === 'Succeeded' ? 'success' : r.status === 'Failed' ? 'danger' : r.status === 'InProgress' ? 'warning' : 'informative'}>{r.status || '—'}</Badge>
                      </TableCell>
                      <TableCell>{r.runStart ? new Date(r.runStart).toLocaleString() : '—'}</TableCell>
                      <TableCell>{r.durationInMs != null ? `${(r.durationInMs / 1000).toFixed(1)}s` : '—'}</TableCell>
                      <TableCell>{r.invokedBy?.name || '—'} <Caption1>({r.invokedBy?.invokedByType || '—'})</Caption1></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      }
    />
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
