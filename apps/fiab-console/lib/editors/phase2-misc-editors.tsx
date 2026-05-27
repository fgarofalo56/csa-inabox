'use client';

/**
 * Phase 2 misc editors — Spark Job Definition, Environment, Copy Job, dbt Job.
 *
 * Each editor is wired to real BFF routes that talk to Azure:
 *
 *   Spark Job Definition → Cosmos state.spec + POST /submit → Synapse Livy
 *                          batch submission against the configured pool.
 *   Environment          → Cosmos state + "Apply to pool" PUTs the pool
 *                          spec on /api/items/synapse-spark-pool/[pool].
 *   Copy Job             → Cosmos state, run materialises a Synapse pipeline
 *                          and triggers it; runs list from queryPipelineRuns.
 *   dbt Job              → Cosmos state, run materialises a Databricks Job
 *                          with a dbt_task and triggers run-now; runs list
 *                          from Databricks jobs/runs/list.
 *
 * No mock data — every list / save / run hits real Azure. Errors surface
 * verbatim in MessageBar.
 */

import {
  Subtitle2, Caption1, Input, Dropdown, Option, Button, Badge, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { useCallback, useEffect, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';

const useStyles = makeStyles({
  form: { padding: '20px', display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 820 },
  row: { display: 'flex', gap: 12 },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 },
  tabBar: { padding: '8px 16px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  tabBody: { padding: 20, display: 'flex', flexDirection: 'column', gap: 12 },
  toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 },
  status: { display: 'flex', gap: 8, alignItems: 'center' },
  resultBox: { marginTop: 16, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12 },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12 },
  json: {
    width: '100%', minHeight: 120, padding: 10,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: 12,
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4,
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    resize: 'vertical',
  },
});

// ----- shared helpers -------------------------------------------------------

function ErrBar({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody>
        <MessageBarTitle>Operation failed</MessageBarTitle>
        {error}
      </MessageBarBody>
    </MessageBar>
  );
}

function fmtTs(ts?: string | number): string {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

interface PoolDTO { name: string; properties?: { sparkVersion?: string; nodeSize?: string } }

function usePoolList() {
  const [pools, setPools] = useState<PoolDTO[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/items/synapse-spark-pool/list');
        const j = await r.json();
        if (j.ok) setPools(j.pools || []);
      } catch { /* surface via individual editors */ }
    })();
  }, []);
  return pools;
}

interface ItemDTO {
  id: string;
  workspaceId: string;
  displayName: string;
  state?: Record<string, any>;
}

function useItem(itemType: string, id: string) {
  const [item, setItem] = useState<ItemDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!id || id === 'new') return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/${itemType}/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setItem(j.item);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [itemType, id]);

  useEffect(() => { reload(); }, [reload]);
  return { item, setItem, error, setError, loading, reload };
}

