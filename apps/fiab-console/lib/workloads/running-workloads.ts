/**
 * Running-workloads model + pure classification helpers (shell switcher).
 *
 * A running notebook or pipeline executes SERVER-SIDE (a Synapse Livy session,
 * an AML/Databricks job, or an Azure Data Factory pipeline run) — its lifetime
 * is NOT tied to the editor being mounted. Navigating away therefore never ends
 * the run; the run keeps going and its state stays fetchable by id. This module
 * turns the two real, already-persisted sources of truth into a single list the
 * app-shell switcher renders so the user can jump BACK to any in-flight run:
 *
 *   • Notebooks  — `state.pendingRuns` on the notebook item (Cosmos). The run
 *     route persists a per-run entry when a cell/notebook is dispatched and the
 *     poll route deletes it on terminal Livy/session state. A live entry ⇒ the
 *     run is (or very recently was) executing.
 *   • Pipelines  — live Azure Data Factory pipeline-run status (the ADF monitor
 *     API is the single source of truth), matched back to the owning Loom item
 *     by the bound factory-pipeline name. No mirror state to drift.
 *
 * Everything here is pure (no I/O) so it is unit-testable; the BFF route wires
 * the Cosmos query + the ADF call to these functions.
 */

/** One in-flight notebook or pipeline the user can navigate back to. */
export interface RunningWorkload {
  workspaceId: string;
  itemId: string;
  itemType: string;
  displayName: string;
  /** Coarse family for the switcher icon/grouping. */
  kind: 'notebook' | 'pipeline';
  /** The real run identifier (Livy `spark:pool:session`, ADF runId, …). */
  runId: string;
  /** Live status: 'running' for notebooks, the ADF status for pipelines. */
  status: string;
  /** ISO start time when known (earliest pending run / ADF runStart). */
  startedAt?: string;
  /** Deep link the switcher opens — the editor re-attaches to the run id. */
  href: string;
}

/** Minimal projected notebook item shape the classifier needs. */
export interface NotebookRunItem {
  id: string;
  workspaceId: string;
  itemType?: string;
  displayName?: string;
  pendingRuns?: Record<string, { startedAt?: string } | null> | null;
}

/** Minimal projected pipeline item shape (a bound Loom pipeline). */
export interface PipelineBindItem {
  id: string;
  workspaceId: string;
  itemType?: string;
  displayName?: string;
  /** ADF pipeline name this item is bound to (data-pipeline vs adf-pipeline). */
  adfPipelineName?: string;
  pipelineName?: string;
}

/** Minimal ADF pipeline-run shape (subset of adf-client's AdfPipelineRun). */
export interface AdfRunLite {
  runId: string;
  pipelineName: string;
  status?: string;
  runStart?: string;
}

/**
 * ADF pipeline-run statuses that mean "still going". Terminal states
 * (Succeeded / Failed / Cancelled) are excluded so the switcher only ever
 * lists genuinely-active runs.
 */
const ACTIVE_PIPELINE_STATES = new Set(['Queued', 'InProgress', 'Cancelling']);

export function isPipelineRunActive(status?: string): boolean {
  return typeof status === 'string' && ACTIVE_PIPELINE_STATES.has(status);
}

/** Deep link to the item editor. Opening it re-attaches to the live run. */
export function itemHref(itemType: string, itemId: string): string {
  return `/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}`;
}

/**
 * The earliest `startedAt` across a notebook's pending runs (so the switcher
 * shows how long the notebook has been running), and the representative runId.
 * Returns null when there is no live pending run.
 */
function summarizeNotebookPending(
  pendingRuns: NotebookRunItem['pendingRuns'],
  staleBeforeIso?: string,
): { runId: string; startedAt?: string } | null {
  if (!pendingRuns || typeof pendingRuns !== 'object') return null;
  let best: { runId: string; startedAt?: string } | null = null;
  for (const [runId, entry] of Object.entries(pendingRuns)) {
    if (!runId || !entry || typeof entry !== 'object') continue;
    const startedAt = typeof entry.startedAt === 'string' ? entry.startedAt : undefined;
    // Drop zombie entries: a run that started before the staleness cutoff and
    // was never cleaned (editor closed mid-run, session later reaped). The
    // longest a run can execute is bounded, so an older entry is not live.
    if (staleBeforeIso && startedAt && startedAt < staleBeforeIso) continue;
    if (!best) { best = { runId, startedAt }; continue; }
    // Prefer the earliest start (the run the user most wants to get back to).
    if (startedAt && (!best.startedAt || startedAt < best.startedAt)) best = { runId, startedAt };
  }
  return best;
}

/**
 * Turn projected notebook items into running-workload rows. A notebook is
 * "running" when it has at least one non-stale entry in `state.pendingRuns`.
 *
 * @param staleBeforeIso  ISO cutoff; pending runs started before it are ignored.
 */
export function collectRunningNotebooks(
  items: NotebookRunItem[],
  staleBeforeIso?: string,
): RunningWorkload[] {
  const out: RunningWorkload[] = [];
  for (const it of items || []) {
    if (!it || !it.id || !it.workspaceId) continue;
    const summary = summarizeNotebookPending(it.pendingRuns, staleBeforeIso);
    if (!summary) continue;
    const itemType = it.itemType || 'notebook';
    out.push({
      workspaceId: it.workspaceId,
      itemId: it.id,
      itemType,
      displayName: it.displayName || 'Untitled notebook',
      kind: 'notebook',
      runId: summary.runId,
      status: 'running',
      startedAt: summary.startedAt,
      href: itemHref(itemType, it.id),
    });
  }
  return out;
}

/**
 * Match live ADF pipeline runs back to the Loom pipeline items that own them.
 * Only ACTIVE runs are emitted, and only when the run's factory-pipeline name
 * is bound to a Loom item the caller can see. Multiple concurrent runs of the
 * same pipeline each surface as their own row (distinct runId).
 */
export function matchRunningPipelines(
  pipelineItems: PipelineBindItem[],
  adfRuns: AdfRunLite[],
): RunningWorkload[] {
  // name → owning Loom item. Last-writer-wins is fine: a factory pipeline name
  // is bound to a single Loom item in normal use.
  const byName = new Map<string, PipelineBindItem>();
  for (const it of pipelineItems || []) {
    if (!it || !it.id || !it.workspaceId) continue;
    const name = it.adfPipelineName || it.pipelineName;
    if (name) byName.set(name, it);
  }
  const out: RunningWorkload[] = [];
  for (const run of adfRuns || []) {
    if (!run || !run.runId || !isPipelineRunActive(run.status)) continue;
    const owner = byName.get(run.pipelineName);
    if (!owner) continue;
    const itemType = owner.itemType || 'data-pipeline';
    out.push({
      workspaceId: owner.workspaceId,
      itemId: owner.id,
      itemType,
      displayName: owner.displayName || run.pipelineName || 'Untitled pipeline',
      kind: 'pipeline',
      runId: run.runId,
      status: run.status || 'InProgress',
      startedAt: run.runStart,
      href: itemHref(itemType, owner.id),
    });
  }
  return out;
}

/**
 * Merge + order the two sources for the switcher: most-recently-started first
 * (a stable, useful ordering), undated entries last.
 */
export function orderWorkloads(workloads: RunningWorkload[]): RunningWorkload[] {
  return [...workloads].sort((a, b) => {
    if (a.startedAt && b.startedAt) return b.startedAt.localeCompare(a.startedAt);
    if (a.startedAt) return -1;
    if (b.startedAt) return 1;
    return a.displayName.localeCompare(b.displayName);
  });
}
