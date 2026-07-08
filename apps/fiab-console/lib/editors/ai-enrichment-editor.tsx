'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AiEnrichmentEditor — the `ai-enrichment` item (AIF-7).
 *
 * Batch LLM augmentation over one column of a lakehouse / warehouse table into a
 * new Delta column — the durable, first-class form of Fabric's AI functions,
 * Azure-native with NO Microsoft Fabric / Power BI dependency
 * (no-fabric-dependency.md). Every control hits a real backend:
 *
 *   • Source picker  → cascading Databricks Unity-Catalog browse
 *                      (GET …/ai-enrichment/[id]/schema — live SHOW/DESCRIBE).
 *   • Preview        → POST …/preview — REAL Azure OpenAI over the first N rows.
 *   • Run            → POST …/run — in-database CREATE TABLE AS SELECT with the
 *                      ai_* builtin (or AOAI per-row + VALUES CTAS for custom
 *                      prompts). Real destination Delta table.
 *   • Run history    → GET …/runs (persisted in Cosmos item.state.runs[]).
 *
 * FGC-19 model tier: Fast (default deployment) / Advanced (a higher-reasoning
 * deployment from the live deployments list + a reasoning-effort level).
 */
import {
  Subtitle2, Caption1, Body1, Button, Badge, Spinner, Divider, Text,
  MessageBar, MessageBarBody, MessageBarTitle,
  Field, Dropdown, Option, Input, Textarea,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Tab, TabList, ProgressBar,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  SettingsRegular, HistoryRegular, SparkleRegular, PlayRegular, DatabaseRegular,
} from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ItemEditorChrome } from './item-editor-chrome';
import { NewItemCreateGate } from './new-item-gate';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import type { RibbonTab } from '@/lib/components/ribbon';
import type {
  EnrichmentOp, EnrichmentRun, ModelTier, ReasoningEffort, CostEstimate,
} from '@/lib/azure/ai-enrichment-client';

const OP_OPTIONS: { key: EnrichmentOp; label: string; desc: string }[] = [
  { key: 'summarize', label: 'Summarize', desc: 'a concise 2–3 sentence summary of each cell' },
  { key: 'classify', label: 'Classify', desc: 'assign exactly one of your labels' },
  { key: 'sentiment', label: 'Sentiment', desc: 'positive / negative / neutral' },
  { key: 'extract', label: 'Extract', desc: 'pull named fields out as JSON' },
  { key: 'translate', label: 'Translate', desc: 'translate to a target language' },
  { key: 'fix_grammar', label: 'Fix grammar', desc: 'correct spelling, grammar & punctuation' },
  { key: 'generate_response', label: 'Generate response', desc: 'draft a reply to each cell' },
  { key: 'custom_prompt', label: 'Custom prompt', desc: 'your own instruction applied per row (Azure OpenAI)' },
];

const REASONING_EFFORTS: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];

const useStyles = makeStyles({
  tabBar: {
    paddingTop: tokens.spacingVerticalS, paddingLeft: tokens.spacingHorizontalL,
    paddingRight: tokens.spacingHorizontalL, borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  body: { padding: tokens.spacingVerticalXL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '960px' },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge,
    padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4,
  },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: tokens.spacingHorizontalM },
  grid3: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: tokens.spacingHorizontalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  tableWrap: { overflow: 'auto', maxHeight: '46vh' },
  estimate: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
});

interface ItemDTO { id: string; workspaceId: string; displayName: string; state?: Record<string, any> }
interface PreviewRow { input: string; output?: string; error?: string }

function useItem(id: string) {
  const [item, setItem] = useState<ItemDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!id || id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/ai-enrichment/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setItem(j.item);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [id]);
  useEffect(() => { reload(); }, [reload]);
  return { item, error, reload };
}

