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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Badge, Button, Input, Dropdown, Option, Textarea,
  Tab, TabList, Spinner, Switch, Field,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tree, TreeItem, TreeItemLayout,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Database20Regular, DocumentTable20Regular, Play20Regular, Server20Regular,
  Pause20Regular, ArrowSync20Regular, Save20Regular,
} from '@fluentui/react-icons';
import { ItemEditorChrome } from './item-editor-chrome';
import { BackendStateBar } from '@/lib/components/backend-state-bar';
import { extractActivities, writeActivitiesToSpec, type PipelineActivity } from '@/lib/components/pipeline/pipeline-dag-view';
import { PipelineDesigner } from '@/lib/components/pipeline/pipeline-designer';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { ComputePicker } from '@/lib/components/compute-picker';

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
// v3.28: replaced the previous stand-in (fake "DW400c · Online · 100 rows · 2.3 s"
// badges + dead Run button + hard-coded T-SQL in a defaultValue textarea) with
// an honest stub per `no-vaporware.md`. The slug `synapse-dedicated-sql-pool`
// is actually routed by `registry.ts` to the real wired editor in
// `synapse-sql-editors.tsx`, so this duplicate is never loaded — but keeping
// the export here as an honest placeholder so anyone reaching it via direct
// import sees the redirect.
export function SynapseDedicatedSqlPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_DSQL_RIBBON}
      main={
        <div className={s.pad}>
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>This is the legacy stub — use the wired editor</MessageBarTitle>
              The real Synapse Dedicated SQL pool editor is in <code>synapse-sql-editors.tsx</code> and is
              the one the catalog actually loads. It runs T-SQL through the BFF, lists databases via ARM,
              and renders real rows. This stub was a pre-wiring sketch and exposed fake badges + a dead Run
              button, which violates the no-vaporware rule.
            </MessageBarBody>
          </MessageBar>
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
// v3.28: see comment on SynapseDedicatedSqlPoolEditor above. Same rule.
export function SynapseServerlessSqlPoolEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={SYN_SSQL_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This is the legacy stub — use the wired editor</MessageBarTitle>
            The real Synapse Serverless SQL pool editor is in <code>synapse-sql-editors.tsx</code> and runs
            OPENROWSET via the BFF. The previous body showed a hard-coded query in a defaultValue textarea
            with a fake "Estimated cost: ~$0.012" caption — both violate no-vaporware.
          </MessageBarBody>
        </MessageBar>
      </div>
    } />
  );
}

