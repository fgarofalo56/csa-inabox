'use client';

/**
 * pipeline-debug-overlay — the U13 ADF-parity in-canvas Debug/Output
 * monitoring layer for the pipeline canvases.
 *
 * ADF Studio's pipeline Debug loop paints each activity node with its live run
 * status (spinner → green check / red cross) and puts an eyeglass on the row /
 * node that drills into the run's input / output / error JSON. Loom already
 * had the bottom Output pane (Monitor + Debug tables over the REAL
 * queryPipelineRuns / queryActivityRuns APIs) but the CANVAS never lit up —
 * the run receipts lived only in the dock. This module closes that gap
 * (canvas-parity audit Part 2 item #1(b)):
 *
 *   • a tiny module-level pub/sub store keyed by the pipeline item id — the
 *     EXISTING run surfaces (DebugRunPanel polling, the Monitor drill-down,
 *     the ribbon Debug button) publish their per-activity rows here; the
 *     shared PipelineCanvas subscribes via its `itemId` and paints node
 *     status glyphs. ONE run path (the /output & /runs BFF routes over
 *     adf-client / synapse-dev-client) — this store only fans results out.
 *     Both pipeline canvases (the data-pipeline editor's direct mount AND
 *     PipelineDesigner) share PipelineCanvas, so both light up.
 *   • `startRunOverlayPolling` — a small self-terminating poller for hosts
 *     that dispatch a run OUTSIDE DebugRunPanel (the editor ribbon Debug,
 *     PipelineEditorCore's Debug) so their runs also stream onto the canvas.
 *   • `ActivityRunDetailDialog` — the eyeglass drill: full status / duration /
 *     input / output / error JSON for one activity run, with the real
 *     "Rerun from this activity" action when the host wires it (ADF
 *     createRun isRecovery=true + startActivityName / startFromFailure).
 *   • `RunOverlayStrip` — the compact in-canvas run banner (status, progress,
 *     rerun-from-failed, dismiss).
 *
 * Kill-switch: `u13-pipeline-run-overlay` (RUNTIME_FLAGS, default-ON) — OFF
 * reverts the canvases to the pre-U13 glyph-less rendering on the next
 * render; the Output pane, Debug dispatch, and every route are unaffected.
 *
 * No mocks anywhere (no-vaporware.md): the store holds only rows the real
 * ADF / Synapse run APIs returned.
 */

import { useSyncExternalStore } from 'react';
import { clientFetch } from '@/lib/client-fetch';
import {
  Badge, Button, Caption1, Body1, Spinner, Text, Tooltip,
  Dialog, DialogSurface, DialogTitle, DialogBody, DialogContent, DialogActions,
  makeStyles, tokens,
} from '@fluentui/react-components';
import {
  Dismiss16Regular, ArrowCounterclockwise16Regular, Glasses20Regular,
} from '@fluentui/react-icons';
import type { CanvasNodeStatus } from '@/lib/components/canvas/canvas-node-kit';

// ── Types ───────────────────────────────────────────────────────────────────

