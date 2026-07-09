'use client';

/**
 * DaxQueryView — the standalone DAX query view (FGC-21).
 *
 * A first-class, ad-hoc DAX pane independent of the measure editor (Power BI
 * "DAX query view" parity): a Monaco DAX editor, a right-click-style "quick
 * query" generator per table/column, a results grid, NL2DAX assist via the
 * existing DAX Copilot persona, and "Save as measure" that persists to the
 * Loom-native model store.
 *
 * Backend: POST /api/items/semantic-model/[id]/dax-query — evaluates against the
 * Azure-native tabular backend (Synapse serverless SQL by default; AAS XMLA when
 * opted in). NO Power BI / Fabric REST on the default path (no-fabric-dependency).
 *
 * web3-ui: Fluent v9 + Loom tokens only (no raw px/hex); an elevated intro card;
 * icons on actions. loom_no_freeform_config: the DAX editor is the sanctioned 1:1
 * query-surface exception (a real DAX query editor, not a JSON config blob).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  makeStyles, tokens, shorthands,
  Subtitle2, Body1, Caption1, Card, Field, Button, Input, Dropdown, Option, Spinner, Badge,
  MessageBar, MessageBarBody, MessageBarTitle, Divider,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, Textarea,
} from '@fluentui/react-components';
import {
  Play20Regular, Sparkle20Regular, Save20Regular, Add16Regular, Table20Regular,
} from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { clientFetch } from '@/lib/client-fetch';
import { daxQueryTemplate, looksLikeDaxQuery, type DaxTemplateKind } from '@/lib/semantic-model/semantic-link';

export interface DaxQueryViewTable {
  name: string;
  columns?: Array<{ name: string; dataType?: string }>;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', ...shorthands.gap(tokens.spacingVerticalL) },
  intro: {
    display: 'flex', flexDirection: 'column', ...shorthands.gap(tokens.spacingVerticalXS),
    ...shorthands.padding(tokens.spacingVerticalL),
    ...shorthands.borderRadius(tokens.borderRadiusXLarge),
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorNeutralBackground2})`,
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
  },
  quickRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', ...shorthands.gap(tokens.spacingHorizontalM) },
  actions: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', ...shorthands.gap(tokens.spacingHorizontalS) },
  resultWrap: {
    ...shorthands.overflow('auto'),
    ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    ...shorthands.borderRadius(tokens.borderRadiusMedium),
    maxHeight: '420px',
  },
  cell: { fontFamily: tokens.fontFamilyMonospace, whiteSpace: 'nowrap' },
  saveCard: { display: 'flex', flexDirection: 'column', ...shorthands.gap(tokens.spacingVerticalS), ...shorthands.padding(tokens.spacingVerticalM) },
  saveRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', ...shorthands.gap(tokens.spacingHorizontalM) },
});

const TEMPLATE_KINDS: Array<{ key: DaxTemplateKind; label: string; needsColumn: boolean }> = [
  { key: 'table-preview', label: 'Preview rows (TOPN)', needsColumn: false },
  { key: 'row-count', label: 'Row count', needsColumn: false },
  { key: 'column-distinct', label: 'Distinct values of column', needsColumn: true },
  { key: 'column-summary', label: 'Group by column + count', needsColumn: true },
];

interface RunResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  backend?: string;
  sql?: string;
}

/** Extract a scalar measure expression from `EVALUATE ROW("x", <expr>)`, else ''. */
function extractScalarExpression(dax: string): string {
  const m = /EVALUATE\s+ROW\s*\(\s*"[^"]*"\s*,\s*([\s\S]+)\)\s*$/i.exec(dax.trim());
  return m ? m[1].trim() : '';
}

