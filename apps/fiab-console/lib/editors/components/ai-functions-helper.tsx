'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * AiFunctionsHelper — bring Fabric's "AI functions" (sentiment · classify ·
 * translate · summarize · extract) to a SQL editor, Azure-native and with NO
 * Microsoft Fabric / Power BI dependency (per no-fabric-dependency.md).
 *
 * Mirrors the Fabric AI-functions authoring affordance: pick a function, pick a
 * column, and either INSERT the generated AI SQL into the query editor or RUN it
 * and see the enriched rows inline.
 *
 * Backend is the item-scoped route POST /api/items/[type]/[id]/ai-function:
 *   • Commercial / GCC + a Databricks SQL Warehouse → the result is computed
 *     IN-DATABASE by Databricks' ai_query() family
 *     (ai_analyze_sentiment / ai_classify / ai_summarize / ai_translate /
 *     ai_extract) over the live warehouse.
 *   • Gov (GCC-High / IL5 / IL6) or no warehouse → the AOAI-direct substitute
 *     (gpt-4o chat-completions), boundary-detected server-side.
 *   • Gov with no AOAI deployed → an honest infra-gate MessageBar (this dialog
 *     renders the warning; it never crashes).
 *
 * A boundary probe (GET ?probe=1) drives which mode + gate the dialog shows.
 *
 * WAREHOUSE LINK (#3669). The in-database path runs only on a warehouse linked to
 * an item the caller can read. A refusal is shown with its `code` and the
 * server's `remediation`, plus "Use Azure OpenAI instead", which re-runs the
 * function on the AOAI path (no warehouse). A tenant admin whose selected
 * warehouse carries no link — and is not the deployment-shared `loom-default`,
 * which stays admin-only — is offered "Link to this item", which calls
 * `POST /api/admin/databricks-warehouses/adopt` for THIS item and reports what
 * the server read back. See `ai-function-warehouse-link.ts`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Link20Regular, Sparkle20Regular } from '@fluentui/react-icons';
import { useIsTenantAdmin } from '@/lib/components/session-context';
import { LINKABLE_ITEM_TYPE, linkOfferFor, runErrorFrom, type LinkOffer, type RunError } from './ai-function-warehouse-link';

// AiFn is a server type; import as type-only so this client bundle never pulls
// in the server module (which imports @azure/identity).
import type { AiFn } from '@/lib/azure/ai-functions-client';
import { escapeSparkSqlLiteral } from '@/lib/sql/quoting';

/** The nine AI functions (kept in sync with AI_FN_NAMES on the server). The
 *  first seven run in-database on Databricks (Comm/GCC) or via AOAI chat; embed
 *  and similarity are AOAI-embeddings only (no column SQL builtin). */
const FN_OPTIONS: { key: AiFn; label: string; desc: string }[] = [
  { key: 'sentiment', label: 'Sentiment', desc: 'positive / negative / neutral over a text column' },
  { key: 'classify', label: 'Classify', desc: 'assign exactly one of your labels' },
  { key: 'translate', label: 'Translate', desc: 'translate the text to a target language' },
  { key: 'summarize', label: 'Summarize', desc: 'a concise 2–3 sentence summary' },
  { key: 'extract', label: 'Extract', desc: 'pull named fields out as JSON' },
  { key: 'fix_grammar', label: 'Fix grammar', desc: 'correct spelling, grammar & punctuation' },
  { key: 'generate_response', label: 'Generate response', desc: 'draft a reply to the text' },
  { key: 'embed', label: 'Embeddings', desc: 'vector embedding of the text (AOAI)' },
  { key: 'similarity', label: 'Similarity', desc: 'cosine similarity vs a second text (AOAI)' },
];

/** Functions with a direct Databricks `ai_*` SQL builtin (in-database path).
 *  embed / similarity have none and always take the AOAI path. */
