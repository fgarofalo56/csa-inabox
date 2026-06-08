'use client';

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
import { Sparkle20Regular } from '@fluentui/react-icons';

// AiFn is a server type; import as type-only so this client bundle never pulls
// in the server module (which imports @azure/identity).
import type { AiFn } from '@/lib/azure/ai-functions-client';

/** The five AI functions (kept in sync with AI_FN_NAMES on the server). */
const FN_OPTIONS: { key: AiFn; label: string; desc: string }[] = [
  { key: 'sentiment', label: 'Sentiment', desc: 'positive / negative / neutral over a text column' },
  { key: 'classify', label: 'Classify', desc: 'assign exactly one of your labels' },
  { key: 'translate', label: 'Translate', desc: 'translate the text to a target language' },
  { key: 'summarize', label: 'Summarize', desc: 'a concise 2–3 sentence summary' },
  { key: 'extract', label: 'Extract', desc: 'pull named fields out as JSON' },
];

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: 14, minWidth: 520 },
  row: { display: 'flex', gap: 12 },
  flex1: { flex: 1 },
  receipt: {
    display: 'flex', flexDirection: 'column', gap: 6,
    padding: 12, borderRadius: 6,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mono: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
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
  const [sampleInput, setSampleInput] = useState<string>('');

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- Boundary probe whenever the dialog opens ---
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProbing(true);
    setProbeError(null);
    (async () => {
      try {
        const r = await fetch(
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
  const useDbx = !!(probe && !probe.govPath && probe.dbxAvailable && warehouseId);

  const optionsPayload = useMemo(() => {
    const o: Record<string, unknown> = {};
    if (fn === 'classify') o.labels = labels.split(',').map((x) => x.trim()).filter(Boolean);
    if (fn === 'extract') o.fields = fields.split(',').map((x) => x.trim()).filter(Boolean);
    if (fn === 'translate') o.targetLang = targetLang.trim();
    return o;
  }, [fn, labels, fields, targetLang]);

  // Build the Databricks AI SQL snippet (for Insert + as the displayed contract).
  const generatedSql = useMemo(() => {
    if (!useDbx || !column.trim()) return '';
    const col = column.includes('`') ? column : `\`${column.trim()}\``;
    const tbl = table && (table.includes('`') || table.includes('.')) ? table : (table ? `\`${table}\`` : '<table>');
    let expr: string;
    switch (fn) {
      case 'sentiment': expr = `ai_analyze_sentiment(${col})`; break;
      case 'summarize': expr = `ai_summarize(${col})`; break;
      case 'classify': {
        const ls = (optionsPayload.labels as string[] | undefined) || ['positive', 'negative', 'neutral'];
        expr = `ai_classify(${col}, ARRAY(${ls.map((l) => `'${l.replace(/'/g, "''")}'`).join(', ')}))`;
        break;
      }
      case 'translate':
        expr = `ai_translate(${col}, '${(targetLang || 'English').replace(/'/g, "''")}')`;
        break;
      case 'extract': {
        const fs = (optionsPayload.fields as string[] | undefined) || ['entity'];
        expr = `ai_extract(${col}, ARRAY(${fs.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ')}))`;
        break;
      }
      default: expr = `ai_query(${col})`;
    }
    return `SELECT ${col}, ${expr} AS ai_result\nFROM ${tbl}\nLIMIT 50;`;
  }, [useDbx, column, table, fn, optionsPayload, targetLang]);

  const reset = useCallback(() => { setResult(null); setError(null); }, []);

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
    setRunning(true);
    try {
      const r = await fetch(`/api/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}/ai-function`, {
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
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        if (j.gated) setProbe((p) => (p ? { ...p, gated: true, hint: j.hint } : p));
        return;
      }
      setResult(j as RunResult);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [reset, column, useDbx, sampleInput, itemType, itemId, fn, warehouseId, table, catalog, schema, optionsPayload]);

  const activeFn = FN_OPTIONS.find((f) => f.key === fn);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '760px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
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

                  {useDbx ? (
                    <Field label="Generated AI SQL" hint="Inserted into the query editor or run against the warehouse">
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

                  {error && (
                    <MessageBar intent="error">
                      <MessageBarBody>
                        <MessageBarTitle>AI function failed</MessageBarTitle>
                        {error}
                      </MessageBarBody>
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
                      <Body1><strong>{fn}</strong> of <span className={s.mono}>{result.column}</span>:</Body1>
                      <div className={s.mono}>{result.result}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Close</Button>
            {useDbx && onInsert && (
              <Button appearance="outline" disabled={!generatedSql} onClick={insert}>Insert SQL</Button>
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
