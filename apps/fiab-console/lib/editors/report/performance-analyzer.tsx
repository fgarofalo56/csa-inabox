'use client';

/**
 * Performance Analyzer — REPORT-BUILDER PARITY · WAVE 9
 *
 * The Loom one-for-one of Power BI Desktop's "Performance analyzer" pane. In
 * Power BI you press *Start recording*, refresh / interact with the report, and
 * each visual reports the real time its DAX query took (plus visual-display +
 * "other" time) with a per-visual *Copy query* link. This pane is the same
 * surface, Azure-native:
 *
 *   • SERVER ms  — the REAL Synapse `executeQuery` elapsed time. The `/query`
 *     route returns `elapsedMs` (= `result.executionMs`); the designer records
 *     it verbatim per visual (see report-designer.tsx F3). No mock, no estimate.
 *   • CLIENT ms  — the round-trip wall-clock the browser measured around the
 *     same `/query` fetch (`performance.now()` delta), i.e. server time + network
 *     + parse — the Power BI "visual display / other" analogue.
 *   • ROWS       — the real `rowCount` the query returned.
 *   • QUERY      — the actual compiled SQL (loom-native) or DAX the visual ran,
 *     copyable for diagnostics (the "Copy query" affordance).
 *
 * There is NO new route here: the recorder simply captures the timings the
 * existing `/query` responses already carry. The pane drives two real actions —
 * *Refresh visuals* re-runs every visual's real query through the host, and
 * *Export JSON* downloads the captured session as a file.
 *
 * Rules compliance:
 *  - no-vaporware.md: every number shown is a real measured value captured from
 *    a real backend response; Refresh / Clear / Export JSON all do exactly what
 *    they say. No dead controls, no placeholder data.
 *  - no-fabric-dependency.md: timings come from the Azure-native Synapse query
 *    path (the `/query` default). Nothing here touches a Fabric / Power BI host.
 *  - no-freeform-config.md: a Switch + buttons + a read-only table — no typed
 *    config / JSON input.
 *  - web3-ui.md: Fluent UI v9 + Loom design tokens only (spacing / color / radius
 *    / shadow tokens — no hard-coded hex), elevated cards, section iconography,
 *    dark-legible foregrounds; matches the sibling right-rail panes.
 *
 * The state store (`usePerfRecorder`) is REF-BACKED and returns a STABLE object
 * so the designer's `runVisual` callback can read `perf.recording` / call
 * `perf.record(...)` WITHOUT listing `perf` in its `useCallback` deps (report-
 * designer.tsx F3). A monotonic tick bumps a host re-render so this pane reflects
 * captures live.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  makeStyles, tokens,
  Switch, Button, Badge, Tooltip, Divider,
  Subtitle2, Caption1, Text,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell, TableCellLayout,
} from '@fluentui/react-components';
import {
  Gauge20Regular, ArrowClockwise20Regular, ArrowDownload20Regular,
  Delete20Regular, Copy16Regular, Info16Regular, TopSpeed20Regular,
} from '@fluentui/react-icons';
import { downloadBlobObject } from './export-report';

// ── model ──────────────────────────────────────────────────────────────────────

/** One captured per-visual timing sample. Every field is optional because the
 *  `/query` response may omit `elapsedMs` (non-SQL backends) or the query text. */
export interface PerfRecord {
  /** The visual's display title at capture time. */
  title?: string;
  /** REAL Synapse `executeQuery` elapsed (= `result.executionMs`), ms. */
  serverMs?: number;
  /** Rows the query returned. */
  rowCount?: number;
  /** Browser-measured round-trip around the `/query` fetch, ms. */
  clientMs?: number;
  /** The compiled SQL (loom-native) or DAX text the visual ran. */
  sql?: string;
  /** Epoch ms when the sample was captured (set by `record`). */
  at?: number;
}

