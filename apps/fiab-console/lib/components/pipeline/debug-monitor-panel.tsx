'use client';

/**
 * DebugRunPanel — the Loom one-for-one of Azure Data Factory Studio's "Debug"
 * experience (the canvas Output strip that lights up while a debug run streams).
 *
 * It is the DEBUG half of the pipeline Output pane (the MONITOR half — recent
 * pipeline runs + per-activity drill-down — stays in `output-pane.tsx`, which
 * mounts this panel under its "Debug" tab). Both halves share the SAME real
 * backend (no mocks, per no-vaporware.md):
 *
 *   DEBUG dispatch  → POST /api/items/data-pipeline/[id]/debug
 *                       (adf-client.debugPipeline → createRun isRecovery=false)
 *   Live status     → GET  /api/items/data-pipeline/[id]/output?runId=…
 *                       (adf-client.listActivityRuns → queryActivityRuns), polled
 *                       on a fixed cadence until every activity reaches a terminal
 *                       state (Succeeded / Failed / Cancelled / Skipped).
 *
 * Parameters: when the bound pipeline declares parameters, each is rendered as a
 * structured value control (`ExpressionField`, reused) so a debug run can be
 * dispatched with per-run values — including `@{…}` defaults — exactly like the
 * ADF "Pipeline run (Debug)" parameters dialog. No freeform JSON (per
 * loom-no-freeform-config).
 *
 * Honest gate: when the pipeline has no live ADF backing the debug POST returns
 * a structured `{ gate }` (409) which we render as a Fluent MessageBar naming the
 * remediation — never a dead-end (no-vaporware.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Caption1, Button, Subtitle2, Body1, Text,
  Table, TableHeader, TableHeaderCell, TableBody, TableRow, TableCell,
  MessageBar, MessageBarBody, MessageBarTitle, makeStyles, tokens, Badge, Spinner,
  Field, ProgressBar, Tooltip,
} from '@fluentui/react-components';
import {
  Bug20Regular, ArrowSync16Regular, ChevronRight16Regular, ChevronDown16Regular,
  Dismiss16Regular,
} from '@fluentui/react-icons';
import { ExpressionField } from './expression-field';
import type { PipelineParameter } from './types';

/** A single activity's live status row (shape returned by the output route). */
export interface DebugActivityRow {
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

const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled', 'Skipped']);
const POLL_MS = 3500;
const MAX_POLLS = 240; // ~14 min ceiling so a hung run never polls forever.

const useStyles = makeStyles({
  root: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM,
    padding: tokens.spacingHorizontalM, overflow: 'auto', flex: 1, minHeight: 0,
  },
  header: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap' },
  spacer: { flex: 1 },
  paramCard: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  intro: { color: tokens.colorNeutralForeground3 },
  runStrip: {
    display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalM, flexWrap: 'wrap',
    padding: tokens.spacingHorizontalS,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  runId: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200 },
  progressWrap: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS, minWidth: '180px', flex: 1 },
  detailRow: { backgroundColor: tokens.colorNeutralBackground2 },
  detailBox: {
    display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto', maxHeight: '320px',
  },
  mono: {
    fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0,
  },
  errText: { color: tokens.colorPaletteRedForeground1 },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL, textAlign: 'center', color: tokens.colorNeutralForeground3,
    border: `${tokens.strokeWidthThin} dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground2,
  },
  peekCol: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
});

export function statusBadge(s?: string) {
  switch (s) {
    case 'Succeeded': return <Badge appearance="filled" color="success" size="small">Succeeded</Badge>;
    case 'Failed':    return <Badge appearance="filled" color="danger" size="small">Failed</Badge>;
    case 'InProgress':return <Badge appearance="filled" color="brand" size="small">In progress</Badge>;
    case 'Queued':    return <Badge appearance="outline" size="small">Queued</Badge>;
    case 'Cancelled': return <Badge appearance="filled" color="warning" size="small">Cancelled</Badge>;
    case 'Cancelling':return <Badge appearance="filled" color="warning" size="small">Cancelling</Badge>;
    case 'Skipped':   return <Badge appearance="filled" color="subtle" size="small">Skipped</Badge>;
    default:          return <Badge appearance="outline" size="small">{s || '—'}</Badge>;
  }
}

export function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

/** A short, safe peek at an activity input/output payload for the grid cell. */
function peek(v: unknown, max = 140): string | null {
  if (v === null || v === undefined) return null;
  let str: string;
  try { str = typeof v === 'string' ? v : JSON.stringify(v); } catch { str = String(v); }
  if (!str) return null;
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

export interface DebugRunPanelProps {
  workspaceId: string;
  pipelineId: string;
  /** Declared pipeline parameters — rendered as structured per-run value fields. */
  pipelineParams?: PipelineParameter[];
  /** Param/variable/activity names for the ExpressionField `@{}` picker. */
  paramNames?: string[];
  variableNames?: string[];
  activityNames?: string[];
}

export function DebugRunPanel({
  workspaceId, pipelineId, pipelineParams, paramNames, variableNames, activityNames,
}: DebugRunPanelProps) {
  const s = useStyles();

  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [debugging, setDebugging] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [overall, setOverall] = useState<string>('Queued');
  const [activities, setActivities] = useState<DebugActivityRow[]>([]);
  const [polling, setPolling] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gate, setGate] = useState<{ reason?: string; remediation?: string } | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polls = useRef(0);

  // Pre-fill param value fields from declared defaults when the param set changes.
  useEffect(() => {
    if (!pipelineParams || pipelineParams.length === 0) { setParamValues({}); return; }
    setParamValues((prev) => {
      const next: Record<string, string> = {};
      for (const p of pipelineParams) {
        const cur = prev[p.name];
        if (cur !== undefined) { next[p.name] = cur; continue; }
        const dv = p.defaultValue;
        next[p.name] = dv === undefined || dv === null
          ? ''
          : (typeof dv === 'string' ? dv : JSON.stringify(dv));
      }
      return next;
    });
  }, [pipelineParams]);

  const clearTimer = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);
  useEffect(() => () => clearTimer(), [clearTimer]);

  /** Coerce a typed param value-string into the JSON the run body expects. */
  const coerce = useCallback((p: PipelineParameter, raw: string): unknown => {
    const v = raw ?? '';
    // An @-expression is passed through verbatim — ADF resolves it server-side.
    if (v.trimStart().startsWith('@')) return v;
    if (v === '') return p.defaultValue ?? '';
    switch (p.type) {
      case 'int': { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : v; }
      case 'float': { const n = Number(v); return Number.isFinite(n) ? n : v; }
      case 'bool': return v === 'true' || v === '1';
      case 'array':
      case 'object': try { return JSON.parse(v); } catch { return v; }
      default: return v;
    }
  }, []);

  const buildParams = useCallback((): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const p of pipelineParams || []) out[p.name] = coerce(p, paramValues[p.name] ?? '');
    return out;
  }, [pipelineParams, paramValues, coerce]);

  // One poll of /output?runId=… — refresh the per-activity grid + overall state.
  const pollOnce = useCallback(async (rid: string) => {
    try {
      const r = await fetch(
        `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/output` +
        `?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(rid)}`,
        { cache: 'no-store' },
      );
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { setErr(j.error || `HTTP ${r.status}`); return true; }
      const rows: DebugActivityRow[] = j.activities || [];
      setActivities(rows);
      // Derive overall state: any Failed/Cancelled wins; else all-terminal ⇒
      // Succeeded; else still InProgress.
      const states = rows.map((a) => a.status || 'Queued');
      let next = 'InProgress';
      if (rows.length > 0 && states.every((x) => TERMINAL.has(x))) {
        next = states.includes('Failed') ? 'Failed'
          : states.includes('Cancelled') ? 'Cancelled'
          : 'Succeeded';
      } else if (states.includes('Failed')) {
        next = 'Failed';
      } else if (rows.length === 0) {
        next = 'Queued';
      }
      setOverall(next);
      // Stop polling once every (≥1) activity is terminal, or the ceiling hits.
      const done = rows.length > 0 && states.every((x) => TERMINAL.has(x));
      return done;
    } catch (e: any) {
      setErr(e?.message || String(e));
      return false; // transient fetch error — keep polling until the ceiling.
    }
  }, [pipelineId, workspaceId]);

  const scheduleNext = useCallback((rid: string) => {
    clearTimer();
    timer.current = setTimeout(async () => {
      polls.current += 1;
      const done = await pollOnce(rid);
      if (done || polls.current >= MAX_POLLS) {
        setPolling(false);
      } else {
        scheduleNext(rid);
      }
    }, POLL_MS);
  }, [clearTimer, pollOnce]);

  const startDebug = useCallback(async () => {
    if (!workspaceId || !pipelineId) return;
    clearTimer();
    polls.current = 0;
    setDebugging(true); setErr(null); setGate(null);
    setActivities([]); setExpanded(null); setRunId(null); setOverall('Queued');
    try {
      const r = await fetch(
        `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/debug?workspaceId=${encodeURIComponent(workspaceId)}`,
        {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parameters: buildParams() }),
        },
      );
      const j = await r.json().catch(() => ({}));
      if (!j.ok) {
        if (j.gate) setGate(j.gate);
        else setErr(j.error || `HTTP ${r.status}`);
        return;
      }
      setRunId(j.runId);
      setOverall(j.status || 'Queued');
      setPolling(true);
      // Kick off the first poll quickly, then settle to the steady cadence.
      timer.current = setTimeout(async () => {
        polls.current += 1;
        const done = await pollOnce(j.runId);
        if (done || polls.current >= MAX_POLLS) setPolling(false);
        else scheduleNext(j.runId);
      }, 1200);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setDebugging(false);
    }
  }, [workspaceId, pipelineId, buildParams, clearTimer, pollOnce, scheduleNext]);

  const stopPolling = useCallback(() => { clearTimer(); setPolling(false); }, [clearTimer]);

  const refreshNow = useCallback(() => {
    if (runId) void pollOnce(runId);
  }, [runId, pollOnce]);

  const total = activities.length;
  const doneCount = useMemo(
    () => activities.filter((a) => TERMINAL.has(a.status || '')).length,
    [activities],
  );

  return (
    <div className={s.root}>
      <div className={s.header}>
        <Subtitle2>Debug run</Subtitle2>
        <div className={s.spacer} />
        {polling && (
          <Tooltip content="Stop refreshing the live status" relationship="label">
            <Button size="small" appearance="subtle" icon={<Dismiss16Regular />} onClick={stopPolling}>
              Stop watching
            </Button>
          </Tooltip>
        )}
        {runId && (
          <Tooltip content="Refresh activity status now" relationship="label">
            <Button size="small" appearance="subtle" icon={<ArrowSync16Regular />} onClick={refreshNow}>
              Refresh
            </Button>
          </Tooltip>
        )}
        <Button
          appearance="primary" icon={<Bug20Regular />}
          disabled={debugging || !pipelineId} onClick={startDebug}
        >
          {debugging ? 'Starting…' : 'Debug'}
        </Button>
      </div>

      <Caption1 className={s.intro}>
        Dispatches a debug run against the live Azure Data Factory backing and streams
        each activity&apos;s status, duration, input/output, and any error — the same
        view ADF Studio shows under the canvas while debugging. Auto-publishes nothing:
        Save / Publish the pipeline first if it has no ADF backing yet.
      </Caption1>

      {pipelineParams && pipelineParams.length > 0 && (
        <div className={s.paramCard}>
          <Text weight="semibold">
            Parameters{' '}
            <Badge appearance="tint" color="informative" size="small">Passed to this run</Badge>
          </Text>
          {pipelineParams.map((p) => (
            <ExpressionField
              key={p.name}
              label={`${p.name} (${p.type})`}
              value={paramValues[p.name] ?? ''}
              onChange={(next) => setParamValues((m) => ({ ...m, [p.name]: next }))}
              placeholder={p.defaultValue !== undefined ? String(p.defaultValue) : `Enter ${p.name}`}
              availableParams={paramNames}
              availableVariables={variableNames}
              activityNames={activityNames}
              pipelineId={pipelineId}
              workspaceId={workspaceId}
              multiline={p.type === 'array' || p.type === 'object'}
            />
          ))}
        </div>
      )}

      {gate && (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>{gate.reason || 'Not yet backed by a live Data Factory pipeline'}</MessageBarTitle>
            {gate.remediation || 'Save / Publish the pipeline to Azure Data Factory, then Debug.'}
          </MessageBarBody>
        </MessageBar>
      )}
      {err && !gate && <MessageBar intent="error"><MessageBarBody>{err}</MessageBarBody></MessageBar>}

      {runId && (
        <div className={s.runStrip}>
          <Field label="Debug run" orientation="horizontal">
            <span className={s.runId}>{runId.slice(0, 8)}</span>
          </Field>
          {statusBadge(overall)}
          {polling && <Spinner size="tiny" />}
          <div className={s.progressWrap}>
            <ProgressBar
              value={total > 0 ? doneCount / total : undefined}
              color={overall === 'Failed' || overall === 'Cancelled' ? 'error' : 'brand'}
            />
            <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
              {total > 0 ? `${doneCount}/${total} activities complete` : 'Waiting for activities to start…'}
            </Caption1>
          </div>
        </div>
      )}

      {runId && total === 0 && !polling && (
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>
          No per-activity records reported for this debug run yet. Click <strong>Refresh</strong> if it just started.
        </Caption1>
      )}

      {total > 0 && (
        <Table size="small" aria-label="Debug activity status">
          <TableHeader>
            <TableRow>
              <TableHeaderCell style={{ width: '32px' }} />
              <TableHeaderCell>Activity</TableHeaderCell>
              <TableHeaderCell>Type</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Duration</TableHeaderCell>
              <TableHeaderCell>Output / error peek</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {activities.map((a) => {
              const isOpen = expanded === a.id;
              const errPeek = a.error ? peek(a.error) : null;
              const outPeek = !errPeek ? peek(a.output) : null;
              return (
                <DebugActivityRows
                  key={a.id}
                  a={a} isOpen={isOpen} errPeek={errPeek} outPeek={outPeek}
                  onToggle={() => setExpanded(isOpen ? null : a.id)}
                  styles={s}
                />
              );
            })}
          </TableBody>
        </Table>
      )}

      {!runId && !gate && !err && (
        <div className={s.empty}>
          <Bug20Regular />
          <Subtitle2>Ready to debug</Subtitle2>
          <Caption1>
            Click <strong>Debug</strong> to dispatch a run and watch each activity execute live.
          </Caption1>
        </div>
      )}
    </div>
  );
}

/**
 * One activity row + its expandable input/output/error detail. Split out so the
 * Fragment-with-two-rows pattern keys cleanly and the detail box is only mounted
 * when expanded.
 */
function DebugActivityRows({
  a, isOpen, errPeek, outPeek, onToggle, styles,
}: {
  a: DebugActivityRow;
  isOpen: boolean;
  errPeek: string | null;
  outPeek: string | null;
  onToggle: () => void;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <>
      <TableRow>
        <TableCell>
          <Button
            size="small" appearance="subtle"
            icon={isOpen ? <ChevronDown16Regular /> : <ChevronRight16Regular />}
            onClick={onToggle}
            aria-label={isOpen ? 'Collapse details' : 'Expand details'}
          />
        </TableCell>
        <TableCell><Text weight="semibold">{a.name}</Text></TableCell>
        <TableCell><Badge appearance="outline" size="small">{a.type}</Badge></TableCell>
        <TableCell>{statusBadge(a.status)}</TableCell>
        <TableCell>{fmtDuration(a.durationMs)}</TableCell>
        <TableCell>
          {errPeek
            ? <span className={`${styles.mono} ${styles.errText}`}>{errPeek}</span>
            : outPeek
              ? <span className={styles.mono}>{outPeek}</span>
              : <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>—</Caption1>}
        </TableCell>
      </TableRow>
      {isOpen && (
        <TableRow className={styles.detailRow}>
          <TableCell colSpan={6}>
            <div className={styles.detailBox}>
              {a.error && (
                <div>
                  <Body1>Error{a.errorCode ? ` (${a.errorCode})` : ''}</Body1>
                  <pre className={`${styles.mono} ${styles.errText}`}>{a.error}</pre>
                </div>
              )}
              <div className={styles.peekCol}>
                <Body1>Input</Body1>
                <pre className={styles.mono}>
                  {a.input ? JSON.stringify(a.input, null, 2).slice(0, 4000) : '—'}
                </pre>
              </div>
              <div className={styles.peekCol}>
                <Body1>Output</Body1>
                <pre className={styles.mono}>
                  {a.output ? JSON.stringify(a.output, null, 2).slice(0, 4000) : '—'}
                </pre>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default DebugRunPanel;
