'use client';
/**
 * OntologySyncPanel (WS-4.4) — Dataset→Object backfill progress UI.
 *
 * Displayed inside the Ontology editor's Objects section when an object type
 * has a datasource binding. Shows:
 *   - Datasource info badge (lakehouse / warehouse, table, PK column)
 *   - Start / re-sync button (calls POST /api/items/ontology/[id]/sync)
 *   - ProgressBar with real row counts from Cosmos (polling GET every 2s)
 *   - AI Search gate MessageBar (honest infra gate, names LOOM_AI_SEARCH_SERVICE)
 *   - Status badges: idle / running / completed / failed / cancelled
 *
 * Design: Fluent v9 + Loom tokens. No hard-coded px/hex. Responsive
 * (flexWrap + minWidth:0). Badges never overlap. Keyboard-accessible.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Badge, Spinner, MessageBar, MessageBarBody,
  ProgressBar, Caption1, Subtitle2, makeStyles, tokens, Tooltip,
} from '@fluentui/react-components';
import { clientFetch } from '@/lib/client-fetch';
import {
  ArrowSync20Regular, Database20Regular, Checkmark16Regular,
  ErrorCircle16Regular, Warning16Regular, Dismiss16Regular,
  Search20Regular, ArrowClockwise16Regular,
} from '@fluentui/react-icons';
import type { OntoDatasource } from '@/lib/editors/ontology-model';
import type { SyncJobDoc } from '@/lib/azure/object-dataset-sync';

// ── Styles ────────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  headerTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  badgeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  progressBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXS,
  },
  progressLabel: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
    minWidth: 0,
  },
  progressLabelText: {
    color: tokens.colorNeutralForeground2,
    minWidth: 0,
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  lastRun: {
    color: tokens.colorNeutralForeground3,
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  ontologyId: string;
  objectType: string;
  datasource: OntoDatasource;
  titleKey?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function OntologySyncPanel({ ontologyId, objectType, datasource }: Props) {
  const s = useStyles();

  const [job, setJob] = useState<SyncJobDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ missing: string; detail: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const baseUrl = `/api/items/ontology/${encodeURIComponent(ontologyId)}/sync`;

  // ── Poll job status every 2 s while running ──
  const fetchStatus = useCallback(async () => {
    try {
      const r = await clientFetch(
        `${baseUrl}?objectType=${encodeURIComponent(objectType)}`,
      );
      const j = await r.json().catch(() => ({}));
      if (j?.ok) setJob(j.job ?? null);
    } catch {
      // ignore transient failures during poll
    }
  }, [baseUrl, objectType]);

  useEffect(() => {
    void fetchStatus();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontologyId, objectType]);

  useEffect(() => {
    if (job?.status === 'running') {
      pollRef.current = setInterval(() => void fetchStatus(), 2000);
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [job?.status, fetchStatus]);

  // ── Start / re-sync ──
  const startSync = useCallback(async () => {
    setLoading(true);
    setErr(null);
    setGate(null);
    try {
      const r = await clientFetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objectType }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503 && j?.gate) {
        setGate({ missing: String(j.gate?.missing || ''), detail: String(j.error || '') });
      } else if (!j?.ok) {
        setErr(j?.error || `HTTP ${r.status}`);
      } else {
        setJob(j.result ? {
          id: `${ontologyId}::${objectType}`,
          ontologyId,
          objectType,
          status: j.result.status,
          startedAt: new Date().toISOString(),
          totalRows: j.result.totalRows,
          syncedRows: j.result.syncedRows,
          indexed: j.result.indexed,
        } : null);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [baseUrl, objectType, ontologyId]);

  // ── Cancel ──
  const cancelSync = useCallback(async () => {
    try {
      await clientFetch(`${baseUrl}?objectType=${encodeURIComponent(objectType)}`, { method: 'DELETE' });
      await fetchStatus();
    } catch {
      // ignore
    }
  }, [baseUrl, objectType, fetchStatus]);

  // ── Derived state ──
  const isRunning = job?.status === 'running';
  const isDone = job?.status === 'completed';
  const isFailed = job?.status === 'failed';
  const isCancelled = job?.status === 'cancelled';
  const progressValue = isRunning && job.totalRows > 0
    ? job.syncedRows / job.totalRows
    : isDone ? 1 : undefined;

  const dsKindLabel = datasource.kind === 'lakehouse' ? 'Lakehouse (Delta)' : 'Warehouse (SQL)';
  const dsLabel = datasource.sourceDisplayName || datasource.kind;

  return (
    <div className={s.root} data-testid="ontology-sync-panel">
      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.headerTitle}>
          <ArrowSync20Regular />
          <Subtitle2>Dataset sync</Subtitle2>
          <Badge appearance="tint" color="warning">Preview</Badge>
        </div>
      </div>

      {/* ── Datasource info ── */}
      <div className={s.badgeRow}>
        <Badge appearance="tint" color="brand" icon={<Database20Regular />}>{dsKindLabel}</Badge>
        {datasource.sourceDisplayName && (
          <Badge appearance="tint" color="informative">{dsLabel}</Badge>
        )}
        {datasource.table && (
          <Badge appearance="outline">{datasource.table}</Badge>
        )}
        {datasource.primaryKeyColumn && (
          <Tooltip content={`Primary key: ${datasource.primaryKeyColumn}`} relationship="label">
            <Badge appearance="outline">{datasource.primaryKeyColumn}</Badge>
          </Tooltip>
        )}
      </div>

      {/* ── AI Search gate (honest infra gate — non-blocking) ── */}
      {gate && (
        <MessageBar intent="warning" layout="multiline">
          <MessageBarBody>
            <strong>AI Search not configured</strong> — instances were synced to the graph store but are
            not yet searchable. Set <code>{gate.missing}</code> and grant the Console UAMI
            &ldquo;Search Index Data Contributor&rdquo; to enable full-text search over instances.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── Progress ── */}
      {(isRunning || isDone) && (
        <div className={s.progressBlock}>
          <div className={s.progressLabel}>
            <Caption1 className={s.progressLabelText}>
              {isRunning
                ? `Syncing… ${job.syncedRows.toLocaleString()} / ${job.totalRows > 0 ? job.totalRows.toLocaleString() : '?'} rows`
                : `Completed — ${job?.syncedRows.toLocaleString() ?? 0} instances`}
            </Caption1>
            {isDone && job?.indexed && (
              <Badge appearance="tint" color="success" icon={<Search20Regular />}>Indexed in AI Search</Badge>
            )}
          </div>
          <ProgressBar
            value={progressValue}
            shape="rounded"
            thickness="medium"
            aria-label={isRunning ? `Syncing ${objectType} instances` : 'Sync complete'}
          />
        </div>
      )}

      {/* ── Error ── */}
      {(isFailed || err) && (
        <MessageBar intent="error">
          <MessageBarBody>
            {isFailed
              ? `Sync failed: ${job?.error || 'unknown error'}`
              : err}
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── Status badges ── */}
      {job && (
        <div className={s.badgeRow}>
          {isDone && <Badge appearance="tint" color="success" icon={<Checkmark16Regular />}>Synced</Badge>}
          {isRunning && <Badge appearance="tint" color="brand" icon={<Spinner size="tiny" />}>Running</Badge>}
          {isFailed && <Badge appearance="tint" color="danger" icon={<ErrorCircle16Regular />}>Failed</Badge>}
          {isCancelled && <Badge appearance="tint" color="warning" icon={<Warning16Regular />}>Cancelled</Badge>}
          {isDone && job.indexed && <Badge appearance="tint" color="informative" icon={<Search20Regular />}>Searchable</Badge>}
          {isDone && !job.indexed && (
            <Badge appearance="tint" color="subtle">Not indexed</Badge>
          )}
        </div>
      )}

      {/* ── Action row ── */}
      <div className={s.actionRow}>
        <Button
          appearance="primary"
          icon={loading || isRunning ? <Spinner size="tiny" /> : <ArrowSync20Regular />}
          onClick={() => void startSync()}
          disabled={loading || isRunning}
          aria-label={isDone ? `Re-sync ${objectType} instances` : `Sync ${objectType} instances from datasource`}
        >
          {loading ? 'Starting…' : isRunning ? 'Syncing…' : isDone ? 'Re-sync' : 'Run backfill'}
        </Button>
        {isRunning && (
          <Button
            appearance="subtle"
            icon={<Dismiss16Regular />}
            onClick={() => void cancelSync()}
            aria-label="Cancel sync"
          >
            Cancel
          </Button>
        )}
        {!isRunning && (
          <Button
            appearance="subtle"
            icon={<ArrowClockwise16Regular />}
            onClick={() => void fetchStatus()}
            aria-label="Refresh sync status"
          >
            Refresh
          </Button>
        )}
      </div>

      {job?.completedAt && (
        <Caption1 className={s.lastRun}>
          Last run: {new Date(job.completedAt).toLocaleString()}
        </Caption1>
      )}
    </div>
  );
}
