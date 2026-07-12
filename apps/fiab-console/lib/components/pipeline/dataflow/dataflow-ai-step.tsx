'use client';

/**
 * DataflowAiStepDialog — a Dataflow Gen2 "AI column" step (G2 #3).
 *
 * Applies a Loom AI function over sample values of a source column via the SAME
 * real batch endpoint the grid "Add AI column" uses (POST /api/ai-functions/table
 * — live Azure OpenAI, no Microsoft Fabric / Power BI dependency), then appends a
 * genuine Power Query (M) applied step to the active query that materializes the
 * enriched column as an inline value→result lookup. The preview is a real AOAI
 * round-trip; the emitted M step is a real `Table.AddColumn` transform (no mock).
 *
 * Honest scope note (surfaced in the UI): the step maps the values enriched here;
 * when the dataflow runs on ADF over new/unseen rows those cells default to null
 * until the AI step is re-run — Loom does not (yet) invoke AOAI from inside the
 * ADF WranglingDataFlow at execution time.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Badge, Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent,
  DialogSurface, DialogTitle, Dropdown, Field, Input, MessageBar, MessageBarBody,
  Option, Spinner, Textarea, makeStyles, tokens,
} from '@fluentui/react-components';
import { Sparkle20Regular } from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { AI_FN_META, type AiFnKey } from '@/lib/azure/ai-functions-registry';
import {
  parseSharedQueries, parseLetBody, buildLetBody, setQueryBody, quoteStepName,
} from './m-script';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: '480px' },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  flex1: { flex: 1, minWidth: '180px' },
  breakText: { overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0 },
});

/** An M string literal (doubling embedded quotes). */
function mStr(v: string): string { return `"${v.replace(/"/g, '""')}"`; }
/** A quoted M record field name. */
function mField(v: string): string { return `#"${v.replace(/"/g, '""')}"`; }

/**
 * Build a real `Table.AddColumn` applied step that maps the source column to the
 * AI result via an inline record lookup. Returns the full M section with the new
 * step appended to `queryName`.
 */
export function appendAiColumnStep(
  mScript: string,
  queryName: string,
  sourceColumn: string,
  outColumn: string,
  pairs: Array<{ input: string; result: string }>,
): string {
  const query = parseSharedQueries(mScript).find((q) => q.name === queryName);
  if (!query) return mScript;
  const { steps, result } = parseLetBody(query.body);
  const prev = result || (steps.length ? steps[steps.length - 1].name : 'Source');
  const record = pairs
    .filter((p) => p.input.trim())
    .map((p) => `${mField(p.input)} = ${mStr(p.result)}`)
    .join(', ');
  const srcAccess = /^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceColumn) ? `[${sourceColumn}]` : `[${mField(sourceColumn)}]`;
  const expr =
    `Table.AddColumn(${quoteStepName(prev)}, ${mStr(outColumn)}, ` +
    `each Record.FieldOrDefault([${record}], Text.From(${srcAccess}), null), type text)`;
  const stepName = `Added AI ${outColumn}`;
  const nextSteps = [...steps, { name: stepName, expr }];
  return setQueryBody(mScript, queryName, buildLetBody(nextSteps, stepName));
}

export interface DataflowAiStepDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Column names of the active query (may be empty). */
  columns: string[];
  /** Active query name to append the step to. */
  queryName: string;
  /** Full M section text. */
  mScript: string;
  /** Commit the new M section (with the AI step appended) back to the editor. */
  onApply: (nextM: string) => void;
}