export function DaxQueryView({ id, tables }: { id: string; tables: DaxQueryViewTable[] }) {
  const cs = useStyles();
  const [dax, setDax] = useState('EVALUATE\nTOPN(100, ');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [runErr, setRunErr] = useState<{ text: string; hint?: string } | null>(null);

  // Quick-query builder state.
  const [qTable, setQTable] = useState<string>(tables[0]?.name || '');
  const [qColumn, setQColumn] = useState<string>('');
  const [qKind, setQKind] = useState<DaxTemplateKind>('table-preview');
  const columnsForTable = useMemo(
    () => tables.find((t) => t.name === qTable)?.columns || [],
    [tables, qTable],
  );

  // NL2DAX assist (DAX Copilot persona — SSE stream, zero Power BI).
  const [nlPrompt, setNlPrompt] = useState('');
  const [nlBusy, setNlBusy] = useState(false);
  const [nlErr, setNlErr] = useState<string | null>(null);
  const [nlNote, setNlNote] = useState<string | null>(null);

  // Save-as-measure state.
  const [showSave, setShowSave] = useState(false);
  const [measureName, setMeasureName] = useState('');
  const [measureExpr, setMeasureExpr] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const insertTemplate = useCallback(() => {
    if (!qTable) return;
    const q = daxQueryTemplate(qKind, qTable, qColumn || undefined);
    setDax(q);
    setResult(null);
    setRunErr(null);
  }, [qKind, qTable, qColumn]);

  const run = useCallback(async () => {
    const q = dax.trim();
    if (!q) return;
    if (!looksLikeDaxQuery(q)) { setRunErr({ text: 'A DAX query must start with EVALUATE (or DEFINE … EVALUATE).' }); return; }
    setRunning(true); setResult(null); setRunErr(null); setSaveMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/dax-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'run', dax: q }),
      });
      const j = await r.json();
      if (!j.ok) { setRunErr({ text: j.error || `HTTP ${r.status}`, hint: j.hint }); return; }
      setResult({ columns: j.columns || [], rows: j.rows || [], backend: j.backend, sql: j.sql });
      // Pre-fill the save-as-measure expression from a scalar EVALUATE ROW query.
      const scalar = extractScalarExpression(q);
      if (scalar) setMeasureExpr(scalar);
    } catch (e: any) { setRunErr({ text: e?.message || String(e) }); }
    finally { setRunning(false); }
  }, [dax, id]);

  const askCopilot = useCallback(async () => {
    const p = nlPrompt.trim();
    if (!p) return;
    setNlBusy(true); setNlErr(null); setNlNote(null);
    try {
      // Streaming SSE — raw fetch is the sanctioned path for token streams.
      const res = await fetch('/api/copilot/dax', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `Write a DAX EVALUATE query: ${p}`, itemId: id, itemType: 'semantic-model' }),
      });
      if (!res.ok && !res.body) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep */ }
        setNlErr(msg); return;
      }
      const reader = res.body?.getReader();
      if (!reader) { setNlErr('No response stream.'); return; }
      const decoder = new TextDecoder();
      let buf = '';
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split('\n\n');
        buf = frames.pop() ?? '';
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let step: any;
          try { step = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (step.kind === 'error') setNlErr(step.error || 'DAX Copilot error');
          if (step.kind === 'tool_result' && step.name === 'dax_nl2measure' && step.result?.daxExpression) {
            const expr = String(step.result.daxExpression).trim();
            setDax(/^\s*(EVALUATE|DEFINE)\b/i.test(expr) ? expr : `EVALUATE\nROW("Result", ${expr})`);
            setNlNote('Copilot inserted a query — review and run it.');
          }
          if (step.kind === 'final' && !step.result) { /* final text ignored */ }
        }
      }
    } catch (e: any) { setNlErr(e?.message || String(e)); }
    finally { setNlBusy(false); }
  }, [nlPrompt, id]);

  const saveMeasure = useCallback(async () => {
    const name = measureName.trim();
    const expression = measureExpr.trim();
    if (!name || !expression) { setSaveMsg({ ok: false, text: 'A measure needs a name and an expression.' }); return; }
    setSaveBusy(true); setSaveMsg(null);
    try {
      const r = await clientFetch(`/api/items/semantic-model/${encodeURIComponent(id)}/dax-query`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'save-measure', name, expression }),
      });
      const j = await r.json();
      if (!j.ok) { setSaveMsg({ ok: false, text: j.error || `HTTP ${r.status}` }); return; }
      setSaveMsg({ ok: true, text: j.note || `Saved measure [${name}].` });
    } catch (e: any) { setSaveMsg({ ok: false, text: e?.message || String(e) }); }
    finally { setSaveBusy(false); }
  }, [measureName, measureExpr, id]);

  const needsColumn = TEMPLATE_KINDS.find((k) => k.key === qKind)?.needsColumn;

  return (
    <div className={cs.root}>
      <div className={cs.intro}>
        <Subtitle2>DAX query view</Subtitle2>
        <Body1>
          Author and run ad-hoc DAX against this model. Queries evaluate on the Azure-native tabular
          backend (Synapse serverless SQL by default; Azure Analysis Services when opted in) — no Microsoft
          Fabric or Power BI workspace required. Generate a starter query for a table or column, ask the DAX
          Copilot in plain English, then pin a result as a measure.
        </Body1>
      </div>

      {/* Quick-query generator (right-click "New quick query" parity) */}
      <Card>
        <div className={cs.quickRow}>
          <Field label="Table">
            <Dropdown
              aria-label="Table for quick query"
              value={qTable}
              selectedOptions={qTable ? [qTable] : []}
              onOptionSelect={(_, d) => { setQTable(d.optionValue || ''); setQColumn(''); }}
            >
              {tables.map((t) => <Option key={t.name} value={t.name} text={t.name}>{t.name}</Option>)}
            </Dropdown>
          </Field>
          <Field label="Quick query">
            <Dropdown
              aria-label="Quick query kind"
              value={TEMPLATE_KINDS.find((k) => k.key === qKind)?.label || ''}
              selectedOptions={[qKind]}
              onOptionSelect={(_, d) => setQKind((d.optionValue as DaxTemplateKind) || 'table-preview')}
            >
              {TEMPLATE_KINDS.map((k) => <Option key={k.key} value={k.key} text={k.label}>{k.label}</Option>)}
            </Dropdown>
          </Field>
          {needsColumn && (
            <Field label="Column">
              <Dropdown
                aria-label="Column for quick query"
                value={qColumn}
                selectedOptions={qColumn ? [qColumn] : []}
                onOptionSelect={(_, d) => setQColumn(d.optionValue || '')}
              >
                {columnsForTable.map((c) => <Option key={c.name} value={c.name} text={c.name}>{c.name}</Option>)}
              </Dropdown>
            </Field>
          )}
          <Button icon={<Add16Regular />} appearance="secondary" onClick={insertTemplate} disabled={!qTable || (needsColumn && !qColumn)}>
            Insert query
          </Button>
        </div>
      </Card>

      {/* DAX editor + run */}
      <Field label="DAX query" hint="Starts with EVALUATE (or DEFINE … EVALUATE). Ctrl/⌘+Enter runs.">
        <div onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }}>
          <MonacoTextarea value={dax} onChange={setDax} language="dax" height={160} minHeight={120} ariaLabel="DAX query editor" />
        </div>
      </Field>
      <div className={cs.actions}>
        <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <Play20Regular />} disabled={running || !dax.trim()} onClick={run}>
          {running ? 'Running…' : 'Run'}
        </Button>
        {result && (
          <Button appearance="secondary" icon={<Save20Regular />} onClick={() => setShowSave((v) => !v)}>
            {showSave ? 'Hide save-as-measure' : 'Save as measure'}
          </Button>
        )}
      </div>

      {/* NL2DAX assist */}
      <Card>
        <Field label="Ask the DAX Copilot" hint="Plain English → a DAX query grounded in this model. Inserts into the editor above for you to review and run.">
          <div className={cs.saveRow}>
            <Textarea
              value={nlPrompt}
              onChange={(_, d) => setNlPrompt(d.value)}
              placeholder={'e.g. "total sales by year", "count of customers with more than 5 orders"'}
              resize="vertical"
              aria-label="Ask the DAX Copilot"
              style={{ flex: 1, minWidth: '260px' }}
            />
            <Button appearance="secondary" icon={nlBusy ? <Spinner size="tiny" /> : <Sparkle20Regular />} disabled={nlBusy || !nlPrompt.trim()} onClick={askCopilot}>
              {nlBusy ? 'Asking…' : 'Ask Copilot'}
            </Button>
          </div>
        </Field>
        {nlNote && <MessageBar intent="success"><MessageBarBody>{nlNote}</MessageBarBody></MessageBar>}
        {nlErr && <MessageBar intent="error"><MessageBarBody>{nlErr}</MessageBarBody></MessageBar>}
      </Card>

      {runErr && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Query could not run</MessageBarTitle>
            {runErr.text}{runErr.hint ? ` — ${runErr.hint}` : ''}
          </MessageBarBody>
        </MessageBar>
      )}

      {result && (
        <div>
          <Caption1>
            {result.rows.length} row(s){result.backend ? ` · backend: ${result.backend}` : ''}{result.sql ? ' · translated to SQL' : ''}
          </Caption1>
          <div className={cs.resultWrap}>
            <Table aria-label="DAX query result" size="small">
              <TableHeader>
                <TableRow>
                  {(result.columns.length ? result.columns : Object.keys(result.rows[0] || {})).map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}
                  {result.rows.length === 0 && <TableHeaderCell>result</TableHeaderCell>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.length === 0 && (
                  <TableRow><TableCell><Caption1>No rows returned.</Caption1></TableCell></TableRow>
                )}
                {result.rows.slice(0, 200).map((row, i) => (
                  <TableRow key={i}>
                    {(result.columns.length ? result.columns : Object.keys(result.rows[0] || {})).map((c) => (
                      <TableCell key={c} className={cs.cell}>{String((row as any)[c] ?? '')}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {showSave && (
        <>
          <Divider />
          <Card className={cs.saveCard}>
            <Subtitle2>Save a result as a measure</Subtitle2>
            <Caption1>Persists to this model (Azure-native, Cosmos) — usable in queries immediately. No Power BI / Fabric required.</Caption1>
            <div className={cs.saveRow}>
              <Field label="Measure name">
                <Input value={measureName} onChange={(_, d) => setMeasureName(d.value)} placeholder="Total Sales" />
              </Field>
            </div>
            <Field label="Measure expression (DAX)">
              <MonacoTextarea value={measureExpr} onChange={setMeasureExpr} language="dax" height={90} minHeight={70} ariaLabel="Measure expression" />
            </Field>
            <div className={cs.actions}>
              <Button appearance="primary" icon={saveBusy ? <Spinner size="tiny" /> : <Save20Regular />} disabled={saveBusy || !measureName.trim() || !measureExpr.trim()} onClick={saveMeasure}>
                {saveBusy ? 'Saving…' : 'Save measure'}
              </Button>
            </div>
            {saveMsg && <MessageBar intent={saveMsg.ok ? 'success' : 'error'}><MessageBarBody>{saveMsg.text}</MessageBarBody></MessageBar>}
          </Card>
        </>
      )}

      {tables.length === 0 && (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle><Table20Regular /> No tables yet</MessageBarTitle>
            Add tables to this model (Tables tab) to use the quick-query generator. You can still type any DAX query above.
          </MessageBarBody>
        </MessageBar>
      )}
    </div>
  );
}

export default DaxQueryView;
