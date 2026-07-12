'use client';

/**
 * AddAiColumnDialog — Fabric-parity "Add AI column" over a table/result grid
 * (G2 #1). Pick an AI function, the source column(s), an output column name, and
 * a model tier; it runs the function over every loaded row through the real
 * batch endpoint POST /api/ai-functions/table (live Azure OpenAI — no Microsoft
 * Fabric / Power BI dependency, no mock rows) and appends the produced column(s)
 * to the grid.
 *
 * Also hosts the schema-builder (G2 #6): for `extract`, define multiple
 * field/type/prompt rows and materialize one output column per field in a single
 * pass. And the multimodal seam (G2 #5): choose an image/document input column
 * for the vision-capable functions (honest-gated by the route when no vision
 * deployment is configured).
 *
 * Presentational + self-contained: it takes the loaded `columns` + `rows` and
 * returns produced columns via `onApply`; the host grid owns the append.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Checkbox, Dialog, DialogActions, DialogBody,
  DialogContent, DialogSurface, DialogTitle, Dropdown, Field, Input, MessageBar,
  MessageBarBody, MessageBarTitle, Option, Spinner, Switch, Table, TableBody,
  TableCell, TableHeader, TableHeaderCell, TableRow, Textarea, Tooltip,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Sparkle20Regular, Add16Regular, Delete16Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import {
  AI_FN_META, aiFnMeta, type AiFnKey, type AiSchemaField,
} from '@/lib/azure/ai-functions-registry';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '520px' },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  flex1: { flex: 1, minWidth: '200px' },
  schemaRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'flex-end' },
  receipt: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground3, border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  mono: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  tableWrap: { overflow: 'auto', maxHeight: '34vh' },
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
});

/** A produced AI column, values aligned to the input `rows` order. */
export interface ProducedAiColumn { name: string; values: string[] }

export interface AddAiColumnDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Base column names of the grid. */
  columns: string[];
  /** Base rows (cells aligned to `columns`). */
  rows: unknown[][];
  /** Commit the produced column(s) to the host grid. */
  onApply: (produced: ProducedAiColumn[]) => void;
}

const TIERS: { key: 'mini' | 'standard' | 'strong'; label: string }[] = [
  { key: 'mini', label: 'Mini (cheapest)' },
  { key: 'standard', label: 'Standard (default)' },
  { key: 'strong', label: 'Strong (reasoning)' },
];

