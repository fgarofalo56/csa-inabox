'use client';

/**
 * AnomalyForecastDialog — native-KQL time-series anomaly detection + forecasting
 * over the Azure-native ADX cluster (no Fabric, no external ML service).
 *
 * Shared by the KQL Database editor (a table-level "Detect anomalies / Forecast"
 * action) and the Real-Time Dashboard editor (an anomaly/forecast tile builder).
 * The dialog is a structured builder — pick a table, its time + value columns,
 * an aggregation + bin, then either detect anomalies (threshold) or forecast
 * (horizon). It POSTs to /api/adx/anomaly, which composes pure KQL
 * (make-series → series_decompose_anomalies / series_decompose_forecast) and
 * runs it live via kusto-client. The real ADX result grid is rendered with the
 * repo's existing TimeSeriesChart (no new chart lib); an honest Fluent
 * MessageBar surfaces the 503 config gate / any query error.
 *
 * Web5: Fluent v9 + Loom tokens (see .claude/rules/web3-ui.md). No mocks
 * (.claude/rules/no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Caption1, Subtitle2, Badge, Button, Input, Select, Field, Spinner, Switch,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  MessageBar, MessageBarBody, MessageBarTitle,
  tokens,
} from '@fluentui/react-components';
import { Play20Regular, DataTrending20Regular, Warning16Regular } from '@fluentui/react-icons';
import { TimeSeriesChart } from '@/lib/components/adx/time-series-chart';
import { parseKustoSchema } from '@/lib/components/adx/column-grid-designer';

/** The KQL result grid the /api/adx/anomaly route returns for the chart. */
interface SeriesResult {
  ok: boolean;
  columns?: string[];
  columnTypes?: string[];
  rows?: unknown[][];
  rowCount?: number;
  executionMs?: number;
  error?: string;
}

interface AnomalyResponse {
  ok: boolean;
  mode?: 'anomaly' | 'forecast';
  database?: string;
  step?: string;
  threshold?: number;
  horizon?: number;
  anomalyCount?: number;
  pointCount?: number;
  kql?: string;
  result?: SeriesResult;
  error?: string;
  code?: string;
  missing?: string | string[];
}

type Mode = 'anomaly' | 'forecast';
type Aggregation = 'avg' | 'sum' | 'min' | 'max' | 'count';

const AGGREGATIONS: Aggregation[] = ['avg', 'sum', 'min', 'max', 'count'];
const STEP_CHOICES = ['1m', '5m', '15m', '1h', '6h', '12h', '1d', '7d'];
const NUMERIC_TYPES = /^(long|int|real|double|decimal)$/i;
const TIME_TYPES = /^(datetime|timestamp)$/i;

export interface AnomalyForecastDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** kql-database (or kql-dashboard) item id — passed as ?id= to the route. */
  itemId: string;
  /** Optional explicit database override (else the item-resolved DB is used). */
  database?: string;
  /** Tables to offer in the picker (from the live navigator / info.tables). */
  tables?: string[];
  /** Pre-selected table when opened from a table context. */
  defaultTable?: string;
  /** Which mode the dialog opens in. */
  defaultMode?: Mode;
  /**
   * When true (default) the dialog fetches the selected table's schema via
   * /api/adx/tables?id=<itemId> to populate typed column dropdowns. Set false
   * when the host item id does not resolve to the target KQL database (e.g. a
   * Real-Time Dashboard tile) — the column pickers then fall back to free-text
   * inputs validated against the real DB at run time.
   */
  fetchSchema?: boolean;
  /**
   * Optional: when the host wants to persist the built query (e.g. a dashboard
   * tile), this fires with the composed KQL + a suggested title on "Add as tile".
   */
  onAddTile?: (args: { kql: string; title: string; mode: Mode }) => void;
}

/** Subset a result grid to the named columns (keeps chart series clean). */
function subsetResult(res: SeriesResult, keep: string[]): SeriesResult {
  const cols = res.columns || [];
  const idxs = keep.map((k) => cols.indexOf(k)).filter((i) => i >= 0);
  return {
    ok: true,
    columns: idxs.map((i) => cols[i]),
    columnTypes: res.columnTypes ? idxs.map((i) => res.columnTypes![i]) : undefined,
    rows: (res.rows || []).map((row) => idxs.map((i) => row[i])),
  };
}

