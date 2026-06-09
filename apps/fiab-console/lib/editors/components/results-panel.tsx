'use client';

/**
 * ResultsPanel — rich results area for the SQL query / schema tabs.
 *
 * Parity with the Azure Data Studio / SSMS / Fabric SQL editor results pane:
 *   - Results tab:  table grid with an in-grid search filter
 *   - Messages tab: PRINT / RAISERROR / row counts / batch duration
 *   - Multi-result-set dropdown when the batch returns > 1 SELECT
 *   - 10,000-row server cap with an honest "Showing first 10,000 of N rows" badge
 *   - Copy dropdown:     Column names + data | Data only | Column names only
 *   - Download dropdown: CSV | JSON | XLSX (Excel — dependency-free writer)
 *
 * No mock data. Consumes the BatchQueryResponse shape from
 * /api/items/azure-sql-database/[id]/query, with backward-compat handling for
 * the legacy single-recordset shape (postgres gate / older callers).
 */

import { useMemo, useState } from 'react';
import {
  Badge, Button, Spinner, Caption1, Input, Tooltip,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  TabList, Tab,
  Menu, MenuTrigger, MenuPopover, MenuList, MenuItem,
  MessageBar, MessageBarBody, MessageBarTitle,
  Dropdown, Option, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowDownload20Regular, Copy20Regular, Search20Regular,
  DocumentTable20Regular, Info20Regular,
} from '@fluentui/react-icons';

// ── Public response shape (matches the BFF route) ──
export interface RecordsetItem {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}
export interface InfoMsg {
  message: string;
  number: number;
  severity: number;
  lineNumber: number;
  procName: string;
}
export interface BatchQueryResponse {
  ok: boolean;
  // Multi-recordset shape (new route):
  recordsets?: RecordsetItem[];
  messages?: InfoMsg[];
  rowsAffected?: number[];
  executionMs?: number;
  // Backward-compat single-recordset shape (legacy / gated routes):
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  truncated?: boolean;
  // Error / gate path:
  error?: string;
  code?: string;
  gated?: boolean;
}

const useStyles = makeStyles({
  box: { borderTop: `1px solid ${tokens.colorNeutralStroke2}`, paddingTop: 12, minHeight: 160, display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  meta: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  actions: { marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' },
  search: { minWidth: 220 },
  tableWrap: { overflow: 'auto', maxHeight: 360, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: 4 },
  cell: { fontFamily: 'Consolas, monospace', fontSize: 12, whiteSpace: 'nowrap' },
  selRow: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
});

export function formatCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ── CSV / JSON serializers (client-side, no extra route) ──
function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function resultsToCsv(columns: string[], rows: unknown[][]): string {
  return [
    columns.map(csvEscape).join(','),
    ...rows.map((r) => columns.map((_, j) => csvEscape(r[j])).join(',')),
  ].join('\r\n');
}
function resultsToJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, j) => [c, r[j] ?? null]))),
    null,
    2,
  );
}
function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

interface Normalised {
  recordsets: RecordsetItem[];
  messages: InfoMsg[];
  rowsAffected: number[];
  executionMs: number;
}
function normalise(result: BatchQueryResponse): Normalised {
  if (result.recordsets) {
    return {
      recordsets: result.recordsets,
      messages: result.messages ?? [],
      rowsAffected: result.rowsAffected ?? [],
      executionMs: result.executionMs ?? 0,
    };
  }
  // Legacy single-recordset shape — wrap in a single-item array.
  return {
    recordsets: [{
      columns: result.columns ?? [],
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? 0,
      truncated: result.truncated ?? false,
    }],
    messages: [],
    rowsAffected: [],
    executionMs: result.executionMs ?? 0,
  };
}

function severityBadge(sev: number): { color: 'success' | 'warning' | 'danger'; label: string } {
  if (sev > 10) return { color: 'danger', label: `Error (${sev})` };
  if (sev >= 1) return { color: 'warning', label: `Warning (${sev})` };
  return { color: 'success', label: 'Info' };
}