export function DataflowAiStepDialog(props: DataflowAiStepDialogProps) {
  const s = useStyles();
  const { open, onOpenChange, columns, queryName, mScript, onApply } = props;

  const [fn, setFn] = useState<AiFnKey>('summarize');
  const [sourceCol, setSourceCol] = useState<string>(columns[0] || '');
  const [outCol, setOutCol] = useState<string>('ai_summarize');
  const [tier, setTier] = useState<'mini' | 'standard' | 'strong'>('standard');
  const [valuesText, setValuesText] = useState('');
  const [labels, setLabels] = useState('positive, negative, neutral');
  const [targetLang, setTargetLang] = useState('English');

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateHint, setGateHint] = useState<string | null>(null);
  const [pairs, setPairs] = useState<Array<{ input: string; result: string }> | null>(null);

  const inputs = useMemo(
    () => valuesText.split('\n').map((l) => l.trim()).filter(Boolean),
    [valuesText],
  );

  const options = useMemo(() => {
    const o: Record<string, unknown> = {};
    if (fn === 'classify') o.labels = labels.split(',').map((x) => x.trim()).filter(Boolean);
    if (fn === 'translate') o.targetLang = targetLang.trim();
    return o;
  }, [fn, labels, targetLang]);

  const run = useCallback(async () => {
    setError(null); setGateHint(null); setPairs(null);
    if (!inputs.length) { setError('Enter at least one sample value (one per line).'); return; }
    setRunning(true);
    try {
      const r = await clientFetch('/api/ai-functions/table', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fn, inputs, outputColumn: outCol.trim() || `ai_${fn}`, modelTier: tier, options }),
      });
      const j = await r.json();
      if (!j.ok) {
        setError(j.error || `HTTP ${r.status}`);
        if (j.gated || j.code === 'not_configured') setGateHint(j.hint || null);
        return;
      }
      const resultRows: Array<{ index: number; result: string }> = j.rows || [];
      setPairs(inputs.map((input, i) => ({ input, result: resultRows[i]?.result ?? '' })));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  }, [inputs, fn, outCol, tier, options]);

  const apply = useCallback(() => {
    if (!pairs) return;
    const src = sourceCol.trim() || columns[0] || 'value';
    const next = appendAiColumnStep(mScript, queryName, src, outCol.trim() || `ai_${fn}`, pairs);
    onApply(next);
    onOpenChange(false);
  }, [pairs, sourceCol, columns, mScript, queryName, outCol, fn, onApply, onOpenChange]);

  const activeMeta = AI_FN_META.find((m) => m.key === fn);

  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: '720px', width: '92vw' }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Sparkle20Regular /> AI column step
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.body}>
              <Caption1>
                Enrich sample values with an Azure OpenAI function, then add a Power Query step to
                <strong> {queryName || 'the active query'}</strong> that maps the source column to the result.
              </Caption1>
              <div className={s.row}>
                <Field label="Function" className={s.flex1}>
                  <Dropdown
                    value={activeMeta?.label || ''}
                    selectedOptions={[fn]}
                    onOptionSelect={(_, d) => { if (d.optionValue) { setFn(d.optionValue as AiFnKey); setOutCol(`ai_${d.optionValue}`); setPairs(null); } }}
                  >
                    {AI_FN_META.filter((m) => m.category === 'chat').map((m) => (
                      <Option key={m.key} value={m.key} text={m.label}>{m.label} — {m.desc}</Option>
                    ))}
                  </Dropdown>
                </Field>
                <Field label="Source column" className={s.flex1}>
                  {columns.length ? (
                    <Dropdown value={sourceCol} selectedOptions={sourceCol ? [sourceCol] : []} onOptionSelect={(_, d) => { if (d.optionValue) setSourceCol(d.optionValue); }}>
                      {columns.map((c) => <Option key={c} value={c} text={c}>{c}</Option>)}
                    </Dropdown>
                  ) : (
                    <Input value={sourceCol} placeholder="column name" onChange={(_, d) => setSourceCol(d.value)} />
                  )}
                </Field>
              </div>
              <div className={s.row}>
                <Field label="Output column" className={s.flex1}>
                  <Input value={outCol} onChange={(_, d) => { setOutCol(d.value); setPairs(null); }} />
                </Field>
                <Field label="Model tier" className={s.flex1}>
                  <Dropdown value={tier} selectedOptions={[tier]} onOptionSelect={(_, d) => { if (d.optionValue) { setTier(d.optionValue as any); setPairs(null); } }}>
                    <Option value="mini" text="mini">mini</Option>
                    <Option value="standard" text="standard">standard</Option>
                    <Option value="strong" text="strong">strong</Option>
                  </Dropdown>
                </Field>
              </div>
              {fn === 'classify' && (
                <Field label="Labels" hint="Comma-separated"><Input value={labels} onChange={(_, d) => { setLabels(d.value); setPairs(null); }} /></Field>
              )}
              {fn === 'translate' && (
                <Field label="Target language"><Input value={targetLang} onChange={(_, d) => { setTargetLang(d.value); setPairs(null); }} /></Field>
              )}
              <Field label="Sample values" hint="One per line — the values from the source column to enrich now">
                <Textarea value={valuesText} onChange={(_, d) => { setValuesText(d.value); setPairs(null); }} rows={5} resize="vertical" placeholder={'first value\nsecond value\n…'} />
              </Field>

              {error && (
                <MessageBar intent={gateHint ? 'warning' : 'error'}>
                  <MessageBarBody className={s.breakText}>{error}{gateHint ? <><br />{gateHint}</> : null}</MessageBarBody>
                </MessageBar>
              )}
              {pairs && (
                <MessageBar intent="success">
                  <MessageBarBody className={s.breakText}>
                    <Badge appearance="tint" color="brand">Azure OpenAI</Badge> Enriched {pairs.length} value(s).
                    The step maps these values; unseen rows default to null on ADF until re-run.
                  </MessageBarBody>
                </MessageBar>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button appearance="outline" icon={running ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={running || !inputs.length} onClick={run}>
              {running ? 'Running…' : pairs ? 'Re-run' : 'Preview'}
            </Button>
            <Button appearance="primary" disabled={!pairs} onClick={apply}>Add step</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export default DataflowAiStepDialog;
