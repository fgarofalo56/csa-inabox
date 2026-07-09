'use client';

/**
 * WranglerAiTab — the Data Wrangler "AI assist" surface (FGC-16), a 1:1 of
 * Microsoft Fabric's Data Wrangler AI capabilities on Azure OpenAI:
 *   https://learn.microsoft.com/fabric/data-science/data-wrangler-ai
 *
 * Three real-backed sections, all Azure-native (no Fabric / Power BI):
 *   1. Cleaning suggestions — rule-based (from REAL column profiles: nulls /
 *      distinct / dtype / whitespace / duplicates) + optional AOAI-proposed
 *      steps, each APPLIED by appending a structured gallery operation to the
 *      recipe (executed for real by the pandas host — never freeform code).
 *   2. AI function on a column — apply summarize / classify / sentiment /
 *      extract / translate over the sampled column values via the merged
 *      ai-function BFF batch endpoint (real Azure OpenAI, bounded concurrency),
 *      preview the enriched column, and insert the equivalent runnable pandas
 *      cell (the `ai_functions` package).
 *   3. Describe a change — natural language → an ordered list of gallery
 *      operations via AOAI (notebook persona), previewed live on the sampled
 *      rows through the same real host before apply.
 *
 * Every control calls a real backend or honest-gates with a Fluent MessageBar
 * naming the exact env var (no-vaporware). Freeform text appears only as the
 * NL prompt and per-function options — never as raw item config.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Badge, Body1, Button, Caption1, Subtitle2, Field, Input, Textarea, Dropdown, Option, Switch,
  Spinner, Divider, Card,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Lightbulb20Regular, Sparkle20Regular, WandRegular, Add16Regular, Code16Regular,
  CheckmarkCircle16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { ColSummary, WranglerStep, WranglerSuggestion } from '@/lib/notebook/wrangler-ai';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, overflowY: 'auto', paddingRight: tokens.spacingHorizontalXS },
  section: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL, borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow4,
  },
  head: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorBrandForeground1 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  cards: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sugCard: {
    display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, alignItems: 'flex-start',
    padding: tokens.spacingVerticalM, borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1,
  },
  sugText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  sugTitle: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  resultWrap: { maxHeight: '260px', overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium },
  cell: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, maxWidth: '360px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  stepList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  stepPill: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3,
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
  },
});

/** The 5 AI functions with a real `ai_functions` pandas method (for insert-to-cell). */
type ColumnFn = 'summarize' | 'classify' | 'sentiment' | 'extract' | 'translate';
const COLUMN_FNS: Array<{ fn: ColumnFn; label: string; opt?: 'labels' | 'fields' | 'targetLang' }> = [
  { fn: 'summarize', label: 'Summarize' },
  { fn: 'classify', label: 'Classify', opt: 'labels' },
  { fn: 'sentiment', label: 'Sentiment' },
  { fn: 'extract', label: 'Extract fields', opt: 'fields' },
  { fn: 'translate', label: 'Translate', opt: 'targetLang' },
];

const CATEGORY_COLOR: Record<string, 'brand' | 'success' | 'warning' | 'informative' | 'danger'> = {
  Missing: 'warning', Schema: 'brand', Text: 'informative', Rows: 'success', Numeric: 'brand',
};

export interface WranglerAiTabProps {
  notebookId: string;
  itemType?: string;
  itemId?: string;
  profile: { columns: string[]; rows: Record<string, unknown>[]; summary: ColSummary[]; rowCount: number };
  onAddSteps: (steps: WranglerStep[]) => void;
  onInsertCell: (source: string, lang: 'python' | 'pyspark') => void;
}

interface BatchRow { index: number; input: string; result: string; error?: string }