/** The stable, ref-backed recorder handle returned by {@link usePerfRecorder}. */
export interface PerfRecorder {
  /** Whether new query timings are being captured. Live (ref-backed) getter. */
  recording: boolean;
  /** Turn capture on/off (the designer reads `recording`; only this pane sets it). */
  setRecording: (on: boolean) => void;
  /** Captured samples keyed by visual id. Live (ref-backed) getter. */
  records: Record<string, PerfRecord>;
  /** Record (replace) the latest sample for a visual id. */
  record: (id: string, rec: PerfRecord) => void;
  /** Drop all captured samples. */
  clear: () => void;
}

/**
 * Ref-backed performance-recorder store. Returns a STABLE object (built once via
 * a ref) whose `recording` / `records` are live getters reading mutable refs, so
 * a consumer that closed over the object on an earlier render still sees current
 * values — which is exactly why report-designer.tsx F3 can omit `perf` from its
 * `runVisual` `useCallback` deps. Mutations bump a tick so the host (and this
 * pane) re-render to reflect new captures.
 */
export function usePerfRecorder(): PerfRecorder {
  const recordingRef = useRef(false);
  const recordsRef = useRef<Record<string, PerfRecord>>({});
  // Tick state purely to force a host re-render on capture / toggle / clear.
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => (t + 1) % 1_000_000), []);

  // Build the handle exactly once; getters keep it in sync with the refs.
  const apiRef = useRef<PerfRecorder | null>(null);
  if (apiRef.current === null) {
    apiRef.current = {
      get recording(): boolean {
        return recordingRef.current;
      },
      get records(): Record<string, PerfRecord> {
        return recordsRef.current;
      },
      setRecording: (on: boolean): void => {
        recordingRef.current = !!on;
        bump();
      },
      record: (id: string, rec: PerfRecord): void => {
        if (!id) return;
        recordsRef.current = { ...recordsRef.current, [id]: { ...rec, at: Date.now() } };
        bump();
      },
      clear: (): void => {
        recordsRef.current = {};
        bump();
      },
    };
  }
  return apiRef.current;
}

// ── derived row + helpers ───────────────────────────────────────────────────────

interface PerfRow extends PerfRecord {
  id: string;
  /** Sort/display key = server + client (the "total" the table orders by). */
  total: number;
}

