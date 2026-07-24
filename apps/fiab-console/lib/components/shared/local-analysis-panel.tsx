'use client';

/**
 * N2a — **local analysis**: SQL that runs in the browser over an already-fetched
 * Arrow result.
 *
 * The engine (`loom-duckdb`) hands back an Arrow IPC stream. Once those bytes
 * are in the tab, slicing / filtering / aggregating them costs nothing: no
 * server, no network, no pool. This panel fetches the Arrow ONCE, registers it
 * as a `result` table on duckdb-wasm, and then serves every statement locally —
 * with a timing bar that PROVES it (measured elapsed ms, and a network-request
 * counter that stays at zero).
 *
 * Honest about its edges:
 *   • no Arrow source configured → an informative (never red) note explaining
 *     that the server tier is answering and what deploying the Arrow tier adds;
 *   • a browser that cannot host WebAssembly/Workers → the same note, with the
 *     reason, and the surface keeps working on the server tier;
 *   • nothing is silently cached: re-fetching is one click and is labelled.
 *
 * FLAG0 `n2a-duckdb-wasm-preview` (default-ON) hides the panel on the next
 * render if local execution ever misbehaves — the server path is untouched.
 *
 * IL5: the engine is a static, same-origin `.wasm`. No CDN, no telemetry, no
 * egress — the fastest tier in the product also works air-gapped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge, Body1, Button, Spinner, Subtitle2,
  MessageBar, MessageBarBody, MessageBarTitle,
  makeStyles, tokens,
} from '@fluentui/react-components';
import { Play20Regular, Flash20Regular, ArrowDownload20Regular } from '@fluentui/react-icons';
import { MonacoTextarea } from '@/lib/components/editor/monaco-textarea';
import { PreviewTable, type PreviewData } from '@/lib/components/shared/preview-table';
import { EmptyState } from '@/lib/components/empty-state';
import { useRuntimeFlag } from '@/lib/components/ui/use-runtime-flag';
import {
  DEFAULT_LOCAL_TABLE,
  describeLocalRun,
  openLocalSession,
  type LocalArrowSession,
  type LocalQueryStats,
} from '@/lib/duckdb/local-arrow-query';

/** FLAG0 runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const N2A_LOCAL_FLAG_ID = 'n2a-duckdb-wasm-preview';

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    minWidth: 0, minHeight: 0,
  },
  head: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
  },
  bar: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap', minWidth: 0,
    paddingTop: tokens.spacingVerticalXS, paddingBottom: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalM, paddingRight: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase200,
  },
});

/** What the panel needs to obtain the Arrow bytes it will analyze locally. */
export interface LocalArrowSource {
  /** Human label for the source ("Query result", "sales.parquet"). */
  label: string;
  /**
   * Fetch the Arrow IPC stream. Returns the bytes plus the honest fetch cost
   * and row count so the timing bar can amortize them. Reject with a readable
   * Error when the Arrow tier is not available — the panel renders it as an
   * informative note, not a failure.
   */
  fetchArrow: () => Promise<{ arrow: Uint8Array; fetchMs: number; rows: number }>;
  /** False when there is nothing fetchable yet (no file selected, no result). */
  ready: boolean;
  /** Why it is not ready / not available — rendered verbatim, never red. */
  unavailableNote?: string;
}

export interface LocalAnalysisPanelProps {
  source: LocalArrowSource;
  /** Persisted Monaco sizing key (G3). */
  sizingKey: string;
  /** Statement seeded into the editor on first open. */
  initialSql?: string;
}

function toPreview(
  columns: { name: string; type: string }[],
  rows: unknown[][],
  stats: LocalQueryStats,
): PreviewData {
  return {
    columns: columns.map((c) => c.name),
    rows,
    elapsedMs: Math.round(stats.elapsedMs),
    rowCount: rows.length,
    note: describeLocalRun(stats),
  };
}

