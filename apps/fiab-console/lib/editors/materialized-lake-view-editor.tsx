'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * Materialized Lake View (MLV) editor — Fabric-parity surface, Azure-native.
 *
 * Mirrors the Fabric lakehouse "Materialized lake views" experience
 * (docs/fiab/parity/materialized-lake-view.md):
 *
 *   Ribbon (Home): Refresh · Refresh runs · Create ADF pipeline · Save
 *   Tabs:
 *     • Definition  — Language (SQL / PySpark), target container + schema + view
 *                     name, the SQL SELECT or PySpark function editor (Monaco),
 *                     partition columns, table properties, comment. Live
 *                     "Generated CREATE MATERIALIZED LAKE VIEW" preview.
 *     • Constraints — Data-quality CHECK constraints with FAIL / DROP actions.
 *     • Lineage     — Cross-workspace dependency graph (upstream sources +
 *                     downstream MLVs) read from / re-derived to Cosmos.
 *     • Refresh     — Run a full refresh (Synapse Spark batch) + live run grid;
 *                     create the "Refresh materialized lake view" ADF pipeline.
 *     • Preview     — Query the materialized Delta via Synapse Serverless.
 *
 * Every control hits a real backend (no mock data, per no-vaporware.md):
 *   - Save / load spec   → Cosmos via /api/items/materialized-lake-view/[id] (PATCH/GET)
 *   - Refresh            → /api/items/materialized-lake-view/[id]/refresh (Spark batch)
 *   - Runs               → /api/items/materialized-lake-view/[id]/runs (Livy history)
 *   - Lineage            → /api/items/materialized-lake-view/[id]/lineage (Cosmos)
 *   - ADF pipeline       → /api/items/materialized-lake-view/[id]/adf-pipeline (ARM)
 *   - Preview            → /api/items/materialized-lake-view/[id]/preview (Serverless SQL)
 *
 * Works against Azure-native Synapse + ADLS with LOOM_DEFAULT_FABRIC_WORKSPACE
 * unset — no Microsoft Fabric. Infra gaps surface as honest Fluent MessageBars.
 */

import {
  Subtitle2, Caption1, Body1Strong, Input, Dropdown, Option, Button, Badge,
  MessageBar, MessageBarBody, MessageBarTitle, Spinner, Tooltip,
  Tab, TabList, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSync16Regular, Dismiss16Regular, Add16Regular, Branch16Regular, Play16Regular,
  Checkmark16Regular, DataLine20Regular, BranchFork20Regular, Table20Regular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { KeyValueGrid } from '@/lib/components/ui/key-value-grid';
import { LoomDataTable, type LoomColumn } from '@/lib/components/ui/loom-data-table';
import { EmptyState } from '@/lib/components/empty-state';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import {
  MLV_CONTAINERS, buildCreateMlvSql, deriveSources, validateMlvSpec,
  type MlvSpec, type MlvLanguage, type MlvContainer, type MlvConstraint,
} from '@/lib/azure/materialized-lake-view-model';
import { useSharedEditorStyles } from './shared-styles';

const useLocalStyles = makeStyles({
  tabBody: { padding: tokens.spacingVerticalXXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '1000px', minWidth: 0 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  field: { flex: 1, minWidth: '180px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  toolbar: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere' },
  pre: {
    margin: 0, maxHeight: '280px', overflow: 'auto', maxWidth: '100%', padding: tokens.spacingVerticalMNudge,
    fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, lineHeight: '1.4',
    backgroundColor: tokens.colorNeutralBackground3, color: tokens.colorNeutralForeground1,
    borderRadius: tokens.borderRadiusMedium, whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere',
  },
  constraintRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end', flexWrap: 'wrap' },
  lineageBox: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalSNudge },
  lineageRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', padding: `${tokens.spacingVerticalXS} 0`, flexWrap: 'wrap', minWidth: 0 },
  chip: { padding: `${tokens.spacingVerticalXXS} ${tokens.spacingHorizontalS}`, borderRadius: tokens.borderRadiusCircular, backgroundColor: tokens.colorNeutralBackground3, fontSize: tokens.fontSizeBase200, overflowWrap: 'anywhere', minWidth: 0, maxWidth: '100%' },
  statusBar: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
});

function useStyles() {
  const shared = useSharedEditorStyles();
  const local = useLocalStyles();
  return useMemo(() => ({ ...shared, ...local }), [shared, local]);
}

const ACTIVE_STATES = new Set(['starting', 'running', 'busy', 'not_started', 'recovering']);

interface ItemDTO { id: string; workspaceId: string; displayName: string; state?: Record<string, any> }
interface BatchRun { id: number; name?: string; state?: string; result?: string; submittedAt?: string; appId?: string | null; trigger?: string }
interface LineageNode { id: string; label: string; type?: string; focus?: boolean; openHref?: string }
interface LineageEdge { from: string; to: string }

const SAMPLE_SQL =
  '-- SELECT that defines this materialized lake view\nSELECT\n  customerName,\n  SUM(sales) AS total_sales\nFROM bronze.customer_bronze\nWHERE sales IS NOT NULL\nGROUP BY customerName';
const SAMPLE_PYSPARK =
  '# Return a Spark DataFrame that defines this view\ndf = spark.read.table("bronze.customer_bronze")\ndf = df.filter(df["sales"].isNotNull())\nreturn df';

function ErrBar({ error, title = 'Operation failed' }: { error: string | null; title?: string }) {
  if (!error) return null;
  return (
    <MessageBar intent="error">
      <MessageBarBody style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}><MessageBarTitle>{title}</MessageBarTitle>{error}</MessageBarBody>
    </MessageBar>
  );
}