async function saveItem(itemType: string, id: string, state: Record<string, any>): Promise<void> {
  const r = await fetch(`/api/items/${itemType}/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save failed');
}

// ============================================================================
// Spark Job Definition
// ============================================================================

const SPARK_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Run', actions: [{ label: 'Submit' }, { label: 'Refresh runs' }] },
    { label: 'Edit', actions: [{ label: 'Save' }] },
  ]},
];

interface SparkBatchRun {
  id: number;
  name?: string;
  state?: string;
  result?: string;
  submittedAt?: string;
  appId?: string | null;
}

export function SparkJobDefinitionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const pools = usePoolList();
  const { item: cosmosItem, error: loadError, loading, reload } = useItem('spark-job-definition', id);

  const [file, setFile] = useState('');
  const [className, setClassName] = useState('');
  const [argsText, setArgsText] = useState('');
  const [confText, setConfText] = useState('{}');
  const [pool, setPool] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<SparkBatchRun[]>([]);
  const [lastSubmit, setLastSubmit] = useState<any>(null);

  useEffect(() => {
    const spec = (cosmosItem?.state as any)?.spec;
    if (!spec) return;
    setFile(spec.file || '');
    setClassName(spec.className || '');
    setArgsText((spec.args || []).join('\n'));
    setConfText(JSON.stringify(spec.conf || {}, null, 2));
    setPool(spec.pool || '');
  }, [cosmosItem]);

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/spark-job-definition/${encodeURIComponent(id)}/runs?size=20`);
      const j = await r.json();
      if (j.ok) setRuns(j.sessions || []);
      else if (j.error) setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  useEffect(() => { if (cosmosItem) loadRuns(); }, [cosmosItem, loadRuns]);

  const buildSpec = () => {
    let conf: Record<string, string> = {};
    try { conf = JSON.parse(confText || '{}'); }
    catch { throw new Error('Spark conf must be valid JSON'); }
    return {
      file: file.trim(),
      className: className.trim() || undefined,
      args: argsText.split('\n').map((a) => a.trim()).filter(Boolean),
      conf,
      pool,
    };
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const spec = buildSpec();
      await saveItem('spark-job-definition', id, { ...(cosmosItem?.state || {}), spec });
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true); setErr(null); setLastSubmit(null);
    try {
      const spec = buildSpec();
      // Persist before submit so /submit reads the freshest spec.
      await saveItem('spark-job-definition', id, { ...(cosmosItem?.state || {}), spec });
      const r = await fetch(`/api/items/spark-job-definition/${encodeURIComponent(id)}/submit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'submit failed');
      setLastSubmit(j.job);
      setTimeout(loadRuns, 1500);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  if (id === 'new') {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={SPARK_RIBBON} main={
        <div className={styles.form}>
          <MessageBar intent="info">
            <MessageBarBody>Create this Spark Job Definition from the workspace catalog,
              then return here to configure the job spec.</MessageBarBody>
          </MessageBar>
        </div>
      } />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={SPARK_RIBBON} main={
      <div className={styles.form}>
        <ErrBar error={err || loadError} />
        {loading && <Spinner size="small" label="Loading spec…" labelPosition="after" />}

        <Subtitle2>Job configuration</Subtitle2>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Main file (abfss:// or wasbs:// URI)</Caption1>
            <Input value={file} onChange={(_, d) => setFile(d.value)}
              placeholder="abfss://files@<account>.dfs.core.windows.net/jobs/main.py" />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Main class (Scala/Java; leave blank for Python)</Caption1>
            <Input value={className} onChange={(_, d) => setClassName(d.value)}
              placeholder="com.example.Main" />
          </div>
          <div className={styles.field}>
            <Caption1>Spark pool</Caption1>
            <Dropdown value={pool} selectedOptions={pool ? [pool] : []}
              onOptionSelect={(_, d) => setPool(d.optionValue || '')}>
              {pools.length === 0 && <Option value="">(no pools — refresh or check workspace)</Option>}
              {pools.map((p) => (
                <Option key={p.name} value={p.name}>
                  {p.properties?.sparkVersion ? `${p.name} (Spark ${p.properties.sparkVersion})` : p.name}
                </Option>
              ))}
            </Dropdown>
          </div>
        </div>
        <div className={styles.field}>
          <Caption1>Arguments (one per line)</Caption1>
          <Textarea value={argsText} onChange={(_, d) => setArgsText(d.value)} rows={3}
            placeholder={'--input gold/sales\n--output gold/sales_agg'} />
        </div>
        <div className={styles.field}>
          <Caption1>Spark conf (JSON: {`{ "spark.sql.shuffle.partitions": "200" }`})</Caption1>
          <MonacoTextarea value={confText} onChange={setConfText} language="json" height={140} minHeight={100} ariaLabel="Spark conf JSON" />
        </div>
        <div className={styles.toolbar}>
          <Button appearance="primary" onClick={submit} disabled={busy || !file || !pool}>Submit Spark batch</Button>
          <Button onClick={save} disabled={busy}>Save spec</Button>
          <Button onClick={loadRuns} disabled={busy}>Refresh runs</Button>
          {busy && <Spinner size="tiny" />}
        </div>

        {lastSubmit && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Submitted batch #{lastSubmit.id}</MessageBarTitle>
              State: {lastSubmit.state || lastSubmit.livyInfo?.currentState || '—'}
              {lastSubmit.appId && ` · appId ${lastSubmit.appId}`}
            </MessageBarBody>
          </MessageBar>
        )}

        <div className={styles.resultBox}>
          <Subtitle2>Recent runs</Subtitle2>
          {runs.length === 0 ? (
            <Caption1>No runs yet.</Caption1>
          ) : (
            <Table size="small" aria-label="Spark batch runs">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>ID</TableHeaderCell>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>State</TableHeaderCell>
                  <TableHeaderCell>Result</TableHeaderCell>
                  <TableHeaderCell>Submitted</TableHeaderCell>
                  <TableHeaderCell>App ID</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className={styles.mono}>{r.id}</TableCell>
                    <TableCell>{r.name || '—'}</TableCell>
                    <TableCell><Badge appearance="outline">{r.state || '—'}</Badge></TableCell>
                    <TableCell>
                      <Badge appearance="outline" color={r.result === 'Succeeded' ? 'success' : r.result === 'Failed' ? 'danger' : 'informative'}>
                        {r.result || '—'}
                      </Badge>
                    </TableCell>
                    <TableCell>{fmtTs(r.submittedAt)}</TableCell>
                    <TableCell className={styles.mono}>{r.appId || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    } />
  );
}

// ============================================================================
// Environment
// ============================================================================

const ENV_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Edit', actions: [{ label: 'Save' }] },
    { label: 'Apply', actions: [{ label: 'Apply to pool' }] },
  ]},
];

export function EnvironmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const pools = usePoolList();
  const { item: cosmosItem, error: loadError, loading, reload } = useItem('environment', id);

  const [tab, setTab] = useState('requirements');
  const [requirements, setRequirements] = useState('');
  const [confText, setConfText] = useState('{}');
  const [jarsText, setJarsText] = useState('');
  const [targetPool, setTargetPool] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  useEffect(() => {
    const s: any = cosmosItem?.state || {};
    setRequirements(s.requirements || '');
    setConfText(JSON.stringify(s.conf || {}, null, 2));
    setJarsText((s.jars || []).join('\n'));
  }, [cosmosItem]);

  const buildState = () => {
    let conf: Record<string, string> = {};
    try { conf = JSON.parse(confText || '{}'); }
    catch { throw new Error('Spark conf must be valid JSON'); }
    return {
      requirements,
      conf,
      jars: jarsText.split('\n').map((j) => j.trim()).filter(Boolean),
    };
  };

  const save = async () => {
    setBusy(true); setErr(null); setApplyMsg(null);
    try {
      await saveItem('environment', id, buildState());
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const applyToPool = async () => {
    if (!targetPool) { setErr('Select a target pool first.'); return; }
    setBusy(true); setErr(null); setApplyMsg(null);
    try {
      const state = buildState();
      // Fetch current pool, merge librarySpec, PUT back.
      const cur = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(targetPool)}`).then((r) => r.json());
      if (!cur.ok) throw new Error(cur.error || 'failed to read pool');
      const pool = cur.pool || {};
      const properties = { ...(pool.properties || {}) };
      properties.libraryRequirements = {
        content: state.requirements,
        filename: 'requirements.txt',
      };
      properties.sparkConfigProperties = {
        content: Object.entries(state.conf).map(([k, v]) => `${k} ${v}`).join('\n'),
        filename: 'spark-defaults.conf',
      };
      properties.customLibraries = state.jars.map((path) => ({ name: path.split('/').pop(), path, type: 'jar' }));
      properties.sessionLevelPackagesEnabled = true;

      const r = await fetch(`/api/items/synapse-spark-pool/${encodeURIComponent(targetPool)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location: pool.location, properties }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'apply failed');
      setApplyMsg(`Applied environment to pool "${targetPool}".`);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  if (id === 'new') {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={ENV_RIBBON} main={
        <div className={styles.form}>
          <MessageBar intent="info">
            <MessageBarBody>Create this Environment from the workspace catalog,
              then return here to configure libraries and Spark conf.</MessageBarBody>
          </MessageBar>
        </div>
      } />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ENV_RIBBON} main={
      <>
        <div className={styles.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="requirements">Requirements (PyPI)</Tab>
            <Tab value="conf">Spark conf</Tab>
            <Tab value="jars">Custom JARs</Tab>
            <Tab value="apply">Apply to pool</Tab>
          </TabList>
        </div>
        <div className={styles.tabBody}>
          <ErrBar error={err || loadError} />
          {applyMsg && (
            <MessageBar intent="success"><MessageBarBody>{applyMsg}</MessageBarBody></MessageBar>
          )}
          {loading && <Spinner size="small" label="Loading environment…" labelPosition="after" />}

          {tab === 'requirements' && (
            <>
              <Subtitle2>requirements.txt</Subtitle2>
              <Textarea value={requirements} onChange={(_, d) => setRequirements(d.value)} rows={10}
                placeholder={'pandas==2.2.2\nscikit-learn==1.4.2\nmlflow==2.13.0'} />
            </>
          )}
          {tab === 'conf' && (
            <>
              <Subtitle2>Spark configuration (JSON map)</Subtitle2>
              <MonacoTextarea value={confText} onChange={setConfText} language="json" height={240} minHeight={180} ariaLabel="Spark conf JSON" />
            </>
          )}
          {tab === 'jars' && (
            <>
              <Subtitle2>Custom JAR URIs (one per line)</Subtitle2>
              <Textarea value={jarsText} onChange={(_, d) => setJarsText(d.value)} rows={6}
                placeholder={'abfss://libs@<account>.dfs.core.windows.net/myudf.jar'} />
            </>
          )}
          {tab === 'apply' && (
            <>
              <Subtitle2>Target Spark pool</Subtitle2>
              <div className={styles.field}>
                <Caption1>Pool</Caption1>
                <Dropdown value={targetPool} selectedOptions={targetPool ? [targetPool] : []}
                  onOptionSelect={(_, d) => setTargetPool(d.optionValue || '')}>
                  {pools.length === 0 && <Option value="">(no pools available)</Option>}
                  {pools.map((p) => <Option key={p.name} value={p.name}>{p.name}</Option>)}
                </Dropdown>
              </div>
              <Caption1>
                Applies the persisted requirements, Spark conf, and JAR list onto
                the pool's <code>libraryRequirements</code>, <code>sparkConfigProperties</code>,
                and <code>customLibraries</code>. The pool will recycle sessions to pick up
                the new spec — existing batch jobs are unaffected until they restart.
              </Caption1>
            </>
          )}

          <div className={styles.toolbar}>
            <Button appearance="primary" onClick={save} disabled={busy}>Save environment</Button>
            <Button onClick={applyToPool} disabled={busy || !targetPool}>Apply to pool</Button>
            {busy && <Spinner size="tiny" />}
          </div>
        </div>
      </>
    } />
  );
}

// ============================================================================
// Copy Job
// ============================================================================

const COPY_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Edit', actions: [{ label: 'Save' }] },
    { label: 'Run', actions: [{ label: 'Run now' }, { label: 'Refresh' }] },
  ]},
];

interface PipelineRunDTO {
  runId: string;
  status?: string;
  runStart?: string;
  runEnd?: string;
  durationInMs?: number;
  message?: string;
}

const COPY_SOURCE_TYPES = ['AzureSqlSource', 'AzureBlobSource', 'DelimitedTextSource', 'ParquetSource', 'JsonSource', 'AzureTableSource'];
const COPY_SINK_TYPES   = ['AzureSqlSink',   'AzureBlobSink',   'DelimitedTextSink',   'ParquetSink',   'JsonSink',   'AzureTableSink'];

export function CopyJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const { item: cosmosItem, error: loadError, loading, reload } = useItem('copy-job', id);

  const [srcLs, setSrcLs] = useState('');
  const [srcType, setSrcType] = useState('AzureSqlSource');
  const [srcQuery, setSrcQuery] = useState('');
  const [snkLs, setSnkLs] = useState('');
  const [snkType, setSnkType] = useState('AzureSqlSink');
  const [snkTable, setSnkTable] = useState('');
  const [mappingsText, setMappingsText] = useState('[]');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<PipelineRunDTO[]>([]);
  const [lastRun, setLastRun] = useState<string | null>(null);

  useEffect(() => {
    const s: any = cosmosItem?.state || {};
    setSrcLs(s.source?.linkedService || '');
    setSrcType(s.source?.type || 'AzureSqlSource');
    setSrcQuery(s.source?.query || '');
    setSnkLs(s.sink?.linkedService || '');
    setSnkType(s.sink?.type || 'AzureSqlSink');
    setSnkTable(s.sink?.table || '');
    setMappingsText(JSON.stringify(s.mappings || [], null, 2));
  }, [cosmosItem]);

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/copy-job/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (j.ok) setRuns(j.runs || []);
      else if (j.error) setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  useEffect(() => { if (cosmosItem) loadRuns(); }, [cosmosItem, loadRuns]);

  const buildState = () => {
    let mappings: any[] = [];
    try { mappings = JSON.parse(mappingsText || '[]'); }
    catch { throw new Error('Mappings must be valid JSON (array of {source, sink})'); }
    return {
      source: { linkedService: srcLs, type: srcType, query: srcQuery || undefined },
      sink:   { linkedService: snkLs, type: snkType, table: snkTable || undefined },
      mappings,
    };
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try { await saveItem('copy-job', id, buildState()); await reload(); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setErr(null); setLastRun(null);
    try {
      await saveItem('copy-job', id, buildState());
      const r = await fetch(`/api/items/copy-job/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'run failed');
      setLastRun(j.runId);
      setTimeout(loadRuns, 2000);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  if (id === 'new') {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={COPY_RIBBON} main={
        <div className={styles.form}>
          <MessageBar intent="info">
            <MessageBarBody>Create this Copy Job from the workspace catalog,
              then return here to configure source, sink, and mappings.</MessageBarBody>
          </MessageBar>
        </div>
      } />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={COPY_RIBBON} main={
      <div className={styles.form}>
        <ErrBar error={err || loadError} />
        {loading && <Spinner size="small" label="Loading copy-job…" labelPosition="after" />}

        <Subtitle2>Source</Subtitle2>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Linked service name</Caption1>
            <Input value={srcLs} onChange={(_, d) => setSrcLs(d.value)} placeholder="MyAzureSqlLinkedService" />
          </div>
          <div className={styles.field}>
            <Caption1>Source type</Caption1>
            <Dropdown value={srcType} selectedOptions={[srcType]}
              onOptionSelect={(_, d) => setSrcType(d.optionValue || srcType)}>
              {COPY_SOURCE_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown>
          </div>
        </div>
        <div className={styles.field}>
          <Caption1>Source query (for SQL sources)</Caption1>
          <Textarea value={srcQuery} onChange={(_, d) => setSrcQuery(d.value)} rows={3}
            placeholder="SELECT id, name, amount FROM dbo.orders WHERE updated_at > '2025-01-01'" />
        </div>

        <Subtitle2 style={{ marginTop: 8 }}>Sink</Subtitle2>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Linked service name</Caption1>
            <Input value={snkLs} onChange={(_, d) => setSnkLs(d.value)} placeholder="MyLakehouseLinkedService" />
          </div>
          <div className={styles.field}>
            <Caption1>Sink type</Caption1>
            <Dropdown value={snkType} selectedOptions={[snkType]}
              onOptionSelect={(_, d) => setSnkType(d.optionValue || snkType)}>
              {COPY_SINK_TYPES.map((t) => <Option key={t} value={t}>{t}</Option>)}
            </Dropdown>
          </div>
        </div>
        <div className={styles.field}>
          <Caption1>Sink table / path</Caption1>
          <Input value={snkTable} onChange={(_, d) => setSnkTable(d.value)}
            placeholder="bronze.orders  or  files/bronze/orders/" />
        </div>

        <Subtitle2 style={{ marginTop: 8 }}>Column mappings</Subtitle2>
        <Caption1>JSON array of {`{ "source": "...", "sink": "..." }`}</Caption1>
        <MonacoTextarea value={mappingsText} onChange={setMappingsText} language="json" height={180} minHeight={140} ariaLabel="Column mappings JSON" />

        <div className={styles.toolbar}>
          <Button appearance="primary" onClick={run} disabled={busy || !srcLs || !snkLs}>Run now</Button>
          <Button onClick={save} disabled={busy}>Save</Button>
          <Button onClick={loadRuns} disabled={busy}>Refresh runs</Button>
          {busy && <Spinner size="tiny" />}
        </div>

        {lastRun && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>Pipeline run started</MessageBarTitle>
              runId <code>{lastRun}</code>
            </MessageBarBody>
          </MessageBar>
        )}

        <div className={styles.resultBox}>
          <Subtitle2>Recent runs (pipeline loom-copy-{id.substring(0, 8)}…)</Subtitle2>
          {runs.length === 0 ? (
            <Caption1>No runs yet.</Caption1>
          ) : (
            <Table size="small" aria-label="Pipeline runs">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Run ID</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Ended</TableHeaderCell>
                  <TableHeaderCell>Duration</TableHeaderCell>
                  <TableHeaderCell>Message</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell className={styles.mono}>{r.runId.substring(0, 8)}…</TableCell>
                    <TableCell>
                      <Badge appearance="outline" color={r.status === 'Succeeded' ? 'success' : r.status === 'Failed' ? 'danger' : 'informative'}>
                        {r.status || '—'}
                      </Badge>
                    </TableCell>
                    <TableCell>{fmtTs(r.runStart)}</TableCell>
                    <TableCell>{fmtTs(r.runEnd)}</TableCell>
                    <TableCell>{r.durationInMs ? `${(r.durationInMs / 1000).toFixed(1)}s` : '—'}</TableCell>
                    <TableCell>{r.message || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    } />
  );
}

// ============================================================================
// dbt Job
// ============================================================================

const DBT_RIBBON: RibbonTab[] = [
  { id: 'home', label: 'Home', groups: [
    { label: 'Edit', actions: [{ label: 'Save' }] },
    { label: 'Run', actions: [{ label: 'Run dbt' }, { label: 'Refresh' }] },
  ]},
];

interface JobRunDTO {
  run_id: number;
  state?: { life_cycle_state?: string; result_state?: string; state_message?: string };
  start_time?: number;
  end_time?: number;
}

export function DbtJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const { item: cosmosItem, error: loadError, loading, reload } = useItem('dbt-job', id);

  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [target, setTarget] = useState('prod');
  const [profilesYaml, setProfilesYaml] = useState('');
  const [modelsText, setModelsText] = useState('');
  const [commandsText, setCommandsText] = useState('');
  const [clusterId, setClusterId] = useState('');
  const [databricksJobId, setDatabricksJobId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRunDTO[]>([]);
  const [lastRun, setLastRun] = useState<number | null>(null);

  useEffect(() => {
    const s: any = cosmosItem?.state || {};
    setRepoUrl(s.repoUrl || '');
    setBranch(s.branch || 'main');
    setTarget(s.target || 'prod');
    setProfilesYaml(s.profilesYaml || '');
    setModelsText((s.models || []).join('\n'));
    setCommandsText((s.commands || []).join('\n'));
    setClusterId(s.clusterId || '');
    setDatabricksJobId(s.databricksJobId ?? null);
  }, [cosmosItem]);

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/dbt-job/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (j.ok) { setRuns(j.runs || []); if (j.databricksJobId) setDatabricksJobId(j.databricksJobId); }
      else if (j.error) setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  useEffect(() => { if (cosmosItem) loadRuns(); }, [cosmosItem, loadRuns]);

  const buildState = () => ({
    repoUrl,
    branch,
    target,
    profilesYaml,
    models: modelsText.split('\n').map((m) => m.trim()).filter(Boolean),
    commands: commandsText.split('\n').map((c) => c.trim()).filter(Boolean),
    clusterId,
    ...(databricksJobId !== null ? { databricksJobId } : {}),
  });

  const save = async () => {
    setBusy(true); setErr(null);
    try { await saveItem('dbt-job', id, buildState()); await reload(); }
    catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setErr(null); setLastRun(null);
    try {
      await saveItem('dbt-job', id, buildState());
      const r = await fetch(`/api/items/dbt-job/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'run failed');
      setLastRun(j.run_id);
      if (j.databricksJobId) setDatabricksJobId(j.databricksJobId);
      setTimeout(loadRuns, 2000);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  if (id === 'new') {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={DBT_RIBBON} main={
        <div className={styles.form}>
          <MessageBar intent="info">
            <MessageBarBody>Create this dbt Job from the workspace catalog,
              then return here to configure the repo + Databricks cluster.</MessageBarBody>
          </MessageBar>
        </div>
      } />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={DBT_RIBBON} main={
      <div className={styles.form}>
        <ErrBar error={err || loadError} />
        {loading && <Spinner size="small" label="Loading dbt-job…" labelPosition="after" />}

        <Subtitle2>Project</Subtitle2>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Git repo URL</Caption1>
            <Input value={repoUrl} onChange={(_, d) => setRepoUrl(d.value)} placeholder="https://github.com/contoso/dbt-prod" />
          </div>
          <div className={styles.field}>
            <Caption1>Branch</Caption1>
            <Input value={branch} onChange={(_, d) => setBranch(d.value)} />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Target profile</Caption1>
            <Input value={target} onChange={(_, d) => setTarget(d.value)} placeholder="prod" />
          </div>
          <div className={styles.field}>
            <Caption1>Databricks cluster ID</Caption1>
            <Input value={clusterId} onChange={(_, d) => setClusterId(d.value)}
              placeholder="0303-184849-xyz123 (existing all-purpose cluster)" />
          </div>
        </div>
        <div className={styles.field}>
          <Caption1>Model selection (--select, one per line; blank = all)</Caption1>
          <Textarea value={modelsText} onChange={(_, d) => setModelsText(d.value)} rows={3}
            placeholder={'tag:nightly\nstg_orders+'} />
        </div>
        <div className={styles.field}>
          <Caption1>Override commands (one per line; blank = default dbt deps + dbt run)</Caption1>
          <Textarea value={commandsText} onChange={(_, d) => setCommandsText(d.value)} rows={3}
            placeholder={'dbt deps\ndbt seed\ndbt run\ndbt test'} />
        </div>
        <div className={styles.field}>
          <Caption1>profiles.yml (informational — copy into your repo)</Caption1>
          <Textarea value={profilesYaml} onChange={(_, d) => setProfilesYaml(d.value)} rows={6}
            placeholder={'prod:\n  target: prod\n  outputs:\n    prod:\n      type: databricks\n      ...'} />
        </div>

        <div className={styles.toolbar}>
          <Button appearance="primary" onClick={run} disabled={busy || !repoUrl || !clusterId}>Run dbt</Button>
          <Button onClick={save} disabled={busy}>Save</Button>
          <Button onClick={loadRuns} disabled={busy}>Refresh runs</Button>
          {busy && <Spinner size="tiny" />}
          {databricksJobId !== null && (
            <Badge appearance="outline">Databricks job_id {databricksJobId}</Badge>
          )}
        </div>

        {lastRun && (
          <MessageBar intent="success">
            <MessageBarBody>
              <MessageBarTitle>dbt run started</MessageBarTitle>
              run_id {lastRun}
            </MessageBarBody>
          </MessageBar>
        )}

        <div className={styles.resultBox}>
          <Subtitle2>Recent runs</Subtitle2>
          {runs.length === 0 ? (
            <Caption1>No runs yet.</Caption1>
          ) : (
            <Table size="small" aria-label="dbt runs">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>run_id</TableHeaderCell>
                  <TableHeaderCell>Lifecycle</TableHeaderCell>
                  <TableHeaderCell>Result</TableHeaderCell>
                  <TableHeaderCell>Started</TableHeaderCell>
                  <TableHeaderCell>Ended</TableHeaderCell>
                  <TableHeaderCell>Message</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.run_id}>
                    <TableCell className={styles.mono}>{r.run_id}</TableCell>
                    <TableCell><Badge appearance="outline">{r.state?.life_cycle_state || '—'}</Badge></TableCell>
                    <TableCell>
                      <Badge appearance="outline" color={r.state?.result_state === 'SUCCESS' ? 'success' : r.state?.result_state === 'FAILED' ? 'danger' : 'informative'}>
                        {r.state?.result_state || '—'}
                      </Badge>
                    </TableCell>
                    <TableCell>{fmtTs(r.start_time)}</TableCell>
                    <TableCell>{fmtTs(r.end_time)}</TableCell>
                    <TableCell>{r.state?.state_message || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    } />
  );
}