export function AddAiColumnDialog(props: AddAiColumnDialogProps) {
  const s = useStyles();
  const { open, onOpenChange, columns, rows, onApply } = props;

  const [fn, setFn] = useState<AiFnKey>('summarize');
  const [inputCols, setInputCols] = useState<string[]>(columns.length ? [columns[0]] : []);
  const [outputCol, setOutputCol] = useState<string>('ai_summarize');
  const [tier, setTier] = useState<'mini' | 'standard' | 'strong'>('standard');
  const [inputType, setInputType] = useState<'text' | 'image' | 'document'>('text');

  const [labels, setLabels] = useState('positive, negative, neutral');
  const [fields, setFields] = useState('');
  const [targetLang, setTargetLang] = useState('English');
  const [compareTo, setCompareTo] = useState('');

  const [useSchema, setUseSchema] = useState(false);
  const [schema, setSchema] = useState<AiSchemaField[]>([{ field: '', type: 'string', prompt: '' }]);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateHint, setGateHint] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ columns: string[]; sample: string[][]; produced: ProducedAiColumn[]; rowCount: number; failed: number; model?: string; totalTokens?: number } | null>(null);

  const meta = aiFnMeta(fn);
  const supportsVision = !!meta?.supportsVision;
  const schemaMode = fn === 'extract' && useSchema;

  const setFnAndDefaults = useCallback((next: AiFnKey) => {
    setFn(next);
    setOutputCol(`ai_${next}`);
    setPreview(null);
    setError(null);
    if (next !== 'extract') setUseSchema(false);
    if (!aiFnMeta(next)?.supportsVision) setInputType('text');
  }, []);

  const toggleCol = useCallback((c: string) => {
    setInputCols((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
    setPreview(null);
  }, []);

  const updateSchema = useCallback((i: number, patch: Partial<AiSchemaField>) => {
    setSchema((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
    setPreview(null);
  }, []);

  const options = useMemo(() => {
    const o: Record<string, unknown> = {};
    if (fn === 'classify') o.labels = labels.split(',').map((x) => x.trim()).filter(Boolean);
    if (fn === 'extract' && !useSchema) o.fields = fields.split(',').map((x) => x.trim()).filter(Boolean);
    if (fn === 'translate') o.targetLang = targetLang.trim();
    if (fn === 'similarity') o.compareTo = compareTo.trim();
    return o;
  }, [fn, labels, fields, targetLang, compareTo, useSchema]);

  const run = useCallback(async () => {
    setError(null);
    setGateHint(null);
    setPreview(null);
    if (!inputCols.length) { setError('Pick at least one source column.'); return; }
    if (fn === 'similarity' && !compareTo.trim()) { setError('Similarity needs a second text to compare against.'); return; }
    if (schemaMode && !schema.some((f) => f.field.trim())) { setError('Add at least one schema field.'); return; }

    // Convert grid rows → row objects the endpoint keys off inputColumns.
    const rowObjs = rows.map((cells) => {
      const o: Record<string, unknown> = {};
      columns.forEach((c, i) => { o[c] = cells[i]; });
      return o;
    });

    setRunning(true);
    try {
      const r = await clientFetch('/api/ai-functions/table', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          fn,
          rows: rowObjs,
          inputColumns: inputCols,
          outputColumn: outputCol.trim() || `ai_${fn}`,
          modelTier: tier,
          inputType,
          options,
          schema: schemaMode ? schema.filter((f) => f.field.trim()) : undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        if (j.gated || j.code === 'not_configured') setGateHint(j.hint || null);
        return;
      }

      const resultRows: Array<{ index: number; result: string; error?: string; values?: Record<string, string> }> = j.rows || [];
      const n = rows.length;
      let produced: ProducedAiColumn[];
      let previewCols: string[];
      if (j.outputColumns && Array.isArray(j.outputColumns)) {
        previewCols = j.outputColumns;
        produced = j.outputColumns.map((name: string) => ({
          name,
          values: Array.from({ length: n }, (_, i) => resultRows[i]?.values?.[name] ?? ''),
        }));
      } else {
        const name = j.outputColumn || outputCol.trim() || `ai_${fn}`;
        previewCols = [name];
        produced = [{ name, values: Array.from({ length: n }, (_, i) => resultRows[i]?.result ?? '') }];
      }

      const sample = Array.from({ length: Math.min(n, 8) }, (_, i) => previewCols.map((c) => {
        const col = produced.find((p) => p.name === c);
        return col ? col.values[i] : '';
      }));

      setPreview({
        columns: previewCols, sample, produced,
        rowCount: j.rowCount ?? n, failed: j.failed ?? 0,
        model: j.model, totalTokens: j.usage?.totalTokens,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [inputCols, fn, compareTo, schemaMode, schema, rows, columns, outputCol, tier, inputType, options]);

  const apply = useCallback(() => {
    if (preview) { onApply(preview.produced); onOpenChange(false); }
  }, [preview, onApply, onOpenChange]);

  const activeMeta = AI_FN_META.find((m) => m.key === fn);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '820px', width: '94vw' }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Sparkle20Regular /> Add AI column
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Caption1>
                Applies an Azure OpenAI function to every loaded row and adds the result as a new
                column. {rows.length.toLocaleString()} row(s) will be enriched (max 500 per run).
              </Caption1>

              <div className={s.row}>
                <Field label="Function" className={s.flex1}>
                  <Dropdown
                    value={activeMeta?.label || ''}
                    selectedOptions={[fn]}
                    onOptionSelect={(_, d) => { if (d.optionValue) setFnAndDefaults(d.optionValue as AiFnKey); }}
                  >
                    {AI_FN_META.map((m) => (
                      <Option key={m.key} value={m.key} text={m.label}>{m.label} — {m.desc}</Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Output column" className={s.flex1} hint={schemaMode ? 'Schema mode adds one column per field' : 'New column name'}>
                  <Input value={outputCol} disabled={schemaMode} onChange={(_, d) => { setOutputCol(d.value); setPreview(null); }} />
                </Field>
              </div>

              <Field label="Source column(s)" hint={inputType === 'text' ? 'Values fed to the function (multiple are joined as labeled lines)' : 'Column holding the image / document URL or data URI'}>
                <div className={s.row}>
                  {columns.length === 0 && <Caption1>No columns loaded.</Caption1>}
                  {columns.map((c) => (
                    <Checkbox key={c} label={c} checked={inputCols.includes(c)} onChange={() => toggleCol(c)} />
                  ))}
                </div>
              </Field>

              <div className={s.row}>
                <Field label="Model tier" className={s.flex1} hint="Routed via the Loom model-tier router">
                  <Dropdown
                    value={TIERS.find((t) => t.key === tier)?.label || ''}
                    selectedOptions={[tier]}
                    onOptionSelect={(_, d) => { if (d.optionValue) { setTier(d.optionValue as any); setPreview(null); } }}
                  >
                    {TIERS.map((t) => <Option key={t.key} value={t.key} text={t.label}>{t.label}</Option>)}
                  </Dropdown>
                </Field>
                {supportsVision && (
                  <Field label="Input type" className={s.flex1} hint="Image / document needs a vision deployment">
                    <Dropdown
                      value={inputType === 'text' ? 'Text' : inputType === 'image' ? 'Image (vision)' : 'Document (vision)'}
                      selectedOptions={[inputType]}
                      onOptionSelect={(_, d) => { if (d.optionValue) { setInputType(d.optionValue as any); setPreview(null); } }}
                    >
                      <Option value="text" text="Text">Text</Option>
                      <Option value="image" text="Image (vision)">Image (vision)</Option>
                      <Option value="document" text="Document (vision)">Document (vision)</Option>
                    </Dropdown>
                  </Field>
                )}
              </div>

              {/* Per-function options */}
              {fn === 'classify' && (
                <Field label="Labels" hint="Comma-separated; the model returns exactly one">
                  <Input value={labels} onChange={(_, d) => { setLabels(d.value); setPreview(null); }} />
                </Field>
              )}
              {fn === 'translate' && (
                <Field label="Target language">
                  <Input value={targetLang} onChange={(_, d) => { setTargetLang(d.value); setPreview(null); }} />
                </Field>
              )}
              {fn === 'similarity' && (
                <Field label="Compare to" hint="Cosine similarity is computed against each row (Azure OpenAI embeddings)">
                  <Textarea value={compareTo} onChange={(_, d) => { setCompareTo(d.value); setPreview(null); }} rows={2} resize="vertical" />
                </Field>
              )}
              {fn === 'extract' && (
                <>
                  <Switch
                    label="Structured extraction schema (one column per field)"
                    checked={useSchema}
                    onChange={(_, d) => { setUseSchema(d.checked); setPreview(null); }}
                  />
                  {!useSchema && (
                    <Field label="Fields" hint="Comma-separated field names returned as JSON">
                      <Input value={fields} placeholder="e.g. company, amount, date" onChange={(_, d) => { setFields(d.value); setPreview(null); }} />
                    </Field>
                  )}
                  {useSchema && (
                    <Field label="Schema" hint="Each field becomes its own output column">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                        {schema.map((f, i) => (
                          <div key={i} className={s.schemaRow}>
                            <Input placeholder="field name" value={f.field} onChange={(_, d) => updateSchema(i, { field: d.value })} style={{ flex: 1 }} />
                            <Dropdown
                              style={{ minWidth: '110px' }}
                              value={f.type}
                              selectedOptions={[f.type]}
                              onOptionSelect={(_, d) => { if (d.optionValue) updateSchema(i, { type: d.optionValue as AiSchemaField['type'] }); }}
                            >
                              {(['string', 'number', 'boolean', 'date'] as const).map((t) => <Option key={t} value={t} text={t}>{t}</Option>)}
                            </Dropdown>
                            <Input placeholder="what to extract" value={f.prompt} onChange={(_, d) => updateSchema(i, { prompt: d.value })} style={{ flex: 2 }} />
                            <Tooltip content="Remove field" relationship="label">
                              <Button appearance="subtle" icon={<Delete16Regular />} onClick={() => setSchema((prev) => prev.filter((_, idx) => idx !== i))} aria-label="Remove field" />
                            </Tooltip>
                          </div>
                        ))}
                        <Button appearance="outline" icon={<Add16Regular />} onClick={() => setSchema((prev) => [...prev, { field: '', type: 'string', prompt: '' }])} style={{ alignSelf: 'flex-start' }}>
                          Add field
                        </Button>
                      </div>
                    </Field>
                  )}
                </>
              )}

              {error && (
                <MessageBar intent={gateHint ? 'warning' : 'error'}>
                  <MessageBarBody className={s.breakText}>
                    <MessageBarTitle>{gateHint ? 'Azure OpenAI not configured' : 'AI column failed'}</MessageBarTitle>
                    {error}{gateHint ? <><br />{gateHint}</> : null}
                  </MessageBarBody>
                </MessageBar>
              )}

              {preview && (
                <div className={s.receipt}>
                  <Caption1>
                    {preview.rowCount.toLocaleString()} row(s) enriched
                    {preview.failed ? ` · ${preview.failed} failed` : ''}
                    {preview.model ? ` · ${preview.model}` : ''}
                    {preview.totalTokens ? ` · ${preview.totalTokens} tokens` : ''}
                    {' · '}
                    <Badge appearance="tint" color="brand">Azure OpenAI</Badge>
                  </Caption1>
                  <div className={s.tableWrap}>
                    <Table size="small" aria-label="AI column preview">
                      <TableHeader>
                        <TableRow>{preview.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.sample.map((row, i) => (
                          <TableRow key={i}>{row.map((cell, j) => <TableCell key={j}><span className={s.mono}>{cell}</span></TableCell>)}</TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {preview.rowCount > preview.sample.length && <Caption1>Showing first {preview.sample.length} of {preview.rowCount}.</Caption1>}
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button appearance="outline" icon={running ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={running || !inputCols.length} onClick={run}>
              {running ? 'Running…' : preview ? 'Re-run' : 'Run'}
            </Button>
            <Button appearance="primary" disabled={!preview} onClick={apply}>
              {preview && preview.columns.length > 1 ? `Add ${preview.columns.length} columns` : 'Add column'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default AddAiColumnDialog;