// ============================================================
// Synapse — Spark pool
// ============================================================
// (Ribbon defined inside the component via useMemo so onClick handlers can
// reference inline state. See SynapseSparkPoolEditor body.)
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

  // Scale dialog
  const [scaleOpen, setScaleOpen] = useState(false);
  const [scaleMode, setScaleMode] = useState<'fixed' | 'autoscale'>('autoscale');
  const [scaleNodeCount, setScaleNodeCount] = useState(3);
  const [scaleMin, setScaleMin] = useState(3);
  const [scaleMax, setScaleMax] = useState(10);
  const [scaleError, setScaleError] = useState<string | null>(null);

  // Auto-pause dialog
  const [apOpen, setApOpen] = useState(false);
  const [apEnabled, setApEnabled] = useState(true);
  const [apDelay, setApDelay] = useState(15);
  const [apError, setApError] = useState<string | null>(null);

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

  const openScaleDialog = useCallback(() => {
    if (pool?.properties.autoScale?.enabled) {
      setScaleMode('autoscale');
      setScaleMin(pool.properties.autoScale.minNodeCount || 3);
      setScaleMax(pool.properties.autoScale.maxNodeCount || 10);
    } else {
      setScaleMode('fixed');
      setScaleNodeCount(pool?.properties.nodeCount || 3);
    }
    setScaleError(null);
    setScaleOpen(true);
  }, [pool]);

  const applyScale = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setScaleError(null);
    try {
      const body =
        scaleMode === 'fixed'
          ? { nodeCount: scaleNodeCount }
          : { autoScale: { enabled: true, minNodeCount: scaleMin, maxNodeCount: scaleMax } };
      const r = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(selected)}/scale`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `scale failed (${r.status})`);
      setScaleOpen(false);
      await loadPool(selected);
    } catch (e: any) { setScaleError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, scaleMode, scaleNodeCount, scaleMin, scaleMax, loadPool]);

  const openApDialog = useCallback(() => {
    setApEnabled(pool?.properties.autoPause?.enabled ?? true);
    setApDelay(pool?.properties.autoPause?.delayInMinutes ?? 15);
    setApError(null);
    setApOpen(true);
  }, [pool]);

  const applyAutoPause = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setApError(null);
    try {
      const r = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(selected)}/auto-pause`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: apEnabled, delayInMinutes: apEnabled ? apDelay : undefined }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `auto-pause update failed (${r.status})`);
      setApOpen(false);
      await loadPool(selected);
    } catch (e: any) { setApError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, apEnabled, apDelay, loadPool]);

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

  // Ribbon — wires Submit Spark job to inline `submit`; Scale/Pause/Auto-pause/Open notebook
  // remain honestly disabled until their flows land.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Pool', actions: [
        { label: 'Scale', onClick: selected && !busy ? openScaleDialog : undefined, disabled: !selected || busy, title: !selected ? 'Select a pool first' : undefined },
        { label: 'Pause', disabled: true, title: 'Pause — use the Force pause button below (auto-pause runs via Synapse policy)' },
        { label: 'Auto-pause', onClick: selected && !busy ? openApDialog : undefined, disabled: !selected || busy, title: !selected ? 'Select a pool first' : undefined },
      ]},
      { label: 'Run', actions: [
        { label: 'Open notebook', disabled: true, title: 'Open notebook — use the Synapse Notebook editor (synapse-notebook slug)' },
        { label: busy ? 'Submitting…' : 'Submit Spark job', onClick: !busy && selected ? () => { setTab('submit'); submit(); } : undefined, disabled: busy || !selected, title: !selected ? 'Select a pool first' : undefined },
      ]},
    ]},
  ], [busy, selected, submit, openScaleDialog, openApDialog]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
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
          {/*
           * Cross-editor consistency: surface the shared ComputePicker so
           * users navigating between editors see the same pool selector +
           * state UI. The left-side Tree remains authoritative for pool
           * detail loading; this picker mirrors selection via the "spark:"
           * id prefix used by /api/loom/compute-targets.
           */}
          <ComputePicker
            label="Compute target"
            filter={['synapse-spark']}
            value={selected ? `spark:${selected}` : ''}
            onChange={(picked) => {
              const bare = picked.startsWith('spark:') ? picked.slice('spark:'.length) : picked;
              if (bare) setSelected(bare);
            }}
            showLifecycle={false}
          />
          {loading && <Spinner size="tiny" label="Loading Spark pools…" labelPosition="after" />}
          {error && (
            <BackendStateBar error={error} title="Spark API" />
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

          <Dialog open={scaleOpen} onOpenChange={(_, d) => setScaleOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Scale Spark pool — {selected}</DialogTitle>
                <DialogContent>
                  <Field label="Mode">
                    <Dropdown
                      value={scaleMode === 'fixed' ? 'Fixed node count' : 'Autoscale'}
                      selectedOptions={[scaleMode]}
                      onOptionSelect={(_, d) => setScaleMode((d.optionValue as 'fixed' | 'autoscale') || 'autoscale')}
                    >
                      <Option value="autoscale">Autoscale</Option>
                      <Option value="fixed">Fixed node count</Option>
                    </Dropdown>
                  </Field>
                  {scaleMode === 'fixed' ? (
                    <Field label="Node count (≥ 3)">
                      <Input type="number" min={3} value={String(scaleNodeCount)} onChange={(_, d) => setScaleNodeCount(Math.max(3, Number(d.value) || 3))} />
                    </Field>
                  ) : (
                    <>
                      <Field label="Min nodes (≥ 3)">
                        <Input type="number" min={3} value={String(scaleMin)} onChange={(_, d) => setScaleMin(Math.max(3, Number(d.value) || 3))} />
                      </Field>
                      <Field label="Max nodes">
                        <Input type="number" min={3} value={String(scaleMax)} onChange={(_, d) => setScaleMax(Math.max(scaleMin, Number(d.value) || scaleMin))} />
                      </Field>
                    </>
                  )}
                  {scaleError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Scale failed</MessageBarTitle>{scaleError}</MessageBarBody></MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setScaleOpen(false)} disabled={busy}>Cancel</Button>
                  <Button appearance="primary" onClick={applyScale} disabled={busy}>{busy ? 'Applying…' : 'Apply scale'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>

          <Dialog open={apOpen} onOpenChange={(_, d) => setApOpen(d.open)}>
            <DialogSurface>
              <DialogBody>
                <DialogTitle>Auto-pause — {selected}</DialogTitle>
                <DialogContent>
                  <Field label="Enable auto-pause">
                    <Switch checked={apEnabled} onChange={(_, d) => setApEnabled(d.checked)} label={apEnabled ? 'Enabled' : 'Disabled'} />
                  </Field>
                  {apEnabled && (
                    <Field label="Idle delay (minutes, ≥ 5)">
                      <Input type="number" min={5} value={String(apDelay)} onChange={(_, d) => setApDelay(Math.max(5, Number(d.value) || 5))} />
                    </Field>
                  )}
                  {apError && (
                    <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Update failed</MessageBarTitle>{apError}</MessageBarBody></MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setApOpen(false)} disabled={busy}>Cancel</Button>
                  <Button appearance="primary" onClick={applyAutoPause} disabled={busy}>{busy ? 'Applying…' : 'Apply'}</Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
        </div>
      }
    />
  );
}

// ============================================================
// Synapse — Pipeline
// ============================================================
// (Ribbon defined inside the component via useMemo.)
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
  const [tab, setTab] = useState<'graph' | 'json' | 'runs'>('graph');

  // Triggers dialog state — lists triggers wired to this pipeline and
  // lets the user start/stop or upsert a schedule trigger inline.
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [triggersList, setTriggersList] = useState<Array<{ name: string; type?: string; runtimeState?: string }>>([]);
  const [triggersBusy, setTriggersBusy] = useState(false);
  const [triggersError, setTriggersError] = useState<string | null>(null);
  const [newTriggerName, setNewTriggerName] = useState('');
  const [newTriggerHour, setNewTriggerHour] = useState(0);
  const [newTriggerMinute, setNewTriggerMinute] = useState(0);

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

  // Run-history date range + status filter — POST'd as query params to the
  // BFF, which passes them through to Synapse `queryPipelineRuns`. Default
  // window: last 7 days (the BFF computes that when `after` is unset).
  const [runsAfterDays, setRunsAfterDays] = useState<number>(7);
  const [runsStatus, setRunsStatus] = useState<string>('');

  const loadRuns = useCallback(async (name: string) => {
    try {
      const after = new Date(Date.now() - runsAfterDays * 24 * 60 * 60 * 1000).toISOString();
      const qs = new URLSearchParams({ after });
      if (runsStatus) qs.set('status', runsStatus);
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(name)}/runs?${qs.toString()}`);
      const j = await r.json();
      if (!j.ok) { setRuns([]); return; }
      setRuns(j.runs || []);
    } catch { setRuns([]); }
  }, [runsAfterDays, runsStatus]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { if (selected) { loadPipeline(selected); loadRuns(selected); } }, [selected, loadPipeline, loadRuns]);

  const save = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
    try {
      const parsed = JSON.parse(spec);
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(selected)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      setOrigSpec(spec);
      try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: selected } })); } catch {}
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

  // Synapse Studio Debug — createRun?isDebugRun=true. Same UX as Run
  // (kick off + flip to Runs tab) but Synapse tags the run as DebugRun
  // so the editor's run history can filter on it.
  const debug = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(selected)}/debug`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'debug failed');
      setTimeout(() => loadRuns(selected), 1500);
      setTab('runs');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, loadRuns]);

  const loadTriggers = useCallback(async (name: string) => {
    setTriggersError(null);
    try {
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(name)}/triggers`);
      const j = await r.json();
      if (!j.ok) { setTriggersList([]); setTriggersError(j.error || 'list triggers failed'); return; }
      setTriggersList((j.triggers || []).map((t: any) => ({
        name: t.name,
        type: t.properties?.type || t.type,
        runtimeState: t.properties?.runtimeState,
      })));
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
  }, []);

  const openTriggers = useCallback(() => {
    setTriggersOpen(true);
    if (selected) loadTriggers(selected);
  }, [selected, loadTriggers]);

  const triggerAction = useCallback(async (name: string, action: 'start' | 'stop' | 'delete') => {
    if (!selected) return;
    setTriggersBusy(true); setTriggersError(null);
    try {
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(selected)}/triggers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, action }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `${action} failed`);
      await loadTriggers(selected);
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
    finally { setTriggersBusy(false); }
  }, [selected, loadTriggers]);

  const createTrigger = useCallback(async () => {
    if (!selected || !newTriggerName.trim()) return;
    setTriggersBusy(true); setTriggersError(null);
    try {
      const now = new Date();
      now.setUTCSeconds(0, 0);
      const startTime = now.toISOString();
      const r = await fetch(`/api/items/synapse-pipeline/${encodeURIComponent(selected)}/triggers`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: newTriggerName.trim(),
          properties: {
            type: 'ScheduleTrigger',
            runtimeState: 'Stopped',
            typeProperties: {
              recurrence: {
                frequency: 'Day',
                interval: 1,
                startTime,
                timeZone: 'UTC',
                schedule: { hours: [newTriggerHour], minutes: [newTriggerMinute] },
              },
            },
          },
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create failed');
      setNewTriggerName('');
      await loadTriggers(selected);
    } catch (e: any) { setTriggersError(e?.message || String(e)); }
    finally { setTriggersBusy(false); }
  }, [selected, newTriggerName, newTriggerHour, newTriggerMinute, loadTriggers]);

  const dirty = spec !== origSpec;
  const activities = extractActivities(spec);
  const activityCount = activities.length;

  // v3.28 Phase 4.5: Ctrl+S triggers Save when dirty. Mirrors Synapse Studio + ADF.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selected && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, dirty, busy, save]);

  // Phase-2 palette: append a freshly-templated activity to
  // properties.activities[] and re-serialize the spec JSON.
  const addActivity = useCallback((activity: PipelineActivity) => {
    setSpec((prev) => {
      let parsed: any;
      try { parsed = JSON.parse(prev); }
      catch { return prev; } // bail if JSON is currently broken; user must fix it first
      if (!parsed.properties || typeof parsed.properties !== 'object') parsed.properties = {};
      if (!Array.isArray(parsed.properties.activities)) parsed.properties.activities = [];
      parsed.properties.activities.push(activity);
      return JSON.stringify(parsed, null, 2);
    });
  }, []);

  // Helper — name suffix scan for ribbon-palette templates. Walks the current
  // activities[] looking for `<prefix><n>` and returns the next free n.
  const nextActivityName = useCallback((prefix: string): string => {
    let max = 0;
    for (const a of activities) {
      const name = a.name || '';
      if (!name.startsWith(prefix)) continue;
      const tail = name.slice(prefix.length);
      if (!/^\d+$/.test(tail)) continue;
      const n = parseInt(tail, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${max + 1}`;
  }, [activities]);

  // Ribbon — wires Run to inline `run`, activity palette to existing `addActivity`,
  // Debug/Triggers honestly disabled per no-vaporware rule.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Activities', actions: [
        { label: 'Copy data', onClick: () => addActivity({ name: nextActivityName('Copy'), type: 'Copy', typeProperties: { source: {}, sink: {} }, dependsOn: [] }) },
        { label: 'Notebook', onClick: () => addActivity({ name: nextActivityName('Notebook'), type: 'SynapseNotebook', typeProperties: { notebook: { referenceName: '', type: 'NotebookReference' } }, dependsOn: [] }) },
        { label: 'Stored procedure', onClick: () => addActivity({ name: nextActivityName('SP'), type: 'SqlServerStoredProcedure', typeProperties: { storedProcedureName: '' }, dependsOn: [] }) },
        { label: 'Mapping data flow', onClick: () => addActivity({ name: nextActivityName('Dataflow'), type: 'ExecuteDataFlow', typeProperties: {}, dependsOn: [] }) },
      ]},
      { label: 'Run', actions: [
        { label: busy ? 'Running…' : 'Run', onClick: !busy && selected && !dirty ? run : undefined, disabled: busy || !selected || dirty, title: dirty ? 'Save the spec first' : (!selected ? 'Select a pipeline first' : undefined) },
        { label: busy ? 'Debugging…' : 'Debug', onClick: !busy && selected && !dirty ? debug : undefined, disabled: busy || !selected || dirty, title: dirty ? 'Save the spec first' : (!selected ? 'Select a pipeline first' : undefined) },
        { label: 'Triggers', onClick: selected ? openTriggers : undefined, disabled: !selected, title: !selected ? 'Select a pipeline first' : undefined },
      ]},
    ]},
  ], [addActivity, nextActivityName, busy, selected, dirty, run, debug, openTriggers]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
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
            <BackendStateBar error={error} title="Pipeline API" />
          )}
          <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'graph' | 'json' | 'runs')}>
              <Tab value="graph">Graph ({activityCount} act{activityCount === 1 ? '' : 's'})</Tab>
              <Tab value="json">Spec (JSON)</Tab>
              <Tab value="runs">Run history ({runs.length})</Tab>
            </TabList>
          </div>
          {tab === 'graph' && (
            <PipelineDesigner
              activities={activities as any}
              onActivitiesChange={(next) => setSpec((prev) => writeActivitiesToSpec(prev || '{"properties":{}}', next as any))}
            />
          )}
          {tab === 'json' && (
            <MonacoTextarea
              value={spec}
              onChange={setSpec}
              language="json"
              height={400}
              minHeight={320}
              ariaLabel="Pipeline spec editor"
            />
          )}
          {tab === 'runs' && (
            <div style={{ overflow: 'auto' }}>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                <Field label="Window">
                  <Dropdown
                    value={
                      runsAfterDays === 1 ? 'Last 24 hours' :
                      runsAfterDays === 14 ? 'Last 14 days' :
                      runsAfterDays === 30 ? 'Last 30 days' :
                      runsAfterDays === 45 ? 'Last 45 days (max retention)' :
                      'Last 7 days'
                    }
                    selectedOptions={[String(runsAfterDays)]}
                    onOptionSelect={(_, d) => d.optionValue && setRunsAfterDays(Number(d.optionValue) || 7)}
                  >
                    <Option value="1" text="Last 24 hours">Last 24 hours</Option>
                    <Option value="7" text="Last 7 days">Last 7 days</Option>
                    <Option value="14" text="Last 14 days">Last 14 days</Option>
                    <Option value="30" text="Last 30 days">Last 30 days</Option>
                    <Option value="45" text="Last 45 days (max retention)">Last 45 days (max retention)</Option>
                  </Dropdown>
                </Field>
                <Field label="Status">
                  <Dropdown
                    value={runsStatus || 'Any'}
                    selectedOptions={[runsStatus]}
                    onOptionSelect={(_, d) => setRunsStatus(d.optionValue || '')}
                  >
                    <Option value="" text="Any">Any</Option>
                    <Option value="Succeeded" text="Succeeded">Succeeded</Option>
                    <Option value="Failed" text="Failed">Failed</Option>
                    <Option value="InProgress" text="In progress">In progress</Option>
                    <Option value="Cancelled" text="Cancelled">Cancelled</Option>
                    <Option value="Queued" text="Queued">Queued</Option>
                  </Dropdown>
                </Field>
                <Button appearance="outline" icon={<ArrowSync20Regular />} onClick={() => { if (selected) loadRuns(selected); }} disabled={!selected}>
                  Apply filter
                </Button>
              </div>
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

          <Dialog open={triggersOpen} onOpenChange={(_, d) => setTriggersOpen(d.open)}>
            <DialogSurface style={{ maxWidth: '760px', width: '90vw' }}>
              <DialogBody>
                <DialogTitle>Triggers — {selected}</DialogTitle>
                <DialogContent>
                  <Caption1>Triggers that reference this pipeline. Start/stop or create a daily schedule trigger inline.</Caption1>
                  <div style={{ overflow: 'auto', marginTop: 8, marginBottom: 12 }}>
                    <Table aria-label="Triggers for pipeline" size="small">
                      <TableHeader><TableRow>
                        <TableHeaderCell>Name</TableHeaderCell>
                        <TableHeaderCell>Type</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow></TableHeader>
                      <TableBody>
                        {triggersList.length === 0 && (
                          <TableRow><TableCell colSpan={4}><Caption1>No triggers wired to this pipeline.</Caption1></TableCell></TableRow>
                        )}
                        {triggersList.map((t) => (
                          <TableRow key={t.name}>
                            <TableCell><strong>{t.name}</strong></TableCell>
                            <TableCell><code>{t.type || '—'}</code></TableCell>
                            <TableCell>
                              <Badge appearance="filled" color={t.runtimeState === 'Started' ? 'success' : t.runtimeState === 'Stopped' ? 'informative' : 'warning'}>
                                {t.runtimeState || '—'}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div style={{ display: 'flex', gap: 4 }}>
                                <Button size="small" disabled={triggersBusy || t.runtimeState === 'Started'} onClick={() => triggerAction(t.name, 'start')}>Start</Button>
                                <Button size="small" disabled={triggersBusy || t.runtimeState !== 'Started'} onClick={() => triggerAction(t.name, 'stop')}>Stop</Button>
                                <Button size="small" appearance="subtle" disabled={triggersBusy} onClick={() => triggerAction(t.name, 'delete')}>Delete</Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <Subtitle2>Create new daily schedule trigger</Subtitle2>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginTop: 8 }}>
                    <Field label="Name">
                      <Input value={newTriggerName} onChange={(_, d) => setNewTriggerName(d.value)} placeholder="daily-orders" />
                    </Field>
                    <Field label="UTC hour (0-23)">
                      <Input type="number" min={0} max={23} value={String(newTriggerHour)} onChange={(_, d) => setNewTriggerHour(Math.max(0, Math.min(23, Number(d.value) || 0)))} />
                    </Field>
                    <Field label="Minute (0-59)">
                      <Input type="number" min={0} max={59} value={String(newTriggerMinute)} onChange={(_, d) => setNewTriggerMinute(Math.max(0, Math.min(59, Number(d.value) || 0)))} />
                    </Field>
                  </div>

                  {triggersError && (
                    <MessageBar intent="error" style={{ marginTop: 12 }}>
                      <MessageBarBody><MessageBarTitle>Trigger action failed</MessageBarTitle>{triggersError}</MessageBarBody>
                    </MessageBar>
                  )}
                </DialogContent>
                <DialogActions>
                  <Button appearance="secondary" onClick={() => setTriggersOpen(false)} disabled={triggersBusy}>Close</Button>
                  <Button appearance="primary" onClick={createTrigger} disabled={triggersBusy || !newTriggerName.trim()}>
                    {triggersBusy ? 'Working…' : 'Create trigger'}
                  </Button>
                </DialogActions>
              </DialogBody>
            </DialogSurface>
          </Dialog>
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
// v3.28: legacy stub. Real Databricks Notebook editor is in
// `databricks-editors.tsx` (wired to /api/items/databricks-notebook/* via
// the Databricks Workspace + Jobs REST API). The previous body faked "Attached:
// ml-jobs-cluster (i3.xlarge, 4 workers)" badges + dead Run button + textareas
// with hard-coded code — no-vaporware violation.
export function DatabricksNotebookEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_NB_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This is the legacy stub — use the wired editor</MessageBarTitle>
            The catalog routes the <code>databricks-notebook</code> slug to the real implementation in
            <code> databricks-editors.tsx</code>. That editor lists notebooks via the Databricks Workspace API,
            opens cells in Monaco, and runs jobs through the Jobs REST API.
          </MessageBarBody>
        </MessageBar>
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
// v3.28: legacy stub — see DatabricksNotebookEditor comment. The previous body
// rendered five fake job rows (ingest_raw / silver_enrich / etc.) and a fake
// schedule/status line. The wired Databricks Job editor in
// `databricks-editors.tsx` lists real jobs and run history.
export function DatabricksJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_JOB_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This is the legacy stub — use the wired editor</MessageBarTitle>
            The <code>databricks-job</code> slug is routed by the catalog to the real editor in
            <code> databricks-editors.tsx</code> which queries the Databricks Jobs REST API.
          </MessageBarBody>
        </MessageBar>
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
// v3.28: legacy stub — see DatabricksNotebookEditor comment. The previous body
// pretended a cluster was Running on "14.3 LTS (Photon)" with hard-coded
// defaultValue Inputs (Standard_DS3_v2, 2-8 autoscale, etc.). No backend was
// wired. The wired editor is in `databricks-editors.tsx`.
export function DatabricksClusterEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_CLUSTER_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This is the legacy stub — use the wired editor</MessageBarTitle>
            The <code>databricks-cluster</code> slug routes to the real editor in
            <code> databricks-editors.tsx</code> which queries the Databricks Clusters REST API and supports
            Start / Restart / Terminate against real cluster IDs.
          </MessageBarBody>
        </MessageBar>
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
// v3.28: legacy stub — see DatabricksNotebookEditor comment. Previous body had
// hard-coded "Serverless · Medium", fake Running badge, and a defaultValue
// textarea — all dead. Real editor in `databricks-editors.tsx`.
export function DatabricksSqlWarehouseEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBX_SQLW_RIBBON} main={
      <div className={s.pad}>
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>This is the legacy stub — use the wired editor</MessageBarTitle>
            The <code>databricks-sql-warehouse</code> slug routes to the real editor in
            <code> databricks-editors.tsx</code> which submits real SQL through the Databricks SQL Statements API.
          </MessageBarBody>
        </MessageBar>
      </div>
    } />
  );
}

