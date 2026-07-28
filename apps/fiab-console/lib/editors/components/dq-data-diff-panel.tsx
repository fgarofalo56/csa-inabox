'use client';

/**
 * N7d — "Data diff" panel for the data-quality editor (fold b).
 *
 * Pick two Delta versions (or two environments / paths) of a table → the exact
 * changed cells, added rows, and removed rows, **computed through the N2 DuckDB
 * engine** (POST /api/items/data-quality/[id]/diff). DuckDB reconstructs each
 * side's active parquet file-set from the `_delta_log` and reads it in place —
 * Azure-native, no Fabric, IL5-disconnected. Optionally emits a `data-diff`
 * finding for N17's incident console.
 *
 * Props declared inline (no import of EditorProps — avoids the registry cycle).
 */

import { useCallback, useState } from 'react';
import {
  Subtitle2, Caption1, Badge, Button, Field, Input, Checkbox, Spinner,
  Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, Divider,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  ArrowSyncRegular, PlayRegular,
} from '@fluentui/react-icons';
import { clientFetch } from '@/lib/client-fetch';
import { EmptyState } from '@/lib/components/empty-state';

interface Side { container: string; path: string; version: string; label: string }
interface CellChange { column: string; before: unknown; after: unknown }
interface ChangedRow { key: Record<string, unknown>; cells: CellChange[] }
interface DiffResult {
  columns: string[]; keyColumns: string[];
  changed: ChangedRow[]; added: Array<Record<string, unknown>>; removed: Array<Record<string, unknown>>;
  counts: { changed: number; added: number; removed: number };
  truncated: boolean;
  scan: { a: { label: string; files: number; version?: number }; b: { label: string; files: number; version?: number } };
  engine: string;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, maxWidth: '1040px' },
  card: { border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusXLarge, padding: tokens.spacingVerticalL, display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow4 },
  sectionHeader: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground2, flexWrap: 'wrap', minWidth: 0 },
  sectionIcon: { color: tokens.colorBrandForeground1, display: 'inline-flex', fontSize: tokens.fontSizeBase400 },
  sides: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: tokens.spacingHorizontalL, alignItems: 'start' },
  sideCard: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, padding: tokens.spacingVerticalM, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2 },
  row: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  badgeRow: { display: 'flex', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap', minWidth: 0 },
  tableWrap: { overflowX: 'auto', maxHeight: '44vh', overflowY: 'auto' },
  hint: { color: tokens.colorNeutralForeground3 },
  mono: { fontFamily: 'Consolas, "Cascadia Code", monospace', fontSize: tokens.fontSizeBase200 },
  before: { color: tokens.colorPaletteRedForeground1, textDecorationLine: 'line-through' },
  after: { color: tokens.colorPaletteGreenForeground1 },
});

function cell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const EMPTY_SIDE: Side = { container: '', path: '', version: '', label: '' };

