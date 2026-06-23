'use client';

/**
 * Spark Job Definition (SJD) editor — Fabric-parity surface over Azure
 * Synapse Spark (Livy batches). Replaces the thin form that previously lived
 * in `phase2-misc-editors.tsx`.
 *
 * Anatomy mirrors Fabric's SJD item editor (docs/fiab/parity/spark-job-definition.md):
 *
 *   Ribbon (Home): Run · Cancel active run · Refresh runs · Save
 *   Tabs:
 *     • Definition    — Language, Main definition file (upload OR abfss://),
 *                       Main class (Scala/Java), Reference files (.py/.jar/.files),
 *                       Command-line arguments, Spark pool, Environment.
 *     • Spark Compute — driver/executor memory + cores, executor count, and the
 *                       per-job Spark conf key/value grid.
 *     • Optimization  — retry policy (count + interval) with an idempotency note.
 *     • Runs          — live runs-history grid; per-run Cancel + driver-log viewer.
 *
 * Every control hits a real backend:
 *   - Save / load spec   → Cosmos via /api/items/spark-job-definition/[id]
 *   - File upload        → ADLS Gen2 via /api/items/spark-job-definition/[id]/files
 *   - Submit batch       → Synapse Livy via .../submit
 *   - Runs list          → Synapse Livy via .../runs
 *   - Run detail + logs  → Synapse Livy via .../runs/[runId]
 *   - Cancel run         → Synapse Livy via .../runs/[runId]/cancel
 *
 * No mock data. Errors surface verbatim in a MessageBar. Works against
 * Azure-native Synapse with LOOM_DEFAULT_FABRIC_WORKSPACE unset — no Fabric.
 */

