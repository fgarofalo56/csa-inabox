'use client';

/**
 * SynapseSparkEditor — the Synapse Studio "Spark job definition" editor for a
 * workspace artifact (Develop hub → Spark job definitions → open a definition).
 *
 * Synapse-Studio-faithful surface for authoring + submitting a batch Spark job
 * definition that runs as a Livy batch against a Synapse Spark Big Data pool.
 * This is the WORKSPACE-ARTIFACT SJD (persisted in the Synapse dev-plane
 * `sparkJobDefinitions` collection) — distinct from the Cosmos-tracked Loom
 * spark-job-definition ITEM (spark-job-definition-editor.tsx). It mirrors the
 * same Fabric/Synapse anatomy:
 *
 *   Definition tab    — Language, Spark pool, Main definition file (abfss://),
 *                       Main class, Command-line arguments, Reference files.
 *   Spark Compute tab — driver/executor memory + cores, executor count.
 *   Runs tab          — live Livy-batch history grid; per-run state.
 *
 * Every control hits a real backend (no mocks):
 *   - load / save → /api/synapse/sparkjobdefinitions/[name]       (GET / PUT)
 *   - pools        → /api/synapse/sparkjobdefinitions/[name]       (ARM bigDataPools)
 *   - Submit       → /api/synapse/sparkjobdefinitions/[name]/run    (Livy batch)
 *   - Runs list    → /api/synapse/sparkjobdefinitions/[name]/run    (Livy batches)
 *
 * Azure-native: the target is a real Synapse Spark pool — no Fabric. Rendered as
 * a Drawer overlay by the pipeline editor.
 */

import {
  Drawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Button, Dropdown, Option, Input, Textarea, Field, Caption1, Badge, Spinner,
  Tab, TabList, MessageBar, MessageBarBody, MessageBarTitle,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss24Regular, Play16Regular, Save16Regular, ArrowSync16Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useState } from 'react';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, height: '100%', overflow: 'hidden' },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  tabBody: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, overflow: 'auto', flex: 1, minHeight: 0, paddingTop: tokens.spacingVerticalS },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300 },
  // Constrain the (long) Spark application id so it never blows out the runs grid.
  appIdCell: {
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase300,
    maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  hint: { color: tokens.colorNeutralForeground3 },
  // Sticky header keeps the runs columns visible while scrolling history.
  runsHeader: { position: 'sticky', top: 0, zIndex: 1, backgroundColor: tokens.colorNeutralBackground1 },
});

type SparkLanguage = 'PySpark' | 'Spark' | 'SparkR';

interface JobProps {
  file?: string; className?: string; args?: string[]; jars?: string[]; pyFiles?: string[]; files?: string[];
  conf?: Record<string, string>;
  driverMemory?: string; driverCores?: number; executorMemory?: string; executorCores?: number; numExecutors?: number;
}
interface SjdProps {
  description?: string;
  targetBigDataPool?: { referenceName: string; type: string };
  language?: string;
  jobProperties?: JobProps;
}
interface PoolRow { name: string; sparkVersion?: string; nodeSize?: string }
interface RunRow { id: number; state?: string; appId?: string | null; result?: string; submittedAt?: string }

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { ok: false, error: text || `HTTP ${res.status}` }; }
}

const splitLines = (v: string): string[] => v.split('\n').map((x) => x.trim()).filter(Boolean);

export interface SynapseSparkEditorProps {
  /** The Spark job definition artifact name. */
  name: string;
  /** Close the editor (clears the parent's open state). */
  onClose: () => void;
}

