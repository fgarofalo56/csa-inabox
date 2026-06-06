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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { KeyValueGrid } from '@/lib/components/ui/key-value-grid';
import { ComputePicker } from '@/lib/components/compute-picker';

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

// ADF Linked Service picker — populates Source/Sink dropdowns on Copy Job
// from the ADF factory's actual linked services. If the BFF call fails
// (factory not provisioned / SP missing Contributor on the factory) we
// surface `hint` so the user can fix it without leaving the editor.
interface LinkedServiceDTO {
  name: string;
  type?: string;
  properties?: { type?: string; description?: string };
}

function useLinkedServices() {
  const [linkedServices, setLinkedServices] = useState<LinkedServiceDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true); setError(null); setHint(null);
    try {
      const r = await fetch('/api/adf/linked-services');
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        setHint(j.hint || 'Provision an ADF Linked Service in the Data Factory portal first, then refresh.');
        setLinkedServices([]);
      } else {
        setLinkedServices(j.linkedServices || []);
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setLinkedServices([]);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { linkedServices, error, hint, loading, reload };
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
  // Phase 4.5 — dirty flag prevents the post-save reload from clobbering
  // unsaved edits if the user kept typing while save() was in flight.
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    const spec = (cosmosItem?.state as any)?.spec;
    if (!spec) return;
    // Phase 4.5 — never overwrite local edits-in-flight when the cosmosItem
    // reference changes (e.g. after a post-save reload).
    if (dirty) return;
    setFile(spec.file || '');
    setClassName(spec.className || '');
    setArgsText((spec.args || []).join('\n'));
    setConfText(JSON.stringify(spec.conf || {}, null, 2));
    setPool(spec.pool || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setBusy(true); setErr(null); setSaveMsg('Saving spec…');
    try {
      const spec = buildSpec();
      await saveItem('spark-job-definition', id, { ...(cosmosItem?.state || {}), spec });
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); setSaveMsg(null); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setBusy(true); setErr(null); setLastSubmit(null);
    try {
      const spec = buildSpec();
      // Persist before submit so /submit reads the freshest spec.
      await saveItem('spark-job-definition', id, { ...(cosmosItem?.state || {}), spec });
      setDirty(false);
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

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (id !== 'new' && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, dirty, busy]);

  const canSubmit = !busy && !!file && !!pool;
  const canSave = !busy && dirty;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: busy ? 'Submitting…' : 'Submit', onClick: canSubmit ? submit : undefined, disabled: !canSubmit },
        { label: 'Refresh runs', onClick: busy ? undefined : loadRuns, disabled: busy },
      ]},
      { label: 'Edit', actions: [
        { label: dirty ? 'Save' : 'Saved', onClick: canSave ? save : undefined, disabled: !canSave },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busy, canSubmit, canSave, dirty, loadRuns]);

  if (id === 'new') {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={styles.form}>
        <ErrBar error={err || loadError} />
        {loading && <Spinner size="small" label="Loading spec…" labelPosition="after" />}

        <Subtitle2>Job configuration</Subtitle2>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Main file (abfss:// or wasbs:// URI)</Caption1>
            <Input value={file} onChange={(_, d) => { setFile(d.value); setDirty(true); }}
              placeholder="abfss://files@<account>.dfs.core.windows.net/jobs/main.py" />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Main class (Scala/Java; leave blank for Python)</Caption1>
            <Input value={className} onChange={(_, d) => { setClassName(d.value); setDirty(true); }}
              placeholder="com.example.Main" />
          </div>
          <div className={styles.field}>
            <Caption1>Spark pool</Caption1>
            <Dropdown value={pool} selectedOptions={pool ? [pool] : []}
              onOptionSelect={(_, d) => { setPool(d.optionValue || ''); setDirty(true); }}>
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
          <Textarea value={argsText} onChange={(_, d) => { setArgsText(d.value); setDirty(true); }} rows={3}
            placeholder={'--input gold/sales\n--output gold/sales_agg'} />
        </div>
        <div className={styles.field}>
          <Caption1>Spark configuration</Caption1>
          <KeyValueGrid value={confText} onChange={(v) => { setConfText(v); setDirty(true); }}
            keyLabel="Conf key" valueLabel="Value"
            keyPlaceholder="spark.sql.shuffle.partitions" valuePlaceholder="200" addLabel="Add Spark conf" />
        </div>
        {saveMsg && <MessageBar intent="success"><MessageBarBody>{saveMsg}</MessageBarBody></MessageBar>}
        <div className={styles.toolbar}>
          <Button appearance="primary" onClick={submit} disabled={busy || !file || !pool}>Submit Spark batch</Button>
          <Button onClick={save} disabled={busy || !dirty}>{dirty ? 'Save spec' : 'Saved'}</Button>
          <Button onClick={loadRuns} disabled={busy}>Refresh runs</Button>
          {busy && <Spinner size="tiny" />}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
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
  // Phase 4.5 — see SparkJobDefinitionEditor for rationale.
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    const s: any = cosmosItem?.state || {};
    if (dirty) return; // never clobber in-flight edits when cosmosItem reloads
    setRequirements(s.requirements || '');
    setConfText(JSON.stringify(s.conf || {}, null, 2));
    setJarsText((s.jars || []).join('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setBusy(true); setErr(null); setApplyMsg(null); setSaveMsg('Saving environment…');
    try {
      await saveItem('environment', id, buildState());
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); setSaveMsg(null); }
    finally { setBusy(false); }
  };

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (id !== 'new' && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, dirty, busy]);

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

  const canSaveEnv = !busy && dirty;
  const canApply = !busy && !!targetPool;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: dirty ? 'Save' : 'Saved', onClick: canSaveEnv ? save : undefined, disabled: !canSaveEnv },
      ]},
      { label: 'Apply', actions: [
        { label: 'Apply to pool', onClick: canApply ? applyToPool : undefined, disabled: !canApply },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busy, dirty, canSaveEnv, canApply]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create environment"
        intro="A Spark environment bundles PyPI requirements, Spark configuration, and custom JARs that you can apply to a Synapse Spark pool. Create it, then configure and apply." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
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
              <Textarea value={requirements} onChange={(_, d) => { setRequirements(d.value); setDirty(true); }} rows={10}
                placeholder={'pandas==2.2.2\nscikit-learn==1.4.2\nmlflow==2.13.0'} />
            </>
          )}
          {tab === 'conf' && (
            <>
              <Subtitle2>Spark configuration</Subtitle2>
              <Caption1>Key/value pairs passed to the Spark session (spark.conf).</Caption1>
              <KeyValueGrid value={confText} onChange={(v) => { setConfText(v); setDirty(true); }}
                keyLabel="Conf key" valueLabel="Value"
                keyPlaceholder="spark.sql.shuffle.partitions" valuePlaceholder="200" addLabel="Add Spark conf" />
            </>
          )}
          {tab === 'jars' && (
            <>
              <Subtitle2>Custom JAR URIs (one per line)</Subtitle2>
              <Textarea value={jarsText} onChange={(_, d) => { setJarsText(d.value); setDirty(true); }} rows={6}
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

          {saveMsg && <MessageBar intent="success"><MessageBarBody>{saveMsg}</MessageBarBody></MessageBar>}
          <div className={styles.toolbar}>
            <Button appearance="primary" onClick={save} disabled={busy || !dirty}>{dirty ? 'Save environment' : 'Saved'}</Button>
            <Button onClick={applyToPool} disabled={busy || !targetPool}>Apply to pool</Button>
            {busy && <Spinner size="tiny" />}
            {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
          </div>
        </div>
      </>
    } />
  );
}