/** One activity's run receipt (shape the /output & /runs?runId routes return). */
export interface ActivityRunOverlayRow {
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

/** The published overlay state for one pipeline item. */
export interface RunOverlayState {
  /** The pipeline run whose receipts are painted on the canvas. */
  runId: string;
  /** 'debug' = a live Debug dispatch; 'monitor' = a historical run drill. */
  source: 'debug' | 'monitor';
  /** Derived overall run status (ADF vocabulary). */
  overall: string;
  rows: ActivityRunOverlayRow[];
  /** True while a poller is still streaming updates for this run. */
  polling: boolean;
  updatedAt: number;
  /** Rerun the whole run from its failed activities (isRecovery + startFromFailure). */
  onRerunFromFailed?: () => void | Promise<void>;
  /** Rerun from one named activity (isRecovery + startActivityName). */
  onRerunFromActivity?: (activityName: string) => void | Promise<void>;
}

/** Runtime kill-switch id (registered in lib/admin/runtime-flags.ts). */
export const PIPELINE_RUN_OVERLAY_FLAG_ID = 'u13-pipeline-run-overlay';

// ── Store (module-level pub/sub, keyed by pipeline item id) ─────────────────

const store = new Map<string, RunOverlayState>();
const listeners = new Set<() => void>();
/** Active poller cancel per key — a new run for the same item supersedes. */
const activePolls = new Map<string, () => void>();

function emit() { for (const l of listeners) l(); }

export function publishRunOverlay(key: string, state: RunOverlayState): void {
  if (!key) return;
  store.set(key, state);
  emit();
}

export function clearRunOverlay(key: string): void {
  if (!key) return;
  activePolls.get(key)?.();
  activePolls.delete(key);
  if (store.delete(key)) emit();
}

export function getRunOverlay(key: string | undefined): RunOverlayState | null {
  return (key && store.get(key)) || null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Subscribe a component (the canvas) to the overlay state for one pipeline
 * item. Returns null when nothing has been published (or no key).
 */
export function useRunOverlay(key: string | undefined): RunOverlayState | null {
  return useSyncExternalStore(
    subscribe,
    () => getRunOverlay(key),
    () => null,
  );
}

// ── Status helpers ──────────────────────────────────────────────────────────

const TERMINAL = new Set(['Succeeded', 'Failed', 'Cancelled', 'Skipped']);

/** True when `status` is a terminal ADF activity state. */
export function isTerminalRunStatus(status?: string): boolean {
  return !!status && TERMINAL.has(status);
}

/** ADF run-status vocabulary → the canvas-node-kit status glyph. */
export function runStatusToNodeStatus(status?: string): CanvasNodeStatus {
  switch (status) {
    case 'Succeeded': return 'succeeded';
    case 'Failed': return 'failed';
    case 'Skipped': return 'skipped';
    case 'Cancelled': return 'warning';
    case 'Queued':
    case 'InProgress':
    case 'Cancelling': return 'running';
    default: return 'idle';
  }
}

/**
 * Derive the run's overall status from its activity rows — any Failed wins;
 * all-terminal ⇒ Failed/Cancelled/Succeeded; no rows yet ⇒ Queued.
 * (Same derivation DebugRunPanel has always used.)
 */
export function deriveOverallStatus(rows: ActivityRunOverlayRow[]): string {
  const states = rows.map((r) => r.status || 'Queued');
  if (rows.length === 0) return 'Queued';
  if (states.every((x) => TERMINAL.has(x))) {
    return states.includes('Failed') ? 'Failed'
      : states.includes('Cancelled') ? 'Cancelled'
      : 'Succeeded';
  }
  if (states.includes('Failed')) return 'Failed';
  return 'InProgress';
}

/** Human duration for a run row ('1.2s' / '3m 4s'). */
export function fmtDuration(ms?: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec * 10) / 10}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

/** The shared run-status Badge (single colour language across every surface). */
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

/** The short in-node status caption for a run row (kit statusDetail slot). */
export function runStatusDetail(row: ActivityRunOverlayRow): string {
  if (row.status === 'Failed') return row.errorCode || 'Failed';
  if (row.status === 'InProgress' || row.status === 'Queued' || row.status === 'Cancelling') {
    return row.status === 'InProgress' ? 'Running…' : row.status;
  }
  const d = fmtDuration(row.durationMs);
  return d === '—' ? (row.status || '') : d;
}

// ── Shared poller (one run path — fans an EXISTING BFF route onto the canvas) ─

export interface RunOverlayPollOptions {
  /** Overlay key — the pipeline item id the canvas subscribes with. */
  key: string;
  runId: string;
  source?: 'debug' | 'monitor';
  /**
   * Fetch the per-activity rows for `runId` from the REAL run API (the host's
   * existing /output or /runs?runId route). Return null on a transient error
   * (the poller keeps trying until the ceiling).
   */
  fetchActivities: () => Promise<ActivityRunOverlayRow[] | null>;
  onRerunFromFailed?: () => void | Promise<void>;
  onRerunFromActivity?: (activityName: string) => void | Promise<void>;
  /** Poll cadence (default 3500ms — the DebugRunPanel cadence). */
  pollMs?: number;
  /** Poll ceiling so a hung run never polls forever (default 240 ≈ 14 min). */
  maxPolls?: number;
}

/**
 * Poll a run's per-activity rows and publish them to the overlay store until
 * every activity reaches a terminal state (or the ceiling hits). Starting a
 * new poll for the same key cancels the previous one. Returns a cancel fn.
 */
export function startRunOverlayPolling(opts: RunOverlayPollOptions): () => void {
  const { key, runId, fetchActivities, onRerunFromFailed, onRerunFromActivity } = opts;
  const source = opts.source ?? 'debug';
  const pollMs = opts.pollMs ?? 3500;
  const maxPolls = opts.maxPolls ?? 240;

  // Supersede any in-flight poll for this pipeline.
  activePolls.get(key)?.();

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polls = 0;

  const publish = (rows: ActivityRunOverlayRow[], polling: boolean) => {
    publishRunOverlay(key, {
      runId, source, rows,
      overall: deriveOverallStatus(rows),
      polling,
      updatedAt: Date.now(),
      onRerunFromFailed,
      onRerunFromActivity,
    });
  };

  const tick = async () => {
    if (cancelled) return;
    polls += 1;
    const rows = await fetchActivities().catch(() => null);
    if (cancelled) return;
    if (rows) {
      const done = rows.length > 0 && rows.every((r) => isTerminalRunStatus(r.status));
      publish(rows, !done && polls < maxPolls);
      if (done || polls >= maxPolls) { activePolls.delete(key); return; }
    } else if (polls >= maxPolls) {
      activePolls.delete(key);
      return;
    }
    timer = setTimeout(() => { void tick(); }, pollMs);
  };

  const cancel = () => {
    cancelled = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (activePolls.get(key) === cancel) activePolls.delete(key);
  };
  activePolls.set(key, cancel);

  // Seed the strip immediately (Queued, no rows yet), then poll quickly first.
  publish([], true);
  timer = setTimeout(() => { void tick(); }, 1200);
  return cancel;
}

/**
 * Stream a data-pipeline debug run onto the canvas overlay via the SAME
 * /output route the Output pane reads (one run path). The rerun callbacks
 * dispatch REAL ADF recovery runs (isRecovery=true + startFromFailure /
 * startActivityName) through the same /debug route and stream the new run.
 * `notify` surfaces rerun outcomes (the editor wires its toaster).
 */
export function streamDataPipelineRun(opts: {
  workspaceId: string;
  pipelineId: string;
  runId: string;
  notify?: (message: string, intent: 'success' | 'error') => void;
}): void {
  const { workspaceId, pipelineId, notify } = opts;
  const outputUrl = (rid: string) =>
    `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/output` +
    `?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(rid)}`;
  const debugUrl =
    `/api/items/data-pipeline/${encodeURIComponent(pipelineId)}/debug?workspaceId=${encodeURIComponent(workspaceId)}`;
  async function rerun(body: Record<string, unknown>) {
    const r = await clientFetch(debugUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.ok && j.runId) {
      notify?.(`Recovery run started · ${String(j.runId).slice(0, 8)}`, 'success');
      start(String(j.runId));
    } else {
      notify?.(`Rerun failed: ${j?.gate?.remediation || j?.error || 'unknown error'}`, 'error');
    }
  }
  function start(rid: string) {
    startRunOverlayPolling({
      key: pipelineId,
      runId: rid,
      source: 'debug',
      fetchActivities: async () => {
        const r = await clientFetch(outputUrl(rid), { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        return j?.ok ? ((j.activities || []) as ActivityRunOverlayRow[]) : null;
      },
      onRerunFromFailed: () => rerun({ referencePipelineRunId: rid, startFromFailure: true }),
      onRerunFromActivity: (name) => rerun({ referencePipelineRunId: rid, startActivityName: name }),
    });
  }
  start(opts.runId);
}

// ── UI: in-canvas run strip + eyeglass detail dialog ────────────────────────

const useStyles = makeStyles({
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
    minWidth: 0,
    paddingTop: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalXXS,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
    boxShadow: tokens.shadow16,
  },
  stripRunId: { fontFamily: 'Consolas, monospace', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  stripProgress: { color: tokens.colorNeutralForeground3 },
  detailGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    minWidth: 0,
  },
  metaRow: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 },
  mono: {
    fontFamily: 'Consolas, monospace',
    fontSize: tokens.fontSizeBase200,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    margin: 0,
  },
  errText: { color: tokens.colorPaletteRedForeground1 },
  jsonBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    padding: tokens.spacingHorizontalM,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `${tokens.strokeWidthThin} solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'auto',
    maxHeight: '260px',
    minWidth: 0,
  },
});

/** Safe pretty-print of a run payload for the detail dialog. */
function pretty(v: unknown, max = 6000): string {
  if (v === null || v === undefined) return '—';
  try {
    const str = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return str.length > max ? `${str.slice(0, max)}…` : str;
  } catch {
    return String(v);
  }
}

export interface RunOverlayStripProps {
  state: RunOverlayState;
  /** Clear the overlay (removes glyphs from the canvas). */
  onDismiss: () => void;
}

/**
 * The compact in-canvas run banner — ADF's debug status strip, floated as a
 * React Flow Panel. Status badge + runId + progress + rerun-from-failed.
 */
export function RunOverlayStrip({ state, onDismiss }: RunOverlayStripProps) {
  const s = useStyles();
  const done = state.rows.filter((r) => isTerminalRunStatus(r.status)).length;
  return (
    <div className={s.strip} data-run-overlay-strip role="status" aria-live="polite">
      {statusBadge(state.overall)}
      <span className={s.stripRunId} title={state.runId}>
        {state.source === 'debug' ? 'Debug' : 'Run'} · {state.runId.slice(0, 8)}
      </span>
      {state.polling && <Spinner size="extra-tiny" aria-label="Streaming run status" />}
      <Caption1 className={s.stripProgress}>
        {state.rows.length > 0
          ? `${done}/${state.rows.length} activities`
          : 'Waiting for activities…'}
      </Caption1>
      {state.overall === 'Failed' && !state.polling && state.onRerunFromFailed && (
        <Tooltip content="Rerun this pipeline from its failed activities (ADF recovery run)" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            icon={<ArrowCounterclockwise16Regular />}
            onClick={() => { void state.onRerunFromFailed?.(); }}
          >
            Rerun from failed
          </Button>
        </Tooltip>
      )}
      <Tooltip content="Hide run status from the canvas" relationship="label">
        <Button
          size="small"
          appearance="subtle"
          icon={<Dismiss16Regular />}
          aria-label="Dismiss run overlay"
          onClick={onDismiss}
        />
      </Tooltip>
    </div>
  );
}

export interface ActivityRunDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ActivityRunOverlayRow | null;
  runId?: string;
  /** Wire to enable the real "Rerun from this activity" action. */
  onRerunFromActivity?: (activityName: string) => void | Promise<void>;
}

/**
 * The eyeglass drill — one activity run's full receipt: status, duration,
 * timestamps, error, and the input/output JSON the real run API returned.
 */
export function ActivityRunDetailDialog({
  open, onOpenChange, row, runId, onRerunFromActivity,
}: ActivityRunDetailDialogProps) {
  const s = useStyles();
  if (!row) return null;
  return (
    <Dialog open={open} onOpenChange={(_, d) => onOpenChange(d.open)}>
      <DialogSurface aria-describedby={undefined}>
        <DialogBody>
          <DialogTitle>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS }}>
              <Glasses20Regular /> {row.name}
            </span>
          </DialogTitle>
          <DialogContent>
            <div className={s.detailGrid}>
              <div className={s.metaRow}>
                <Badge appearance="outline" size="small">{row.type}</Badge>
                {statusBadge(row.status)}
                <Caption1>Duration {fmtDuration(row.durationMs)}</Caption1>
                {runId && <Caption1 className={s.stripRunId}>run {runId.slice(0, 8)}</Caption1>}
              </div>
              {(row.start || row.end) && (
                <Caption1 className={s.stripProgress}>
                  {row.start ? `Started ${row.start}` : ''}{row.start && row.end ? ' · ' : ''}{row.end ? `Ended ${row.end}` : ''}
                </Caption1>
              )}
              {row.error && (
                <div className={s.jsonBox}>
                  <Body1>Error{row.errorCode ? ` (${row.errorCode})` : ''}</Body1>
                  <pre className={`${s.mono} ${s.errText}`}>{row.error}</pre>
                </div>
              )}
              <div className={s.jsonBox}>
                <Text weight="semibold">Input</Text>
                <pre className={s.mono}>{pretty(row.input)}</pre>
              </div>
              <div className={s.jsonBox}>
                <Text weight="semibold">Output</Text>
                <pre className={s.mono}>{pretty(row.output)}</pre>
              </div>
            </div>
          </DialogContent>
          <DialogActions>
            {onRerunFromActivity && (
              <Tooltip content="Dispatch a recovery run starting at this activity" relationship="label">
                <Button
                  appearance="secondary"
                  icon={<ArrowCounterclockwise16Regular />}
                  onClick={() => { void onRerunFromActivity(row.name); onOpenChange(false); }}
                >
                  Rerun from this activity
                </Button>
              </Tooltip>
            )}
            <Button appearance="primary" onClick={() => onOpenChange(false)}>Close</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
