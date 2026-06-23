'use client';

/**
 * HistoryDrawer — right-side OverlayDrawer that lists notebook run history.
 *
 * Phase 3 (CSA Loom v3.4):
 *  - Fetches /api/items/notebook/[id]/jobs?workspaceId=...
 *  - Renders one card per job: timestamp, duration, status Badge, invokeType,
 *    failureReason.message (if any).
 *  - Click a card → expands inline. Inline pane shows:
 *      • Re-run button → POST /api/items/notebook/[id]/run with the
 *        current compute target (passed in as prop). Optimistic: closes
 *        the drawer + lets the parent's `run()` handle polling.
 *      • "Open in Azure portal" link if the job carries a `runUrl`.
 *
 * No mocks. If the fetch fails the drawer surfaces the verbatim error
 * via a MessageBar — per no-vaporware.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody,
  Badge, Button, Caption1, Subtitle2,
  MessageBar, MessageBarBody, Spinner,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss20Regular, ArrowSync20Regular, Play16Regular, Open16Regular,
} from '@fluentui/react-icons';

// Phase 3: keep JobLite shape local — Phase 1A/2 already defines an
// identical one inside notebook-editor.tsx. Per scope we inline-copy
// here rather than re-export (avoids a circular dep on the editor).
export interface JobLite {
  id: string;
  status?: string;
  jobType?: string;
  invokeType?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { errorCode?: string; message?: string } | null;
  // Optional — Fabric does not return this today, but if a future
  // /jobs response carries a portal deep-link we surface it.
  runUrl?: string;
}

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS },
  toolbar: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  spacer: { flex: 1 },
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    cursor: 'pointer',
    transition: 'background-color 0.1s',
    ':hover': { backgroundColor: tokens.colorNeutralBackground2 },
  },
  cardActive: {
    border: `1px solid ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  cardHead: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS,
    padding: '8px 10px',
  },
  cardBody: {
    padding: '8px 10px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS,
  },
  meta: { fontFamily: 'Consolas, monospace', fontSize: '11px', color: tokens.colorNeutralForeground3 },
  failure: { color: tokens.colorPaletteRedForeground1, fontSize: tokens.fontSizeBase200 },
});

interface BadgeColor { color: 'success' | 'danger' | 'warning' | 'informative' | 'brand'; label: string; }

function statusBadge(status?: string): BadgeColor {
  const s = (status || '').toLowerCase();
  if (s === 'completed' || s === 'succeeded' || s === 'success') return { color: 'success', label: status || '—' };
  if (s === 'failed' || s === 'error' || s === 'dead' || s === 'killed' || s === 'internal_error') return { color: 'danger', label: status || '—' };
  if (s === 'inprogress' || s === 'running' || s === 'starting' || s === 'queued' || s === 'notstarted') return { color: 'warning', label: status || '—' };
  if (s === 'cancelled' || s === 'canceled') return { color: 'informative', label: status || '—' };
  return { color: 'brand', label: status || '—' };
}

function formatDuration(startIso?: string, endIso?: string): string {
  if (!startIso) return '—';
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return '—';
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(end)) return '—';
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const rem = sec % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatTimestamp(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export interface HistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notebookId: string;
  workspaceId: string;
  /** Currently selected compute target (e.g. "spark:default" or "databricks:<id>"). */
  computeId: string;
  /**
   * Called when the user clicks Re-run on a row. The parent should
   * dispatch the same logic as the whole-notebook run() button —
   * i.e. POST /run + poll. The drawer closes after dispatch.
   */
  onRerun?: () => void;
}