export function LocalAnalysisPanel({ source, sizingKey, initialSql }: LocalAnalysisPanelProps) {
  const s = useStyles();
  const enabled = useRuntimeFlag(N2A_LOCAL_FLAG_ID);

  const [sql, setSql] = useState(
    initialSql || `SELECT * FROM ${DEFAULT_LOCAL_TABLE} LIMIT 100`,
  );
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [stats, setStats] = useState<LocalQueryStats | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<LocalArrowSession | null>(null);

  // Tear the engine down with the panel so a tab that never uses local
  // analysis again does not hold a worker + wasm heap.
  useEffect(() => () => { void sessionRef.current?.close(); sessionRef.current = null; }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      const fetched = await source.fetchArrow();
      await sessionRef.current?.close();
      const session = await openLocalSession({
        arrow: fetched.arrow,
        fetchMs: fetched.fetchMs,
        sourceRows: fetched.rows,
      });
      sessionRef.current = session;
      const first = await session.selectAll(1000);
      setPreview(toPreview(first.columns, first.rows, first.stats));
      setStats(first.stats);
    } catch (e) {
      // An unavailable local engine is a capability note, not a failure the
      // user must fix — the server tier already answered their query.
      setNote(e instanceof Error ? e.message : String(e));
      setPreview(null);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, [source]);

  const run = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) {
      await load();
      return;
    }
    setRunning(true);
    setError(null);
    try {
      const outcome = await session.run(sql);
      setPreview(toPreview(outcome.columns, outcome.rows, outcome.stats));
      setStats(outcome.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [load, sql]);

  if (!enabled) return null;

  return (
    <div className={s.root}>
      <div className={s.head}>
        <Flash20Regular />
        <Subtitle2>Local analysis — runs in your browser</Subtitle2>
        <Badge appearance="tint" color="brand">duckdb-wasm</Badge>
        <Button
          appearance="secondary"
          icon={loading ? <Spinner size="tiny" /> : <ArrowDownload20Regular />}
          disabled={!source.ready || loading}
          onClick={() => void load()}
        >
          {sessionRef.current ? 'Re-fetch Arrow' : `Load ${source.label}`}
        </Button>
        <Button
          appearance="primary"
          icon={running ? <Spinner size="tiny" /> : <Play20Regular />}
          disabled={running || loading || !sessionRef.current}
          onClick={() => void run()}
        >
          Run locally
        </Button>
      </div>

      <Body1>
        Fetch the result once, then slice, filter and aggregate it here as many times as you like —
        each statement runs on your machine, so it costs no server time and makes no network request.
      </Body1>

      {!source.ready && source.unavailableNote && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>{source.unavailableNote}</MessageBarBody>
        </MessageBar>
      )}

      {note && (
        <MessageBar intent="info" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Running on the server tier</MessageBarTitle>
            {note}
          </MessageBarBody>
        </MessageBar>
      )}

      <MonacoTextarea
        value={sql}
        onChange={setSql}
        language="sql"
        height={160}
        minHeight={120}
        sizingKey={sizingKey}
        ariaLabel="Local SQL over the fetched Arrow result"
      />

      {error && (
        <MessageBar intent="error" layout="multiline">
          <MessageBarBody>
            <MessageBarTitle>Local query failed</MessageBarTitle>
            {error}
          </MessageBarBody>
        </MessageBar>
      )}

      {stats && (
        <div className={s.bar} role="status" aria-live="polite">
          <Flash20Regular />
          <span>{describeLocalRun(stats)}</span>
        </div>
      )}

      {preview ? (
        <PreviewTable
          sources={[{ id: 'local', label: source.label, data: preview }]}
          showSearch
          showRefresh={false}
          ariaLabel="Local analysis results"
        />
      ) : !loading && (
        <EmptyState
          icon={<Flash20Regular />}
          title="Nothing loaded locally yet"
          body={`Load ${source.label} to bring its Arrow result into this tab. Everything after that runs on your machine.`}
          primaryAction={source.ready
            ? { label: `Load ${source.label}`, appearance: 'primary', onClick: () => void load() }
            : undefined}
        />
      )}
    </div>
  );
}

export default LocalAnalysisPanel;