export function AnomalyForecastDialog({
  open, onOpenChange, itemId, database, tables = [], defaultTable, defaultMode = 'anomaly', fetchSchema = true, onAddTile,
}: AnomalyForecastDialogProps) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [table, setTable] = useState(defaultTable || '');
  const [columns, setColumns] = useState<Array<{ name: string; type: string }>>([]);
  const [colsLoading, setColsLoading] = useState(false);
  const [timeColumn, setTimeColumn] = useState('');
  const [valueColumn, setValueColumn] = useState('');
  const [aggregation, setAggregation] = useState<Aggregation>('avg');
  const [step, setStep] = useState('1h');
  const [threshold, setThreshold] = useState('1.5');
  const [horizon, setHorizon] = useState('24');
  const [running, setRunning] = useState(false);
  const [resp, setResp] = useState<AnomalyResponse | null>(null);

  // Reset the builder each time the dialog opens (honor the passed defaults).
  useEffect(() => {
    if (!open) return;
    setMode(defaultMode);
    setTable(defaultTable || '');
    setResp(null);
    setColumns([]);
    setTimeColumn(''); setValueColumn('');
    setAggregation('avg'); setStep('1h'); setThreshold('1.5'); setHorizon('24');
  }, [open, defaultTable, defaultMode]);

  // Load the selected table's schema → column pickers, auto-selecting a datetime
  // axis + a numeric measure (the real .show table cslschema via /api/adx/tables).
  const loadColumns = useCallback(async (tbl: string) => {
    if (!fetchSchema || !tbl || !itemId || itemId === 'new') { setColumns([]); return; }
    setColsLoading(true);
    try {
      const r = await fetch(`/api/adx/tables?id=${encodeURIComponent(itemId)}&schema=${encodeURIComponent(tbl)}`);
      const j = await r.json().catch(() => ({}));
      const cols = j?.ok && j.cslSchema ? parseKustoSchema(j.cslSchema) : [];
      setColumns(cols);
      const timeCol = cols.find((c: { type: string }) => TIME_TYPES.test(c.type)) || cols[0];
      const valCol = cols.find((c: { name: string; type: string }) => NUMERIC_TYPES.test(c.type) && c.name !== timeCol?.name) || cols.find((c: { type: string }) => NUMERIC_TYPES.test(c.type));
      setTimeColumn(timeCol?.name || '');
      setValueColumn(valCol?.name || '');
    } catch {
      setColumns([]);
    } finally {
      setColsLoading(false);
    }
  }, [itemId, fetchSchema]);

  useEffect(() => { if (open && table) loadColumns(table); }, [open, table, loadColumns]);

  const run = useCallback(async () => {
    setRunning(true); setResp(null);
    try {
      const r = await fetch(`/api/adx/anomaly?id=${encodeURIComponent(itemId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          database,
          table,
          timeColumn,
          valueColumn,
          aggregation,
          step,
          mode,
          threshold: Number(threshold),
          horizon: Number(horizon),
        }),
      });
      const j = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as AnomalyResponse;
      setResp(j);
    } catch (e: any) {
      setResp({ ok: false, error: e?.message || String(e) });
    } finally {
      setRunning(false);
    }
  }, [itemId, database, table, timeColumn, valueColumn, aggregation, step, mode, threshold, horizon]);

  const canRun = !!table && !!timeColumn && (aggregation === 'count' || !!valueColumn) && !running;

  // Chart-ready subset: value + baseline (anomaly) / value + forecast (forecast).
  const chartResult = useMemo(() => {
    if (!resp?.ok || !resp.result?.ok) return null;
    const keep = mode === 'anomaly'
      ? [timeColumn, 'value', 'baseline']
      : [timeColumn, 'value', 'forecast'];
    return subsetResult(resp.result, keep);
  }, [resp, mode, timeColumn]);

  // Flagged anomalies (is_anomaly = ±1) → a compact highlight table.
  const anomalyRows = useMemo(() => {
    if (mode !== 'anomaly' || !resp?.ok || !resp.result?.rows) return [];
    const cols = resp.result.columns || [];
    const tIdx = cols.indexOf(timeColumn);
    const vIdx = cols.indexOf('value');
    const sIdx = cols.indexOf('anomaly_score');
    const fIdx = cols.indexOf('is_anomaly');
    if (fIdx < 0) return [];
    return resp.result.rows
      .filter((row) => Number(row[fIdx]) !== 0)
      .slice(0, 100)
      .map((row) => ({
        time: String(row[tIdx] ?? ''),
        value: row[vIdx],
        score: row[sIdx],
        direction: Number(row[fIdx]) > 0 ? 'spike' : 'dip',
      }));
  }, [resp, mode, timeColumn]);

  const gateMissing = resp && !resp.ok && resp.code === 'not_configured'
    ? (Array.isArray(resp.missing) ? resp.missing.join(', ') : resp.missing)
    : null;

  return (
    <Dialog open={open} onOpenChange={(_: unknown, d: any) => onOpenChange(d.open)}>
      <DialogSurface style={{ maxWidth: 900 }}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <DataTrending20Regular />
              {mode === 'anomaly' ? 'Detect anomalies' : 'Forecast'} — time-series ML (KQL)
            </span>
          </DialogTitle>
          <DialogContent>
            <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM }}>
              <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
                Runs pure KQL over Azure Data Explorer —{' '}
                <code>{mode === 'anomaly' ? 'series_decompose_anomalies' : 'series_decompose_forecast'}</code>{' '}
                over a <code>make-series</code> of your table. No Fabric, no external ML service.
              </Caption1>

              {/* Mode toggle */}
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalXS }} role="tablist" aria-label="Analysis mode">
                <Button size="small" appearance={mode === 'anomaly' ? 'primary' : 'subtle'}
                  aria-pressed={mode === 'anomaly'} onClick={() => setMode('anomaly')}>Detect anomalies</Button>
                <Button size="small" appearance={mode === 'forecast' ? 'primary' : 'subtle'}
                  aria-pressed={mode === 'forecast'} onClick={() => setMode('forecast')}>Forecast</Button>
              </div>

              {/* Source + columns */}
              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' }}>
                <Field label="Table" style={{ flex: 1, minWidth: 180 }}>
                  {tables.length > 0 ? (
                    <Select value={table} onChange={(_: unknown, d: any) => setTable(d.value)} aria-label="Source table">
                      <option value="">— select a table —</option>
                      {tables.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  ) : (
                    <Input value={table} onChange={(_: unknown, d: any) => setTable(d.value)} placeholder="events" aria-label="Source table" />
                  )}
                </Field>
                <Field label="Aggregation" style={{ width: 120 }}>
                  <Select value={aggregation} onChange={(_: unknown, d: any) => setAggregation(d.value as Aggregation)} aria-label="Aggregation">
                    {AGGREGATIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </Select>
                </Field>
              </div>

              <div style={{ display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Field label="Time column" style={{ flex: 1, minWidth: 160 }}>
                  {columns.length > 0 ? (
                    <Select value={timeColumn} onChange={(_: unknown, d: any) => setTimeColumn(d.value)} aria-label="Time column">
                      {!columns.some((c) => c.name === timeColumn) && <option value="">— select —</option>}
                      {columns.map((c) => <option key={c.name} value={c.name}>{c.name} : {c.type}</option>)}
                    </Select>
                  ) : (
                    <Input value={timeColumn} onChange={(_: unknown, d: any) => setTimeColumn(d.value)} placeholder="timestamp" aria-label="Time column" />
                  )}
                </Field>
                <Field label={aggregation === 'count' ? 'Value column (n/a for count)' : 'Value column'} style={{ flex: 1, minWidth: 160 }}>
                  {columns.length > 0 ? (
                    <Select value={valueColumn} onChange={(_: unknown, d: any) => setValueColumn(d.value)} disabled={aggregation === 'count'} aria-label="Value column">
                      {!columns.some((c) => c.name === valueColumn) && <option value="">— select —</option>}
                      {columns.map((c) => <option key={c.name} value={c.name}>{c.name} : {c.type}</option>)}
                    </Select>
                  ) : (
                    <Input value={valueColumn} onChange={(_: unknown, d: any) => setValueColumn(d.value)} disabled={aggregation === 'count'} placeholder="value" aria-label="Value column" />
                  )}
                </Field>
                <Field label="Bin (step)" style={{ width: 110 }}>
                  <Select value={step} onChange={(_: unknown, d: any) => setStep(d.value)} aria-label="Time bin">
                    {STEP_CHOICES.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
                  </Select>
                </Field>
                {mode === 'anomaly' ? (
                  <Field label="Sensitivity (k)" hint="lower = more anomalies" style={{ width: 130 }}>
                    <Input type="number" value={threshold} min={0.5} step={0.5} onChange={(_: unknown, d: any) => setThreshold(d.value)} aria-label="Anomaly threshold" />
                  </Field>
                ) : (
                  <Field label="Horizon (points)" style={{ width: 130 }}>
                    <Input type="number" value={horizon} min={1} onChange={(_: unknown, d: any) => setHorizon(d.value)} aria-label="Forecast horizon" />
                  </Field>
                )}
              </div>

              {colsLoading && <Caption1><Spinner size="tiny" labelPosition="after" label="Loading table schema…" /></Caption1>}

              <div>
                <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <Play20Regular />} disabled={!canRun} onClick={run}>
                  {running ? 'Running…' : mode === 'anomaly' ? 'Detect anomalies' : 'Run forecast'}
                </Button>
              </div>

              {/* Honest config gate / query error */}
              {resp && !resp.ok && (
                <MessageBar intent={gateMissing ? 'warning' : 'error'}>
                  <MessageBarBody>
                    <MessageBarTitle>{gateMissing ? 'Azure Data Explorer not configured' : 'Analysis failed'}</MessageBarTitle>
                    {gateMissing
                      ? <>Set <code>{gateMissing}</code> to point Loom at an ADX cluster, then retry.</>
                      : (resp.error || 'Unknown error')}
                  </MessageBarBody>
                </MessageBar>
              )}

              {/* Result: chart + summary + anomaly highlights */}
              {resp?.ok && resp.result?.ok && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS }}>
                  <div style={{ display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Badge appearance="filled" color="brand">{resp.pointCount ?? 0} points</Badge>
                    {mode === 'anomaly' && (
                      <Badge appearance="filled" color={(resp.anomalyCount ?? 0) > 0 ? 'danger' : 'success'}
                        icon={(resp.anomalyCount ?? 0) > 0 ? <Warning16Regular /> : undefined}>
                        {resp.anomalyCount ?? 0} anomalies
                      </Badge>
                    )}
                    {mode === 'forecast' && <Badge appearance="outline" color="brand">forecast +{resp.horizon} points</Badge>}
                    <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>· {resp.result.executionMs} ms · bin {resp.step}</Caption1>
                  </div>

                  {chartResult && (chartResult.rows?.length ?? 0) > 0 ? (
                    <TimeSeriesChart
                      columns={chartResult.columns || []}
                      rows={chartResult.rows || []}
                      columnTypes={chartResult.columnTypes}
                      height={260}
                    />
                  ) : (
                    <Caption1>No series points returned — widen the time range or choose a smaller bin.</Caption1>
                  )}

                  {mode === 'anomaly' && anomalyRows.length > 0 && (
                    <div>
                      <Subtitle2>Flagged points ({anomalyRows.length})</Subtitle2>
                      <div style={{ maxHeight: 180, overflow: 'auto', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusMedium, marginTop: tokens.spacingVerticalXS }}>
                        <Table size="small" aria-label="Detected anomalies">
                          <TableHeader>
                            <TableRow>
                              <TableHeaderCell>{timeColumn}</TableHeaderCell>
                              <TableHeaderCell>value</TableHeaderCell>
                              <TableHeaderCell>score</TableHeaderCell>
                              <TableHeaderCell>direction</TableHeaderCell>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {anomalyRows.map((a, i) => (
                              <TableRow key={i}>
                                <TableCell style={{ fontFamily: tokens.fontFamilyMonospace }}>{a.time}</TableCell>
                                <TableCell>{typeof a.value === 'number' ? a.value.toLocaleString() : String(a.value ?? '')}</TableCell>
                                <TableCell>{typeof a.score === 'number' ? a.score.toFixed(2) : String(a.score ?? '')}</TableCell>
                                <TableCell>
                                  <Badge size="small" appearance="tint" color={a.direction === 'spike' ? 'danger' : 'warning'}>{a.direction}</Badge>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            {onAddTile && resp?.ok && resp.kql && (
              <Button appearance="secondary" icon={<DataTrending20Regular />}
                onClick={() => onAddTile({ kql: resp.kql!, title: `${mode === 'anomaly' ? 'Anomalies' : 'Forecast'} · ${table}`, mode })}>
                Add as tile
              </Button>
            )}
            <Button appearance="primary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