export function HistoryDrawer({ open, onOpenChange, notebookId, workspaceId, computeId, onRerun }: HistoryDrawerProps) {
  const s = useStyles();
  const [jobs, setJobs] = useState<JobLite[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!notebookId || !workspaceId) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/items/notebook/${encodeURIComponent(notebookId)}/jobs?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!j.ok) { setError(j.error || 'failed to load jobs'); setJobs([]); return; }
      setJobs(j.jobs || []);
    } catch (e: any) {
      setError(e?.message || String(e));
      setJobs([]);
    } finally { setLoading(false); }
  }, [notebookId, workspaceId]);

  // Fetch when the drawer opens (and notebook/workspace are set).
  useEffect(() => {
    if (open && notebookId && workspaceId) load();
  }, [open, notebookId, workspaceId, load]);

  const handleRerun = useCallback(() => {
    if (!onRerun) return;
    onOpenChange(false);
    onRerun();
  }, [onRerun, onOpenChange]);

  return (
    <OverlayDrawer
      open={open}
      onOpenChange={(_, d) => onOpenChange(d.open)}
      position="end"
      size="medium"
    >
      <DrawerHeader>
        <DrawerHeaderTitle
          action={
            <Button appearance="subtle" icon={<Dismiss20Regular />} onClick={() => onOpenChange(false)} aria-label="Close history drawer" />
          }
        >
          Run history
        </DrawerHeaderTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className={s.body}>
          <div className={s.toolbar}>
            <Caption1>{jobs ? `${jobs.length} run${jobs.length === 1 ? '' : 's'}` : '—'}</Caption1>
            <div className={s.spacer} />
            <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={load} disabled={loading || !notebookId || !workspaceId}>
              {loading ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>

          {!notebookId && (
            <MessageBar intent="info"><MessageBarBody>Select a notebook to view run history.</MessageBarBody></MessageBar>
          )}
          {error && (
            <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
          )}
          {loading && jobs === null && <Spinner size="tiny" label="Loading runs…" />}
          {jobs && jobs.length === 0 && !error && (
            <Caption1>No runs yet. Click Run on the toolbar to queue one.</Caption1>
          )}

          {(jobs || []).map((j) => {
            const b = statusBadge(j.status);
            const isExpanded = expandedId === j.id;
            return (
              <div
                key={j.id}
                className={`${s.card} ${isExpanded ? s.cardActive : ''}`}
                onClick={() => setExpandedId(isExpanded ? null : j.id)}
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(isExpanded ? null : j.id); } }}
              >
                <div className={s.cardHead}>
                  <Badge appearance="filled" color={b.color} size="small">{b.label}</Badge>
                  <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    <Subtitle2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {formatTimestamp(j.startTimeUtc)}
                    </Subtitle2>
                    <Caption1 className={s.meta}>
                      {formatDuration(j.startTimeUtc, j.endTimeUtc)} · {j.invokeType || j.jobType || 'manual'} · {j.id.slice(0, 8)}
                    </Caption1>
                    {j.failureReason?.message && (
                      <Caption1 className={s.failure}>{j.failureReason.message}</Caption1>
                    )}
                  </div>
                </div>
                {isExpanded && (
                  <div className={s.cardBody} onClick={(e) => e.stopPropagation()}>
                    <Caption1 className={s.meta}>
                      Started: {formatTimestamp(j.startTimeUtc)}<br />
                      Ended:&nbsp;&nbsp; {formatTimestamp(j.endTimeUtc)}<br />
                      Type:&nbsp;&nbsp;&nbsp;&nbsp; {j.jobType || '—'}
                    </Caption1>
                    {j.failureReason?.errorCode && (
                      <Caption1 className={s.failure}>
                        {j.failureReason.errorCode}: {j.failureReason.message}
                      </Caption1>
                    )}
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <Button
                        size="small"
                        appearance="primary"
                        icon={<Play16Regular />}
                        disabled={!onRerun || !computeId}
                        onClick={handleRerun}
                      >
                        Re-run
                      </Button>
                      {j.runUrl && (
                        <Button
                          size="small"
                          appearance="outline"
                          icon={<Open16Regular />}
                          as="a"
                          href={j.runUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open in Azure portal
                        </Button>
                      )}
                    </div>
                    {!computeId && (
                      <Caption1 className={s.failure}>
                        Pick a compute target on the editor toolbar before re-running.
                      </Caption1>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </DrawerBody>
    </OverlayDrawer>
  );
}