export function DqDataDiffPanel({ id }: { id: string }) {
  const s = useStyles();
  const [a, setA] = useState<Side>({ ...EMPTY_SIDE, label: 'A' });
  const [b, setB] = useState<Side>({ ...EMPTY_SIDE, label: 'B' });
  const [keyCols, setKeyCols] = useState('');
  const [emitFinding, setEmitFinding] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [emitted, setEmitted] = useState<boolean>(false);

  const swap = useCallback(() => { setA(b); setB(a); }, [a, b]);

  const sideBody = (side: Side): Record<string, unknown> => {
    const out: Record<string, unknown> = { container: side.container.trim(), path: side.path.trim() };
    if (side.label.trim()) out.label = side.label.trim();
    const v = side.version.trim();
    if (v !== '') { const n = Number(v); if (Number.isFinite(n)) out.version = Math.floor(n); }
    return out;
  };

  const run = useCallback(async () => {
    setErr(null); setRunning(true); setDiff(null); setEmitted(false);
    try {
      const keyColumns = keyCols.split(',').map((x) => x.trim()).filter(Boolean);
      const r = await clientFetch(`/api/items/data-quality/${encodeURIComponent(id)}/diff`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: sideBody(a), b: sideBody(b), keyColumns, emitFinding }),
      });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return; }
      if (j.disabled) { setErr(j.note || 'Surface disabled.'); return; }
      setDiff(j.diff || null);
      setEmitted(!!j.findingEmitted);
    } catch (e) { setErr((e as Error)?.message || String(e)); }
    finally { setRunning(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, a, b, keyCols, emitFinding]);

  const canRun = a.container.trim() && a.path.trim() && b.container.trim() && b.path.trim() && keyCols.trim() && !running;

  return (
    <div className={s.body}>
      {err && <MessageBar intent="error"><MessageBarBody><MessageBarTitle>Diff failed</MessageBarTitle>{err}</MessageBarBody></MessageBar>}

      <div className={s.card}>
        <span className={s.sectionHeader}><ArrowSyncRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Compare two versions or environments</Subtitle2>
          <Badge appearance="tint" color="brand">DuckDB engine</Badge>
        </span>
        <div className={s.sides}>
          <div className={s.sideCard}>
            <Caption1>Side A (baseline)</Caption1>
            <Field label="Container"><Input value={a.container} onChange={(_, d) => setA((p) => ({ ...p, container: d.value }))} placeholder="gold" /></Field>
            <Field label="Table path"><Input value={a.path} onChange={(_, d) => setA((p) => ({ ...p, path: d.value }))} placeholder="sales/orders" /></Field>
            <Field label="Delta version" hint="Blank = latest"><Input value={a.version} onChange={(_, d) => setA((p) => ({ ...p, version: d.value }))} placeholder="3" type="number" /></Field>
            <Field label="Label"><Input value={a.label} onChange={(_, d) => setA((p) => ({ ...p, label: d.value }))} placeholder="prod / v3" /></Field>
          </div>
          <div className={s.sideCard}>
            <Caption1>Side B (candidate)</Caption1>
            <Field label="Container"><Input value={b.container} onChange={(_, d) => setB((p) => ({ ...p, container: d.value }))} placeholder="gold" /></Field>
            <Field label="Table path"><Input value={b.path} onChange={(_, d) => setB((p) => ({ ...p, path: d.value }))} placeholder="sales/orders" /></Field>
            <Field label="Delta version" hint="Blank = latest"><Input value={b.version} onChange={(_, d) => setB((p) => ({ ...p, version: d.value }))} placeholder="5" type="number" /></Field>
            <Field label="Label"><Input value={b.label} onChange={(_, d) => setB((p) => ({ ...p, label: d.value }))} placeholder="dev / v5" /></Field>
          </div>
        </div>
        <Field label="Key column(s)" hint="Comma-separated — how a row is matched across versions">
          <Input value={keyCols} onChange={(_, d) => setKeyCols(d.value)} placeholder="order_id" />
        </Field>
        <div className={s.row}>
          <Button appearance="primary" icon={running ? <Spinner size="tiny" /> : <PlayRegular />} disabled={!canRun} onClick={run}>
            {running ? 'Diffing on DuckDB…' : 'Compute diff'}
          </Button>
          <Button appearance="subtle" icon={<ArrowSyncRegular />} onClick={swap} disabled={running}>Swap sides</Button>
          <Checkbox label="Emit a finding for the incident console (N17)" checked={emitFinding} onChange={(_, d) => setEmitFinding(!!d.checked)} />
        </div>
      </div>

      {!diff && !running && (
        <EmptyState
          icon={<ArrowSyncRegular />}
          title="No diff yet"
          body="Fill in two sides (a container + table path, and a Delta version to time-travel to, or leave version blank for latest) and a key column, then Compute diff. DuckDB reads each version's parquet files off the lake in place and returns the exact changed cells, added rows, and removed rows."
        />
      )}

      {diff && (
        <div className={s.card}>
          <span className={s.sectionHeader}><ArrowSyncRegular className={s.sectionIcon} aria-hidden /><Subtitle2>Diff result</Subtitle2>
            <div className={s.badgeRow}>
              <Badge appearance="tint" color="warning">{diff.counts.changed} changed</Badge>
              <Badge appearance="tint" color="success">{diff.counts.added} added</Badge>
              <Badge appearance="tint" color="danger">{diff.counts.removed} removed</Badge>
              {emitted && <Badge appearance="outline">finding → N17</Badge>}
              {diff.truncated && <Badge appearance="tint" color="informative">truncated</Badge>}
            </div>
          </span>
          <Caption1 className={s.hint}>
            {diff.scan.a.label} ({diff.scan.a.files} file{diff.scan.a.files === 1 ? '' : 's'}{diff.scan.a.version !== undefined ? `, v${diff.scan.a.version}` : ''}) →
            {' '}{diff.scan.b.label} ({diff.scan.b.files} file{diff.scan.b.files === 1 ? '' : 's'}{diff.scan.b.version !== undefined ? `, v${diff.scan.b.version}` : ''}) · key [{diff.keyColumns.join(', ')}] · {diff.engine}
          </Caption1>

          {diff.counts.changed === 0 && diff.counts.added === 0 && diff.counts.removed === 0 ? (
            <MessageBar intent="success"><MessageBarBody>No differences — the two versions are identical over the compared columns.</MessageBarBody></MessageBar>
          ) : (
            <>
              {diff.changed.length > 0 && (<>
                <Caption1><b>Changed cells</b></Caption1>
                <div className={s.tableWrap}>
                  <Table size="small" aria-label="Changed cells">
                    <TableHeader><TableRow>
                      <TableHeaderCell>Key</TableHeaderCell>
                      <TableHeaderCell>Column</TableHeaderCell>
                      <TableHeaderCell>Before</TableHeaderCell>
                      <TableHeaderCell>After</TableHeaderCell>
                    </TableRow></TableHeader>
                    <TableBody>
                      {diff.changed.flatMap((rowc) => rowc.cells.map((c, ci) => (
                        <TableRow key={`${JSON.stringify(rowc.key)}-${c.column}-${ci}`}>
                          <TableCell><span className={s.mono}>{Object.entries(rowc.key).map(([k, v]) => `${k}=${cell(v)}`).join(', ')}</span></TableCell>
                          <TableCell>{c.column}</TableCell>
                          <TableCell><span className={`${s.mono} ${s.before}`}>{cell(c.before)}</span></TableCell>
                          <TableCell><span className={`${s.mono} ${s.after}`}>{cell(c.after)}</span></TableCell>
                        </TableRow>
                      )))}
                    </TableBody>
                  </Table>
                </div>
              </>)}

              {(diff.added.length > 0 || diff.removed.length > 0) && <Divider />}

              {diff.added.length > 0 && (<>
                <Caption1><b>Added rows (present only in {diff.scan.b.label})</b></Caption1>
                <RowTable rows={diff.added} columns={[...diff.keyColumns, ...diff.columns]} styles={s} />
              </>)}
              {diff.removed.length > 0 && (<>
                <Caption1><b>Removed rows (present only in {diff.scan.a.label})</b></Caption1>
                <RowTable rows={diff.removed} columns={[...diff.keyColumns, ...diff.columns]} styles={s} />
              </>)}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RowTable({ rows, columns, styles }: { rows: Array<Record<string, unknown>>; columns: string[]; styles: ReturnType<typeof useStyles> }) {
  const cols = columns.slice(0, 12);
  return (
    <div className={styles.tableWrap}>
      <Table size="small" aria-label="Rows">
        <TableHeader><TableRow>{cols.map((c) => <TableHeaderCell key={c}>{c}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={i}>{cols.map((c) => <TableCell key={c}><span className={styles.mono}>{cell(r[c])}</span></TableCell>)}</TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