// ============================================================================
// Copy Job
// ============================================================================
//
// The Copy Job editor moved to its own wizard-based module (F14 — Fabric Copy
// job parity). It is re-exported here so the registry and tests that import
// `CopyJobEditor` from this module keep working.
export { CopyJobEditor } from './copy-job-editor';

// (Copy Job editor lives in ./copy-job-editor; re-exported above.)


// ============================================================================
// dbt Job
// ============================================================================

interface JobRunDTO {
  run_id: number;
  state?: { life_cycle_state?: string; result_state?: string; state_message?: string };
  start_time?: number;
  end_time?: number;
}

interface DatabricksWorkspaceDTO { hostname: string; url: string }

function useDatabricksWorkspace() {
  const [workspace, setWorkspace] = useState<DatabricksWorkspaceDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/databricks/workspace');
        const j = await r.json();
        if (!j.ok) { setError(j.error || `HTTP ${r.status}`); setHint(j.hint || null); }
        else { setWorkspace(j.workspace || null); }
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally { setLoading(false); }
    })();
  }, []);
  return { workspace, error, hint, loading };
}

export function DbtJobEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const { item: cosmosItem, error: loadError, loading, reload } = useItem('dbt-job', id);
  const dbxWs = useDatabricksWorkspace();

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
  // Phase 4.5 — see SparkJobDefinitionEditor for rationale.
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    const s: any = cosmosItem?.state || {};
    if (dirty) return; // never clobber in-flight edits when cosmosItem reloads
    setRepoUrl(s.repoUrl || '');
    setBranch(s.branch || 'main');
    setTarget(s.target || 'prod');
    setProfilesYaml(s.profilesYaml || '');
    setModelsText((s.models || []).join('\n'));
    setCommandsText((s.commands || []).join('\n'));
    setClusterId(s.clusterId || '');
    setDatabricksJobId(s.databricksJobId ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setBusy(true); setErr(null); setSaveMsg('Saving dbt-job…');
    try {
      await saveItem('dbt-job', id, buildState());
      setDirty(false);
      setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); setSaveMsg(null); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true); setErr(null); setLastRun(null);
    try {
      await saveItem('dbt-job', id, buildState());
      setDirty(false);
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

  // Phase 4.5 — Ctrl+S / Cmd+S shortcut for Save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (id !== 'new' && dirty && !busy) save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, dirty, busy]);

  const canSaveDbt = !busy && dirty;
  const canRunDbt = !busy && !!repoUrl && !!clusterId;
  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Edit', actions: [
        { label: dirty ? 'Save' : 'Saved', onClick: canSaveDbt ? save : undefined, disabled: !canSaveDbt },
      ]},
      { label: 'Run', actions: [
        { label: busy ? 'Running…' : 'Run dbt', onClick: canRunDbt ? run : undefined, disabled: !canRunDbt },
        { label: 'Refresh', onClick: busy ? undefined : loadRuns, disabled: busy },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busy, dirty, canSaveDbt, canRunDbt, loadRuns]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create dbt job"
        intro="A dbt Job runs your dbt project on a Databricks cluster (materialised as a Databricks Job + dbt_task). Create it, then configure the repo + cluster and Run dbt." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div className={styles.form}>
        <ErrBar error={err || loadError} />
        {loading && <Spinner size="small" label="Loading dbt-job…" labelPosition="after" />}

        <Subtitle2>Databricks workspace</Subtitle2>
        {dbxWs.loading && <Spinner size="tiny" label="Loading workspace…" labelPosition="after" />}
        {dbxWs.workspace && (
          <div className={styles.field}>
            <Caption1>Workspace (configured via <code>LOOM_DATABRICKS_HOSTNAME</code>)</Caption1>
            <Input value={dbxWs.workspace.hostname} readOnly aria-readonly="true" />
            <Caption1>
              All dbt runs execute on a cluster in this workspace.
              <a href={dbxWs.workspace.url} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>Open in Databricks</a>
            </Caption1>
          </div>
        )}
        {dbxWs.error && (
          <MessageBar intent="warning">
            <MessageBarBody>
              <MessageBarTitle>Databricks workspace not configured</MessageBarTitle>
              {dbxWs.error}
              {dbxWs.hint && <><br /><Caption1>{dbxWs.hint}</Caption1></>}
            </MessageBarBody>
          </MessageBar>
        )}

        <Subtitle2>Project</Subtitle2>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Git repo URL</Caption1>
            <Input value={repoUrl} onChange={(_, d) => { setRepoUrl(d.value); setDirty(true); }} placeholder="https://github.com/contoso/dbt-prod" />
          </div>
          <div className={styles.field}>
            <Caption1>Branch</Caption1>
            <Input value={branch} onChange={(_, d) => { setBranch(d.value); setDirty(true); }} />
          </div>
        </div>
        <div className={styles.row}>
          <div className={styles.field}>
            <Caption1>Target profile</Caption1>
            <Input value={target} onChange={(_, d) => { setTarget(d.value); setDirty(true); }} placeholder="prod" />
          </div>
          <div className={styles.field}>
            {/*
             * Replaced the free-text "paste cluster ID by hand" Input with the
             * shared ComputePicker so users can (a) see live cluster state,
             * (b) Start/Restart from inline, and (c) avoid typos. The picker
             * emits ids like "databricks:<clusterId>"; we strip the prefix
             * before persisting so the run BFF (which expects a bare cluster
             * id) keeps working.
             */}
            <ComputePicker
              label="Databricks cluster"
              filter={['databricks-cluster']}
              value={clusterId ? `databricks:${clusterId}` : ''}
              onChange={(picked) => {
                const bare = picked.startsWith('databricks:') ? picked.slice('databricks:'.length) : picked;
                setClusterId(bare);
                setDirty(true);
              }}
            />
          </div>
        </div>
        <div className={styles.field}>
          <Caption1>Model selection (--select, one per line; blank = all)</Caption1>
          <Textarea value={modelsText} onChange={(_, d) => { setModelsText(d.value); setDirty(true); }} rows={3}
            placeholder={'tag:nightly\nstg_orders+'} />
        </div>
        <div className={styles.field}>
          <Caption1>Override commands (one per line; blank = default dbt deps + dbt run)</Caption1>
          <Textarea value={commandsText} onChange={(_, d) => { setCommandsText(d.value); setDirty(true); }} rows={3}
            placeholder={'dbt deps\ndbt seed\ndbt run\ndbt test'} />
        </div>
        <div className={styles.field}>
          <Caption1>profiles.yml (informational — copy into your repo)</Caption1>
          <Textarea value={profilesYaml} onChange={(_, d) => { setProfilesYaml(d.value); setDirty(true); }} rows={6}
            placeholder={'prod:\n  target: prod\n  outputs:\n    prod:\n      type: databricks\n      ...'} />
        </div>

        {saveMsg && <MessageBar intent="success"><MessageBarBody>{saveMsg}</MessageBarBody></MessageBar>}
        <div className={styles.toolbar}>
          <Button appearance="primary" onClick={run} disabled={busy || !repoUrl || !clusterId}>Run dbt</Button>
          <Button onClick={save} disabled={busy || !dirty}>{dirty ? 'Save' : 'Saved'}</Button>
          <Button onClick={loadRuns} disabled={busy}>Refresh runs</Button>
          {busy && <Spinner size="tiny" />}
          {dirty && <Badge appearance="outline" color="warning">unsaved</Badge>}
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