// ============================================================
// Azure Data Factory — Pipeline (real-REST against adf-loom-*)
// ============================================================
// (Ribbon defined inside the component via useMemo.)

interface AdfPipelineDTO {
  name: string;
  properties: { activities?: unknown[]; description?: string; parameters?: Record<string, { type: string; defaultValue?: unknown }> };
}
interface AdfPipelineRunDTO {
  runId: string;
  pipelineName: string;
  status?: string;
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  message?: string;
  invokedBy?: { name?: string; invokedByType?: string };
}

export function AdfPipelineEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [pipelines, setPipelines] = useState<AdfPipelineDTO[]>([]);
  const [selected, setSelected] = useState<string>(id);
  const [spec, setSpec] = useState<string>('');
  const [origSpec, setOrigSpec] = useState<string>('');
  const [runs, setRuns] = useState<AdfPipelineRunDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'graph' | 'json' | 'runs'>('graph');

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/items/adf-pipeline');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'list failed');
      setPipelines(j.pipelines || []);
      if (j.pipelines?.length && !j.pipelines.find((p: AdfPipelineDTO) => p.name === selected)) {
        setSelected(j.pipelines[0].name);
      }
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [selected]);

  const loadPipeline = useCallback(async (name: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/items/adf-pipeline/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'get failed');
      const txt = JSON.stringify(j.pipeline, null, 2);
      setSpec(txt); setOrigSpec(txt);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  const loadRuns = useCallback(async (name: string) => {
    try {
      const r = await fetch(`/api/items/adf-pipeline/${encodeURIComponent(name)}/runs`);
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
    try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
    try {
      const parsed = JSON.parse(spec);
      const r = await fetch(`/api/items/adf-pipeline/${encodeURIComponent(selected)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      setOrigSpec(spec);
      try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: selected } })); } catch {}
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, spec]);

  const run = useCallback(async () => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/items/adf-pipeline/${encodeURIComponent(selected)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'run failed');
      setTimeout(() => loadRuns(selected), 1500);
      setTab('runs');
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, loadRuns]);

  const createNew = useCallback(async () => {
    const name = window.prompt('New pipeline name (letters, digits, _ -)');
    if (!name) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/items/adf-pipeline', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, properties: { activities: [] } }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create failed');
      await loadList();
      setSelected(name);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [loadList]);

  const dirty = spec !== origSpec;
  const activityCount = (() => {
    try { return (JSON.parse(spec)?.properties?.activities || []).length; } catch { return 0; }
  })();

  // v3.28 Phase 4.5: Ctrl+S to save when dirty. Matches ADF Studio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selected && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, dirty, busy, save]);

  // Phase-2 palette: append a freshly-templated activity to
  // properties.activities[] and re-serialize the spec JSON.
  const addActivity = useCallback((activity: PipelineActivity) => {
    setSpec((prev) => {
      let parsed: any;
      try { parsed = JSON.parse(prev); }
      catch { return prev; }
      if (!parsed.properties || typeof parsed.properties !== 'object') parsed.properties = {};
      if (!Array.isArray(parsed.properties.activities)) parsed.properties.activities = [];
      parsed.properties.activities.push(activity);
      return JSON.stringify(parsed, null, 2);
    });
  }, []);

  // Name-suffix helper for ribbon palette templates. Scans the activities[]
  // in the current spec for `<prefix><n>` and returns next free name.
  const nextActivityName = useCallback((prefix: string): string => {
    let acts: any[] = [];
    try { acts = JSON.parse(spec)?.properties?.activities || []; } catch { /* ignore */ }
    let max = 0;
    for (const a of acts) {
      const name = a?.name || '';
      if (!name.startsWith(prefix)) continue;
      const tail = name.slice(prefix.length);
      if (!/^\d+$/.test(tail)) continue;
      const n = parseInt(tail, 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `${prefix}${max + 1}`;
  }, [spec]);

  // Ribbon — Publish all wires to inline `save`; activity palette wires to addActivity;
  // Debug/Add trigger disabled honestly per no-vaporware.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Activities', actions: [
        { label: 'Copy data', onClick: () => addActivity({ name: nextActivityName('Copy'), type: 'Copy', typeProperties: { source: {}, sink: {} }, dependsOn: [] }) },
        { label: 'Mapping data flow', onClick: () => addActivity({ name: nextActivityName('Dataflow'), type: 'ExecuteDataFlow', typeProperties: {}, dependsOn: [] }) },
        { label: 'Notebook', onClick: () => addActivity({ name: nextActivityName('Notebook'), type: 'DatabricksNotebook', typeProperties: { notebookPath: '' }, dependsOn: [] }) },
        { label: 'SP', onClick: () => addActivity({ name: nextActivityName('SP'), type: 'SqlServerStoredProcedure', typeProperties: { storedProcedureName: '' }, dependsOn: [] }) },
      ]},
      { label: 'Debug & run', actions: [
        { label: 'Debug', disabled: true, title: 'Debug — needs ADF createRun?isDebugRun=true BFF route (deferred)' },
        { label: 'Add trigger', disabled: true, title: 'Add trigger — use the ADF Trigger editor (adf-trigger slug)' },
        { label: busy ? 'Publishing…' : 'Publish all', onClick: !busy && dirty && selected ? save : undefined, disabled: busy || !dirty || !selected, title: !dirty ? 'No unsaved changes' : (!selected ? 'Select a pipeline first' : undefined) },
      ]},
    ]},
  ], [addActivity, nextActivityName, busy, dirty, selected, save]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="ADF pipelines" defaultOpenItems={['p']}>
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
          <Button size="small" appearance="outline" onClick={createNew} style={{ marginTop: 8 }}>+ New pipeline</Button>
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
            <BackendStateBar error={error} title="ADF Pipeline" />
          )}
          <div style={{ borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}>
            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'graph' | 'json' | 'runs')}>
              <Tab value="graph">Graph ({activityCount} act{activityCount === 1 ? '' : 's'})</Tab>
              <Tab value="json">Spec (JSON)</Tab>
              <Tab value="runs">Run history ({runs.length})</Tab>
            </TabList>
          </div>
          {tab === 'graph' && (
            <PipelineDesigner
              activities={extractActivities(spec) as any}
              onActivitiesChange={(next) => setSpec((prev) => writeActivitiesToSpec(prev || '{"properties":{}}', next as any))}
            />
          )}
          {tab === 'json' && (
            <MonacoTextarea
              value={spec}
              onChange={setSpec}
              language="json"
              height={400}
              minHeight={320}
              ariaLabel="ADF pipeline spec editor"
            />
          )}
          {tab === 'runs' && (
            <div style={{ overflow: 'auto' }}>
              <Table aria-label="ADF pipeline runs" size="small">
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
// Azure Data Factory — Dataset (real-REST)
// ============================================================
// (Ribbon defined inside the component via useMemo.)

interface AdfDatasetDTO {
  name: string;
  properties: {
    type: string;
    linkedServiceName?: { referenceName: string; type: 'LinkedServiceReference' };
    schema?: Array<{ name?: string; type?: string }>;
    typeProperties?: Record<string, any>;
  };
}
interface AdfLinkedServiceDTO { name: string; properties: { type: string } }

const ADF_DATASET_TYPES = ['Parquet', 'DelimitedText', 'Json', 'Avro', 'AzureSqlTable', 'AzureBlob'];

export function AdfDatasetEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [datasets, setDatasets] = useState<AdfDatasetDTO[]>([]);
  const [linkedServices, setLinkedServices] = useState<AdfLinkedServiceDTO[]>([]);
  const [selected, setSelected] = useState<string>(id);
  const [ds, setDs] = useState<AdfDatasetDTO | null>(null);
  const [type, setType] = useState<string>('Parquet');
  const [linkedService, setLinkedService] = useState<string>('');
  const [path, setPath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/items/adf-dataset');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'list failed');
      setDatasets(j.datasets || []);
      if (j.datasets?.length && !j.datasets.find((d: AdfDatasetDTO) => d.name === selected)) {
        setSelected(j.datasets[0].name);
      }
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [selected]);

  const loadLinkedServices = useCallback(async () => {
    try {
      const r = await fetch('/api/adf/linked-services');
      const j = await r.json();
      if (j.ok) setLinkedServices(j.linkedServices || []);
    } catch { /* ignore */ }
  }, []);

  const loadDataset = useCallback(async (name: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/items/adf-dataset/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'get failed');
      setDs(j.dataset);
      setType(j.dataset?.properties?.type || 'Parquet');
      setLinkedService(j.dataset?.properties?.linkedServiceName?.referenceName || '');
      const tp = j.dataset?.properties?.typeProperties || {};
      setPath(
        tp?.location?.folderPath
        ?? tp?.location?.fileName
        ?? tp?.tableName
        ?? tp?.fileName
        ?? '',
      );
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  useEffect(() => { loadList(); loadLinkedServices(); }, [loadList, loadLinkedServices]);
  useEffect(() => { if (selected) loadDataset(selected); }, [selected, loadDataset]);

  const save = useCallback(async () => {
    if (!selected || !linkedService) {
      setError('Pick a linked service.');
      return;
    }
    setBusy(true); setError(null);
    try {
      // Build a sensible typeProperties block per type
      let typeProperties: Record<string, any> = {};
      if (type === 'AzureSqlTable') {
        typeProperties = { schema: 'dbo', table: path };
      } else if (path) {
        // file-based: split folder / file if there's a slash
        const ix = path.lastIndexOf('/');
        const folder = ix >= 0 ? path.slice(0, ix) : '';
        const file = ix >= 0 ? path.slice(ix + 1) : path;
        typeProperties = {
          location: {
            type: 'AzureBlobFSLocation',
            fileName: file,
            folderPath: folder,
          },
        };
      }
      const body: AdfDatasetDTO = {
        name: selected,
        properties: {
          type,
          linkedServiceName: { referenceName: linkedService, type: 'LinkedServiceReference' },
          schema: ds?.properties.schema || [],
          typeProperties,
        },
      };
      try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
      const r = await fetch(`/api/items/adf-dataset/${encodeURIComponent(selected)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: selected } })); } catch {}
      await loadDataset(selected);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, linkedService, type, path, ds, loadDataset]);

  // v3.28 Phase 4.5: Ctrl+S triggers Save. Mirrors ADF Studio behavior.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selected && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, busy, save]);

  const createNew = useCallback(async () => {
    const name = window.prompt('New dataset name');
    if (!name || !linkedServices.length) {
      if (!linkedServices.length) setError('No linked services found. Create one in ADF Studio first.');
      return;
    }
    setBusy(true); setError(null);
    try {
      const body: AdfDatasetDTO = {
        name,
        properties: {
          type: 'Parquet',
          linkedServiceName: { referenceName: linkedServices[0].name, type: 'LinkedServiceReference' },
          typeProperties: { location: { type: 'AzureBlobFSLocation', fileName: '', folderPath: '' } },
        },
      };
      const r = await fetch('/api/items/adf-dataset', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create failed');
      await loadList();
      setSelected(name);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [linkedServices, loadList]);

  // Ribbon — Import schema deep-links to ADF Studio (no inline schema import BFF route);
  // Preview data honestly disabled until SELECT TOP 100 BFF lands.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Schema', actions: [
        { label: 'Import schema', disabled: true, title: 'Import schema — needs ADF datasets PUT with schema-import op (deferred; use ADF Studio for now)' },
        { label: 'Preview data', disabled: true, title: 'Preview data — needs SELECT TOP 100 BFF route' },
      ]},
    ]},
  ], []);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="ADF datasets" defaultOpenItems={['d']}>
            <TreeItem itemType="branch" value="d">
              <TreeItemLayout iconBefore={<Database20Regular />}>Datasets ({datasets.length})</TreeItemLayout>
              <Tree>
                {datasets.map((d) => (
                  <TreeItem key={d.name} itemType="leaf" value={`ds-${d.name}`} onClick={() => setSelected(d.name)}>
                    <TreeItemLayout iconBefore={<DocumentTable20Regular />}>{d.name} {selected === d.name && '·'}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
          <Button size="small" appearance="outline" onClick={createNew} style={{ marginTop: 8 }}>+ New dataset</Button>
        </div>
      }
      main={
        <div className={s.form}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Badge appearance="filled" color="brand">{selected || '(no dataset)'}</Badge>
            <Badge appearance="outline">{type}</Badge>
            <Button appearance="primary" icon={<Save20Regular />} disabled={busy || !selected} onClick={save} style={{ marginLeft: 'auto' }}>Save</Button>
          </div>
          {error && (
            <BackendStateBar error={error} title="ADF Dataset" />
          )}
          <Subtitle2>Dataset configuration</Subtitle2>
          <div className={s.row}>
            <div className={s.field}>
              <Caption1>Type</Caption1>
              <Dropdown value={type} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue || 'Parquet')}>
                {ADF_DATASET_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            </div>
            <div className={s.field}>
              <Caption1>Linked service ({linkedServices.length} available)</Caption1>
              <Dropdown value={linkedService} selectedOptions={[linkedService]} onOptionSelect={(_, d) => setLinkedService(d.optionValue || '')}>
                {linkedServices.map((ls) => <Option key={ls.name} value={ls.name}>{`${ls.name} (${ls.properties.type})`}</Option>)}
              </Dropdown>
            </div>
          </div>
          <div className={s.field}>
            <Caption1>{type === 'AzureSqlTable' ? 'Table name' : 'Path (folder/file or wildcard)'}</Caption1>
            <Input value={path} onChange={(_, d) => setPath(d.value)} placeholder={type === 'AzureSqlTable' ? 'dbo.FactSales' : 'raw/orders/year=2026/*.parquet'} />
          </div>
          <Subtitle2 style={{ marginTop: 8 }}>Schema ({ds?.properties.schema?.length || 0} columns)</Subtitle2>
          <Table aria-label="Schema" size="small">
            <TableHeader><TableRow><TableHeaderCell>Name</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {(ds?.properties.schema || []).length === 0 && (
                <TableRow><TableCell colSpan={2}><Caption1>No schema imported. Use ADF Studio "Import schema" to populate.</Caption1></TableCell></TableRow>
              )}
              {(ds?.properties.schema || []).map((c, i) => (
                <TableRow key={i}><TableCell><code>{c.name || '—'}</code></TableCell><TableCell>{c.type || '—'}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      }
    />
  );
}

// ============================================================
// Azure Data Factory — Trigger (real-REST)
// ============================================================
// (Ribbon defined inside the component via useMemo.)

interface AdfTriggerDTO {
  name: string;
  properties: {
    type: string;
    runtimeState?: 'Started' | 'Stopped' | 'Disabled';
    pipelines?: Array<{ pipelineReference: { referenceName: string; type: 'PipelineReference' }; parameters?: Record<string, unknown> }>;
    typeProperties?: Record<string, any>;
  };
}

const ADF_TRIGGER_TYPES = ['ScheduleTrigger', 'TumblingWindowTrigger', 'BlobEventsTrigger'];

export function AdfTriggerEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [triggers, setTriggers] = useState<AdfTriggerDTO[]>([]);
  const [pipelines, setPipelines] = useState<AdfPipelineDTO[]>([]);
  const [selected, setSelected] = useState<string>(id);
  const [tr, setTr] = useState<AdfTriggerDTO | null>(null);
  const [type, setType] = useState<string>('ScheduleTrigger');
  const [frequency, setFrequency] = useState<string>('Hour');
  const [interval, setIntervalMin] = useState<string>('1');
  const [timeZone, setTimeZone] = useState<string>('UTC');
  const [targetPipeline, setTargetPipeline] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/items/adf-trigger');
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'list failed');
      setTriggers(j.triggers || []);
      if (j.triggers?.length && !j.triggers.find((t: AdfTriggerDTO) => t.name === selected)) {
        setSelected(j.triggers[0].name);
      }
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [selected]);

  const loadPipelines = useCallback(async () => {
    try {
      const r = await fetch('/api/items/adf-pipeline');
      const j = await r.json();
      if (j.ok) setPipelines(j.pipelines || []);
    } catch { /* ignore */ }
  }, []);

  const loadTrigger = useCallback(async (name: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/items/adf-trigger/${encodeURIComponent(name)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'get failed');
      setTr(j.trigger);
      const p = j.trigger?.properties || {};
      setType(p.type || 'ScheduleTrigger');
      const recur = p.typeProperties?.recurrence;
      if (recur) {
        setFrequency(recur.frequency || 'Hour');
        setIntervalMin(String(recur.interval ?? '1'));
        setTimeZone(recur.timeZone || 'UTC');
      }
      setTargetPipeline(p.pipelines?.[0]?.pipelineReference?.referenceName || '');
    } catch (e: any) { setError(e?.message || String(e)); }
  }, []);

  useEffect(() => { loadList(); loadPipelines(); }, [loadList, loadPipelines]);
  useEffect(() => { if (selected) loadTrigger(selected); }, [selected, loadTrigger]);

  const save = useCallback(async () => {
    if (!selected || !targetPipeline) {
      setError('Pick a target pipeline.');
      return;
    }
    setBusy(true); setError(null);
    try {
      let typeProperties: Record<string, any> = {};
      if (type === 'ScheduleTrigger') {
        typeProperties = {
          recurrence: {
            frequency,
            interval: Number(interval) || 1,
            timeZone,
            startTime: new Date().toISOString(),
          },
        };
      } else if (type === 'TumblingWindowTrigger') {
        typeProperties = {
          frequency,
          interval: Number(interval) || 1,
          startTime: new Date().toISOString(),
          delay: '00:00:00',
          maxConcurrency: 1,
        };
      } else if (type === 'BlobEventsTrigger') {
        typeProperties = {
          blobPathBeginsWith: '/container/blobs/',
          events: ['Microsoft.Storage.BlobCreated'],
          scope: '',
        };
      }
      const body: AdfTriggerDTO = {
        name: selected,
        properties: {
          type,
          pipelines: [{
            pipelineReference: { referenceName: targetPipeline, type: 'PipelineReference' },
            parameters: {},
          }],
          typeProperties,
        },
      };
      try { window.dispatchEvent(new CustomEvent('loom:item-saving')); } catch {}
      const r = await fetch(`/api/items/adf-trigger/${encodeURIComponent(selected)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'save failed');
      try { window.dispatchEvent(new CustomEvent('loom:item-saved', { detail: { label: selected } })); } catch {}
      await loadTrigger(selected);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, targetPipeline, type, frequency, interval, timeZone, loadTrigger]);

  // v3.28 Phase 4.5: Ctrl+S triggers Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (selected && !busy && targetPipeline) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, busy, targetPipeline, save]);

  const setState = useCallback(async (action: 'start' | 'stop') => {
    if (!selected) return;
    setBusy(true); setError(null);
    try {
      const r = await fetch(`/api/items/adf-trigger/${encodeURIComponent(selected)}/state`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || `${action} failed`);
      await loadTrigger(selected);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [selected, loadTrigger]);

  const createNew = useCallback(async () => {
    const name = window.prompt('New trigger name');
    if (!name || !pipelines.length) {
      if (!pipelines.length) setError('No pipelines to attach to. Create one first.');
      return;
    }
    setBusy(true); setError(null);
    try {
      const body: AdfTriggerDTO = {
        name,
        properties: {
          type: 'ScheduleTrigger',
          pipelines: [{ pipelineReference: { referenceName: pipelines[0].name, type: 'PipelineReference' }, parameters: {} }],
          typeProperties: { recurrence: { frequency: 'Hour', interval: 1, timeZone: 'UTC', startTime: new Date().toISOString() } },
        },
      };
      const r = await fetch('/api/items/adf-trigger', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'create failed');
      await loadList();
      setSelected(name);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [pipelines, loadList]);

  const runtimeState = tr?.properties.runtimeState || 'Stopped';

  // Ribbon — Start/Stop wire to inline setState; Recurrence/Parameters honestly disabled
  // (the form fields below are the actual edit surface).
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'State', actions: [
        { label: 'Start', onClick: !busy && selected && runtimeState !== 'Started' ? () => setState('start') : undefined, disabled: busy || !selected || runtimeState === 'Started', title: runtimeState === 'Started' ? 'Trigger already started' : (!selected ? 'Select a trigger first' : undefined) },
        { label: 'Stop', onClick: !busy && selected && runtimeState === 'Started' ? () => setState('stop') : undefined, disabled: busy || !selected || runtimeState !== 'Started', title: runtimeState !== 'Started' ? 'Trigger is not started' : undefined },
      ]},
      { label: 'Edit', actions: [
        { label: 'Recurrence', disabled: true, title: 'Recurrence — use the Frequency / Interval / Time zone fields in the form below' },
        { label: 'Parameters', disabled: true, title: 'Parameters — needs pipeline-parameter pass-through editor (deferred)' },
      ]},
    ]},
  ], [busy, selected, runtimeState, setState]);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon}
      leftPanel={
        <div style={{ padding: 8 }}>
          <Tree aria-label="ADF triggers" defaultOpenItems={['t']}>
            <TreeItem itemType="branch" value="t">
              <TreeItemLayout iconBefore={<Server20Regular />}>Triggers ({triggers.length})</TreeItemLayout>
              <Tree>
                {triggers.map((t) => (
                  <TreeItem key={t.name} itemType="leaf" value={`tr-${t.name}`} onClick={() => setSelected(t.name)}>
                    <TreeItemLayout iconBefore={<ArrowSync20Regular />}>{t.name} {selected === t.name && '·'}</TreeItemLayout>
                  </TreeItem>
                ))}
              </Tree>
            </TreeItem>
          </Tree>
          <Button size="small" appearance="outline" onClick={createNew} style={{ marginTop: 8 }}>+ New trigger</Button>
        </div>
      }
      main={
        <div className={s.form}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <Badge appearance="filled" color="brand">{selected || '(no trigger)'}</Badge>
            <Badge appearance="filled" color={runtimeState === 'Started' ? 'success' : 'informative'}>{runtimeState}</Badge>
            <Button appearance="primary" icon={<Save20Regular />} disabled={busy || !selected} onClick={save}>Save</Button>
            <Button appearance="outline" icon={<Play20Regular />} disabled={busy || !selected || runtimeState === 'Started'} onClick={() => setState('start')}>Start</Button>
            <Button appearance="outline" icon={<Pause20Regular />} disabled={busy || !selected || runtimeState !== 'Started'} onClick={() => setState('stop')}>Stop</Button>
          </div>
          {error && (
            <BackendStateBar error={error} title="ADF Trigger" />
          )}
          <Subtitle2>Trigger configuration</Subtitle2>
          <div className={s.row}>
            <div className={s.field}>
              <Caption1>Type</Caption1>
              <Dropdown value={type} selectedOptions={[type]} onOptionSelect={(_, d) => setType(d.optionValue || 'ScheduleTrigger')}>
                {ADF_TRIGGER_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
              </Dropdown>
            </div>
            <div className={s.field}>
              <Caption1>Target pipeline ({pipelines.length} available)</Caption1>
              <Dropdown value={targetPipeline} selectedOptions={[targetPipeline]} onOptionSelect={(_, d) => setTargetPipeline(d.optionValue || '')}>
                {pipelines.map((p) => <Option key={p.name} value={p.name}>{p.name}</Option>)}
              </Dropdown>
            </div>
          </div>
          {(type === 'ScheduleTrigger' || type === 'TumblingWindowTrigger') && (
            <div className={s.row}>
              <div className={s.field}>
                <Caption1>Frequency</Caption1>
                <Dropdown value={frequency} selectedOptions={[frequency]} onOptionSelect={(_, d) => setFrequency(d.optionValue || 'Hour')}>
                  {['Minute', 'Hour', 'Day', 'Week', 'Month'].map((f) => <Option key={f} value={f}>{f}</Option>)}
                </Dropdown>
              </div>
              <div className={s.field}><Caption1>Interval</Caption1><Input value={interval} onChange={(_, d) => setIntervalMin(d.value)} /></div>
              <div className={s.field}><Caption1>Time zone</Caption1><Input value={timeZone} onChange={(_, d) => setTimeZone(d.value)} /></div>
            </div>
          )}
          <Caption1>
            Linked pipelines: {tr?.properties.pipelines?.length || 0}
          </Caption1>
        </div>
      }
    />
  );
}

// ============================================================
// U-SQL job (Azure Data Lake Analytics)
// ============================================================
// (Ribbon defined inside the component via useMemo.)

const USQL_SAMPLE = `// U-SQL — Azure Data Lake Analytics (RETIRED 2024-02-29)
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
USING Outputters.Csv(outputHeader: true);`;

// v3.27: heuristic U-SQL → PySpark translator. Handles EXTRACT/OUTPUT
// patterns + SELECT/GROUP BY. NOT a full compiler — operator covers
// the 80% case; the rest must be hand-edited in the resulting cell.
function convertUsqlToPyspark(usql: string): string {
  const lines: string[] = [
    '# Converted from U-SQL by Loom usql-job heuristic translator.',
    '# REVIEW BEFORE RUNNING — this covers EXTRACT/SELECT/GROUP BY/OUTPUT only.',
    '',
  ];
  const extractMatch = usql.match(/@(\w+)\s*=\s*EXTRACT\s+([\s\S]*?)FROM\s+"([^"]+)"\s+USING\s+Extractors\.(\w+)\s*\(([^)]*)\)/i);
  if (extractMatch) {
    const [, alias, cols, path, fmt, opts] = extractMatch;
    const skip = /skipFirstNRows:\s*1/i.test(opts);
    const schema = cols.split(',').map(c => c.trim().split(/\s+/)).filter(p => p.length === 2)
      .map(([n, t]) => `('${n}', '${t.toLowerCase()}')`).join(', ');
    lines.push(`# EXTRACT @${alias}`);
    lines.push(`${alias} = spark.read.option("header", ${skip ? 'True' : 'False'}).${fmt.toLowerCase() === 'csv' ? 'csv' : fmt.toLowerCase()}("abfss:/${path}")`);
    lines.push(`# Original U-SQL schema: ${schema}`);
    lines.push('');
  }
  const selectMatch = usql.match(/@(\w+)\s*=\s*SELECT\s+([\s\S]*?)\s+FROM\s+@(\w+)([\s\S]*?);/i);
  if (selectMatch) {
    const [, target, projection, src, rest] = selectMatch;
    const groupBy = rest.match(/GROUP\s+BY\s+([\w,\s]+)/i);
    lines.push(`# SELECT into @${target}`);
    if (groupBy) {
      lines.push(`${target} = ${src}.groupBy("${groupBy[1].trim().replace(/\s*,\s*/g, '", "')}").agg(/* TODO: hand-translate aggregates from: ${projection.trim()} */)`);
    } else {
      lines.push(`${target} = ${src}.selectExpr(${projection.split(',').map(c => '"' + c.trim() + '"').join(', ')})`);
    }
    lines.push('');
  }
  const outputMatch = usql.match(/OUTPUT\s+@(\w+)\s+TO\s+"([^"]+)"\s+USING\s+Outputters\.(\w+)\s*\(([^)]*)\)/i);
  if (outputMatch) {
    const [, src, path, fmt, opts] = outputMatch;
    const header = /outputHeader:\s*true/i.test(opts);
    lines.push(`# OUTPUT @${src}`);
    lines.push(`${src}.write.mode("overwrite").option("header", ${header ? 'True' : 'False'}).${fmt.toLowerCase() === 'csv' ? 'csv' : fmt.toLowerCase()}("abfss:/${path}")`);
  }
  if (lines.length <= 3) {
    lines.push('# Translator could not parse the input.');
    lines.push('# Original U-SQL preserved as a comment block:');
    usql.split(/\r?\n/).forEach(l => lines.push('# ' + l));
  }
  return lines.join('\n');
}

export function UsqlJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [usql, setUsql] = useState<string>(USQL_SAMPLE);
  const [pyspark, setPyspark] = useState<string>('');

  // Ribbon — Convert to PySpark wires to the inline heuristic translator.
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Migration', actions: [
        { label: 'Convert to PySpark', onClick: () => setPyspark(convertUsqlToPyspark(usql)) },
      ]},
    ]},
  ], [usql]);

  // v3.27: D-fix — ADLA was retired 2024-02-29. The previous editor
  // pretended to estimate AUs and submit jobs to a service that no
  // longer exists. This is now a deprecation surface that helps users
  // migrate to Spark via a heuristic translator.
  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={s.pad}>
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>Azure Data Lake Analytics has been retired</MessageBarTitle>
            ADLA reached end of life on <strong>2024-02-29</strong>. New <code>Microsoft.DataLakeAnalytics/accounts</code> resources cannot be provisioned in any cloud and <code>az dla</code> is deprecated. This editor is preserved as a migration surface only — there is no live submission target.
            <br /><br />
            <strong>Recommended path</strong>: convert your U-SQL to PySpark (button below) and submit through the Synapse Spark, Databricks Notebook, or Fabric Notebook editor instead.
          </MessageBarBody>
        </MessageBar>
        <Subtitle2>U-SQL source</Subtitle2>
        <textarea className={s.monaco} spellCheck={false} value={usql} onChange={(e) => setUsql(e.target.value)} aria-label="U-SQL editor" />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button appearance="primary" icon={<ArrowSync20Regular />} onClick={() => setPyspark(convertUsqlToPyspark(usql))}>
            Convert to PySpark
          </Button>
          <Caption1 style={{ alignSelf: 'center' }}>Heuristic translator — covers EXTRACT / SELECT / GROUP BY / OUTPUT. Review before running.</Caption1>
        </div>
        {pyspark && (
          <>
            <Subtitle2>PySpark (review + paste into a Notebook)</Subtitle2>
            <textarea className={s.monaco} spellCheck={false} value={pyspark} onChange={(e) => setPyspark(e.target.value)} aria-label="PySpark output" />
          </>
        )}
      </div>
    } />
  );
}