const DBX_SUPPORTED = new Set<AiFn>([
  'sentiment', 'classify', 'translate', 'summarize', 'extract', 'fix_grammar', 'generate_response',
]);

export interface DatabricksAiSnippetInput {
  fn: AiFn;
  column: string;
  table?: string;
  labels?: string[];
  fields?: string[];
  targetLang?: string;
}

/**
 * The Databricks AI SQL snippet the dialog displays and inserts. Labels, fields
 * and the target language are Databricks string literals, so they are escaped
 * by the Spark SQL literal grammar (escapeSparkSqlLiteral), the same rule the
 * server route applies. Every character is carried, so this never throws; it
 * returns '' only when no column is chosen (see {@link aiSnippetBlockedReason}).
 */
export function buildDatabricksAiSnippet(input: DatabricksAiSnippetInput): string {
  const { fn, column, table, targetLang } = input;
  if (!column.trim()) return '';
  const col = column.includes('`') ? column : `\`${column.trim()}\``;
  const tbl = table && (table.includes('`') || table.includes('.')) ? table : (table ? `\`${table}\`` : '<table>');
  const lit = (v: string) => `'${escapeSparkSqlLiteral(v)}'`;
  let expr: string;
  switch (fn) {
    case 'sentiment': expr = `ai_analyze_sentiment(${col})`; break;
    case 'summarize': expr = `ai_summarize(${col})`; break;
    case 'classify': {
      const ls = input.labels && input.labels.length ? input.labels : ['positive', 'negative', 'neutral'];
      expr = `ai_classify(${col}, ARRAY(${ls.map(lit).join(', ')}))`;
      break;
    }
    case 'translate':
      expr = `ai_translate(${col}, ${lit(targetLang || 'English')})`;
      break;
    case 'extract': {
      const fs = input.fields && input.fields.length ? input.fields : ['entity'];
      expr = `ai_extract(${col}, ARRAY(${fs.map(lit).join(', ')}))`;
      break;
    }
    case 'fix_grammar': expr = `ai_fix_grammar(${col})`; break;
    case 'generate_response': expr = `ai_gen(${col})`; break;
    default: expr = `ai_query(${col})`;
  }
  return `SELECT ${col}, ${expr} AS ai_result\nFROM ${tbl}\nLIMIT 50;`;
}

/**
 * Why the dialog has no AI SQL to insert, or null when it has one. Shown as the
 * snippet field's hint and the Insert button's tooltip, so a disabled Insert is
 * never unexplained.
 */
export function aiSnippetBlockedReason(input: { column: string }): string | null {
  if (!input.column.trim()) return 'Choose a column to generate the AI SQL.';
  return null;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, minWidth: '520px' },
  row: { display: 'flex', gap: tokens.spacingHorizontalM },
  flex1: { flex: 1 },
  receipt: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  tableWrap: { overflow: 'auto', maxHeight: '40vh' },
});

interface ProbeState {
  ok: boolean;
  govPath: boolean;
  dbxAvailable: boolean;
  gated: boolean;
  hint?: string;
}

interface DbxResult {
  engine: 'databricks';
  sql: string;
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  executionMs: number;
}
interface AoaiResult {
  engine: 'aoai';
  fn: string;
  column: string;
  input: string;
  result: string;
  model?: string;
  usage?: { totalTokens: number };
  /** `embed`: the embedding vector. */
  vector?: number[];
  /** `similarity`: cosine similarity in [-1, 1]. */
  similarity?: number;
}
type RunResult = DbxResult | AoaiResult;

export interface AiFunctionsHelperProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Loom item type slug (carried in the route — e.g. databricks-sql-warehouse). */
  itemType: string;
  /** Loom item id. */
  itemId: string;
  /** Active Databricks SQL Warehouse id (Comm/GCC in-database path). */
  warehouseId?: string;
  /** Active catalog / schema context (Databricks path). */
  catalog?: string | null;
  schema?: string | null;
  /** Fully- or partly-qualified table the column lives in (Databricks path). */
  table?: string;
  /** Known columns for the table → Dropdown. When absent the user types one. */
  columns?: string[];
  /** Insert the generated AI SQL into the host query editor. */
  onInsert?: (sql: string) => void;
}

