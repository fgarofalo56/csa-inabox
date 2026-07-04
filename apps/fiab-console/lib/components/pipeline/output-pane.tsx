'use client';

import { clientFetch } from '@/lib/client-fetch';
/**
 * OutputPane — the bottom-area (or Output tab) of the Data Pipeline editor.
 *
 * Two sub-experiences, one for each thing ADF Studio surfaces under the canvas
 * (the parent editor mounts this on its "Output" top tab):
 *
 *   • MONITOR — recent pipeline runs (queryPipelineRuns): runId, status, start,
 *     end, duration, invoked-by, message; expand a run for its per-activity runs
 *     (queryActivityRuns). This is the historical run-history view, with the
 *     Log-Analytics fallback for runs older than ADF's 45-day native window.
 *   • DEBUG — dispatch a debug run and watch each activity execute live (see
 *     `DebugRunPanel`).
 *
 * Backend (real REST only, no mocks — no-vaporware.md):
 *   GET  /api/items/data-pipeline/[id]/output                 → run list
 *   GET  /api/items/data-pipeline/[id]/output?runId=…         → per-activity runs
 *   POST /api/items/data-pipeline/[id]/debug                  → debug dispatch
 *
 * An empty array reflects an honestly-empty ADF history — never a placeholder.
 *
 * The prop signature is preserved (`{ workspaceId, pipelineId }`) so the existing
 * editor mount keeps working unchanged; the parameter/picker props are optional
 * additions the editor can wire to drive the Debug tab's per-run parameters.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Caption1, Button, Subtitle2, Text,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  TabList, Tab,
  MessageBar, MessageBarBody, makeStyles, tokens, Badge, Spinner,
} from '@fluentui/react-components';
import {
  ArrowSync20Regular, ChevronRight20Regular, ChevronDown20Regular,
  History20Regular, Bug20Regular,
} from '@fluentui/react-icons';
import { DebugRunPanel, statusBadge, fmtDuration } from './debug-monitor-panel';
import type { PipelineParameter } from './types';

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
  errorCode?: string | null;
}

type OutputTab = 'monitor' | 'debug';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  tabs: {
    paddingLeft: tokens.spacingHorizontalM,
    borderBottom: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  monitor: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM, overflow: 'auto', flex: 1, minHeight: 0,
  },
  header: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center' },
  detailBox: {
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    maxHeight: '320px',
  },
  activityRow: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS,
    marginBottom: tokens.spacingVerticalS,
  },
  activityHead: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  mono: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0,
  },
  errText: { color: tokens.colorPaletteRedForeground1 },
});

export interface OutputPaneProps {
  workspaceId: string;
  pipelineId: string;
  /** Declared pipeline parameters — forwarded to the Debug tab's per-run fields. */
  pipelineParams?: PipelineParameter[];
  /** Param/variable/activity names for the Debug tab's `@{}` expression picker. */
  paramNames?: string[];
  variableNames?: string[];
  activityNames?: string[];
}

export function OutputPane({
  workspaceId, pipelineId, pipelineParams, paramNames, variableNames, activityNames,
}: OutputPaneProps) {
  const s = useStyles();
  const [tab, setTab] = useState<OutputTab>('monitor');

  return (
    <div className={s.root}>
      <TabList
        className={s.tabs}
        selectedValue={tab}
        onTabSelect={(_, d) => setTab(d.value as OutputTab)}
        size="small"
      >
        <Tab value="monitor" icon={<History20Regular />}>Monitor</Tab>
        <Tab value="debug" icon={<Bug20Regular />}>Debug</Tab>
      </TabList>

      {tab === 'monitor' && (
        <MonitorView workspaceId={workspaceId} pipelineId={pipelineId} styles={s} />
      )}
      {tab === 'debug' && (
        <DebugRunPanel
          workspaceId={workspaceId}
          pipelineId={pipelineId}
          pipelineParams={pipelineParams}
          paramNames={paramNames}
          variableNames={variableNames}
          activityNames={activityNames}
        />
      )}
    </div>
  );
}