import {
  Subtitle2, Caption1, Body1Strong, Input, Dropdown, Option, Button, Badge, Textarea,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Switch, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList, Accordion, AccordionHeader, AccordionItem, AccordionPanel,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { ArrowUpload16Regular, Dismiss16Regular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import { KeyValueGrid } from '@/lib/components/ui/key-value-grid';

const useStyles = makeStyles({
  tabBar: { padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL} 0`, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  tabBody: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: 900 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  fileRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  refList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  refItem: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  refUri: {
    flex: 1, fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', marginTop: tokens.spacingVerticalS },
  resultBox: { marginTop: tokens.spacingVerticalS, borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: tokens.spacingVerticalM },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200 },
  logPre: {
    margin: 0, maxHeight: 320, overflow: 'auto', padding: tokens.spacingVerticalS,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, lineHeight: '1.4',
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusMedium, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  },
});

// ---- types -----------------------------------------------------------------

type SparkLanguage = 'PySpark' | 'Spark' | 'SparkR';

interface SparkBatchRun {
  id: number;
  name?: string;
  state?: string;
  result?: string;
  submittedAt?: string;
  appId?: string | null;
}

interface PoolDTO { name: string; properties?: { sparkVersion?: string; nodeSize?: string } }
interface ItemLite { id: string; displayName: string }
interface ItemDTO { id: string; workspaceId: string; displayName: string; state?: Record<string, any> }

const LANGUAGES: { value: SparkLanguage; label: string; accept: string }[] = [
  { value: 'PySpark', label: 'PySpark (Python)', accept: '.py' },
  { value: 'Spark',   label: 'Spark (Scala/Java)', accept: '.jar' },
  { value: 'SparkR',  label: 'SparkR (R)', accept: '.r,.R' },
];

const ACTIVE_STATES = new Set(['starting', 'running', 'busy', 'not_started', 'recovering']);

// ---- helpers ---------------------------------------------------------------

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

function usePoolList() {
  const [pools, setPools] = useState<PoolDTO[]>([]);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/items/synapse-spark-pool/list');
        const j = await r.json();
        if (j.ok) setPools(j.pools || []);
        else setPoolErr(j.error || 'failed to list Spark pools');
      } catch (e: any) { setPoolErr(e?.message || String(e)); }
    })();
  }, []);
  return { pools, poolErr };
}

function useEnvironments() {
  const [envs, setEnvs] = useState<ItemLite[]>([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/items/environment');
        const j = await r.json();
        if (j.ok) setEnvs((j.items || []).map((i: any) => ({ id: i.id, displayName: i.displayName })));
      } catch { /* environment is optional; ignore */ }
    })();
  }, []);
  return envs;
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
  return { item, error, loading, reload };
}

async function saveItemState(itemType: string, id: string, state: Record<string, any>): Promise<void> {
  const r = await fetch(`/api/items/${itemType}/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'save failed');
}

function linesToArr(s: string): string[] {
  return s.split('\n').map((x) => x.trim()).filter(Boolean);
}

// ============================================================================

export function SparkJobDefinitionEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const { pools, poolErr } = usePoolList();
  const environments = useEnvironments();
  const { item: cosmosItem, error: loadError, loading, reload } = useItem('spark-job-definition', id);

  const [tab, setTab] = useState('definition');

  // Definition
  const [language, setLanguage] = useState<SparkLanguage>('PySpark');
  const [file, setFile] = useState('');
  const [className, setClassName] = useState('');
  const [argsText, setArgsText] = useState('');
  const [refPyText, setRefPyText] = useState('');
  const [refJarText, setRefJarText] = useState('');
  const [refFilesText, setRefFilesText] = useState('');
  const [pool, setPool] = useState('');
  const [environmentId, setEnvironmentId] = useState('');

  // Spark compute
  const [driverMemory, setDriverMemory] = useState('');
  const [driverCores, setDriverCores] = useState('');
  const [executorMemory, setExecutorMemory] = useState('');
  const [executorCores, setExecutorCores] = useState('');
  const [numExecutors, setNumExecutors] = useState('');
  const [confText, setConfText] = useState('{}');

  // Optimization
  const [retryEnabled, setRetryEnabled] = useState(false);
  const [retryCount, setRetryCount] = useState('1');
  const [retryInterval, setRetryInterval] = useState('30');

  // Runs / status
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<SparkBatchRun[]>([]);
  const [lastSubmit, setLastSubmit] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // log viewer state: runId -> { loading, text, error }
  const [logs, setLogs] = useState<Record<number, { loading: boolean; text?: string; error?: string }>>({});

  const mainFileInput = useRef<HTMLInputElement | null>(null);

  const langDef = LANGUAGES.find((l) => l.value === language) || LANGUAGES[0];

  useEffect(() => {
    const spec = (cosmosItem?.state as any)?.spec;
    if (!spec) return;
    if (dirty) return;
    setLanguage((spec.language as SparkLanguage) || 'PySpark');
    setFile(spec.file || '');
    setClassName(spec.className || '');
    setArgsText((spec.args || []).join('\n'));
    setRefPyText((spec.pyFiles || []).join('\n'));
    setRefJarText((spec.jars || []).join('\n'));
    setRefFilesText((spec.files || []).join('\n'));
    setPool(spec.pool || '');
    setEnvironmentId(spec.environmentId || '');
    setDriverMemory(spec.driverMemory || '');
    setDriverCores(spec.driverCores != null ? String(spec.driverCores) : '');
    setExecutorMemory(spec.executorMemory || '');
    setExecutorCores(spec.executorCores != null ? String(spec.executorCores) : '');
    setNumExecutors(spec.numExecutors != null ? String(spec.numExecutors) : '');
    setConfText(JSON.stringify(spec.conf || {}, null, 2));
    setRetryEnabled(!!spec.retryPolicy);
    setRetryCount(spec.retryPolicy?.retryCount != null ? String(spec.retryPolicy.retryCount) : '1');
    setRetryInterval(spec.retryPolicy?.intervalBetweenRetriesInSeconds != null
      ? String(spec.retryPolicy.intervalBetweenRetriesInSeconds) : '30');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cosmosItem]);

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await fetch(`/api/items/spark-job-definition/${encodeURIComponent(id)}/runs?size=25`);
      const j = await r.json();
      if (j.ok) setRuns(j.sessions || []);
      else if (j.error) setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  useEffect(() => { if (cosmosItem) loadRuns(); }, [cosmosItem, loadRuns]);

  // Auto-refresh the runs grid while any run is still active so the user sees
  // the status transition to Succeeded/Failed without clicking Refresh.
  const anyActive = runs.some((r) => ACTIVE_STATES.has((r.state || '').toLowerCase()));
  useEffect(() => {
    if (id === 'new' || !anyActive) return;
    const t = setInterval(loadRuns, 5000);
    return () => clearInterval(t);
  }, [id, anyActive, loadRuns]);

  const numOrUndef = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() && Number.isFinite(n) ? n : undefined;
  };

  const buildSpec = () => {
    let conf: Record<string, string> = {};
    try { conf = JSON.parse(confText || '{}'); }
    catch { throw new Error('Spark conf must be valid JSON'); }
    if (retryEnabled) {
      const rc = Number(retryCount);
      const ri = Number(retryInterval);
      if (!Number.isInteger(rc) || (rc < 1 && rc !== -1)) {
        throw new Error('Retry count must be an integer ≥ 1 (or -1 for unlimited)');
      }
      if (!Number.isInteger(ri) || ri < 0 || ri > 86400) {
        throw new Error('Retry interval must be 0–86400 seconds');
      }
    }
    return {
      language,
      file: file.trim(),
      className: language === 'Spark' ? (className.trim() || undefined) : undefined,
      args: linesToArr(argsText),
      pyFiles: linesToArr(refPyText),
      jars: linesToArr(refJarText),
      files: linesToArr(refFilesText),
      conf,
      pool,
      environmentId: environmentId || undefined,
      driverMemory: driverMemory.trim() || undefined,
      driverCores: numOrUndef(driverCores),
      executorMemory: executorMemory.trim() || undefined,
      executorCores: numOrUndef(executorCores),
      numExecutors: numOrUndef(numExecutors),
      retryPolicy: retryEnabled
        ? { retryCount: Number(retryCount), intervalBetweenRetriesInSeconds: Number(retryInterval) }
        : undefined,
    };
  };

  const save = async () => {
    setBusy(true); setErr(null); setSaveMsg('Saving spec…');
    try {
      const spec = buildSpec();
      await saveItemState('spark-job-definition', id, { ...(cosmosItem?.state || {}), spec });
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
      await saveItemState('spark-job-definition', id, { ...(cosmosItem?.state || {}), spec });
      setDirty(false);
      const r = await fetch(`/api/items/spark-job-definition/${encodeURIComponent(id)}/submit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'submit failed');
      setLastSubmit(j.job);
      setTab('runs');
      setTimeout(loadRuns, 1500);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const uploadMain = async (chosen: File) => {
    setUploading(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append('kind', 'main');
      fd.append('file', chosen);
      const r = await fetch(`/api/items/spark-job-definition/${encodeURIComponent(id)}/files`, {
        method: 'POST', body: fd,
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'upload failed');
      setFile(j.abfssPath);
      setDirty(true);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setUploading(false); }
  };

  const cancelRun = async (runId: number) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`/api/items/spark-job-definition/${encodeURIComponent(id)}/runs/${runId}/cancel`, {
        method: 'POST',
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'cancel failed');
      setTimeout(loadRuns, 1000);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const loadLog = async (runId: number) => {
    setLogs((m) => ({ ...m, [runId]: { loading: true } }));
    try {
      const r = await fetch(`/api/items/spark-job-definition/${encodeURIComponent(id)}/runs/${runId}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'log fetch failed');
      const log: string[] = j.job?.log || [];
      const errInfo: any[] = j.job?.errorInfo || [];
      const text = [
        ...log,
        ...(errInfo.length ? ['', '--- errorInfo ---', JSON.stringify(errInfo, null, 2)] : []),
      ].join('\n') || '(no driver log lines returned yet — the job may still be starting)';
      setLogs((m) => ({ ...m, [runId]: { loading: false, text } }));
    } catch (e: any) {
      setLogs((m) => ({ ...m, [runId]: { loading: false, error: e?.message || String(e) } }));
    }
  };

  // Ctrl+S / Cmd+S → Save.
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
  const activeRun = runs.find((r) => ACTIVE_STATES.has((r.state || '').toLowerCase()));

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Run', actions: [
        { label: busy ? 'Submitting…' : 'Submit', icon: undefined, appearance: 'primary',
          onClick: canSubmit ? submit : undefined, disabled: !canSubmit },
        { label: 'Cancel active run',
          onClick: activeRun && !busy ? () => cancelRun(activeRun.id) : undefined,
          disabled: !activeRun || busy },
        { label: 'Refresh runs', onClick: busy ? undefined : loadRuns, disabled: busy },
      ]},
      { label: 'Edit', actions: [
        { label: dirty ? 'Save' : 'Saved', onClick: canSave ? save : undefined, disabled: !canSave },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busy, canSubmit, canSave, dirty, loadRuns, activeRun]);

  if (id === 'new') {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
        <div className={styles.tabBody}>
          <MessageBar intent="info">
            <MessageBarBody>Create this Spark Job Definition from the workspace catalog,
              then return here to configure the job spec and submit batches.</MessageBarBody>
          </MessageBar>
        </div>
      } />
    );
  }

  const markDirty = () => setDirty(true);

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={styles.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="definition">Definition</Tab>
            <Tab value="compute">Spark Compute</Tab>
            <Tab value="optimization">Optimization</Tab>
            <Tab value="runs">Runs</Tab>
          </TabList>
        </div>
        <div className={styles.tabBody}>
          <ErrBar error={err || loadError} />
          {loading && <Spinner size="small" label="Loading spec…" labelPosition="after" />}
          {poolErr && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>Spark pools unavailable</MessageBarTitle>
                {poolErr} — ensure <code>LOOM_SYNAPSE_WORKSPACE</code> is set and the Console UAMI has
                Synapse Administrator on the workspace (provisioned by
                <code> platform/fiab/bicep/modules/landing-zone/synapse.bicep</code>).
              </MessageBarBody>
            </MessageBar>
          )}

          {/* ---------------- Definition ---------------- */}
          {tab === 'definition' && (
            <>
              <Subtitle2>Definition</Subtitle2>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Language</Caption1>
                  <Dropdown value={langDef.label} selectedOptions={[language]}
                    onOptionSelect={(_, d) => { setLanguage((d.optionValue as SparkLanguage) || 'PySpark'); markDirty(); }}>
                    {LANGUAGES.map((l) => <Option key={l.value} value={l.value}>{l.label}</Option>)}
                  </Dropdown>
                </div>
                <div className={styles.field}>
                  <Caption1>Spark pool</Caption1>
                  <Dropdown value={pool} selectedOptions={pool ? [pool] : []}
                    placeholder={pools.length ? 'Select a Spark pool' : '(no pools — check workspace)'}
                    onOptionSelect={(_, d) => { setPool(d.optionValue || ''); markDirty(); }}>
                    {pools.map((p) => (
                      <Option key={p.name} value={p.name}>
                        {p.properties?.sparkVersion ? `${p.name} (Spark ${p.properties.sparkVersion})` : p.name}
                      </Option>
                    ))}
                  </Dropdown>
                </div>
              </div>

              <div className={styles.field}>
                <Caption1>Main definition file ({langDef.accept} — upload from local or paste an abfss:// URI)</Caption1>
                <div className={styles.fileRow}>
                  <Input className={styles.field} value={file}
                    onChange={(_, d) => { setFile(d.value); markDirty(); }}
                    placeholder={`abfss://landing@<account>.dfs.core.windows.net/sjd/${id}/Main/main${langDef.accept.split(',')[0]}`} />
                  <input ref={mainFileInput} type="file" accept={langDef.accept} style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadMain(f); e.target.value = ''; }} />
                  <Button icon={<ArrowUpload16Regular />} disabled={uploading}
                    onClick={() => mainFileInput.current?.click()}>
                    {uploading ? 'Uploading…' : 'Upload'}
                  </Button>
                </div>
              </div>

              {language === 'Spark' && (
                <div className={styles.field}>
                  <Caption1>Main class (FQCN, required for Scala/Java jars)</Caption1>
                  <Input value={className} onChange={(_, d) => { setClassName(d.value); markDirty(); }}
                    placeholder="com.example.Main" />
                </div>
              )}

              <div className={styles.field}>
                <Caption1>Command-line arguments (one per line → argv[])</Caption1>
                <Textarea value={argsText} onChange={(_, d) => { setArgsText(d.value); markDirty(); }} rows={3}
                  placeholder={'--input gold/sales\n--output gold/sales_agg'} />
              </div>

              <Subtitle2 style={{ marginTop: tokens.spacingVerticalS }}>Reference files</Subtitle2>
              <Caption1>Optional additional files staged with the job. Paste abfss:// URIs, one per line.</Caption1>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Python modules (.py / .zip / .egg → --py-files)</Caption1>
                  <Textarea value={refPyText} onChange={(_, d) => { setRefPyText(d.value); markDirty(); }} rows={3}
                    placeholder={'abfss://landing@<account>.dfs.core.windows.net/sjd/utils.py'} />
                </div>
                <div className={styles.field}>
                  <Caption1>JARs (.jar → --jars)</Caption1>
                  <Textarea value={refJarText} onChange={(_, d) => { setRefJarText(d.value); markDirty(); }} rows={3}
                    placeholder={'abfss://libs@<account>.dfs.core.windows.net/myudf.jar'} />
                </div>
              </div>
              <div className={styles.field}>
                <Caption1>Other files (data / config → --files)</Caption1>
                <Textarea value={refFilesText} onChange={(_, d) => { setRefFilesText(d.value); markDirty(); }} rows={2}
                  placeholder={'abfss://landing@<account>.dfs.core.windows.net/sjd/config.yaml'} />
              </div>

              <div className={styles.field}>
                <Caption1>Environment (optional — merges its Spark conf + JARs at submit)</Caption1>
                <Dropdown value={environments.find((e) => e.id === environmentId)?.displayName || ''}
                  selectedOptions={environmentId ? [environmentId] : ['']}
                  placeholder="Workspace default (none)"
                  onOptionSelect={(_, d) => { setEnvironmentId(d.optionValue || ''); markDirty(); }}>
                  <Option value="">Workspace default (none)</Option>
                  {environments.map((e) => <Option key={e.id} value={e.id}>{e.displayName}</Option>)}
                </Dropdown>
              </div>
            </>
          )}

          {/* ---------------- Spark Compute ---------------- */}
          {tab === 'compute' && (
            <>
              <Subtitle2>Spark compute</Subtitle2>
              <Caption1>Resource sizing for the batch driver and executors. Leave blank to inherit the pool defaults.</Caption1>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Driver memory (e.g. 4g, 8g)</Caption1>
                  <Input value={driverMemory} onChange={(_, d) => { setDriverMemory(d.value); markDirty(); }} placeholder="4g" />
                </div>
                <div className={styles.field}>
                  <Caption1>Driver cores</Caption1>
                  <Input type="number" value={driverCores} onChange={(_, d) => { setDriverCores(d.value); markDirty(); }} placeholder="4" />
                </div>
              </div>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Executor memory</Caption1>
                  <Input value={executorMemory} onChange={(_, d) => { setExecutorMemory(d.value); markDirty(); }} placeholder="8g" />
                </div>
                <div className={styles.field}>
                  <Caption1>Executor cores</Caption1>
                  <Input type="number" value={executorCores} onChange={(_, d) => { setExecutorCores(d.value); markDirty(); }} placeholder="4" />
                </div>
                <div className={styles.field}>
                  <Caption1>Number of executors</Caption1>
                  <Input type="number" value={numExecutors} onChange={(_, d) => { setNumExecutors(d.value); markDirty(); }} placeholder="2" />
                </div>
              </div>
              <div className={styles.field}>
                <Caption1>Spark configuration (per-job overrides)</Caption1>
                <KeyValueGrid value={confText} onChange={(v) => { setConfText(v); markDirty(); }}
                  keyLabel="Conf key" valueLabel="Value"
                  keyPlaceholder="spark.sql.shuffle.partitions" valuePlaceholder="200" addLabel="Add Spark conf" />
              </div>
            </>
          )}

          {/* ---------------- Optimization ---------------- */}
          {tab === 'optimization' && (
            <>
              <Subtitle2>Optimization</Subtitle2>
              <Switch checked={retryEnabled} label="Retry policy"
                onChange={(_, d) => { setRetryEnabled(d.checked); markDirty(); }} />
              {retryEnabled && (
                <>
                  <MessageBar intent="warning">
                    <MessageBarBody>Make sure the job is idempotent — a retried run re-executes the
                      whole batch and can duplicate side-effects if writes are not idempotent.</MessageBarBody>
                  </MessageBar>
                  <div className={styles.row}>
                    <div className={styles.field}>
                      <Caption1>Retry count (≥ 1, or -1 for unlimited)</Caption1>
                      <Input type="number" value={retryCount} onChange={(_, d) => { setRetryCount(d.value); markDirty(); }} />
                    </div>
                    <div className={styles.field}>
                      <Caption1>Interval between retries (seconds, 0–86400)</Caption1>
                      <Input type="number" value={retryInterval} onChange={(_, d) => { setRetryInterval(d.value); markDirty(); }} />
                    </div>
                  </div>
                  <Caption1>
                    Persisted on the SJD spec and re-applied on every submit. Synapse Livy has no native
                    per-batch retry; Loom re-submits a failed batch up to the configured count via the
                    run-orchestrator. Until that worker is enabled in a deployment, the policy is stored
                    and surfaced but not auto-enforced — re-submit manually from the Runs tab.
                  </Caption1>
                </>
              )}
            </>
          )}

          {/* ---------------- Runs ---------------- */}
          {tab === 'runs' && (
            <>
              {lastSubmit && (
                <MessageBar intent="success">
                  <MessageBarBody>
                    <MessageBarTitle>Submitted batch #{lastSubmit.id}</MessageBarTitle>
                    State: {lastSubmit.state || lastSubmit.livyInfo?.currentState || '—'}
                    {lastSubmit.appId && ` · appId ${lastSubmit.appId}`}
                  </MessageBarBody>
                </MessageBar>
              )}
              <div className={styles.toolbar}>
                <Button appearance="primary" onClick={submit} disabled={!canSubmit}>
                  {busy ? 'Submitting…' : 'Submit batch'}
                </Button>
                <Button onClick={loadRuns} disabled={busy}>Refresh runs</Button>
                {busy && <Spinner size="tiny" />}
                {anyActive && <Badge appearance="outline" color="informative">live — auto-refreshing</Badge>}
              </div>

              <div className={styles.resultBox}>
                <Subtitle2>Run history</Subtitle2>
                {runs.length === 0 ? (
                  <Caption1>No runs yet. Configure the Definition tab and Submit a batch.</Caption1>
                ) : (
                  <Table size="small" aria-label="Spark batch runs">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>ID</TableHeaderCell>
                        <TableHeaderCell>Application name</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Result</TableHeaderCell>
                        <TableHeaderCell>Submitted</TableHeaderCell>
                        <TableHeaderCell>Spark app ID</TableHeaderCell>
                        <TableHeaderCell>Actions</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((r) => {
                        const active = ACTIVE_STATES.has((r.state || '').toLowerCase());
                        return (
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
                            <TableCell>
                              {active && (
                                <Tooltip content="Cancel this run" relationship="label">
                                  <Button size="small" icon={<Dismiss16Regular />} disabled={busy}
                                    onClick={() => cancelRun(r.id)}>Cancel</Button>
                                </Tooltip>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}

                {runs.length > 0 && (
                  <div style={{ marginTop: tokens.spacingVerticalM }}>
                    <Body1Strong>Driver logs</Body1Strong>
                    <Accordion multiple collapsible
                      onToggle={(_, d) => {
                        const opened = (d.openItems as (string | number)[]) || [];
                        for (const v of opened) {
                          const rid = Number(v);
                          if (Number.isFinite(rid) && !logs[rid]) loadLog(rid);
                        }
                      }}>
                      {runs.map((r) => (
                        <AccordionItem key={r.id} value={r.id}>
                          <AccordionHeader>Batch #{r.id} · {r.name || '—'} · {r.state || '—'}</AccordionHeader>
                          <AccordionPanel>
                            {logs[r.id]?.loading && <Spinner size="tiny" label="Loading log…" labelPosition="after" />}
                            {logs[r.id]?.error && <ErrBar error={logs[r.id]!.error!} />}
                            {logs[r.id]?.text !== undefined && (
                              <>
                                <Button size="small" appearance="subtle" onClick={() => loadLog(r.id)} style={{ marginBottom: tokens.spacingVerticalXS }}>
                                  Reload log
                                </Button>
                                <pre className={styles.logPre}>{logs[r.id]!.text}</pre>
                              </>
                            )}
                            {!logs[r.id] && <Caption1>Expand to fetch the driver log tail.</Caption1>}
                          </AccordionPanel>
                        </AccordionItem>
                      ))}
                    </Accordion>
                  </div>
                )}
              </div>
            </>
          )}

          {saveMsg && <MessageBar intent="success"><MessageBarBody>{saveMsg}</MessageBarBody></MessageBar>}
          {dirty && (
            <div className={styles.toolbar}>
              <Button appearance="primary" onClick={save} disabled={!canSave}>Save spec</Button>
              <Badge appearance="outline" color="warning">unsaved changes</Badge>
            </div>
          )}
        </div>
      </>
    } />
  );
}