export function SynapseSparkEditor({ name, onClose }: SynapseSparkEditorProps) {
  const s = useStyles();
  const base = `/api/synapse/sparkjobdefinitions/${encodeURIComponent(name)}`;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'definition' | 'compute' | 'runs'>('definition');

  const [pools, setPools] = useState<PoolRow[]>([]);
  const [pool, setPool] = useState('');
  const [language, setLanguage] = useState<SparkLanguage>('PySpark');
  const [file, setFile] = useState('');
  const [className, setClassName] = useState('');
  const [args, setArgs] = useState('');         // newline-separated
  const [pyFiles, setPyFiles] = useState('');   // newline-separated
  const [jars, setJars] = useState('');         // newline-separated
  const [refFiles, setRefFiles] = useState(''); // newline-separated

  const [driverMemory, setDriverMemory] = useState('4g');
  const [driverCores, setDriverCores] = useState('4');
  const [executorMemory, setExecutorMemory] = useState('4g');
  const [executorCores, setExecutorCores] = useState('4');
  const [numExecutors, setNumExecutors] = useState('2');

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<string | null>(null);
  const [submitGate, setSubmitGate] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const body = await fetch(base).then(readJson);
      if (!body.ok) { setError(body.error || 'failed to load Spark job definition'); setLoading(false); return; }
      const props = body.sparkJobDefinition?.properties as SjdProps | undefined;
      const jp = props?.jobProperties || {};
      setPool(props?.targetBigDataPool?.referenceName || '');
      setLanguage((props?.language as SparkLanguage) || 'PySpark');
      setFile(jp.file || '');
      setClassName(jp.className || '');
      setArgs((jp.args || []).join('\n'));
      setPyFiles((jp.pyFiles || []).join('\n'));
      setJars((jp.jars || []).join('\n'));
      setRefFiles((jp.files || []).join('\n'));
      if (jp.driverMemory) setDriverMemory(jp.driverMemory);
      if (typeof jp.driverCores === 'number') setDriverCores(String(jp.driverCores));
      if (jp.executorMemory) setExecutorMemory(jp.executorMemory);
      if (typeof jp.executorCores === 'number') setExecutorCores(String(jp.executorCores));
      if (typeof jp.numExecutors === 'number') setNumExecutors(String(jp.numExecutors));
      setPools(body.pools || []);
      setDirty(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { load(); }, [load]);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    try {
      const body = await fetch(`${base}/run`).then(readJson);
      if (body.ok) setRuns(body.runs || []);
    } catch { /* leave runs as-is */ }
    finally { setRunsLoading(false); }
  }, [base]);

  useEffect(() => { if (tab === 'runs') loadRuns(); }, [tab, loadRuns]);

  const buildProperties = useCallback((): SjdProps => ({
    targetBigDataPool: { referenceName: pool, type: 'BigDataPoolReference' },
    language,
    jobProperties: {
      file,
      className: className || undefined,
      args: splitLines(args),
      pyFiles: splitLines(pyFiles),
      jars: splitLines(jars),
      files: splitLines(refFiles),
      driverMemory, driverCores: Number(driverCores) || undefined,
      executorMemory, executorCores: Number(executorCores) || undefined,
      numExecutors: Number(numExecutors) || undefined,
    },
  }), [pool, language, file, className, args, pyFiles, jars, refFiles, driverMemory, driverCores, executorMemory, executorCores, numExecutors]);

  const save = useCallback(async () => {
    if (!pool) { setError('Pick a Spark pool before saving.'); return; }
    setSaving(true); setError(null); setSavedNote(null);
    try {
      const body = await fetch(base, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ properties: buildProperties() }),
      }).then(readJson);
      if (!body.ok) { setError(body.error || 'save failed'); setSaving(false); return; }
      setDirty(false); setSavedNote('Saved');
      setTimeout(() => setSavedNote(null), 2500);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  }, [base, pool, buildProperties]);

  const submit = useCallback(async () => {
    setSubmitting(true); setSubmitMsg(null); setSubmitGate(null);
    try {
      // Save first so the run uses the latest definition.
      if (dirty) await save();
      const body = await fetch(`${base}/run`, { method: 'POST' }).then(readJson);
      if (!body.ok) {
        if (body.code === 'no_pool' || body.code === 'no_file') setSubmitGate(body.error);
        else setSubmitMsg(body.error || 'submit failed');
        setSubmitting(false);
        return;
      }
      setSubmitMsg(`Submitted batch ${body.batchId} (state: ${body.state})`);
      setTab('runs');
      await loadRuns();
    } catch (e: any) { setSubmitMsg(e?.message || String(e)); }
    finally { setSubmitting(false); }
  }, [base, dirty, save, loadRuns]);

  const markDirty = () => setDirty(true);

  return (
    <Drawer open position="end" size="large" onOpenChange={(_, d) => { if (!d.open) onClose(); }} separator>
      <DrawerHeader>
        <DrawerHeaderTitle
          action={<Button appearance="subtle" aria-label="Close" icon={<Dismiss24Regular />} onClick={onClose} />}
        >
          Spark job definition · {name}
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        {loading ? (
          <div style={{ padding: tokens.spacingVerticalL }}><Spinner label="Loading Spark job definition…" /></div>
        ) : (
          <div className={s.body}>
            {error && (
              <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Error</MessageBarTitle>{error}</MessageBarBody></MessageBar>
            )}

            <div className={s.toolbar}>
              <Button appearance="primary" icon={submitting ? <Spinner size="tiny" /> : <Play16Regular />} disabled={submitting} onClick={submit}>
                {submitting ? 'Submitting…' : 'Submit'}
              </Button>
              <Button icon={<Save16Regular />} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</Button>
              <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={loading} onClick={load}>Refresh</Button>
              {dirty && <Badge appearance="tint" color="warning">Unsaved</Badge>}
              {savedNote && <Badge appearance="tint" color="success">{savedNote}</Badge>}
            </div>

            {submitGate && (
              <MessageBar intent="warning"><MessageBarBody><MessageBarTitle>Cannot submit yet</MessageBarTitle>{submitGate}</MessageBarBody></MessageBar>
            )}
            {submitMsg && (
              <MessageBar intent="info"><MessageBarBody>{submitMsg}</MessageBarBody></MessageBar>
            )}

            <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as any)}>
              <Tab value="definition">Definition</Tab>
              <Tab value="compute">Spark compute</Tab>
              <Tab value="runs">Runs</Tab>
            </TabList>

            {tab === 'definition' && (
              <div className={s.tabBody}>
                <div className={s.row}>
                  <Field label="Language" className={s.field}>
                    <Dropdown value={language} selectedOptions={[language]} onOptionSelect={(_, d) => { setLanguage((d.optionValue as SparkLanguage) || 'PySpark'); markDirty(); }}>
                      {(['PySpark', 'Spark', 'SparkR'] as SparkLanguage[]).map((l) => <Option key={l} value={l} text={l}>{l}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Spark pool" className={s.field} required>
                    <Dropdown
                      placeholder={pools.length ? 'Select a Spark pool' : 'No Spark pools on this workspace'}
                      value={pool} selectedOptions={pool ? [pool] : []} disabled={!pools.length}
                      onOptionSelect={(_, d) => { setPool(d.optionValue || ''); markDirty(); }}
                    >
                      {pools.map((p) => <Option key={p.name} value={p.name} text={p.name}>{p.name}{p.sparkVersion ? ` · Spark ${p.sparkVersion}` : ''}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
                <Field label="Main definition file" hint="abfss:// URI to the main .py or .jar">
                  <Input className={s.mono} value={file} onChange={(_, d) => { setFile(d.value); markDirty(); }} placeholder="abfss://container@account.dfs.core.windows.net/jobs/main.py" />
                </Field>
                {language !== 'PySpark' && (
                  <Field label="Main class (Scala/Java)">
                    <Input className={s.mono} value={className} onChange={(_, d) => { setClassName(d.value); markDirty(); }} placeholder="com.contoso.Main" />
                  </Field>
                )}
                <Field label="Command-line arguments" hint="one per line">
                  <Textarea className={s.mono} resize="vertical" rows={3} value={args} onChange={(_, d) => { setArgs(d.value); markDirty(); }} />
                </Field>
                <Field label="Python files (.py / .zip)" hint="one abfss:// URI per line">
                  <Textarea className={s.mono} resize="vertical" rows={2} value={pyFiles} onChange={(_, d) => { setPyFiles(d.value); markDirty(); }} />
                </Field>
                <Field label="JARs" hint="one abfss:// URI per line">
                  <Textarea className={s.mono} resize="vertical" rows={2} value={jars} onChange={(_, d) => { setJars(d.value); markDirty(); }} />
                </Field>
                <Field label="Reference files" hint="one abfss:// URI per line">
                  <Textarea className={s.mono} resize="vertical" rows={2} value={refFiles} onChange={(_, d) => { setRefFiles(d.value); markDirty(); }} />
                </Field>
              </div>
            )}

            {tab === 'compute' && (
              <div className={s.tabBody}>
                <div className={s.row}>
                  <Field label="Driver memory" className={s.field}>
                    <Input value={driverMemory} onChange={(_, d) => { setDriverMemory(d.value); markDirty(); }} placeholder="4g" />
                  </Field>
                  <Field label="Driver cores" className={s.field}>
                    <Input type="number" min={1} value={driverCores} onChange={(_, d) => { setDriverCores(d.value); markDirty(); }} />
                  </Field>
                </div>
                <div className={s.row}>
                  <Field label="Executor memory" className={s.field}>
                    <Input value={executorMemory} onChange={(_, d) => { setExecutorMemory(d.value); markDirty(); }} placeholder="4g" />
                  </Field>
                  <Field label="Executor cores" className={s.field}>
                    <Input type="number" min={1} value={executorCores} onChange={(_, d) => { setExecutorCores(d.value); markDirty(); }} />
                  </Field>
                  <Field label="Executors" className={s.field}>
                    <Input type="number" min={1} value={numExecutors} onChange={(_, d) => { setNumExecutors(d.value); markDirty(); }} />
                  </Field>
                </div>
                <Caption1 className={s.hint}>
                  These map 1:1 onto the Livy batch sizing the Submit button sends to the target Spark pool.
                </Caption1>
              </div>
            )}

            {tab === 'runs' && (
              <div className={s.tabBody}>
                <div className={s.toolbar}>
                  <Button appearance="subtle" icon={<ArrowSync16Regular />} disabled={runsLoading} onClick={loadRuns}>Refresh runs</Button>
                  {runsLoading && <Spinner size="tiny" />}
                </div>
                {runs.length === 0 ? (
                  <Caption1>No batch runs yet. Submit the definition to start one.</Caption1>
                ) : (
                  <Table size="small" aria-label="Spark batch runs">
                    <TableHeader className={s.runsHeader}>
                      <TableRow>
                        <TableHeaderCell>Batch ID</TableHeaderCell>
                        <TableHeaderCell>State</TableHeaderCell>
                        <TableHeaderCell>Result</TableHeaderCell>
                        <TableHeaderCell>App ID</TableHeaderCell>
                        <TableHeaderCell>Submitted</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{r.id}</TableCell>
                          <TableCell>
                            <Badge size="small" appearance="tint" color={r.state === 'success' ? 'success' : r.state === 'error' || r.state === 'dead' || r.state === 'killed' ? 'danger' : 'informative'}>{r.state || '—'}</Badge>
                          </TableCell>
                          <TableCell>{r.result || '—'}</TableCell>
                          <TableCell className={s.appIdCell} title={r.appId || undefined}>{r.appId || '—'}</TableCell>
                          <TableCell>{r.submittedAt || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            )}
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}