/** Render a millisecond value (rounded, with unit) or an em-dash when absent. */
function ms(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v).toLocaleString()} ms` : '—';
}

/** Render a row count or an em-dash. */
function rows(v: number | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—';
}

// ── styles (Fluent v9 + Loom tokens only) ───────────────────────────────────────

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalM, minWidth: 0, minHeight: 0,
  },
  head: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: 0 },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  muted: { color: tokens.colorNeutralForeground3 },

  controls: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
    boxShadow: tokens.shadow2,
  },
  grow: { flex: 1, minWidth: 0 },
  btnRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexWrap: 'wrap' },

  stats: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  stat: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    flex: 1, minWidth: '88px',
    padding: tokens.spacingVerticalS,
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: tokens.shadow2,
  },
  statValue: { fontWeight: tokens.fontWeightSemibold },

  tableWrap: {
    minWidth: 0, maxWidth: '100%', overflowX: 'auto',
    borderRadius: tokens.borderRadiusMedium,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
  },
  table: { minWidth: '340px' },
  num: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  slowRow: { backgroundColor: tokens.colorNeutralBackground2 },
  visCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, minWidth: 0 },
  visName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },

  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    textAlign: 'center', gap: tokens.spacingVerticalS,
    paddingTop: tokens.spacingVerticalXXL, paddingBottom: tokens.spacingVerticalXXL,
    paddingLeft: tokens.spacingHorizontalL, paddingRight: tokens.spacingHorizontalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
    minHeight: '220px',
  },
  emptyArt: {
    width: '64px', height: '64px', borderRadius: tokens.borderRadiusCircular,
    backgroundImage: `linear-gradient(135deg, ${tokens.colorBrandBackground2}, ${tokens.colorBrandBackground})`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: tokens.colorNeutralForegroundOnBrand,
  },
  emptyBody: { color: tokens.colorNeutralForeground3, maxWidth: '320px' },

  legend: { display: 'flex', alignItems: 'flex-start', gap: tokens.spacingHorizontalXS, minWidth: 0 },
});

// ── component ────────────────────────────────────────────────────────────────────

export interface PerformanceAnalyzerProps {
  /** The shared recorder handle (also read/written by the designer's runVisual). */
  perf: PerfRecorder;
  /** Re-run every visual's real `/query` so fresh timings are captured. */
  onRefreshVisuals: () => void;
}

/**
 * The right-rail "Performance" pane. Toggles capture, lists the captured per-visual
 * timings slowest-first, and drives the two real actions (Refresh visuals / Export
 * JSON) plus per-row Copy-query. All values are real backend measurements held in
 * {@link usePerfRecorder}; this component reads them, it never fabricates any.
 */
export function PerformanceAnalyzer({ perf, onRefreshVisuals }: PerformanceAnalyzerProps): ReactElement {
  const s = useStyles();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Slowest-first rows derived from the live ref-backed record map.
  const rowsList = useMemo<PerfRow[]>(() => {
    return Object.entries(perf.records)
      .map(([id, r]) => ({ id, ...r, total: (r.serverMs ?? 0) + (r.clientMs ?? 0) }))
      .sort((a, b) => b.total - a.total);
    // `perf` is stable; re-derive whenever the host re-renders after a capture.
  }, [perf, perf.records]);

  const hasRows = rowsList.length > 0;

  const totals = useMemo(() => {
    let server = 0, client = 0, allRows = 0;
    for (const r of rowsList) {
      server += r.serverMs ?? 0;
      client += r.clientMs ?? 0;
      allRows += r.rowCount ?? 0;
    }
    const slowest = rowsList[0];
    return { server, client, allRows, slowest };
  }, [rowsList]);

  const copyQuery = useCallback(async (id: string, sql: string | undefined) => {
    if (!sql) return;
    try {
      await navigator.clipboard?.writeText(sql);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard blocked — silently ignore; the value is still in the export */
    }
  }, []);

  const exportJson = useCallback(() => {
    const payload = {
      capturedAt: new Date().toISOString(),
      source: 'Loom report Performance analyzer',
      backend: 'azure-native (Synapse executeQuery)',
      visualCount: rowsList.length,
      visuals: rowsList.map((r) => ({
        visualId: r.id,
        title: r.title ?? null,
        serverMs: r.serverMs ?? null,
        clientMs: r.clientMs ?? null,
        totalMs: r.total,
        rowCount: r.rowCount ?? null,
        query: r.sql ?? null,
        capturedAt: r.at ? new Date(r.at).toISOString() : null,
      })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlobObject(`report-performance-${Date.now()}.json`, blob);
  }, [rowsList]);

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.head}>
        <span className={s.titleRow}>
          <Gauge20Regular />
          <Subtitle2>Performance analyzer</Subtitle2>
          {perf.recording && (
            <Badge appearance="filled" color="danger" size="small">Recording</Badge>
          )}
          <Badge appearance="tint" color="brand" size="small">Azure-native</Badge>
        </span>
        <Caption1 className={s.muted}>
          Real per-visual query timing. Server is the Synapse executeQuery elapsed;
          client is the browser round-trip. Turn on Record, then Refresh visuals.
        </Caption1>
      </div>

      {/* Controls */}
      <div className={s.controls}>
        <Switch
          checked={perf.recording}
          label={perf.recording ? 'Recording' : 'Record'}
          onChange={(_e, d) => perf.setRecording(!!d.checked)}
        />
        <span className={s.grow} />
        <div className={s.btnRow}>
          <Tooltip content="Re-run every visual's query to capture fresh timings" relationship="label">
            <Button
              size="small"
              appearance="primary"
              icon={<ArrowClockwise20Regular />}
              onClick={onRefreshVisuals}
            >
              Refresh visuals
            </Button>
          </Tooltip>
          <Tooltip content="Clear captured timings" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<Delete20Regular />}
              disabled={!hasRows}
              onClick={() => perf.clear()}
              aria-label="Clear captured timings"
            />
          </Tooltip>
          <Tooltip content="Export the captured session as JSON" relationship="label">
            <Button
              size="small"
              appearance="subtle"
              icon={<ArrowDownload20Regular />}
              disabled={!hasRows}
              onClick={exportJson}
              aria-label="Export performance JSON"
            />
          </Tooltip>
        </div>
      </div>

      {/* Summary stats (real aggregates of the captured samples) */}
      {hasRows && (
        <div className={s.stats}>
          <div className={s.stat}>
            <Caption1 className={s.muted}>Visuals</Caption1>
            <Text className={s.statValue}>{rowsList.length.toLocaleString()}</Text>
          </div>
          <div className={s.stat}>
            <Caption1 className={s.muted}>Slowest</Caption1>
            <Text className={s.statValue}>{ms(totals.slowest?.total)}</Text>
          </div>
          <div className={s.stat}>
            <Caption1 className={s.muted}>Rows</Caption1>
            <Text className={s.statValue}>{rows(totals.allRows)}</Text>
          </div>
        </div>
      )}

      {/* Timing table — slowest-first */}
      {hasRows ? (
        <div className={s.tableWrap}>
          <Table size="small" className={s.table} aria-label="Per-visual performance">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Visual</TableHeaderCell>
                <Tooltip content="Synapse executeQuery elapsed (real backend time)" relationship="label">
                  <TableHeaderCell className={s.num}>Server</TableHeaderCell>
                </Tooltip>
                <Tooltip content="Browser round-trip around the query fetch" relationship="label">
                  <TableHeaderCell className={s.num}>Client</TableHeaderCell>
                </Tooltip>
                <TableHeaderCell className={s.num}>Rows</TableHeaderCell>
                <TableHeaderCell aria-label="Copy query" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rowsList.map((r, i) => (
                <TableRow key={r.id} className={i === 0 ? s.slowRow : undefined}>
                  <TableCell>
                    <TableCellLayout truncate>
                      <span className={s.visCell}>
                        {i === 0 && (
                          <Tooltip content="Slowest visual" relationship="label">
                            <TopSpeed20Regular />
                          </Tooltip>
                        )}
                        <span className={s.visName} title={r.title || r.id}>
                          {r.title || r.id}
                        </span>
                      </span>
                    </TableCellLayout>
                  </TableCell>
                  <TableCell className={s.num}>{ms(r.serverMs)}</TableCell>
                  <TableCell className={s.num}>{ms(r.clientMs)}</TableCell>
                  <TableCell className={s.num}>{rows(r.rowCount)}</TableCell>
                  <TableCell>
                    <Tooltip
                      content={r.sql ? (copiedId === r.id ? 'Copied' : 'Copy query') : 'No query text'}
                      relationship="label"
                    >
                      <Button
                        size="small"
                        appearance="subtle"
                        icon={<Copy16Regular />}
                        disabled={!r.sql}
                        onClick={() => void copyQuery(r.id, r.sql)}
                        aria-label={`Copy query for ${r.title || r.id}`}
                      />
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className={s.empty} role="status">
          <div className={s.emptyArt} aria-hidden><Gauge20Regular /></div>
          <Subtitle2>No timings captured yet</Subtitle2>
          <Caption1 className={s.emptyBody}>
            Turn on Record, then choose Refresh visuals (or interact with the report).
            Each visual reports the real Synapse query time it took — slowest first.
          </Caption1>
          <Button appearance="primary" icon={<ArrowClockwise20Regular />} onClick={onRefreshVisuals}>
            Refresh visuals
          </Button>
        </div>
      )}

      <Divider />
      <span className={s.legend}>
        <Info16Regular className={s.muted} />
        <Caption1 className={s.muted}>
          Server time is the Azure-native Synapse executeQuery elapsed returned by
          the query route — no Fabric or Power BI capacity is involved. Use Copy
          query to grab a visual&apos;s exact SQL for tuning.
        </Caption1>
      </span>
    </div>
  );
}

export default PerformanceAnalyzer;
