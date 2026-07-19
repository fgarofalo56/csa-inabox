'use client';

/**
 * Analysis Board editor (Foundry-parity row 3.1 — Contour). A board is a data
 * SOURCE + an ordered list of typed transform steps; the editor compiles the
 * board to KQL (client preview via compileBoardToKql) and runs it against ADX
 * via /api/items/analysis-board/[id]/run, showing a live results grid.
 *
 * Fluent v9 + Loom tokens. Backend is real (kusto-client); honest ADX gate.
 * No Fabric — Azure Data Explorer. UI-render E2E pending browser-tool recovery;
 * the compiler (16 tests) + run route are the verified backend.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Subtitle2, Body1, Caption1, Button, Input, Dropdown, Option, Field, Badge, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Textarea, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Add20Regular, Play20Regular, Dismiss16Regular, ArrowUp16Regular, ArrowDown16Regular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import type { FabricItemType } from '@/lib/catalog/fabric-item-types';
import {
  normalizeBoard, compileBoardToKql, BOARD_STEP_TYPES, BOARD_STEP_LABELS,
  FILTER_OPS, FILTER_OP_KQL, AGG_FNS,
  type AnalysisBoard, type BoardStep,
} from '../analysis-board-model';

const useStyles = makeStyles({
  wrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, padding: tokens.spacingVerticalL, minWidth: 0 },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, alignItems: 'flex-end', flexWrap: 'wrap' },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, padding: tokens.spacingVerticalM, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, boxShadow: tokens.shadow4 },
  stepHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  spacer: { flex: 1 },
  kql: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, whiteSpace: 'pre-wrap', color: tokens.colorNeutralForeground2 },
  grid: { overflowX: 'auto' },
});

function blankStep(type: BoardStep['type']): BoardStep {
  switch (type) {
    case 'filter': return { type, column: '', op: 'eq', value: '' };
    case 'select': return { type, columns: [] };
    case 'distinct': return { type, columns: [] };
    case 'derive': return { type, as: '', expr: '' };
    case 'aggregate': return { type, groupBy: [], aggregations: [{ fn: 'count', as: 'n' }] };
    case 'sort': return { type, column: '', direction: 'desc' };
    case 'limit': return { type, count: 100 };
  }
}

export function AnalysisBoardEditor({ id }: { item: FabricItemType; id: string }) {
  const s = useStyles();
  const [board, setBoard] = useState<AnalysisBoard>({ source: { kind: 'table', table: '' }, steps: [] });
  const [addType, setAddType] = useState<BoardStep['type']>('filter');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][]; rowCount: number; executionMs: number } | null>(null);
  const [runMsg, setRunMsg] = useState<{ intent: 'error' | 'warning' | 'success'; text: string } | null>(null);

  // Load persisted board.
  useEffect(() => {
    if (!id || id === 'new') return;
    void (async () => {
      try {
        const r = await clientFetch(`/api/cosmos-items/analysis-board/${encodeURIComponent(id)}`);
        const j = await r.json().catch(() => ({}));
        if (j?.state?.board) setBoard(normalizeBoard(j.state.board));
      } catch { /* keep default */ }
    })();
  }, [id]);

  const compiled = useMemo(() => compileBoardToKql(board), [board]);

  const patch = useCallback((next: AnalysisBoard) => setBoard(next), []);
  const setStep = (i: number, step: BoardStep) => patch({ ...board, steps: board.steps.map((x, xi) => (xi === i ? step : x)) });
  const removeStep = (i: number) => patch({ ...board, steps: board.steps.filter((_, xi) => xi !== i) });
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= board.steps.length) return;
    const steps = [...board.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    patch({ ...board, steps });
  };

  const save = useCallback(async () => {
    if (!id || id === 'new') return;
    setBusy(true); setSaved(null);
    try {
      const r = await clientFetch(`/api/items/analysis-board/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: { board } }),
      });
      setSaved(r.ok ? 'Saved.' : 'Save failed.');
    } catch { setSaved('Save failed.'); } finally { setBusy(false); }
  }, [id, board]);

  const run = useCallback(async () => {
    setBusy(true); setRunMsg(null); setResult(null);
    if (!compiled.ok) { setRunMsg({ intent: 'error', text: compiled.error }); setBusy(false); return; }
    try {
      const r = await clientFetch(`/api/items/analysis-board/${encodeURIComponent(id)}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ board }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok) { setRunMsg({ intent: r.status === 503 ? 'warning' : 'error', text: `${j?.error || `HTTP ${r.status}`}${j?.gate?.remediation ? ' — ' + j.gate.remediation : ''}` }); return; }
      setResult({ columns: j.columns || [], rows: j.rows || [], rowCount: j.rowCount || 0, executionMs: j.executionMs || 0 });
      setRunMsg({ intent: 'success', text: `${j.rowCount} row(s) in ${j.executionMs} ms.` });
    } catch (e: any) { setRunMsg({ intent: 'error', text: e?.message || String(e) }); } finally { setBusy(false); }
  }, [id, board, compiled]);

  return (
    <div className={s.wrap}>
      <div className={s.row}>
        <Subtitle2>Analysis board</Subtitle2>
        <Badge appearance="tint" color="brand">Contour-parity</Badge>
        <span className={s.spacer} />
        <Button onClick={save} disabled={busy}>Save</Button>
        <Button appearance="primary" icon={busy ? <Spinner size="tiny" /> : <Play20Regular />} onClick={run} disabled={busy}>Run</Button>
        {saved && <Caption1>{saved}</Caption1>}
      </div>
      <Body1>Compose a point-and-click analysis over Azure Data Explorer — each step is a real query operator. No Microsoft Fabric.</Body1>

      {/* Source */}
      <div className={s.card}>
        <Subtitle2>Source</Subtitle2>
        <div className={s.row}>
          <Field label="Kind">
            <Dropdown value={board.source.kind === 'table' ? 'Table' : 'Query'} selectedOptions={[board.source.kind]} onOptionSelect={(_, d) => patch({ ...board, source: d.optionValue === 'query' ? { kind: 'query', query: board.source.query || '' } : { kind: 'table', table: board.source.table || '' } })}>
              <Option value="table">Table</Option>
              <Option value="query">Base query</Option>
            </Dropdown>
          </Field>
          {board.source.kind === 'table' ? (
            <Field label="Table" hint="An ADX table name.">
              <Input value={board.source.table || ''} onChange={(_, d) => patch({ ...board, source: { kind: 'table', table: d.value } })} placeholder="Events" />
            </Field>
          ) : (
            <Field label="Base query" hint="A KQL expression the steps append onto.">
              <Textarea value={board.source.query || ''} onChange={(_, d) => patch({ ...board, source: { kind: 'query', query: d.value } })} placeholder="Events | where Timestamp > ago(1d)" />
            </Field>
          )}
        </div>
      </div>

      {/* Steps */}
      <div className={s.row}>
        <Field label="Add step">
          <Dropdown value={BOARD_STEP_LABELS[addType]} selectedOptions={[addType]} onOptionSelect={(_, d) => setAddType((d.optionValue as BoardStep['type']) || 'filter')}>
            {BOARD_STEP_TYPES.map((t) => <Option key={t} value={t}>{BOARD_STEP_LABELS[t]}</Option>)}
          </Dropdown>
        </Field>
        <Button icon={<Add20Regular />} onClick={() => patch({ ...board, steps: [...board.steps, blankStep(addType)] })}>Add</Button>
      </div>

      {board.steps.map((step, i) => (
        <div key={i} className={s.card}>
          <div className={s.stepHead}>
            <Badge appearance="tint">{i + 1}</Badge>
            <Subtitle2>{BOARD_STEP_LABELS[step.type]}</Subtitle2>
            <span className={s.spacer} />
            <Button size="small" appearance="subtle" icon={<ArrowUp16Regular />} aria-label="Move up" onClick={() => moveStep(i, -1)} />
            <Button size="small" appearance="subtle" icon={<ArrowDown16Regular />} aria-label="Move down" onClick={() => moveStep(i, 1)} />
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} aria-label="Remove step" onClick={() => removeStep(i)} />
          </div>
          <StepFields step={step} onChange={(st) => setStep(i, st)} />
        </div>
      ))}

      {/* Compiled KQL preview */}
      <div className={s.card}>
        <Subtitle2>Compiled KQL</Subtitle2>
        {compiled.ok ? <div className={s.kql}>{compiled.kql}</div> : <MessageBar intent="error"><MessageBarBody>{compiled.error}</MessageBarBody></MessageBar>}
      </div>

      {runMsg && <MessageBar intent={runMsg.intent}><MessageBarBody>{runMsg.intent === 'warning' ? <MessageBarTitle>ADX not configured</MessageBarTitle> : null}{runMsg.text}</MessageBarBody></MessageBar>}

      {/* Results */}
      {result && result.columns.length > 0 && (
        <div className={`${s.card} ${s.grid}`}>
          <Subtitle2>Results — {result.rowCount} row(s)</Subtitle2>
          <Table size="small" aria-label="Board results">
            <TableHeader><TableRow>{result.columns.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
            <TableBody>
              {result.rows.slice(0, 200).map((row, ri) => (
                <TableRow key={ri}>{result.columns.map((_, ci) => <TableCell key={ci}>{String((row as unknown[])[ci] ?? '')}</TableCell>)}</TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function StepFields({ step, onChange }: { step: BoardStep; onChange: (s: BoardStep) => void }) {
  const s = useStyles();
  const csv = (arr: string[]) => arr.join(', ');
  const parseCsv = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  switch (step.type) {
    case 'filter':
      return (
        <div className={s.row}>
          <Field label="Column"><Input value={step.column} onChange={(_, d) => onChange({ ...step, column: d.value })} placeholder="region" /></Field>
          <Field label="Operator">
            <Dropdown value={FILTER_OP_KQL[step.op]} selectedOptions={[step.op]} onOptionSelect={(_, d) => onChange({ ...step, op: (d.optionValue as typeof step.op) })}>
              {FILTER_OPS.map((op) => <Option key={op} value={op}>{FILTER_OP_KQL[op]}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Value" hint={step.op === 'in' ? 'comma-separated' : undefined}><Input value={step.value} onChange={(_, d) => onChange({ ...step, value: d.value })} /></Field>
        </div>
      );
    case 'select':
    case 'distinct':
      return <Field label="Columns" hint="comma-separated"><Input value={csv(step.columns)} onChange={(_, d) => onChange({ ...step, columns: parseCsv(d.value) })} placeholder="a, b, c" /></Field>;
    case 'derive':
      return (
        <div className={s.row}>
          <Field label="New column"><Input value={step.as} onChange={(_, d) => onChange({ ...step, as: d.value })} placeholder="net" /></Field>
          <Field label="Expression" hint="arithmetic over columns"><Input value={step.expr} onChange={(_, d) => onChange({ ...step, expr: d.value })} placeholder="amount - fee" /></Field>
        </div>
      );
    case 'aggregate':
      return (
        <div className={s.row}>
          <Field label="Group by" hint="comma-separated"><Input value={csv(step.groupBy)} onChange={(_, d) => onChange({ ...step, groupBy: parseCsv(d.value) })} placeholder="region" /></Field>
          <Field label="Function">
            <Dropdown value={step.aggregations[0]?.fn || 'count'} selectedOptions={[step.aggregations[0]?.fn || 'count']} onOptionSelect={(_, d) => onChange({ ...step, aggregations: [{ ...step.aggregations[0], fn: d.optionValue as typeof step.aggregations[0]['fn'] }] })}>
              {AGG_FNS.map((f) => <Option key={f} value={f}>{f}</Option>)}
            </Dropdown>
          </Field>
          {step.aggregations[0]?.fn !== 'count' && <Field label="Column"><Input value={step.aggregations[0]?.column || ''} onChange={(_, d) => onChange({ ...step, aggregations: [{ ...step.aggregations[0], column: d.value }] })} placeholder="amount" /></Field>}
          <Field label="As"><Input value={step.aggregations[0]?.as || ''} onChange={(_, d) => onChange({ ...step, aggregations: [{ ...step.aggregations[0], as: d.value }] })} placeholder="total" /></Field>
        </div>
      );
    case 'sort':
      return (
        <div className={s.row}>
          <Field label="Column"><Input value={step.column} onChange={(_, d) => onChange({ ...step, column: d.value })} placeholder="amount" /></Field>
          <Field label="Direction">
            <Dropdown value={step.direction} selectedOptions={[step.direction]} onOptionSelect={(_, d) => onChange({ ...step, direction: (d.optionValue as 'asc' | 'desc') })}>
              <Option value="desc">desc</Option><Option value="asc">asc</Option>
            </Dropdown>
          </Field>
        </div>
      );
    case 'limit':
      return <Field label="Rows"><Input type="number" value={String(step.count)} onChange={(_, d) => onChange({ ...step, count: Math.max(1, Math.floor(Number(d.value) || 1)) })} /></Field>;
  }
}