/** MONITOR — recent pipeline runs + per-activity drill-down (queryPipelineRuns). */
function MonitorView({
  workspaceId, pipelineId, styles: s,
}: {
  workspaceId: string;
  pipelineId: string;
  styles: ReturnType<typeof useStyles>;
}) {
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
      const r = await clientFetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/output?workspaceId=${encodeURIComponent(workspaceId)}`, { cache: 'no-store' });
      const j = await r.json();
      if (!j.ok) { setErr(j.error || 'failed'); setRuns([]); setLaFallback(false); }
      else { setRuns(j.runs || []); setLaFallback(!!j.laFallback); }
    } catch (e: any) {
      setErr(e?.message || String(e));
      setRuns([]);
    } finally { setLoading(false); }
  }, [workspaceId, pipelineId]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const toggleRun = useCallback(async (runId: string) => {
    if (expanded === runId) { setExpanded(null); return; }
    setExpanded(runId);
    if (activities[runId]) return;
    setActivitiesLoading((m) => ({ ...m, [runId]: true }));
    try {
      const r = await clientFetch(`/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/output?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}`, { cache: 'no-store' });
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
  }, [expanded, activities, pipelineId, workspaceId]);

  return (
    <div className={s.monitor}>
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
        <Caption1>No runs yet for this pipeline. Click <strong>Run</strong> or open the <strong>Debug</strong> tab to dispatch one.</Caption1>
      )}
      {runs && runs.length > 0 && (
        <Table size="small" aria-label="Pipeline runs">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: '32px' }} />
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
              <RunRows
                key={r.runId}
                r={r}
                isOpen={expanded === r.runId}
                activities={activities[r.runId]}
                loading={!!activitiesLoading[r.runId]}
                error={activitiesErr[r.runId]}
                onToggle={() => toggleRun(r.runId)}
                styles={s}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** A single run row + its expandable per-activity detail (MONITOR drill-down). */
function RunRows({
  r, isOpen, activities, loading, error, onToggle, styles: s,
}: {
  r: RunRow;
  isOpen: boolean;
  activities?: ActivityRow[];
  loading: boolean;
  error?: string;
  onToggle: () => void;
  styles: ReturnType<typeof useStyles>;
}) {
  const list = activities || [];
  return (
    <>
      <TableRow>
        <TableCell>
          <Button size="small" appearance="subtle"
            icon={isOpen ? <ChevronDown20Regular /> : <ChevronRight20Regular />}
            onClick={onToggle}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          />
        </TableCell>
        <TableCell><code className={s.mono}>{r.runId.slice(0, 8)}</code></TableCell>
        <TableCell>{statusBadge(r.status)}</TableCell>
        <TableCell>{r.invokedBy || '—'}</TableCell>
        <TableCell><span className={s.mono}>{r.start || '—'}</span></TableCell>
        <TableCell><span className={s.mono}>{r.end || '—'}</span></TableCell>
        <TableCell>{fmtDuration(r.durationMs)}</TableCell>
        <TableCell>{r.message || ''}</TableCell>
      </TableRow>
      {isOpen && (
        <TableRow>
          <TableCell colSpan={8}>
            <div className={s.detailBox}>
              {loading && <Spinner size="tiny" label="Loading activity output…" />}
              {error && (
                <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>
              )}
              {list.length === 0 && !loading && !error && (
                <Caption1>No per-activity records returned by ADF for this run.</Caption1>
              )}
              {list.map((a) => (
                <div key={a.id} className={s.activityRow}>
                  <div className={s.activityHead}>
                    <Text weight="semibold">{a.name}</Text>
                    <Badge appearance="outline" size="small">{a.type}</Badge>
                    {statusBadge(a.status)}
                    {a.durationMs ? <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>{fmtDuration(a.durationMs)}</Caption1> : null}
                  </div>
                  {a.error && (
                    <pre className={`${s.mono} ${s.errText}`}>
                      {a.errorCode ? `[${a.errorCode}] ` : ''}{a.error}
                    </pre>
                  )}
                  {a.output ? (
                    <details>
                      <summary><Caption1>output</Caption1></summary>
                      <pre className={s.mono}>{JSON.stringify(a.output, null, 2).slice(0, 2000)}</pre>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default OutputPane;