export function AiFunctionsHelper(props: AiFunctionsHelperProps) {
  const s = useStyles();
  const { open, onOpenChange, itemType, itemId, warehouseId, catalog, schema, table, columns, onInsert } = props;

  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [fn, setFn] = useState<AiFn>('sentiment');
  const [column, setColumn] = useState<string>(columns && columns.length ? columns[0] : '');
  const [labels, setLabels] = useState<string>('positive, negative, neutral');
  const [fields, setFields] = useState<string>('');
  const [targetLang, setTargetLang] = useState<string>('English');
  const [compareTo, setCompareTo] = useState<string>('');
  const [sampleInput, setSampleInput] = useState<string>('');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setErrorState] = useState<RunError | null>(null);
  const setError = useCallback((message: string | null) => {
    setErrorState(message === null ? null : { message, aoaiFallback: false });
  }, []);
  // The route answers an unsaved item (`/items/<type>/new`) with 200
  // `{ ok:false, code:'unsaved_item' }`. That is guidance, not a failure, so it
  // renders as a warning (the sibling convention in warehouse-alerts.tsx).
  const [unsavedNotice, setUnsavedNotice] = useState<string | null>(null);

  // #3669 — "Use Azure OpenAI instead" after a warehouse refusal; cleared when the
  // dialog reopens or the warehouse changes.
  const [forceAoai, setForceAoai] = useState(false);
  const isAdmin = useIsTenantAdmin();
  const [linkOffer, setLinkOffer] = useState<LinkOffer>('unknown');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<RunError | null>(null);
  useEffect(() => { setForceAoai(false); setLinkError(null); }, [open, warehouseId]);

  // FGC-19 — model-tier selector (Fast/default vs Advanced) + reasoning-effort.
  // Applies to the Azure OpenAI path only (the in-database Databricks path uses
  // the warehouse's own ai_* runtime, not an AOAI deployment).
  const [tier, setTier] = useState<'fast' | 'advanced'>('fast');
  const [deployments, setDeployments] = useState<{ name: string; modelName?: string }[]>([]);
  const [deployment, setDeployment] = useState<string>('');
  const [reasoningEffort, setReasoningEffort] = useState<'minimal' | 'low' | 'medium' | 'high'>('medium');

  // --- Boundary probe whenever the dialog opens ---
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProbing(true);
    setProbeError(null);
    (async () => {
      try {
        const r = await clientFetch(
          `/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/ai-function?probe=1`,
        );
        const j = await r.json();
        if (cancelled) return;
        setProbe({
          ok: !!j.ok,
          govPath: !!j.govPath,
          dbxAvailable: !!j.dbxAvailable,
          gated: !!j.gated,
          hint: j.hint,
        });
      } catch (e: any) {
        if (!cancelled) setProbeError(e?.message || String(e));
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, itemType, itemId]);

  // Whether the in-database Databricks path is the one this run will take.
  const useDbx = !!(probe && !probe.govPath && probe.dbxAvailable && warehouseId && DBX_SUPPORTED.has(fn) && !forceAoai);

  // #3669 — tenant admins: is the selected warehouse unlinked, so "Link to this
  // item" applies? Read from the admin listing; any failure leaves 'unknown',
  // which offers nothing (never a guess).
  const dbxPossible = !!(probe && !probe.govPath && probe.dbxAvailable && warehouseId && itemType === LINKABLE_ITEM_TYPE);
  useEffect(() => {
    setLinkOffer('unknown');
    if (!open || !isAdmin || !dbxPossible) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/admin/databricks-warehouses/adopt');
        const j = await r.json();
        if (!cancelled && j?.ok) setLinkOffer(linkOfferFor(j.warehouses, warehouseId, itemId));
      } catch { /* stays 'unknown' — nothing offered */ }
    })();
    return () => { cancelled = true; };
  }, [open, isAdmin, dbxPossible, warehouseId, itemId]);

  const linkToItem = useCallback(async () => {
    if (!warehouseId) return;
    setLinking(true);
    setLinkError(null);
    try {
      const r = await clientFetch('/api/admin/databricks-warehouses/adopt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warehouseId, itemId, dryRun: false }),
      });
      const j = await r.json().catch(() => ({}));
      if (j?.ok) {
        setLinkOffer('linked');
        setForceAoai(false);
        setErrorState(null);
      } else {
        setLinkError(runErrorFrom(j, r.status));
      }
    } catch (e: any) {
      setLinkError({ message: e?.message || String(e), aoaiFallback: false });
    } finally {
      setLinking(false);
    }
  }, [warehouseId, itemId]);

  // Load the live model deployments when the Advanced tier is selected on the
  // AOAI path (honest: if the list can't load the dropdown stays empty and Fast
  // is used). Runs once per dialog open.
  useEffect(() => {
    if (useDbx || tier !== 'advanced' || deployments.length) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await clientFetch('/api/foundry/model-deployments');
        const j = await r.json();
        if (!cancelled && j.ok && Array.isArray(j.deployments)) {
          setDeployments(j.deployments.map((d: any) => ({ name: d.name, modelName: d.modelName })));
        }
      } catch { /* honest empty state */ }
    })();
    return () => { cancelled = true; };
  }, [useDbx, tier, deployments.length]);

  const optionsPayload = useMemo(() => {
    const o: Record<string, unknown> = {};
    if (fn === 'classify') o.labels = labels.split(',').map((x) => x.trim()).filter(Boolean);
    if (fn === 'extract') o.fields = fields.split(',').map((x) => x.trim()).filter(Boolean);
    if (fn === 'translate') o.targetLang = targetLang.trim();
    if (fn === 'similarity') o.compareTo = compareTo.trim();
    return o;
  }, [fn, labels, fields, targetLang, compareTo]);

  // Build the Databricks AI SQL snippet (for Insert + as the displayed contract).
  const generatedSql = useMemo(() => {
    if (!useDbx || !column.trim()) return '';
    return buildDatabricksAiSnippet({
      fn,
      column,
      table,
      labels: optionsPayload.labels as string[] | undefined,
      fields: optionsPayload.fields as string[] | undefined,
      targetLang,
    });
  }, [useDbx, column, table, fn, optionsPayload, targetLang]);
  const snippetBlockedReason = useDbx ? aiSnippetBlockedReason({ column }) : null;

  const reset = useCallback(() => { setResult(null); setError(null); setUnsavedNotice(null); }, [setError]);

  const insert = useCallback(() => {
    if (generatedSql && onInsert) {
      onInsert(generatedSql);
      onOpenChange(false);
    }
  }, [generatedSql, onInsert, onOpenChange]);

  const run = useCallback(async () => {
    reset();
    if (!column.trim()) { setError('Pick or name a column first.'); return; }
    if (!useDbx && !sampleInput.trim()) {
      setError('On the Azure OpenAI path, paste a sample value from the column to enrich.');
      return;
    }
    if (fn === 'similarity' && !compareTo.trim()) {
      setError('Similarity needs a second text to compare against.');
      return;
    }
    setRunning(true);
    try {
      const r = await clientFetch(`/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/ai-function`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fn,
          column: column.trim(),
          warehouseId: useDbx ? warehouseId : undefined,
          table: useDbx ? table : undefined,
          catalog: useDbx ? (catalog || undefined) : undefined,
          schema: useDbx ? (schema || undefined) : undefined,
          input: useDbx ? undefined : sampleInput.trim(),
          options: optionsPayload,
          // FGC-19 model-tier: only forwarded on the AOAI path (Advanced tier).
          deployment: !useDbx && tier === 'advanced' && deployment ? deployment : undefined,
          reasoningEffort: !useDbx && tier === 'advanced' ? reasoningEffort : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok && j.code === 'unsaved_item') {
        setUnsavedNotice(j.error || 'AI functions run in the name of a saved item.');
        return;
      }
      if (!j.ok) {
        // #3669 — keep the code and the server's remediation, not just the error.
        setErrorState(runErrorFrom(j, r.status));
        if (j.gated) setProbe((p) => (p ? { ...p, gated: true, hint: j.hint } : p));
        return;
      }
      setResult(j as RunResult);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [reset, setError, column, useDbx, sampleInput, compareTo, itemType, itemId, fn, warehouseId, table, catalog, schema, optionsPayload, tier, deployment, reasoningEffort]);

  const activeFn = FN_OPTIONS.find((f) => f.key === fn);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '760px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Sparkle20Regular /> AI functions
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              {probing && <Spinner size="tiny" label="Checking AI backend…" labelPosition="after" />}
              {probeError && (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>Could not reach the AI backend</MessageBarTitle>
                    {probeError}
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Honest infra-gate: Gov boundary with no AOAI deployed. */}
              {probe?.gated && (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>Azure OpenAI not configured for this boundary</MessageBarTitle>
                    {probe.hint ||
                      'Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (admin-plane/main.bicep — aiFoundryEnabled / agentFoundryEnabled) and grant the Console UAMI "Cognitive Services OpenAI User".'}
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Which path will run */}
              {probe && !probe.gated && (
                <Caption1>
                  Backend:{' '}
                  {useDbx ? (
                    <Badge appearance="tint" color="brand">Databricks ai_query() (in-database)</Badge>
                  ) : (
                    <Badge appearance="tint" color="informative">
                      Azure OpenAI{probe.govPath ? ' (Gov boundary)' : ''}
                    </Badge>
                  )}
                </Caption1>
              )}

              {/* #3669 — tenant admins: link an unlinked warehouse to this item. */}
              {linkOffer === 'offer' && (
                <MessageBar intent="info" layout="multiline">
                  <MessageBarBody>
                    <MessageBarTitle>This warehouse is not linked to this item</MessageBarTitle>
                    Only tenant admins can run AI functions on it until it is linked. Linking tags the
                    warehouse with this item, so readers of this workspace can use it too.
                    {linkError && (
                      <div>
                        <Caption1>
                          {linkError.message}
                          {linkError.code ? <> · <span className={s.mono}>{linkError.code}</span></> : null}
                        </Caption1>
                      </div>
                    )}
                  </MessageBarBody>
                  <MessageBarActions>
                    <Button size="small" icon={<Link20Regular />} disabled={linking} onClick={linkToItem}>
                      {linking ? 'Linking…' : 'Link to this item'}
                    </Button>
                  </MessageBarActions>
                </MessageBar>
              )}

              {!probe?.gated && (
                <>
                  <div className={s.row}>
                    <Field label="Function" className={s.flex1}>
                      <Dropdown
                        value={activeFn?.label || ''}
                        selectedOptions={[fn]}
                        onOptionSelect={(_, d) => { if (d.optionValue) { setFn(d.optionValue as AiFn); reset(); } }}
                      >
                        {FN_OPTIONS.map((f) => (
                          <Option key={f.key} value={f.key} text={f.label}>{f.label} — {f.desc}</Option>
                        ))}
                      </Dropdown>
                    </Field>
                    <Field label="Column" className={s.flex1} hint={useDbx ? 'Column in the selected table' : 'Column you are enriching'}>
                      {columns && columns.length ? (
                        <Dropdown
                          value={column}
                          selectedOptions={column ? [column] : []}
                          placeholder="Select a column"
                          onOptionSelect={(_, d) => { if (d.optionValue) { setColumn(d.optionValue); reset(); } }}
                        >
                          {columns.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                        </Dropdown>
                      ) : (
                        <Input value={column} placeholder="e.g. review_text" onChange={(_, d) => { setColumn(d.value); reset(); }} />
                      )}
                    </Field>
                  </div>

                  {/* Per-function options */}
                  {fn === 'classify' && (
                    <Field label="Labels" hint="Comma-separated; the model returns exactly one">
                      <Input value={labels} onChange={(_, d) => { setLabels(d.value); reset(); }} />
                    </Field>
                  )}
                  {fn === 'extract' && (
                    <Field label="Fields" hint="Comma-separated field names returned as JSON">
                      <Input value={fields} placeholder="e.g. company, amount, date" onChange={(_, d) => { setFields(d.value); reset(); }} />
                    </Field>
                  )}
                  {fn === 'translate' && (
                    <Field label="Target language">
                      <Input value={targetLang} onChange={(_, d) => { setTargetLang(d.value); reset(); }} />
                    </Field>
                  )}
                  {fn === 'similarity' && (
                    <Field label="Compare to" hint="Second text; cosine similarity is computed against the sample value below (Azure OpenAI embeddings)">
                      <Textarea
                        value={compareTo}
                        onChange={(_, d) => { setCompareTo(d.value); reset(); }}
                        placeholder="e.g. The checkout experience was smooth and fast."
                        resize="vertical"
                        rows={2}
                      />
                    </Field>
                  )}

                  {/* FGC-19 — model tier + reasoning effort (Azure OpenAI path only). */}
                  {!useDbx && (
                    <div className={s.row}>
                      <Field label="Model tier" className={s.flex1} hint="Fast = default deployment · Advanced = higher-reasoning">
                        <Dropdown
                          value={tier === 'fast' ? 'Fast (default)' : 'Advanced'}
                          selectedOptions={[tier]}
                          onOptionSelect={(_, d) => { if (d.optionValue) { setTier(d.optionValue as 'fast' | 'advanced'); reset(); } }}
                        >
                          <Option value="fast" text="Fast (default)">Fast (default) — cost-efficient deployment</Option>
                          <Option value="advanced" text="Advanced">Advanced — higher-reasoning deployment</Option>
                        </Dropdown>
                      </Field>
                      {tier === 'advanced' && (
                        <Field label="Deployment" className={s.flex1} hint={deployments.length ? 'Live model deployments' : 'None listed — Fast used'}>
                          <Dropdown
                            value={deployment}
                            selectedOptions={deployment ? [deployment] : []}
                            placeholder="Default"
                            disabled={!deployments.length}
                            onOptionSelect={(_, d) => { if (d.optionValue) { setDeployment(d.optionValue); reset(); } }}
                          >
                            {deployments.map((dp) => (
                              <Option key={dp.name} value={dp.name} text={dp.name}>{dp.name}{dp.modelName ? ` · ${dp.modelName}` : ''}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                      )}
                      {tier === 'advanced' && (
                        <Field label="Reasoning effort" className={s.flex1} hint="Passed to reasoning-class models">
                          <Dropdown
                            value={reasoningEffort}
                            selectedOptions={[reasoningEffort]}
                            onOptionSelect={(_, d) => { if (d.optionValue) { setReasoningEffort(d.optionValue as 'minimal' | 'low' | 'medium' | 'high'); reset(); } }}
                          >
                            {(['minimal', 'low', 'medium', 'high'] as const).map((e) => (
                              <Option key={e} value={e} text={e}>{e}</Option>
                            ))}
                          </Dropdown>
                        </Field>
                      )}
                    </div>
                  )}

                  {useDbx ? (
                    <Field
                      label="Generated AI SQL"
                      hint={snippetBlockedReason ?? 'Inserted into the query editor or run against the warehouse'}
                    >
                      <Textarea value={generatedSql} readOnly textarea={{ className: s.mono }} resize="vertical" rows={4} />
                    </Field>
                  ) : (
                    <Field label="Sample value to enrich" hint="A real cell value from the chosen column (Azure OpenAI path)">
                      <Textarea
                        value={sampleInput}
                        onChange={(_, d) => { setSampleInput(d.value); reset(); }}
                        placeholder="e.g. The onboarding flow was confusing but support fixed it fast."
                        resize="vertical"
                        rows={3}
                      />
                    </Field>
                  )}

                  {unsavedNotice && (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        <MessageBarTitle>Save this item first</MessageBarTitle>
                        {unsavedNotice}
                      </MessageBarBody>
                    </MessageBar>
                  )}

                  {error && (
                    <MessageBar intent="error" layout="multiline">
                      <MessageBarBody>
                        <MessageBarTitle>AI function failed</MessageBarTitle>
                        {error.message}
                        {error.code && (
                          <div><Caption1>Code: <span className={s.mono}>{error.code}</span></Caption1></div>
                        )}
                        {error.remediation && <div><Caption1>{error.remediation}</Caption1></div>}
                      </MessageBarBody>
                      {error.aoaiFallback && (
                        <MessageBarActions>
                          <Button
                            size="small"
                            icon={<Sparkle20Regular />}
                            onClick={() => { setForceAoai(true); setErrorState(null); setResult(null); }}
                          >
                            Use Azure OpenAI instead
                          </Button>
                        </MessageBarActions>
                      )}
                    </MessageBar>
                  )}

                  {/* Receipt: enriched rows (Databricks) or single enrichment (AOAI). */}
                  {result && result.engine === 'databricks' && (
                    <div className={s.receipt}>
                      <Caption1>
                        {result.rowCount} row(s) · {result.executionMs} ms · Databricks ai_query()
                      </Caption1>
                      <div className={s.tableWrap}>
                        <Table size="small" aria-label="AI function result">
                          <TableHeader>
                            <TableRow>
                              {result.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {result.rows.slice(0, 20).map((row, i) => (
                              <TableRow key={i}>
                                {row.map((cell, j) => (
                                  <TableCell key={j}>
                                    <span className={s.mono}>{cell == null ? '' : String(cell)}</span>
                                  </TableCell>
                                ))}
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                  {result && result.engine === 'aoai' && (
                    <div className={s.receipt}>
                      <Caption1>
                        Azure OpenAI{result.model ? ` · ${result.model}` : ''}
                        {result.usage ? ` · ${result.usage.totalTokens} tokens` : ''}
                      </Caption1>
                      {result.fn === 'similarity' ? (
                        <>
                          <Body1><strong>Cosine similarity</strong> of <span className={s.mono}>{result.column}</span> vs the compare text:</Body1>
                          <div className={s.mono} style={{ fontSize: tokens.fontSizeBase500 }}>
                            {typeof result.similarity === 'number' ? result.similarity.toFixed(4) : result.result}
                          </div>
                        </>
                      ) : result.fn === 'embed' ? (
                        <>
                          <Body1><strong>Embedding</strong> of <span className={s.mono}>{result.column}</span>: {result.result}</Body1>
                          {result.vector && result.vector.length > 0 && (
                            <div className={s.mono}>
                              [{result.vector.slice(0, 8).map((v) => v.toFixed(4)).join(', ')}
                              {result.vector.length > 8 ? `, … (+${result.vector.length - 8} more)` : ''}]
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <Body1><strong>{fn}</strong> of <span className={s.mono}>{result.column}</span>:</Body1>
                          <div className={s.mono}>{result.result}</div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            {useDbx && onInsert && (
              <Button
                appearance="outline"
                disabled={!generatedSql}
                title={snippetBlockedReason ?? undefined}
                onClick={insert}
              >
                Insert SQL
              </Button>
            )}
            {!probe?.gated && (
              <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={running || probing} onClick={run}>
                {running ? 'Running…' : 'Run'}
              </Button>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
