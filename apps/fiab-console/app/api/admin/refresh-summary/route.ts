/**
 * GET /api/admin/refresh-summary?workspace=&status=&days=
 *
 * Scheduled-refresh overview (F20). One row per pipeline/dataflow item, built
 * from REAL backends only — no mocks, no sample arrays:
 *
 *   - Run history  → Log Analytics KQL over ADFPipelineRun (Azure Data Factory)
 *                    and, when LOOM_SYNAPSE_WORKSPACE is set,
 *                    SynapseIntegrationPipelineRuns. `arg_max(Start, *)` collapses
 *                    to the most-recent run per pipeline. Status, Start, End,
 *                    ErrorCode/Message come straight from the LA table.
 *   - Next run     → adf-client.listTriggers() (real ARM). For a Started
 *                    ScheduleTrigger we parse typeProperties.recurrence
 *                    (frequency + interval + startTime anchor) and project the
 *                    next occurrence past now. Stopped/manual/event-based and
 *                    tumbling-window triggers report no next-run (— in the UI).
 *   - Enrichment   → Cosmos items/workspaces map PipelineName → friendly
 *                    displayName + workspace name (best-effort; never blocks).
 *
 * Honest gate: when LOOM_LOG_ANALYTICS_WORKSPACE_ID is unset, queryLogs throws
 * MonitorNotConfiguredError and we return { ok:false, gate:{missing,message} }.
 * The pane renders a Fluent MessageBar naming the exact env var. ADF trigger
 * data is OPTIONAL — when the factory env vars are unset, run history still
 * renders and next-run is simply omitted (adfConfigured:false).
 *
 * Auth: cookie session (getSession). Backend reads ride the Console UAMI:
 *   - Monitoring Reader   43d0d8ad-25c7-4714-9337-8ba259a9fe05 (subscription)
 *       → monitoring-reader-rbac.bicep
 *   - Log Analytics Reader 73c42c96-874c-492b-b04d-ab87d138a893 (on the LAW)
 *       → monitoring.bicep
 * Both are already granted; F20 introduces no new role assignment or env var.
 *
 * Sovereign clouds: monitor-client picks up LOOM_LOG_ANALYTICS_ENDPOINT
 * (api.loganalytics.us in GCC-High/IL5) and adf-client picks up the ARM host
 * from cloud-endpoints — no per-cloud code path here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  queryLogs,
  type LogQueryResult,
  MonitorNotConfiguredError,
  MonitorError,
} from '@/lib/azure/monitor-client';
import { adfConfigGate, listTriggers, type AdfTrigger } from '@/lib/azure/adf-client';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

export interface RefreshSummaryRow {
  /** Raw pipeline name as it appears in the LA run table — the join key. */
  pipelineName: string;
  /** Friendly name (Cosmos item displayName when matched, else pipelineName). */
  displayName: string;
  workspaceId?: string;
  workspaceName?: string;
  /** 'adf-pipeline' | 'data-pipeline' | 'dataflow' | 'synapse-pipeline' */
  itemType: string;
  source: 'adf' | 'synapse';

  lastRunId?: string;
  lastRunAt?: string;       // ISO 8601 (Start)
  lastRunEnd?: string;      // ISO 8601 (End)
  lastRunStatus?: string;   // Succeeded | Failed | InProgress | Queued | Cancelled
  lastRunDurationMs?: number;
  lastRunError?: string;

  nextRunAt?: string;       // ISO 8601, omitted when manual / stopped / event-based
  triggerName?: string;
  triggerType?: string;     // ScheduleTrigger | TumblingWindowTrigger | ...
  triggerState?: string;    // Started | Stopped | Disabled
  recurrenceDesc?: string;  // e.g. "Every 4 hours"
}

// ---------------------------------------------------------------------------
// LA row helpers
// ---------------------------------------------------------------------------

/** Build a name→index map for a LogQueryResult so column order can't bite us. */
function indexer(res: LogQueryResult): (name: string) => number {
  const map = new Map<string, number>();
  res.columns.forEach((c, i) => map.set(c, i));
  return (name: string) => map.get(name) ?? -1;
}

function cell(row: unknown[], i: number): string | undefined {
  if (i < 0) return undefined;
  const v = row[i];
  return v == null ? undefined : String(v);
}

function durationMs(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return a && b && b >= a ? b - a : undefined;
}

// ---------------------------------------------------------------------------
// next-run projection from a Started ScheduleTrigger's recurrence
// ---------------------------------------------------------------------------

const FREQ_MS: Record<string, number> = {
  Minute: 60_000,
  Hour: 3_600_000,
  Day: 86_400_000,
  Week: 604_800_000,
};

interface Recurrence {
  frequency?: string;
  interval?: number;
  startTime?: string;
}

/**
 * Next fire time strictly after `now`, or null when it can't be computed
 * (non-schedule trigger, stopped, Month/complex calendar cadence, or no anchor).
 * Pure — no clock side-effects beyond the passed `now`.
 */