export function ResultsPanel({ result, loading }: { result: BatchQueryResponse | null; loading: boolean }) {
  const s = useStyles();
  const [activeSet, setActiveSet] = useState(0);
  const [view, setView] = useState<'results' | 'messages'>('results');
  const [filter, setFilter] = useState('');

  const norm = useMemo(() => (result && result.ok ? normalise(result) : null), [result]);
  const recordsets = norm?.recordsets ?? [];
  const safeIdx = Math.min(activeSet, Math.max(0, recordsets.length - 1));
  const active = recordsets[safeIdx];

  const filteredRows = useMemo(() => {
    if (!active) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return active.rows;
    return active.rows.filter((row) => row.some((cell) => formatCell(cell).toLowerCase().includes(needle)));
  }, [active, filter]);

  if (loading) {
    return <div className={s.box}><Spinner size="small" label="Executing…" labelPosition="after" /></div>;
  }
  if (!result) {
    return <div className={s.box}><Caption1>Click <strong>Run</strong> to execute.</Caption1></div>;
  }
  if (!result.ok) {
    return (
      <div className={s.box}>
        <MessageBar intent={result.gated ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>{result.gated ? 'Query path gated' : 'Query failed'}</MessageBarTitle>
            {result.error || 'Unknown error'} {result.code && <Caption1>· {result.code}</Caption1>}
          </MessageBarBody>
        </MessageBar>
      </div>
    );
  }

  const n = norm as Normalised;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const cols = active?.columns ?? [];

  // ── Clipboard (TSV — pastes cleanly into Excel / SSMS) ──
  async function copyToClipboard(mode: 'names+data' | 'data' | 'names') {
    if (!active) return;
    const lines: string[] = [];
    if (mode === 'names' || mode === 'names+data') lines.push(active.columns.join('\t'));
    if (mode === 'data' || mode === 'names+data') {
      for (const row of filteredRows) lines.push(active.columns.map((_, j) => formatCell(row[j])).join('\t'));
    }
    try { await navigator.clipboard?.writeText(lines.join('\n')); } catch { /* clipboard blocked — no-op */ }
  }

  function downloadCsv() {
    if (!active) return;
    downloadBlob(`query-results-${stamp}.csv`, new Blob([resultsToCsv(active.columns, active.rows)], { type: 'text/csv' }));
  }
  function downloadJson() {
    if (!active) return;
    downloadBlob(`query-results-${stamp}.json`, new Blob([resultsToJson(active.columns, active.rows)], { type: 'application/json' }));
  }
  async function downloadXlsx() {
    const { recordsetsToXlsxBuffer } = await import('@/lib/azure/sql-xlsx-export');
    const bytes = recordsetsToXlsxBuffer(n.recordsets as any, n.messages as any);
    downloadBlob(
      `query-results-${stamp}.xlsx`,
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    );
  }

  return (
    <div className={s.box}>
      {/* Results / Messages switcher + batch duration */}
      <div className={s.meta}>
        <TabList size="small" selectedValue={view} onTabSelect={(_, d) => setView(d.value as any)}>
          <Tab value="results" icon={<DocumentTable20Regular />}>Results</Tab>
          <Tab value="messages" icon={<Info20Regular />}>
            Messages{n.messages.length > 0 ? ` (${n.messages.length})` : ''}
          </Tab>
        </TabList>
        <Caption1>· {n.executionMs} ms</Caption1>
      </div>

      {view === 'messages' ? (
        <MessagesView messages={n.messages} rowsAffected={n.rowsAffected} executionMs={n.executionMs} />
      ) : (
        <>
          <div className={s.selRow}>
            {recordsets.length > 1 && (
              <Dropdown
                size="small"
                aria-label="Select result set"
                value={`Result set ${safeIdx + 1} — ${active.rowCount.toLocaleString()} rows${active.truncated ? ' (capped)' : ''}`}
                selectedOptions={[String(safeIdx)]}
                onOptionSelect={(_, d) => { setActiveSet(Number(d.optionValue)); setFilter(''); }}
              >
                {recordsets.map((rs, i) => (
                  <Option key={i} value={String(i)}>
                    Result set {i + 1} — {rs.rowCount.toLocaleString()} rows{rs.truncated ? ' (capped at 10,000)' : ''}
                  </Option>
                ))}
              </Dropdown>
            )}
            <Badge appearance="filled" color="success">{active?.rowCount.toLocaleString() ?? 0} rows</Badge>
            {active?.truncated && (
              <Badge appearance="outline" color="warning">
                Showing first {active.rows.length.toLocaleString()} of {active.rowCount.toLocaleString()} rows
              </Badge>
            )}
            {filter.trim() && <Caption1>· {filteredRows.length.toLocaleString()} match filter</Caption1>}

            <div className={s.actions}>
              <Input
                className={s.search}
                size="small"
                contentBefore={<Search20Regular />}
                placeholder="Filter rows…"
                value={filter}
                onChange={(_, d) => setFilter(d.value)}
                aria-label="Filter result rows"
              />
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button size="small" appearance="subtle" icon={<Copy20Regular />} disabled={!cols.length}>Copy</Button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem onClick={() => copyToClipboard('names+data')}>Column names + data</MenuItem>
                    <MenuItem onClick={() => copyToClipboard('data')}>Data only</MenuItem>
                    <MenuItem onClick={() => copyToClipboard('names')}>Column names only</MenuItem>
                  </MenuList>
                </MenuPopover>
              </Menu>
              <Menu>
                <MenuTrigger disableButtonEnhancement>
                  <Button size="small" appearance="subtle" icon={<ArrowDownload20Regular />} disabled={!cols.length}>Download</Button>
                </MenuTrigger>
                <MenuPopover>
                  <MenuList>
                    <MenuItem onClick={downloadCsv}>CSV</MenuItem>
                    <MenuItem onClick={downloadJson}>JSON</MenuItem>
                    <Tooltip content="All result sets + messages as an Excel workbook" relationship="label">
                      <MenuItem onClick={downloadXlsx}>XLSX (Excel)</MenuItem>
                    </Tooltip>
                  </MenuList>
                </MenuPopover>
              </Menu>
            </div>
          </div>

          {!active || active.rowCount === 0 ? (
            <Caption1>Query returned no rows.{n.rowsAffected.length > 0 ? ` (${n.rowsAffected.join(', ')} rows affected)` : ''}</Caption1>
          ) : (
            <div className={s.tableWrap}>
              <Table aria-label="Query results" size="small">
                <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
                <TableBody>
                  {filteredRows.map((row, i) => (
                    <TableRow key={i}>{cols.map((_, j) => <TableCell key={j} className={s.cell}>{formatCell(row[j])}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MessagesView({ messages, rowsAffected, executionMs }: { messages: InfoMsg[]; rowsAffected: number[]; executionMs: number }) {
  const s = useStyles();
  return (
    <div className={s.box} style={{ borderTop: 'none', paddingTop: 0 }}>
      <div className={s.meta}>
        <Badge appearance="outline">{messages.length} message{messages.length === 1 ? '' : 's'}</Badge>
        {rowsAffected.length > 0 && <Caption1>Rows affected per statement: <strong>{rowsAffected.join(', ')}</strong></Caption1>}
        <Caption1>· batch completed in {executionMs} ms</Caption1>
      </div>
      {messages.length === 0 ? (
        <Caption1>No PRINT, warning, or info messages. {rowsAffected.length > 0 ? `Total rows affected: ${rowsAffected.reduce((a, b) => a + b, 0)}.` : 'Commands completed successfully.'}</Caption1>
      ) : (
        <div className={s.tableWrap}>
          <Table aria-label="SQL messages" size="small">
            <TableHeader><TableRow>
              <TableHeaderCell>Severity</TableHeaderCell>
              <TableHeaderCell>Number</TableHeaderCell>
              <TableHeaderCell>Message</TableHeaderCell>
              <TableHeaderCell>Line</TableHeaderCell>
              <TableHeaderCell>Proc</TableHeaderCell>
            </TableRow></TableHeader>
            <TableBody>
              {messages.map((m, i) => {
                const b = severityBadge(m.severity);
                return (
                  <TableRow key={i}>
                    <TableCell><Badge appearance="tint" color={b.color}>{b.label}</Badge></TableCell>
                    <TableCell>{m.number || '—'}</TableCell>
                    <TableCell style={{ whiteSpace: 'normal' }}>{m.message}</TableCell>
                    <TableCell>{m.lineNumber || '—'}</TableCell>
                    <TableCell>{m.procName || '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
