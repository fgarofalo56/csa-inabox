'use client';

/**
 * OutputPane — bottom-area (or Output tab) view of recent pipeline runs.
 *
 * Calls /api/items/data-pipeline/[id]/output for the run list, and
 * /api/items/data-pipeline/[id]/output?runId=... for the per-activity
 * breakdown when a run is selected.
 *
 * No mock arrays — empty array reflects an honestly-empty ADF history.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Button, Subtitle2, Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  MessageBar, MessageBarBody, makeStyles, tokens, Badge, Spinner,
} from '@fluentui/react-components';
import { ArrowSync20Regular, ChevronRight20Regular, ChevronDown20Regular } from '@fluentui/react-icons';

interface RunRow {
  runId: string;
  status?: string;
  start?: string;
  end?: string;
  durationMs?: number;
  invokedBy?: string;
  message?: string | null;
}

interface ActivityRow {
  id: string;
  name: string;
  type: string;
  status?: string;
  start?: string;
  end?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string | null;
}

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingHorizontalS, padding: tokens.spacingHorizontalM, overflow: 'auto', flex: 1, minHeight: 0 },
  header: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  detailBox: {
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    maxHeight: '240px',
  },
  mono: { fontFamily: 'Consolas, monospace', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
});

function statusBadge(s?: string) {
  switch (s) {
    case 'Succeeded': return <Badge appearance="filled" color="success" size="small">Succeeded</Badge>;
    case 'Failed':    return <Badge appearance="filled" color="danger" size="small">Failed</Badge>;
    case 'InProgress':return <Badge appearance="filled" color="brand" size="small">InProgress</Badge>;
    case 'Queued':    return <Badge appearance="outline" size="small">Queued</Badge>;
    case 'Cancelled': return <Badge appearance="filled" color="warning" size="small">Cancelled</Badge>;
    case 'Skipped':   return <Badge appearance="filled" color="subtle" size="small">Skipped</Badge>;
    default:          return <Badge appearance="outline" size="small">{s || '—'}</Badge>;
  }
}

export interface OutputPaneProps {
  workspaceId: string;
  pipelineId: string;
}

export function OutputPane({ workspaceId, pipelineId }: OutputPaneProps) {
  const s = useStyles();
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [laFallback, setLaFallback] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activities, setActivities] = useState<Record<string, ActivityRow[]>>({});
  const [activitiesErr, setActivitiesErr] = useState<Record<string, string>>({});
  const [activitiesLoading, setActivitiesLoading] = useState<Record<string, boolean>>({});

  const loadRuns = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/output?workspaceId=${encodeURIComponent(workspaceId)}`);
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'failed'); setRuns([]); setLaFallback(false); }
      else { setRuns(j.runs || []); setLaFallback(!!j.laFallback); }
    } catch (e: any) {
      setErr(e?.message || String(e));
      setRuns([]);
    } finally { setLoading(false); }
  }, [workspaceId, pipelineId]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const toggleRun = async (runId: string) => {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    if (activities[runId]) return;
    setActivitiesLoading((m) => ({ ...m, [runId]: true }));
    try {
      const r = await fetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/output?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`);
      const j = await r.json();
      if (!j.ok) {
        setActivitiesErr((m) => ({ ...m, [runId]: j.error || 'failed' }));
      } else {
        setActivities((m) => ({ ...m, [runId]: j.activities || [] }));
      }
    } catch (e: any) {
      setActivitiesErr((m) => ({ ...m, [runId]: e?.message || String(e) }));
    } finally {
      setActivitiesLoading((m) => ({ ...m, [runId]: false }));
    }
  };

  return (
    <div className={s.root}>
      <div className={s.header}>
        <Subtitle2>Recent runs ({runs?.length ?? 0})</Subtitle2>
        <Button size="small" appearance="subtle" icon={<ArrowSync20Regular />} onClick={loadRuns}>Refresh</Button>
        {loading && <Spinner size="tiny" />}
      </div>
      {err && (
        <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>
      )}
      {laFallback && (
        <MessageBar intent="info">
          <MessageBarBody>
            No runs found in ADF&apos;s 45-day native monitoring window. Showing historical
            runs from Log Analytics (up to the workspace retention, 90 days by default).
            Invoked-by and some run metadata are not recorded in the diagnostic tables.
          </MessageBarBody>
        </MessageBar>
      )}
      {!err && runs && runs.length === 0 && (
        <Caption1>No runs yet for this pipeline. Click <strong>Run</strong> or <strong>Debug</strong> in the ribbon to dispatch one.</Caption1>
      )}
      {runs && runs.length > 0 && (
        <Table size="small" aria-label="Pipeline runs">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: 32 }}></TableHeaderCell>
              <TableHeaderCell>Run ID</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Invoked by</TableHeaderCell>
              <TableHeaderCell>Start</TableHeaderCell>
              <TableHeaderCell>End</TableHeaderCell>
              <TableHeaderCell>Duration</TableHeaderCell>
              <TableHeaderCell>Message</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <>
                <TableRow key={r.runId}>
                  <TableCell>
                    <Button size="small" appearance="subtle"
                      icon={expanded === r.runId ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
                      onClick={() => toggleRun(r.runId)}
                      aria-label={expanded === r.runId ? 'Collapse' : 'Expand'}
                    />
                  </TableCell>
                  <TableCell className={s.mono}><code>{r.runId.slice(0, 8)}</code></TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell>{r.invokedBy || '—'}</TableCell>
                  <TableCell className={s.mono}>{r.start || '—'}</TableCell>
                  <TableCell className={s.mono}>{r.end || '—'}</TableCell>
                  <TableCell>{r.durationMs ? `${Math.round(r.durationMs / 100) / 10}s` : '—'}</TableCell>
                  <TableCell>{r.message || ''}</TableCell>
                </TableRow>
                {expanded === r.runId && (
                  <TableRow key={`${r.runId}-detail`}>
                    <TableCell colSpan={8}>
                      <div className={s.detailBox}>
                        {activitiesLoading[r.runId] && <Spinner size="tiny" label="Loading activity output…" />}
                        {activitiesErr[r.runId] && (
                          <MessageBar intent="error">
                            <MessageBarBody>{activitiesErr[r.runId]}</MessageBarBody>
                          </MessageBar>
                        )}
                        {(activities[r.runId] || []).length === 0 && !activitiesLoading[r.runId] && (
                          <Caption1>No per-activity records returned by ADF for this run.</Caption1>
                        )}
                        {(activities[r.runId] || []).map((a) => (
                          <div key={a.id} style={{ marginBottom: 8 }}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <strong>{a.name}</strong>
                              <Badge appearance="outline" size="small">{a.type}</Badge>
                              {statusBadge(a.status)}
                              {a.durationMs && <Caption1>{Math.round(a.durationMs / 100) / 10}s</Caption1>}
                            </div>
                            {a.error && <div className={s.mono} style={{ color: tokens.colorPaletteRedForeground1 }}>{a.error}</div>}
                            {a.output ? (
                              <details>
                                <summary><Caption1>output</Caption1></summary>
                                <div className={s.mono}>{JSON.stringify(a.output, null, 2).slice(0, 2000)}</div>
                              </details>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