export function AiEnrichmentEditor({ item, id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const { item: cosmosItem, error: loadError, reload } = useItem(id);

  const [tab, setTab] = useState<'configure' | 'runs'>('configure');
  const [err, setErr] = useState<string | null>(null);

  // Boundary probe (which engine + honest gate).
  const [gate, setGate] = useState<{ gated: boolean; hint?: string; dbxAvailable: boolean; aoaiAvailable: boolean } | null>(null);

  // Source (Databricks Unity Catalog cascade).
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; state: string }[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [catalog, setCatalog] = useState('');
  const [schemas, setSchemas] = useState<string[]>([]);
  const [schema, setSchema] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [sourceColumn, setSourceColumn] = useState('');
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [schemaMsg, setSchemaMsg] = useState<string | null>(null);

  // Operation + options.
  const [op, setOp] = useState<EnrichmentOp>('summarize');
  const [labels, setLabels] = useState('positive, negative, neutral');
  const [fields, setFields] = useState('');
  const [targetLang, setTargetLang] = useState('English');
  const [customPrompt, setCustomPrompt] = useState('');
  const [outputColumn, setOutputColumn] = useState('ai_result');
  const [destTable, setDestTable] = useState('');

  // Execution tuning + model tier.
  const [batchSize, setBatchSize] = useState(20);
  const [concurrency, setConcurrency] = useState(4);
  const [tier, setTier] = useState<ModelTier>('fast');
  const [deployments, setDeployments] = useState<{ name: string; modelName?: string }[]>([]);
  const [deployment, setDeployment] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('medium');

  // Preview + run.
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ rows: PreviewRow[]; model?: string; avgTokensPerRow: number; estimate: CostEstimate | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<EnrichmentRun | null>(null);
  const [runs, setRuns] = useState<EnrichmentRun[]>([]);

  const opDef = OP_OPTIONS.find((o) => o.key === op);
  const usesLabels = op === 'classify';
  const usesFields = op === 'extract';
  const usesLang = op === 'translate';
  const usesPrompt = op === 'custom_prompt';

  const optionsPayload = useMemo(() => {
    const o: Record<string, unknown> = {};
    if (usesLabels) o.labels = labels.split(',').map((x) => x.trim()).filter(Boolean);
    if (usesFields) o.fields = fields.split(',').map((x) => x.trim()).filter(Boolean);
    if (usesLang) o.targetLang = targetLang.trim();
    if (usesPrompt) o.customPrompt = customPrompt.trim();
    return o;
  }, [usesLabels, usesFields, usesLang, usesPrompt, labels, fields, targetLang, customPrompt]);

  // --- Rehydrate persisted config + probe + load lists on mount ---
  useEffect(() => {
    if (id === 'new') return;
    (async () => {
      try {
        const r = await clientFetch(`/api/items/ai-enrichment/${encodeURIComponent(id)}/schema?probe=1`);
        const j = await r.json();
        setGate({ gated: !!j.gated, hint: j.hint, dbxAvailable: !!j.dbxAvailable, aoaiAvailable: !!j.aoaiAvailable });
      } catch { /* ignore */ }
      try {
        const r = await clientFetch(`/api/items/ai-enrichment/${encodeURIComponent(id)}/schema`);
        const j = await r.json();
        if (j.ok && Array.isArray(j.warehouses)) setWarehouses(j.warehouses);
      } catch { /* ignore */ }
      loadRuns();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const c = cosmosItem?.state?.config;
    if (!c) return;
    if (c.warehouseId) setWarehouseId(c.warehouseId);
    if (c.catalog) setCatalog(c.catalog);
    if (c.schema) setSchema(c.schema);
    if (c.table) setTable(c.table);
    if (c.sourceColumn) setSourceColumn(c.sourceColumn);
    if (c.outputColumn) setOutputColumn(c.outputColumn);
    if (c.destTable) setDestTable(c.destTable);
    if (c.op) setOp(c.op);
    if (c.options?.labels) setLabels((c.options.labels as string[]).join(', '));
    if (c.options?.fields) setFields((c.options.fields as string[]).join(', '));
    if (c.options?.targetLang) setTargetLang(c.options.targetLang);
    if (c.options?.customPrompt) setCustomPrompt(c.options.customPrompt);
    if (c.batchSize) setBatchSize(c.batchSize);
    if (c.concurrency) setConcurrency(c.concurrency);
    if (c.tier) setTier(c.tier);
    if (c.deployment) setDeployment(c.deployment);
    if (c.reasoningEffort) setReasoningEffort(c.reasoningEffort);
  }, [cosmosItem]);

  const loadRuns = useCallback(async () => {
    if (id === 'new') return;
    try {
      const r = await clientFetch(`/api/items/ai-enrichment/${encodeURIComponent(id)}/runs`);
      const j = await r.json();
      if (j.ok) setRuns(j.runs || []);
    } catch { /* ignore */ }
  }, [id]);

  // --- Cascading schema browse ---
  const browse = useCallback(async (params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    const r = await clientFetch(`/api/items/ai-enrichment/${encodeURIComponent(id)}/schema?${qs}`);
    return r.json();
  }, [id]);

  const onWarehouse = useCallback(async (wid: string) => {
    setWarehouseId(wid); setCatalog(''); setSchema(''); setTable(''); setSourceColumn('');
    setCatalogs([]); setSchemas([]); setTables([]); setColumns([]); setSchemaMsg(null);
    if (!wid) return;
    setSchemaBusy(true);
    try {
      const j = await browse({ warehouseId: wid });
      if (j.ok) setCatalogs(j.catalogs || []);
      else setSchemaMsg(j.message || j.error || 'Could not list catalogs.');
    } catch (e: any) { setSchemaMsg(e?.message || String(e)); }
    finally { setSchemaBusy(false); }
  }, [browse]);

  const onCatalog = useCallback(async (c: string) => {
    setCatalog(c); setSchema(''); setTable(''); setSourceColumn(''); setSchemas([]); setTables([]); setColumns([]);
    if (!c) return;
    setSchemaBusy(true);
    try { const j = await browse({ warehouseId, catalog: c }); if (j.ok) setSchemas(j.schemas || []); else setSchemaMsg(j.message || j.error); }
    finally { setSchemaBusy(false); }
  }, [browse, warehouseId]);

  const onSchema = useCallback(async (sc: string) => {
    setSchema(sc); setTable(''); setSourceColumn(''); setTables([]); setColumns([]);
    if (!sc) return;
    setSchemaBusy(true);
    try { const j = await browse({ warehouseId, catalog, schema: sc }); if (j.ok) setTables(j.tables || []); else setSchemaMsg(j.message || j.error); }
    finally { setSchemaBusy(false); }
  }, [browse, warehouseId, catalog]);

  const onTable = useCallback(async (t: string) => {
    setTable(t); setSourceColumn(''); setColumns([]);
    if (!destTable) setDestTable(`${t}_enriched`);
    if (!t) return;
    setSchemaBusy(true);
    try { const j = await browse({ warehouseId, catalog, schema, table: t }); if (j.ok) setColumns(j.columns || []); else setSchemaMsg(j.message || j.error); }
    finally { setSchemaBusy(false); }
  }, [browse, warehouseId, catalog, schema, destTable]);

  // --- Model deployments (Advanced tier) ---
  useEffect(() => {
    if (tier !== 'advanced' || deployments.length) return;
    (async () => {
      try {
        const r = await clientFetch('/api/foundry/model-deployments');
        const j = await r.json();
        if (j.ok && Array.isArray(j.deployments)) setDeployments(j.deployments.map((d: any) => ({ name: d.name, modelName: d.modelName })));
      } catch { /* honest: dropdown stays empty, user can leave Fast */ }
    })();
  }, [tier, deployments.length]);

  const configBody = useCallback(() => ({
    warehouseId, catalog, schema, table, sourceColumn, outputColumn, destTable,
    op, options: optionsPayload, batchSize, concurrency, tier,
    deployment: tier === 'advanced' ? deployment : undefined,
    reasoningEffort: tier === 'advanced' ? reasoningEffort : undefined,
  }), [warehouseId, catalog, schema, table, sourceColumn, outputColumn, destTable, op, optionsPayload, batchSize, concurrency, tier, deployment, reasoningEffort]);

  const canPreview = !!sourceColumn && (op !== 'custom_prompt' || !!customPrompt.trim());
  const canRun = canPreview && !!warehouseId && !!catalog && !!schema && !!table && !!outputColumn.trim() && !!destTable.trim();

  const doPreview = useCallback(async () => {
    setErr(null); setPreview(null); setPreviewing(true);
    try {
      const r = await clientFetch(`/api/items/ai-enrichment/${encodeURIComponent(id)}/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...configBody(), sampleSize: Math.min(10, batchSize) }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || `HTTP ${r.status}`)); return; }
      setPreview({ rows: j.rows || [], model: j.model, avgTokensPerRow: j.avgTokensPerRow, estimate: j.estimate });
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setPreviewing(false); }
  }, [id, configBody, batchSize]);

  const doRun = useCallback(async () => {
    setErr(null); setRunResult(null); setRunning(true);
    try {
      const r = await clientFetch(`/api/items/ai-enrichment/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(configBody()),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.hint ? `${j.error} — ${j.hint}` : (j.error || `HTTP ${r.status}`)); return; }
      setRunResult(j.run);
      setTab('runs');
      await reload();
      await loadRuns();
    } catch (e: any) { setErr(e?.message || String(e)); }
    finally { setRunning(false); }
  }, [id, configBody, reload, loadRuns]);

  const ribbon: RibbonTab[] = useMemo(() => [
    { id: 'home', label: 'Home', groups: [
      { label: 'Enrichment', actions: [
        { label: previewing ? 'Previewing…' : 'Preview', onClick: canPreview && !previewing ? doPreview : undefined, disabled: !canPreview || previewing },
        { label: running ? 'Running…' : 'Run', onClick: canRun && !running ? doRun : undefined, disabled: !canRun || running },
      ]},
      { label: 'View', actions: [
        { label: 'Refresh runs', onClick: () => loadRuns() },
      ]},
    ]},
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [canPreview, canRun, previewing, running, doPreview, doRun, loadRuns]);

  if (id === 'new') {
    return (
      <NewItemCreateGate item={item} createLabel="Create AI enrichment"
        intro="AI enrichment runs a batch LLM operation over one column of a lakehouse / warehouse table and writes the result to a new Delta column — the durable form of Fabric's AI functions, Azure-native (Azure OpenAI + Databricks SQL, no Fabric dependency). Create it, then pick a source table, choose an operation, preview on real rows, and run." />
    );
  }

  return (
    <ItemEditorChrome item={item} id={id} ribbon={ribbon} main={
      <div>
        <div className={s.tabBar}>
          <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'configure' | 'runs')}>
            <Tab value="configure" icon={<SettingsRegular />}>Configure</Tab>
            <Tab value="runs" icon={<HistoryRegular />}>Runs{runs.length ? ` (${runs.length})` : ''}</Tab>
          </TabList>
        </div>

        <div className={s.body}>
          {(err || loadError) && (
            <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Operation failed</MessageBarTitle>{err || loadError}</MessageBarBody></MessageBar>
          )}
          {gate?.gated && (
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>No enrichment backend configured</MessageBarTitle>
                {gate.hint || 'Provision a Databricks SQL Warehouse or set Azure OpenAI (LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT).'}
              </MessageBarBody>
            </MessageBar>
          )}

          {tab === 'configure' && (
            <>
              {/* Source */}
              <div className={s.card}>
                <span className={s.sectionHeader}><DatabaseRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Source table</Subtitle2>{schemaBusy && <Spinner size="tiny" />}</span>
                {schemaMsg && <MessageBar intent="warning"><MessageBarBody>{schemaMsg}</MessageBarBody></MessageBar>}
                <div className={s.grid3}>
                  <Field label="Warehouse">
                    <Dropdown value={warehouses.find((w) => w.id === warehouseId)?.name || ''} selectedOptions={warehouseId ? [warehouseId] : []} placeholder="Select a SQL warehouse"
                      onOptionSelect={(_, d) => d.optionValue && onWarehouse(d.optionValue)}>
                      {warehouses.map((w) => <Option key={w.id} value={w.id} text={w.name}>{w.name} · {w.state}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Catalog">
                    <Dropdown value={catalog} selectedOptions={catalog ? [catalog] : []} placeholder="Catalog" disabled={!catalogs.length}
                      onOptionSelect={(_, d) => d.optionValue && onCatalog(d.optionValue)}>
                      {catalogs.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Schema">
                    <Dropdown value={schema} selectedOptions={schema ? [schema] : []} placeholder="Schema" disabled={!schemas.length}
                      onOptionSelect={(_, d) => d.optionValue && onSchema(d.optionValue)}>
                      {schemas.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Table">
                    <Dropdown value={table} selectedOptions={table ? [table] : []} placeholder="Table" disabled={!tables.length}
                      onOptionSelect={(_, d) => d.optionValue && onTable(d.optionValue)}>
                      {tables.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Source column">
                    <Dropdown value={sourceColumn} selectedOptions={sourceColumn ? [sourceColumn] : []} placeholder="Column to enrich" disabled={!columns.length}
                      onOptionSelect={(_, d) => d.optionValue && setSourceColumn(d.optionValue)}>
                      {columns.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  </Field>
                </div>
              </div>

              {/* Operation */}
              <div className={s.card}>
                <span className={s.sectionHeader}><SparkleRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Operation</Subtitle2></span>
                <div className={s.grid2}>
                  <Field label="AI operation" hint={opDef?.desc}>
                    <Dropdown value={opDef?.label || ''} selectedOptions={[op]} onOptionSelect={(_, d) => { if (d.optionValue) { setOp(d.optionValue as EnrichmentOp); setPreview(null); } }}>
                      {OP_OPTIONS.map((o) => <Option key={o.key} value={o.key} text={o.label}>{o.label} — {o.desc}</Option>)}
                    </Dropdown>
                  </Field>
                  <Field label="Output column" hint="New column added to the destination table (letters, digits, underscore)">
                    <Input value={outputColumn} onChange={(_, d) => setOutputColumn(d.value)} />
                  </Field>
                  {usesLabels && <Field label="Labels" hint="Comma-separated; the model returns exactly one"><Input value={labels} onChange={(_, d) => setLabels(d.value)} /></Field>}
                  {usesFields && <Field label="Fields" hint="Comma-separated field names returned as JSON"><Input value={fields} placeholder="e.g. company, amount, date" onChange={(_, d) => setFields(d.value)} /></Field>}
                  {usesLang && <Field label="Target language"><Input value={targetLang} onChange={(_, d) => setTargetLang(d.value)} /></Field>}
                </div>
                {usesPrompt && (
                  <Field label="Custom prompt" hint="Applied per row against Azure OpenAI. The row's cell value is provided as the input.">
                    <Textarea value={customPrompt} onChange={(_, d) => setCustomPrompt(d.value)} rows={3} resize="vertical"
                      placeholder="e.g. Rate the urgency of this support message from 1 (low) to 5 (critical) and return only the number." />
                  </Field>
                )}
                <Field label="Destination table" hint="A new Delta table created in the source catalog/schema (letters, digits, underscore)">
                  <Input value={destTable} onChange={(_, d) => setDestTable(d.value)} placeholder="e.g. reviews_enriched" />
                </Field>
              </div>

              {/* Execution + model tier */}
              <div className={s.card}>
                <span className={s.sectionHeader}><SettingsRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Batch &amp; model</Subtitle2></span>
                <div className={s.grid3}>
                  <Field label="Batch size" hint="Rows per chunk (1–500)">
                    <Input type="number" value={String(batchSize)} onChange={(_, d) => setBatchSize(Math.max(1, Math.min(500, Number(d.value) || 20)))} />
                  </Field>
                  <Field label="Concurrency" hint="Parallel per-row calls (1–16)">
                    <Input type="number" value={String(concurrency)} onChange={(_, d) => setConcurrency(Math.max(1, Math.min(16, Number(d.value) || 4)))} />
                  </Field>
                  <Field label="Model tier" hint="Fast = default deployment · Advanced = higher-reasoning">
                    <Dropdown value={tier === 'fast' ? 'Fast (default)' : 'Advanced'} selectedOptions={[tier]} onOptionSelect={(_, d) => d.optionValue && setTier(d.optionValue as ModelTier)}>
                      <Option value="fast" text="Fast (default)">Fast (default) — cost-efficient deployment</Option>
                      <Option value="advanced" text="Advanced">Advanced — higher-reasoning deployment</Option>
                    </Dropdown>
                  </Field>
                  {tier === 'advanced' && (
                    <Field label="Deployment" hint={deployments.length ? 'From your live model deployments' : 'No deployments listed — Fast tier used'}>
                      <Dropdown value={deployment} selectedOptions={deployment ? [deployment] : []} placeholder="Default" disabled={!deployments.length}
                        onOptionSelect={(_, d) => d.optionValue && setDeployment(d.optionValue)}>
                        {deployments.map((dp) => <Option key={dp.name} value={dp.name} text={dp.name}>{dp.name}{dp.modelName ? ` · ${dp.modelName}` : ''}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                  {tier === 'advanced' && (
                    <Field label="Reasoning effort" hint="Passed to reasoning-class models">
                      <Dropdown value={reasoningEffort} selectedOptions={[reasoningEffort]} onOptionSelect={(_, d) => d.optionValue && setReasoningEffort(d.optionValue as ReasoningEffort)}>
                        {REASONING_EFFORTS.map((e) => <Option key={e} value={e} text={e}>{e}</Option>)}
                      </Dropdown>
                    </Field>
                  )}
                </div>
                <div className={s.row}>
                  <Button appearance="outline" icon={previewing ? <Spinner size="tiny" /> : <SparkleRegular />} disabled={!canPreview || previewing} onClick={doPreview}>
                    {previewing ? 'Previewing…' : 'Preview sample'}
                  </Button>
                  <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <PlayRegular />} disabled={!canRun || running} onClick={doRun}>
                    {running ? 'Running…' : 'Run enrichment'}
                  </Button>
                  {!canRun && <Caption1>Pick a warehouse, table, source column, output column and destination table to run.</Caption1>}
                </div>
                {(previewing || running) && <ProgressBar />}
              </div>

              {/* Preview results + cost estimate */}
              {preview && (
                <div className={s.card}>
                  <span className={s.sectionHeader}><SparkleRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Preview ({preview.rows.length} rows)</Subtitle2>{preview.model && <Badge appearance="tint" color="informative">{preview.model}</Badge>}</span>
                  {preview.estimate && (
                    <div className={s.estimate}>
                      <Text weight="semibold">Full-run cost estimate</Text>
                      <Caption1>
                        ~{preview.estimate.estTotalTokens.toLocaleString()} tokens over {preview.estimate.rowCount.toLocaleString()} rows
                        {' '}(≈ {preview.estimate.avgTokensPerRow} tokens/row measured) · ≈ ${preview.estimate.estUsd.toFixed(4)} at ${preview.estimate.usdPer1MTokens}/1M tokens — adjust for your model.
                      </Caption1>
                    </div>
                  )}
                  {!preview.estimate && preview.avgTokensPerRow > 0 && (
                    <Caption1>Measured ~{preview.avgTokensPerRow} tokens/row. (Row count unavailable for a full estimate.)</Caption1>
                  )}
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="Enrichment preview">
                      <TableHeader><TableRow><TableHeaderCell>{sourceColumn || 'input'}</TableHeaderCell><TableHeaderCell>{outputColumn || 'output'}</TableHeaderCell></TableRow></TableHeader>
                      <TableBody>
                        {preview.rows.map((r, i) => (
                          <TableRow key={i}>
                            <TableCell><span className={s.mono}>{r.input}</span></TableCell>
                            <TableCell><span className={s.mono}>{r.error ? `⚠ ${r.error}` : r.output}</span></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'runs' && (
            <div className={s.card}>
              <span className={s.sectionHeader}><HistoryRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Run history</Subtitle2></span>
              {runResult && (
                <MessageBar intent={runResult.status === 'failed' ? 'error' : runResult.status === 'partial' ? 'warning' : 'success'}>
                  <MessageBarBody>
                    <MessageBarTitle>Last run {runResult.status}</MessageBarTitle>
                    {runResult.destTable ? <>Wrote <span className={s.mono}>{runResult.destTable}</span> · </> : null}
                    {runResult.rowsSucceeded}/{runResult.rowsProcessed} rows · {runResult.engine} · {runResult.totalTokens ? `${runResult.totalTokens} tokens · ` : ''}{Math.round(runResult.durationMs / 100) / 10}s
                    {runResult.error ? <><br />{runResult.error}</> : null}
                  </MessageBarBody>
                </MessageBar>
              )}
              {!runs.length ? (
                <Caption1>No runs yet. Configure the enrichment and click Run.</Caption1>
              ) : (
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Run history">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell>Started</TableHeaderCell><TableHeaderCell>Op</TableHeaderCell><TableHeaderCell>Source → dest</TableHeaderCell>
                        <TableHeaderCell>Engine</TableHeaderCell><TableHeaderCell>Rows</TableHeaderCell><TableHeaderCell>Tokens</TableHeaderCell><TableHeaderCell>Status</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((rn) => (
                        <TableRow key={rn.id}>
                          <TableCell>{new Date(rn.startedAt).toLocaleString()}</TableCell>
                          <TableCell>{rn.op}</TableCell>
                          <TableCell><span className={s.mono}>{rn.sourceColumn} → {rn.outputColumn}</span></TableCell>
                          <TableCell>{rn.engine}</TableCell>
                          <TableCell>{rn.rowsSucceeded}/{rn.rowsProcessed}{rn.rowsFailed ? ` (${rn.rowsFailed} failed)` : ''}</TableCell>
                          <TableCell>{rn.totalTokens || '—'}</TableCell>
                          <TableCell>
                            <Badge appearance="tint" color={rn.status === 'failed' ? 'danger' : rn.status === 'partial' ? 'warning' : 'success'}>{rn.status}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <Divider />
              <Caption1>Runs are persisted with the item and survive reloads. Newest first; up to 50 retained.</Caption1>
            </div>
          )}
        </div>
      </div>
    } />
  );
}