export function WranglerAiTab({ notebookId, itemType, itemId, profile, onAddSteps, onInsertCell }: WranglerAiTabProps) {
  const s = useStyles();
  const aiBase = `/api/notebook/${encodeURIComponent(notebookId)}/wrangler-ai`;
  const canRunFns = !!(itemType && itemId && itemId !== 'new');

  // ── 1. Suggestions ──
  const [useAi, setUseAi] = useState(true);
  const [sugLoading, setSugLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<WranglerSuggestion[] | null>(null);
  const [sugGate, setSugGate] = useState<string | null>(null);
  const [sugError, setSugError] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());

  const getSuggestions = useCallback(async () => {
    setSugLoading(true); setSugError(null); setSugGate(null);
    try {
      const r = await clientFetch(aiBase, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'suggest', columns: profile.columns, rows: profile.rows, summary: profile.summary, rowCount: profile.rowCount, useAi }),
      });
      const j = await r.json();
      if (!j.ok) { setSugError(j.error || `HTTP ${r.status}`); return; }
      setSuggestions(j.suggestions || []);
      setSugGate(j.aiGate || null);
    } catch (e: any) { setSugError(e?.message || String(e)); }
    finally { setSugLoading(false); }
  }, [aiBase, profile, useAi]);

  const applySuggestion = useCallback((sug: WranglerSuggestion) => {
    onAddSteps([sug.step]);
    setAppliedIds((prev) => new Set(prev).add(sug.id));
  }, [onAddSteps]);

  const applyAll = useCallback(() => {
    if (!suggestions?.length) return;
    onAddSteps(suggestions.map((x) => x.step));
    setAppliedIds(new Set(suggestions.map((x) => x.id)));
  }, [suggestions, onAddSteps]);

  // ── 2. AI function on a column ──
  const [fnCol, setFnCol] = useState<string>(profile.columns[0] ?? '');
  const [fn, setFn] = useState<ColumnFn>('summarize');
  const [fnOpt, setFnOpt] = useState('');
  const [fnLoading, setFnLoading] = useState(false);
  const [fnRows, setFnRows] = useState<BatchRow[] | null>(null);
  const [fnGate, setFnGate] = useState<string | null>(null);
  const [fnError, setFnError] = useState<string | null>(null);
  const activeFn = useMemo(() => COLUMN_FNS.find((f) => f.fn === fn)!, [fn]);

  const runColumnFn = useCallback(async () => {
    if (!canRunFns) return;
    setFnLoading(true); setFnError(null); setFnGate(null); setFnRows(null);
    const inputs = profile.rows.map((row) => {
      const v = row?.[fnCol];
      return v === null || v === undefined ? '' : String(v);
    });
    const options: Record<string, unknown> = {};
    if (activeFn.opt === 'labels' && fnOpt.trim()) options.labels = fnOpt.split(',').map((x) => x.trim()).filter(Boolean);
    if (activeFn.opt === 'fields' && fnOpt.trim()) options.fields = fnOpt.split(',').map((x) => x.trim()).filter(Boolean);
    if (activeFn.opt === 'targetLang' && fnOpt.trim()) options.targetLang = fnOpt.trim();
    try {
      const r = await clientFetch(`/api/items/${encodeURIComponent(itemType!)}/${encodeURIComponent(itemId!)}/ai-function`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fn, column: fnCol, inputs, options }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.gated || r.status === 501) setFnGate(j.hint || j.error || 'Azure OpenAI is not configured for this deployment.');
        else setFnError(j.error || `HTTP ${r.status}`);
        return;
      }
      setFnRows(j.rows || []);
    } catch (e: any) { setFnError(e?.message || String(e)); }
    finally { setFnLoading(false); }
  }, [canRunFns, profile.rows, fnCol, fn, fnOpt, activeFn, itemType, itemId]);

  const insertFnCell = useCallback(() => {
    const newCol = `${fnCol}_${fn}`;
    const args: string[] = [`df[${JSON.stringify(fnCol)}]`];
    if (activeFn.opt === 'labels' && fnOpt.trim()) args.push(`labels=[${fnOpt.split(',').map((x) => JSON.stringify(x.trim())).filter((x) => x !== '""').join(', ')}]`);
    if (activeFn.opt === 'fields' && fnOpt.trim()) args.push(`fields=[${fnOpt.split(',').map((x) => JSON.stringify(x.trim())).filter((x) => x !== '""').join(', ')}]`);
    if (activeFn.opt === 'targetLang' && fnOpt.trim()) args.push(`target_lang=${JSON.stringify(fnOpt.trim())}`);
    const code = [
      '# AI function applied per-column via the loom ai_functions package (Azure OpenAI).',
      '# Runs on your FULL DataFrame; the panel preview ran on the sample only.',
      'import ai_functions as ai',
      `df[${JSON.stringify(newCol)}] = ai.${fn}(${args.join(', ')})`,
      `df[[${JSON.stringify(fnCol)}, ${JSON.stringify(newCol)}]].head()`,
    ].join('\n');
    onInsertCell(code, 'python');
  }, [fnCol, fn, fnOpt, activeFn, onInsertCell]);

  // ── 3. Describe a change (NL → gallery steps) ──
  const [prompt, setPrompt] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [genSteps, setGenSteps] = useState<WranglerStep[] | null>(null);
  const [genExplain, setGenExplain] = useState('');
  const [genRejected, setGenRejected] = useState<Array<{ reason: string }>>([]);
  const [genGate, setGenGate] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    if (!prompt.trim()) return;
    setGenLoading(true); setGenError(null); setGenGate(null); setGenSteps(null); setGenExplain(''); setGenRejected([]);
    try {
      const r = await clientFetch(aiBase, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'codegen', prompt, columns: profile.columns, rows: profile.rows, summary: profile.summary }),
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.code === 'no_aoai' || r.status === 503) setGenGate(j.hint || j.error || 'Azure OpenAI is not configured.');
        else setGenError(j.error || `HTTP ${r.status}`);
        return;
      }
      setGenSteps(j.steps || []);
      setGenExplain(j.explanation || '');
      setGenRejected(Array.isArray(j.rejected) ? j.rejected : []);
    } catch (e: any) { setGenError(e?.message || String(e)); }
    finally { setGenLoading(false); }
  }, [aiBase, prompt, profile]);

  const applyGenerated = useCallback(() => {
    if (genSteps?.length) { onAddSteps(genSteps); setGenSteps(null); setGenExplain(''); }
  }, [genSteps, onAddSteps]);

  const stepLabel = (step: WranglerStep) => {
    const params = Object.entries(step).filter(([k]) => k !== 'op').map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(',')}]` : String(v)}`).join(' ');
    return `${step.op}${params ? ` · ${params}` : ''}`;
  };

  return (
    <div className={s.root}>
      {/* 1. Suggestions */}
      <Card className={s.section}>
        <div className={s.head}><Lightbulb20Regular /><Subtitle2>Cleaning suggestions</Subtitle2></div>
        <Body1 className={s.muted}>
          Rule-based suggestions from the live column profile (nulls, types, whitespace, duplicates), optionally augmented by Azure OpenAI. Each suggestion applies a real gallery operation to your recipe.
        </Body1>
        <div className={s.row}>
          <Switch label="Include AI-proposed steps" checked={useAi} onChange={(_e, d) => setUseAi(!!d.checked)} />
          <Button appearance="primary" icon={<Sparkle20Regular />} disabled={sugLoading} onClick={getSuggestions}>
            {sugLoading ? 'Analyzing…' : 'Get suggestions'}
          </Button>
          {suggestions && suggestions.length > 0 && (
            <Button appearance="secondary" icon={<Add16Regular />} onClick={applyAll}>Apply all ({suggestions.length})</Button>
          )}
          {sugLoading && <Spinner size="tiny" />}
        </div>
        {sugGate && <MessageBar intent="info"><MessageBarBody>{sugGate}</MessageBarBody></MessageBar>}
        {sugError && <MessageBar intent="error"><MessageBarBody>{sugError}</MessageBarBody></MessageBar>}
        {suggestions && suggestions.length === 0 && !sugLoading && (
          <Caption1 className={s.muted}>No cleaning issues detected in the current sample — your data looks tidy.</Caption1>
        )}
        {suggestions && suggestions.length > 0 && (
          <div className={s.cards}>
            {suggestions.map((sug) => {
              const applied = appliedIds.has(sug.id);
              return (
                <div key={sug.id} className={s.sugCard}>
                  <div className={s.sugText}>
                    <span className={s.sugTitle}>
                      <Body1><strong>{sug.title}</strong></Body1>
                      <Badge appearance="tint" color={CATEGORY_COLOR[sug.category] || 'brand'} size="small">{sug.category}</Badge>
                      {sug.source === 'ai' && <Badge appearance="tint" color="brand" size="small" icon={<Sparkle20Regular />}>AI</Badge>}
                    </span>
                    <Caption1 className={s.muted}>{sug.rationale}</Caption1>
                    <span className={s.stepPill} style={{ alignSelf: 'flex-start' }}>{stepLabel(sug.step)}</span>
                  </div>
                  <Button
                    size="small"
                    appearance={applied ? 'subtle' : 'primary'}
                    icon={applied ? <CheckmarkCircle16Regular /> : <Add16Regular />}
                    disabled={applied}
                    onClick={() => applySuggestion(sug)}
                  >
                    {applied ? 'Applied' : 'Apply'}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 2. AI function on a column */}
      <Card className={s.section}>
        <div className={s.head}><Sparkle20Regular /><Subtitle2>AI function on a column</Subtitle2></div>
        <Body1 className={s.muted}>
          Enrich a column with Azure OpenAI (summarize, classify, sentiment, extract, translate). Runs on the sampled rows for preview; insert a cell to apply on the full DataFrame.
        </Body1>
        {!canRunFns && (
          <MessageBar intent="info">
            <MessageBarBody>
              <MessageBarTitle>Save the notebook first</MessageBarTitle>
              Per-column AI functions run against this notebook item&apos;s AI-function endpoint. Save the notebook (so it has an id), then reopen Data Wrangler.
            </MessageBarBody>
          </MessageBar>
        )}
        <div className={s.row}>
          <Field label="Column">
            <Dropdown value={fnCol} selectedOptions={[fnCol]} onOptionSelect={(_e, d) => setFnCol(d.optionValue || '')} disabled={!canRunFns}>
              {profile.columns.map((c) => <Option key={c} value={c}>{c}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Function">
            <Dropdown
              value={activeFn.label}
              selectedOptions={[fn]}
              onOptionSelect={(_e, d) => { setFn((d.optionValue as ColumnFn) || 'summarize'); setFnOpt(''); }}
              disabled={!canRunFns}
            >
              {COLUMN_FNS.map((f) => <Option key={f.fn} value={f.fn}>{f.label}</Option>)}
            </Dropdown>
          </Field>
          {activeFn.opt && (
            <Field label={activeFn.opt === 'labels' ? 'Labels (comma)' : activeFn.opt === 'fields' ? 'Fields (comma)' : 'Target language'}>
              <Input value={fnOpt} onChange={(_e, d) => setFnOpt(d.value)} disabled={!canRunFns}
                placeholder={activeFn.opt === 'labels' ? 'positive, negative, neutral' : activeFn.opt === 'fields' ? 'name, city' : 'Spanish'} />
            </Field>
          )}
          <Button appearance="primary" icon={<Sparkle20Regular />} disabled={!canRunFns || fnLoading || !fnCol} onClick={runColumnFn}>
            {fnLoading ? 'Running…' : 'Run on sample'}
          </Button>
          {fnRows && fnRows.length > 0 && (
            <Button appearance="secondary" icon={<Code16Regular />} onClick={insertFnCell}>Insert as cell</Button>
          )}
          {fnLoading && <Spinner size="tiny" />}
        </div>
        {fnGate && (
          <MessageBar intent="warning">
            <MessageBarBody><MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>{fnGate}</MessageBarBody>
          </MessageBar>
        )}
        {fnError && <MessageBar intent="error"><MessageBarBody>{fnError}</MessageBarBody></MessageBar>}
        {fnRows && fnRows.length > 0 && (
          <div className={s.resultWrap}>
            <Table size="extra-small" aria-label="AI function results">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{fnCol}</TableHeaderCell>
                  <TableHeaderCell>{fnCol}_{fn}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fnRows.map((r) => (
                  <TableRow key={r.index}>
                    <TableCell><span className={s.cell}>{r.input || '—'}</span></TableCell>
                    <TableCell><span className={s.cell} style={r.error ? { color: tokens.colorPaletteRedForeground1 } : undefined}>{r.error ? `error: ${r.error}` : (r.result || '—')}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* 3. Describe a change */}
      <Card className={s.section}>
        <div className={s.head}><WandRegular /><Subtitle2>Describe a change</Subtitle2></div>
        <Body1 className={s.muted}>
          Describe the transform in plain language. Azure OpenAI maps it to gallery operations, which preview live on the sample before you apply — the generated pandas/PySpark can then be inserted as a cell.
        </Body1>
        <Field label="What should change?">
          <Textarea value={prompt} onChange={(_e, d) => setPrompt(d.value)} rows={2}
            placeholder="e.g. drop rows where Age is missing, then title-case the Name column" resize="vertical" />
        </Field>
        <div className={s.row}>
          <Button appearance="primary" icon={<WandRegular />} disabled={genLoading || !prompt.trim()} onClick={generate}>
            {genLoading ? 'Generating…' : 'Generate steps'}
          </Button>
          {genSteps && genSteps.length > 0 && (
            <Button appearance="secondary" icon={<Add16Regular />} onClick={applyGenerated}>Apply {genSteps.length} step{genSteps.length === 1 ? '' : 's'} to recipe</Button>
          )}
          {genLoading && <Spinner size="tiny" />}
        </div>
        {genGate && (
          <MessageBar intent="warning">
            <MessageBarBody><MessageBarTitle>Azure OpenAI not configured</MessageBarTitle>{genGate}</MessageBarBody>
          </MessageBar>
        )}
        {genError && <MessageBar intent="error"><MessageBarBody>{genError}</MessageBarBody></MessageBar>}
        {genExplain && <Caption1 className={s.muted}>{genExplain}</Caption1>}
        {genSteps && genSteps.length > 0 && (
          <div className={s.stepList}>
            {genSteps.map((step, i) => (
              <span key={i} className={s.stepPill}>{i + 1}. {stepLabel(step)}</span>
            ))}
            <Caption1 className={s.muted}>Applying appends these to your recipe; the preview grid updates live, and Insert pandas / PySpark cell exports the generated code.</Caption1>
          </div>
        )}
        {genSteps && genSteps.length === 0 && !genLoading && !genGate && !genError && (
          <Caption1 className={s.muted}>No gallery operation matches that request. Try rephrasing, or use the operation gallery directly.</Caption1>
        )}
        {genRejected.length > 0 && (
          <Caption1 className={s.muted}>{genRejected.length} proposed step(s) were skipped as invalid ({genRejected.map((x) => x.reason).filter(Boolean).slice(0, 2).join('; ')}).</Caption1>
        )}
      </Card>
      <Divider />
      <Caption1 className={s.muted}>
        All AI features use your Azure OpenAI deployment — no Microsoft Fabric or Power BI dependency.
      </Caption1>
    </div>
  );
}