function GateBar({ gate }: { gate: { error?: string; remediation?: string; link?: string } | null }) {
  if (!gate) return null;
  return (
    <MessageBar intent="warning">
      <MessageBarBody style={{ overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 }}>
        <MessageBarTitle>Configuration required</MessageBarTitle>
        {gate.error} {gate.remediation}
        {gate.link && <> <a href={gate.link} target="_blank" rel="noreferrer">Learn more</a>.</>}
      </MessageBarBody>
    </MessageBar>
  );
}

function fmtTs(ts?: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function MaterializedLakeViewEditor({ item, id }: { item: FabricItemType; id: string }) {
  const styles = useStyles();
  const [tab, setTab] = useState('definition');
  const [cosmosItem, setCosmosItem] = useState<ItemDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Spec fields
  const [language, setLanguage] = useState<MlvLanguage>('sql');
  const [container, setContainer] = useState<MlvContainer>('silver');
  const [schema, setSchema] = useState('silver');
  const [viewName, setViewName] = useState('');
  const [sql, setSql] = useState(SAMPLE_SQL);
  const [pyspark, setPyspark] = useState(SAMPLE_PYSPARK);
  const [partitionText, setPartitionText] = useState('');
  const [propsJson, setPropsJson] = useState('{}');
  const [comment, setComment] = useState('');
  const [constraints, setConstraints] = useState<MlvConstraint[]>([]);

  // Status
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ error?: string; remediation?: string; link?: string } | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  // Runs / lineage / preview
  const [runs, setRuns] = useState<BatchRun[]>([]);
  const [lineageNodes, setLineageNodes] = useState<LineageNode[]>([]);
  const [lineageEdges, setLineageEdges] = useState<LineageEdge[]>([]);
  const [adfStatus, setAdfStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ columns?: { name: string }[]; rows?: any[][] } | null>(null);

  const markDirty = () => { setDirty(true); setSaveMsg(null); };

  const buildSpec = useCallback((): MlvSpec => {
    let tableProperties: Record<string, string> = {};
    try { tableProperties = JSON.parse(propsJson || '{}'); } catch { tableProperties = {}; }
    const partitionCols = partitionText.split(',').map((s) => s.trim()).filter(Boolean);
    return {
      language, container, schema: schema.trim(), viewName: viewName.trim(),
      sql: language === 'sql' ? sql : undefined,
      pyspark: language === 'pyspark' ? pyspark : undefined,
      partitionCols: partitionCols.length ? partitionCols : undefined,
      tableProperties: Object.keys(tableProperties).length ? tableProperties : undefined,
      constraints: constraints.filter((c) => c.name.trim() && c.expression.trim()),
      comment: comment.trim() || undefined,
      refreshMode: language === 'pyspark' ? 'full' : undefined,
    };
  }, [language, container, schema, viewName, sql, pyspark, partitionText, propsJson, constraints, comment]);

  // Load item state into the form.
  const reload = useCallback(async () => {
    if (id === 'new') return;
    setLoading(true); setLoadError(null);
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const it: ItemDTO = await r.json();
      setCosmosItem(it);
      const spec = (it.state as any)?.spec as MlvSpec | undefined;
      if (spec) {
        setLanguage(spec.language || 'sql');
        setContainer((spec.container as MlvContainer) || 'silver');
        setSchema(spec.schema || 'silver');
        setViewName(spec.viewName || '');
        if (spec.sql) setSql(spec.sql);
        if (spec.pyspark) setPyspark(spec.pyspark);
        setPartitionText((spec.partitionCols || []).join(', '));
        setPropsJson(JSON.stringify(spec.tableProperties || {}, null, 2));
        setComment(spec.comment || '');
        setConstraints(spec.constraints || []);
      }
    } catch (e: any) { setLoadError(e?.message || String(e)); }
    finally { setLoading(false); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);

  const save = useCallback(async () => {
    const spec = buildSpec();
    const problems = validateMlvSpec(spec);
    if (problems.length) { setErr(problems.join(' ')); return; }
    setBusy(true); setErr(null); setSaveMsg('Saving…');
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: { ...(cosmosItem?.state || {}), spec } }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      setDirty(false); setSaveMsg(`Saved at ${new Date().toLocaleTimeString()}`);
      await reload();
    } catch (e: any) { setErr(e?.message || String(e)); setSaveMsg(null); }
    finally { setBusy(false); }
  }, [buildSpec, id, cosmosItem, reload]);

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}/runs?size=25`);
      const j = await r.json();
      if (j.ok) setRuns(j.sessions || []);
      else if (j.gate) setGate({ error: j.error, remediation: j.remediation });
      else if (j.error) setErr(j.error);
    } catch (e: any) { setErr(e?.message || String(e)); }
  }, [id]);

  const loadLineage = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}/lineage`);
      const j = await r.json();
      if (j.ok) { setLineageNodes(j.nodes || []); setLineageEdges(j.edges || []); }
    } catch { /* lineage is best-effort */ }
  }, [id]);

  useEffect(() => { if (cosmosItem) { loadRuns(); loadLineage(); } }, [cosmosItem, loadRuns, loadLineage]);

  // Auto-refresh runs while any batch is active.
  const anyActive = runs.some((r) => ACTIVE_STATES.has((r.state || '').toLowerCase()));
  useEffect(() => {
    if (id === 'new' || !anyActive) return;
    const t = setInterval(loadRuns, 5000);
    return () => clearInterval(t);
  }, [id, anyActive, loadRuns]);

  const doRefresh = useCallback(async () => {
    const spec = buildSpec();
    const problems = validateMlvSpec(spec);
    if (problems.length) { setErr(problems.join(' ')); return; }
    setBusy(true); setErr(null); setGate(null); setRefreshMsg('Submitting Spark batch…');
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ spec, trigger: 'editor' }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.gate) { setGate({ error: j.error, remediation: j.remediation, link: j.link }); setRefreshMsg(null); }
        else throw new Error(j.error || `HTTP ${r.status}`);
        return;
      }
      setDirty(false);
      setRefreshMsg(`Spark batch #${j.batch?.id} submitted → ${j.deltaUrl} · ${j.lineageEdges} lineage edge(s) recorded.`);
      setTab('refresh');
      setTimeout(loadRuns, 1500);
      loadLineage();
    } catch (e: any) { setErr(e?.message || String(e)); setRefreshMsg(null); }
    finally { setBusy(false); }
  }, [buildSpec, id, loadRuns, loadLineage]);

  const reDeriveLineage = useCallback(async () => {
    setBusy(true); setErr(null);
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}/lineage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: buildSpec() }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'failed');
      setLineageNodes(j.nodes || []); setLineageEdges(j.edges || []);
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id, buildSpec]);

  const createAdfPipeline = useCallback(async (run: boolean) => {
    setBusy(true); setErr(null); setGate(null); setAdfStatus('Creating ADF pipeline…');
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}/adf-pipeline`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ run }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.gate) { setGate({ error: j.error, remediation: j.remediation, link: j.link }); setAdfStatus(null); }
        else throw new Error(j.error || `HTTP ${r.status}`);
        return;
      }
      setAdfStatus(`Pipeline '${j.pipelineName}' upserted (activity ${j.activity})${j.runId ? ` · run ${j.runId}` : ''}.`);
    } catch (e: any) { setErr(e?.message || String(e)); setAdfStatus(null); }
    finally { setBusy(false); }
  }, [id]);

  const doPreview = useCallback(async () => {
    setBusy(true); setErr(null); setGate(null); setPreview(null);
    try {
      const r = await clientFetch(`/api/items/materialized-lake-view/${encodeURIComponent(id)}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxRows: 200 }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.gate) setGate({ error: j.error, remediation: j.remediation });
        else throw new Error(j.error || `HTTP ${r.status}`);
        return;
      }
      setPreview({ columns: j.columns, rows: j.rows });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  }, [id]);

  // Constraint helpers
  const addConstraint = () => { setConstraints((c) => [...c, { name: '', expression: '', onViolation: 'FAIL' }]); markDirty(); };
  const updConstraint = (i: number, patch: Partial<MlvConstraint>) => {
    setConstraints((c) => c.map((x, j) => (j === i ? { ...x, ...patch } : x))); markDirty();
  };
  const delConstraint = (i: number) => { setConstraints((c) => c.filter((_, j) => j !== i)); markDirty(); };

  const generatedDdl = useMemo(() => {
    try { return language === 'sql' ? buildCreateMlvSql(buildSpec()) : '(PySpark MLVs are defined by the @fmlv-style function — no CREATE statement.)'; }
    catch { return ''; }
  }, [language, buildSpec]);

  const liveSources = useMemo(() => { try { return deriveSources(buildSpec()); } catch { return []; } }, [buildSpec]);

  const canSave = !busy && dirty;

  // Sortable / filterable run-history columns for LoomDataTable.
  const runColumns = useMemo<LoomColumn<BatchRun>[]>(() => [
    { key: 'id', label: 'Batch', width: 90, filterable: false,
      getValue: (r) => r.id,
      render: (r) => <span className={styles.mono}>{r.id}</span> },
    { key: 'state', label: 'State', width: 120, filterType: 'select',
      getValue: (r) => r.state || '—',
      render: (r) => <Badge appearance="outline">{r.state || '—'}</Badge> },
    { key: 'result', label: 'Result', width: 120, filterType: 'select',
      getValue: (r) => r.result || '—',
      render: (r) => (
        <Badge appearance="outline" color={r.result === 'Succeeded' ? 'success' : r.result === 'Failed' ? 'danger' : 'informative'}>
          {r.result || '—'}
        </Badge>
      ) },
    { key: 'trigger', label: 'Trigger', width: 120, filterType: 'select',
      getValue: (r) => r.trigger || '—' },
    { key: 'submittedAt', label: 'Submitted', width: 200, filterType: 'date',
      getValue: (r) => r.submittedAt || '',
      render: (r) => fmtTs(r.submittedAt) },
    { key: 'appId', label: 'Spark app', width: 200, filterable: false,
      getValue: (r) => r.appId || '—',
      render: (r) => <span className={styles.mono}>{r.appId || '—'}</span> },
  ], [styles.mono]);

  // Preview columns are dynamic — one per result column, mono cells.
  const previewColumns = useMemo<LoomColumn<any[]>[]>(() => {
    const cols = preview?.columns || [];
    return cols.map((c, ci) => ({
      key: String(ci), label: c.name, minWidth: 100, width: 160, filterable: cols.length <= 12,
      getValue: (row: any[]) => (row[ci] === null || row[ci] === undefined ? '' : String(row[ci])),
      render: (row: any[]) => <span className={styles.mono}>{row[ci] === null || row[ci] === undefined ? 'NULL' : String(row[ci])}</span>,
    }));
  }, [preview, styles.mono]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Refresh', actions: [
        { label: busy ? 'Refreshing…' : 'Refresh', icon: <Play16Regular />, appearance: 'primary' as const,
          onClick: id !== 'new' && !busy ? doRefresh : undefined, disabled: id === 'new' || busy },
        { label: 'Refresh runs', icon: <ArrowSync16Regular />, onClick: id !== 'new' && !busy ? loadRuns : undefined, disabled: id === 'new' || busy },
      ]},
      { label: 'Orchestrate', actions: [
        { label: 'Create ADF pipeline', icon: <Branch16Regular />, onClick: id !== 'new' && !busy ? () => createAdfPipeline(false) : undefined, disabled: id === 'new' || busy },
      ]},
      { label: 'Edit', actions: [
        { label: dirty ? 'Save' : 'Saved', onClick: canSave ? save : undefined, disabled: !canSave },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [busy, id, dirty, canSave, doRefresh, loadRuns, save]);

  if (id === 'new') {
    return (
      <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
        <div className={styles.tabBody}>
          <MessageBar intent="info"><MessageBarBody>
            Create this materialized lake view from the workspace catalog, then return here to author
            its SQL / PySpark definition, set data-quality constraints, refresh the Delta table, and
            view cross-workspace lineage.
          </MessageBarBody></MessageBar>
        </div>
      } />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <>
        <div className={styles.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as string)}>
            <Tab value="definition">Definition</Tab>
            <Tab value="constraints">Constraints</Tab>
            <Tab value="lineage">Lineage</Tab>
            <Tab value="refresh">Refresh</Tab>
            <Tab value="preview">Preview</Tab>
          </TabList>
        </div>
        <div className={styles.tabBody}>
          <ErrBar error={err || loadError} />
          <GateBar gate={gate} />
          {loading && <Spinner size="small" label="Loading definition…" labelPosition="after" />}

          {/* ---------------- Definition ---------------- */}
          {tab === 'definition' && (
            <>
              <Subtitle2>Definition</Subtitle2>
              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Authoring language</Caption1>
                  <Dropdown value={language === 'sql' ? 'Spark SQL' : 'PySpark'} selectedOptions={[language]}
                    onOptionSelect={(_, d) => { setLanguage((d.optionValue as MlvLanguage) || 'sql'); markDirty(); }}>
                    <Option value="sql">Spark SQL</Option>
                    <Option value="pyspark">PySpark (Preview · full refresh only)</Option>
                  </Dropdown>
                </div>
                <div className={styles.field}>
                  <Caption1>Target container</Caption1>
                  <Dropdown value={container} selectedOptions={[container]}
                    onOptionSelect={(_, d) => { setContainer((d.optionValue as MlvContainer) || 'silver'); markDirty(); }}>
                    {MLV_CONTAINERS.map((c) => <Option key={c} value={c}>{c}</Option>)}
                  </Dropdown>
                </div>
                <div className={styles.field}>
                  <Caption1>Schema</Caption1>
                  <Input value={schema} onChange={(_, d) => { setSchema(d.value); markDirty(); }} placeholder="silver" />
                </div>
                <div className={styles.field}>
                  <Caption1>View name</Caption1>
                  <Input value={viewName} onChange={(_, d) => { setViewName(d.value); markDirty(); }} placeholder="customer_enriched" />
                </div>
              </div>

              <Caption1>{language === 'sql' ? 'Spark SQL SELECT (the view body)' : 'PySpark function body — must `return` a DataFrame'}</Caption1>
              <MonacoTextarea
                value={language === 'sql' ? sql : pyspark}
                onChange={(v) => { if (language === 'sql') setSql(v); else setPyspark(v); markDirty(); }}
                language={language === 'sql' ? 'sparksql' : 'pyspark'}
                height={220}
              />

              <div className={styles.row}>
                <div className={styles.field}>
                  <Caption1>Partition columns (comma-separated, optional)</Caption1>
                  <Input value={partitionText} onChange={(_, d) => { setPartitionText(d.value); markDirty(); }} placeholder="year, city" />
                </div>
                <div className={styles.field}>
                  <Caption1>Comment (optional)</Caption1>
                  <Input value={comment} onChange={(_, d) => { setComment(d.value); markDirty(); }} placeholder="Silver customer view" />
                </div>
              </div>

              <Caption1>Delta table properties (optional)</Caption1>
              <KeyValueGrid value={propsJson} onChange={(v) => { setPropsJson(v); markDirty(); }}
                keyLabel="Property" valueLabel="Value"
                keyPlaceholder="delta.enableChangeDataFeed" valuePlaceholder="true" addLabel="Add property" />

              <Body1Strong style={{ marginTop: tokens.spacingVerticalS }}>Generated statement</Body1Strong>
              <pre className={styles.pre}>{generatedDdl}</pre>
              {liveSources.length > 0 && (
                <Caption1>Derived sources: {liveSources.join(', ')}</Caption1>
              )}
            </>
          )}

          {/* ---------------- Constraints ---------------- */}
          {tab === 'constraints' && (
            <>
              <Subtitle2>Data-quality constraints</Subtitle2>
              <Caption1>Each constraint is a boolean expression every row must satisfy. FAIL stops the refresh at the first violation; DROP silently removes violating rows.</Caption1>
              {constraints.length === 0 && (
                <EmptyState
                  icon={<Checkmark16Regular />}
                  title="No data-quality constraints"
                  body="Add a CHECK constraint to enforce row-level quality on every refresh. FAIL aborts the run on the first violation; DROP quietly discards violating rows."
                  primaryAction={{ label: 'Add constraint', onClick: addConstraint }}
                />
              )}
              {constraints.map((c, i) => (
                <div key={i} className={styles.constraintRow}>
                  <div className={styles.field} style={{ maxWidth: 200 }}>
                    <Caption1>Name</Caption1>
                    <Input value={c.name} onChange={(_, d) => updConstraint(i, { name: d.value })} placeholder="sales_not_null" />
                  </div>
                  <div className={styles.field}>
                    <Caption1>CHECK expression</Caption1>
                    <Input value={c.expression} onChange={(_, d) => updConstraint(i, { expression: d.value })} placeholder="sales IS NOT NULL" />
                  </div>
                  <div className={styles.field} style={{ maxWidth: 140 }}>
                    <Caption1>On violation</Caption1>
                    <Dropdown value={c.onViolation} selectedOptions={[c.onViolation]}
                      onOptionSelect={(_, d) => updConstraint(i, { onViolation: (d.optionValue as 'FAIL' | 'DROP') || 'FAIL' })}>
                      <Option value="FAIL">FAIL</Option>
                      <Option value="DROP">DROP</Option>
                    </Dropdown>
                  </div>
                  <Tooltip content="Remove constraint" relationship="label">
                    <Button icon={<Dismiss16Regular />} onClick={() => delConstraint(i)} />
                  </Tooltip>
                </div>
              ))}
              {constraints.length > 0 && <div><Button icon={<Add16Regular />} onClick={addConstraint}>Add constraint</Button></div>}
            </>
          )}

          {/* ---------------- Lineage ---------------- */}
          {tab === 'lineage' && (
            <>
              <Subtitle2>Cross-workspace lineage</Subtitle2>
              <Caption1>Dependency edges (source → this MLV, and this MLV → downstream MLVs) persisted in Loom's Cosmos lineage store. Spans every workspace you own.</Caption1>
              <div className={styles.toolbar}>
                <Button icon={<ArrowSync16Regular />} onClick={loadLineage} disabled={busy}>Reload</Button>
                <Button icon={<Branch16Regular />} onClick={reDeriveLineage} disabled={busy}>Re-derive from definition</Button>
              </div>
              <div className={styles.lineageBox}>
                {lineageEdges.length === 0 && (
                  <EmptyState
                    icon={<BranchFork20Regular />}
                    title="No lineage edges yet"
                    body="Lineage is derived from this view's definition (upstream sources) and any downstream MLVs that read from it. Save a definition then Re-derive, or run a Refresh to record edges."
                    primaryAction={{ label: 'Re-derive from definition', onClick: busy ? undefined : reDeriveLineage }}
                  />
                )}
                {lineageEdges.map((e, i) => {
                  const from = lineageNodes.find((n) => n.id === e.from);
                  const to = lineageNodes.find((n) => n.id === e.to);
                  return (
                    <div key={i} className={styles.lineageRow}>
                      {from?.openHref ? <a className={styles.chip} href={from.openHref}>{from?.label || e.from}</a> : <span className={styles.chip}>{from?.label || e.from}</span>}
                      <span>→</span>
                      {to?.openHref ? <a className={styles.chip} href={to.openHref}>{to?.label || e.to}</a> : <span className={styles.chip}>{to?.label || e.to}</span>}
                      {to?.focus && <Badge appearance="outline" color="brand">this view</Badge>}
                      {from?.focus && <Badge appearance="outline" color="brand">this view</Badge>}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ---------------- Refresh ---------------- */}
          {tab === 'refresh' && (
            <>
              <Subtitle2>Refresh</Subtitle2>
              <Caption1>A full refresh runs a Synapse Spark batch that executes the definition, enforces constraints, and (re)writes the managed Delta table.</Caption1>
              {refreshMsg && <MessageBar intent="success"><MessageBarBody className={styles.statusBar}>{refreshMsg}</MessageBarBody></MessageBar>}
              <div className={styles.toolbar}>
                <Button appearance="primary" icon={<Play16Regular />} onClick={doRefresh} disabled={busy}>Run full refresh</Button>
                <Button icon={<ArrowSync16Regular />} onClick={loadRuns} disabled={busy}>Refresh runs</Button>
                {anyActive && <Badge appearance="outline" color="informative">live — auto-refreshing</Badge>}
                {busy && <Spinner size="tiny" />}
              </div>

              <Body1Strong style={{ marginTop: tokens.spacingVerticalS }}>Refresh "Refresh materialized lake view" ADF pipeline</Body1Strong>
              <Caption1>Create the ADF pipeline an operator schedules for recurring refresh — its single activity calls back into this view's refresh endpoint.</Caption1>
              {adfStatus && <MessageBar intent="success"><MessageBarBody className={styles.statusBar}>{adfStatus}</MessageBarBody></MessageBar>}
              <div className={styles.toolbar}>
                <Button icon={<Branch16Regular />} onClick={() => createAdfPipeline(false)} disabled={busy}>Create / update pipeline</Button>
                <Button onClick={() => createAdfPipeline(true)} disabled={busy}>Create + run now</Button>
              </div>

              <Body1Strong style={{ marginTop: tokens.spacingVerticalS }}>Run history</Body1Strong>
              {runs.length === 0 ? (
                <EmptyState
                  icon={<DataLine20Regular />}
                  title="No refresh runs yet"
                  body="Run a full refresh to submit the first Synapse Spark batch. Completed runs — with state, result, and the underlying Spark application — appear here."
                  primaryAction={{ label: busy ? 'Refreshing…' : 'Run full refresh', onClick: busy ? undefined : doRefresh }}
                />
              ) : (
                <LoomDataTable
                  ariaLabel="MLV refresh runs"
                  columns={runColumns}
                  rows={runs}
                  getRowId={(r) => String(r.id)}
                  empty="No runs match the current filters."
                />
              )}
            </>
          )}

          {/* ---------------- Preview ---------------- */}
          {tab === 'preview' && (
            <>
              <Subtitle2>Preview materialized data</Subtitle2>
              <Caption1>Queries the materialized Delta table via the Synapse Serverless SQL endpoint (OPENROWSET FORMAT='DELTA'). Run a refresh first if the table isn't materialized yet.</Caption1>
              <div className={styles.toolbar}>
                <Button appearance="primary" onClick={doPreview} disabled={busy}>Preview top 200 rows</Button>
                {busy && <Spinner size="tiny" />}
              </div>
              {preview && (preview.rows?.length ? (
                <>
                  <Caption1>{preview.rows.length} row{preview.rows.length === 1 ? '' : 's'} · {previewColumns.length} column{previewColumns.length === 1 ? '' : 's'}. Click a header to sort.</Caption1>
                  <LoomDataTable
                    ariaLabel="MLV preview"
                    columns={previewColumns}
                    rows={preview.rows.slice(0, 200).map((row, ri) => Object.assign([...row], { __id: ri }))}
                    getRowId={(row: any) => String(row.__id)}
                    empty="No rows match the current filters."
                  />
                </>
              ) : (
                <EmptyState
                  icon={<Table20Regular />}
                  title="Query returned 0 rows"
                  body="The materialized Delta table exists but is currently empty. Run a refresh to (re)populate it, then preview again."
                />
              ))}
            </>
          )}

          {saveMsg && <MessageBar intent="success"><MessageBarBody>{saveMsg}</MessageBarBody></MessageBar>}
          {dirty && (
            <div className={styles.toolbar}>
              <Button appearance="primary" onClick={save} disabled={!canSave}>Save definition</Button>
              <Badge appearance="outline" color="warning">unsaved changes</Badge>
            </div>
          )}
        </div>
      </>
    } />
  );
}