export function computeNextRun(trigger: AdfTrigger, now = Date.now()): string | null {
  const p = trigger.properties;
  if (p.runtimeState !== 'Started') return null;
  if (p.type !== 'ScheduleTrigger') return null;
  const rec = (p.typeProperties as { recurrence?: Recurrence } | undefined)?.recurrence;
  if (!rec?.frequency || !rec.startTime) return null;
  const stepMs = (FREQ_MS[rec.frequency] || 0) * (rec.interval && rec.interval > 0 ? rec.interval : 1);
  // Month frequency (and anything we don't model) → no projection. Honest "—".
  if (!stepMs) return null;
  let next = new Date(rec.startTime).getTime();
  if (Number.isNaN(next)) return null;
  if (next <= now) {
    next += Math.ceil((now - next) / stepMs) * stepMs;
    // Guard the boundary where now lands exactly on a step.
    if (next <= now) next += stepMs;
  }
  return new Date(next).toISOString();
}

/** Human-friendly cadence label for a Started ScheduleTrigger, else undefined. */
function recurrenceDesc(trigger: AdfTrigger): string | undefined {
  const p = trigger.properties;
  if (p.type !== 'ScheduleTrigger') return p.type;
  const rec = (p.typeProperties as { recurrence?: Recurrence } | undefined)?.recurrence;
  if (!rec?.frequency) return undefined;
  const n = rec.interval && rec.interval > 0 ? rec.interval : 1;
  const unit = rec.frequency.toLowerCase();
  return n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`;
}

/** Map pipelineName → trigger by walking both the pipelines[] and singular pipeline refs. */
function buildTriggerMap(triggers: AdfTrigger[]): Map<string, AdfTrigger> {
  const m = new Map<string, AdfTrigger>();
  for (const t of triggers) {
    const refs: string[] = [];
    for (const pl of t.properties.pipelines || []) {
      const n = pl.pipelineReference?.referenceName;
      if (n) refs.push(n);
    }
    const single = t.properties.pipeline?.pipelineReference?.referenceName;
    if (single) refs.push(single);
    for (const n of refs) {
      // First Started trigger wins; otherwise keep whatever we have.
      const existing = m.get(n);
      if (!existing || (existing.properties.runtimeState !== 'Started' && t.properties.runtimeState === 'Started')) {
        m.set(n, t);
      }
    }
  }
  return m;
}

// ---------------------------------------------------------------------------
// KQL — exact column projections, grounded in the LA table schemas
// ---------------------------------------------------------------------------

function adfKql(days: number): string {
  return `
ADFPipelineRun
| where TimeGenerated >= ago(${days}d)
| summarize arg_max(Start, *) by PipelineName
| project PipelineName, RunId, Status, Start, End, ErrorCode, ErrorMessage
`.trim();
}

function synapseKql(days: number): string {
  return `
SynapseIntegrationPipelineRuns
| where TimeGenerated >= ago(${days}d)
| summarize arg_max(Start, *) by PipelineName
| project PipelineName, RunId, Status, Start, End
`.trim();
}

function rowsFromLa(res: LogQueryResult, source: 'adf' | 'synapse'): RefreshSummaryRow[] {
  const at = indexer(res);
  return res.rows.map((r) => {
    const start = cell(r, at('Start'));
    const end = cell(r, at('End'));
    const name = cell(r, at('PipelineName')) || '(unnamed)';
    const errCode = cell(r, at('ErrorCode'));
    const errMsg = cell(r, at('ErrorMessage'));
    return {
      pipelineName: name,
      displayName: name,
      itemType: source === 'adf' ? 'data-pipeline' : 'synapse-pipeline',
      source,
      lastRunId: cell(r, at('RunId')),
      lastRunAt: start,
      lastRunEnd: end,
      lastRunStatus: cell(r, at('Status')),
      lastRunDurationMs: durationMs(start, end),
      lastRunError: errCode || errMsg ? [errCode, errMsg].filter(Boolean).join(': ') : undefined,
    } satisfies RefreshSummaryRow;
  });
}

// ---------------------------------------------------------------------------
// Cosmos enrichment — friendly names (best-effort, never blocks the response)
// ---------------------------------------------------------------------------

async function enrich(rows: RefreshSummaryRow[], tenantId: string): Promise<void> {
  if (rows.length === 0) return;
  try {
    const wsC = await workspacesContainer();
    const { resources: workspaces } = await wsC.items
      .query<{ id: string; name: string }>({
        query: 'SELECT c.id, c.name FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      })
      .fetchAll();
    const wsIds = workspaces.map((w) => w.id);
    const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
    if (wsIds.length === 0) return;

    const itemsC = await itemsContainer();
    const { resources: items } = await itemsC.items
      .query<{ displayName: string; itemType: string; workspaceId: string; state?: Record<string, unknown> }>({
        query:
          "SELECT c.displayName, c.itemType, c.workspaceId, c.state FROM c " +
          "WHERE ARRAY_CONTAINS(@wsIds, c.workspaceId) AND " +
          "c.itemType IN ('data-pipeline', 'adf-pipeline', 'dataflow', 'synapse-pipeline', 'pipeline')",
        parameters: [{ name: '@wsIds', value: wsIds }],
      })
      .fetchAll();

    // Index by displayName and by last-run id for the join.
    const byName = new Map<string, { displayName: string; itemType: string; workspaceId: string }>();
    const byRunId = new Map<string, { displayName: string; itemType: string; workspaceId: string }>();
    for (const it of items) {
      const meta = { displayName: it.displayName, itemType: it.itemType, workspaceId: it.workspaceId };
      if (it.displayName) byName.set(it.displayName, meta);
      const lastRunId = it.state?.['lastRunId'];
      if (typeof lastRunId === 'string') byRunId.set(lastRunId, meta);
    }

    for (const row of rows) {
      const match =
        (row.lastRunId ? byRunId.get(row.lastRunId) : undefined) || byName.get(row.pipelineName);
      if (match) {
        row.displayName = match.displayName || row.displayName;
        row.itemType = match.itemType || row.itemType;
        row.workspaceId = match.workspaceId;
        row.workspaceName = wsName.get(match.workspaceId);
      }
    }
  } catch {
    // Enrichment is cosmetic — a Cosmos hiccup must never fail the summary.
  }
}

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const days = Math.min(30, Math.max(1, Number(sp.get('days')) || 7));
  const wsFilter = (sp.get('workspace') || '').trim();
  const statusFilter = (sp.get('status') || '').trim().toLowerCase();
  const timespan = `P${days}D`;

  try {
    // 1) Run history from Log Analytics. ADF is always queried; Synapse only
    //    when a Synapse workspace is configured (the table is empty otherwise).
    const synapseConfigured = Boolean((process.env.LOOM_SYNAPSE_WORKSPACE || '').trim());
    const queries: Promise<RefreshSummaryRow[]>[] = [
      queryLogs(adfKql(days), timespan).then((r) => rowsFromLa(r, 'adf')),
    ];
    if (synapseConfigured) {
      queries.push(queryLogs(synapseKql(days), timespan).then((r) => rowsFromLa(r, 'synapse')));
    }
    const grouped = await Promise.all(queries);
    let rows: RefreshSummaryRow[] = grouped.flat();

    // 2) Next-run + cadence from real ADF triggers (optional — skip if ADF env unset).
    const adfGate = adfConfigGate();
    const adfConfigured = adfGate === null;
    if (adfConfigured) {
      try {
        const triggers = await listTriggers();
        const tmap = buildTriggerMap(triggers);
        const now = Date.now();
        for (const row of rows) {
          const t = tmap.get(row.pipelineName);
          if (!t) continue;
          row.triggerName = t.name;
          row.triggerType = t.properties.type;
          row.triggerState = t.properties.runtimeState;
          row.recurrenceDesc = recurrenceDesc(t);
          const next = computeNextRun(t, now);
          if (next) row.nextRunAt = next;
        }
      } catch {
        // Trigger read is best-effort; run history still renders without next-run.
      }
    }

    // 3) Friendly-name enrichment from Cosmos (best-effort).
    await enrich(rows, s.claims.oid);

    // 4) Server-side filters.
    if (wsFilter) rows = rows.filter((r) => (r.workspaceName || r.workspaceId) === wsFilter);
    if (statusFilter) rows = rows.filter((r) => (r.lastRunStatus || '').toLowerCase() === statusFilter);

    // 5) Sort: most-recent run first; un-run items last.
    rows.sort((a, b) => {
      const ta = a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0;
      const tb = b.lastRunAt ? new Date(b.lastRunAt).getTime() : 0;
      return tb - ta;
    });

    // Distinct facets for the UI dropdowns (pre-filter set is recomputed client-side,
    // but we hand the server's view of workspaces for convenience).
    const workspaces = Array.from(
      new Set(rows.map((r) => r.workspaceName || r.workspaceId).filter(Boolean) as string[]),
    ).sort();

    return NextResponse.json({
      ok: true,
      adfConfigured,
      synapseConfigured,
      days,
      total: rows.length,
      workspaces,
      rows,
    });
  } catch (e) {
    // Honest gate: LA workspace not configured → name the exact env var.
    if (e instanceof MonitorNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        gate: {
          missing: e.missing,
          message:
            'Refresh history reads pipeline/dataflow run tables from Log Analytics. ' +
            'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID on the Console container app and ensure ' +
            'ADF/Synapse diagnostic settings route PipelineRuns to that workspace.',
        },
      });
    }
    const status = e instanceof MonitorError ? e.status : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
