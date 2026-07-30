/**
 * GET /api/items/spark-job-definition/[id]/runs/[runId]
 *
 * Fetches a single Livy batch by id against the SJD's configured Spark pool
 * and returns it with the driver `log[]` tail so the editor's Runs tab can
 * show live status + a log viewer. The pool comes from the persisted spec ONLY
 * — see SCOPE below.
 *
 * LU-8: on a SUCCEEDED batch that this item actually submitted, this also
 * harvests the run into OpenLineage and writes the resulting edges into the
 * unified-lineage store, so a Spark job's lineage shows up on the canvas
 * without waiting for an operator to stage the openlineage-spark listener onto
 * the pool. The harvest reads the batch's own `livyInfo.jobCreationRequest` —
 * the args + conf that were really submitted — deduped per run, non-throwing so
 * it can never turn a healthy status poll into an error.
 *
 * SCOPE (LU-8 remediation). Two caller-supplied values reach a Synapse
 * data-plane read that now WRITES lineage:
 *   - `?pool=` used to stand in for a missing `spec.pool`. Livy batches are
 *     visible to anyone who can read the pool, so the override let a caller
 *     read — and, once LU-8 landed, persist the `abfss://` paths of — batches
 *     on a pool their item was never bound to. The override is gone; the pool
 *     is whatever the item's own spec says, exactly as the sibling cancel route
 *     already required.
 *   - `runId` is a Livy batch id, which is POOL-scoped, not item-scoped: every
 *     SJD sharing a pool sees one id space. {@link batchBelongsToItem} proves
 *     the batch was submitted by THIS item before any lineage is written; an
 *     unattributed batch still renders its status (it is on the caller's own
 *     pool) but contributes no edges, and the receipt says why.
 *
 * ATTRIBUTION GATES DISCLOSURE, NOT ONLY THE WRITE (round-3 remediation).
 * The first cut of the gate above passed `batchBelongsToItem` to the harvest
 * and then returned the WHOLE `SparkBatchJob` regardless. That object carries
 * another team's secrets and topology: `livyInfo.jobCreationRequest` is the
 * argv + Spark conf as submitted (their `abfss://` input/output paths, and any
 * SAS or connection string passed as a job argument), `log[]` is the driver log
 * tail, plus `submitterName`, `tags`, `errorInfo`, `schedulerInfo`,
 * `pluginInfo`. Removing `?pool=` does NOT bound that: Livy ids are POOL-scoped
 * and this estate runs one shared pool, so every SJD on it sees one id space.
 * An unattributed batch therefore returns the SAME safe status projection the
 * sibling `/api/synapse/sparkjobdefinitions/[name]/run` route already returns
 * ({@link redactUnattributedBatch}) — enough to render "batch 41: running",
 * nothing that describes someone else's job.
 */

import { NextResponse } from 'next/server';
import { getSparkBatchJob, type SparkBatchJob } from '@/lib/azure/synapse-dev-client';
import { harvestSparkBatchLineage } from '@/lib/lineage/synapse-lineage-harvest';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { jerr } from '../../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'spark-job-definition';

/**
 * The batch `name` Loom stamps on every submit (see the submit route):
 * `loom-<displayName sanitized>-<epoch ms>`. That prefix is the only
 * attribution link between a pool-scoped Livy batch id and the Loom item that
 * submitted it.
 */
export function loomBatchNamePrefix(displayName: string): string {
  return `loom-${String(displayName || '').replace(/[^A-Za-z0-9_-]/g, '_')}-`;
}

/**
 * True when this Livy batch was demonstrably submitted by this Loom item.
 *
 * Conservative by construction: a batch submitted directly in Synapse Studio,
 * or by a DIFFERENT Loom item on the same pool, does not match and therefore
 * never contributes lineage to this item's workspace graph.
 */
export function batchBelongsToItem(
  item: { displayName?: string },
  job: { name?: string },
): boolean {
  const name = String(job?.name || '');
  if (!name || !item.displayName) return false;
  return name.startsWith(loomBatchNamePrefix(item.displayName));
}

/**
 * The projection returned for a batch this item did NOT submit.
 *
 * Allow-list, not a deny-list: a new field added to `SparkBatchJob` upstream
 * must not silently become disclosable. The kept fields are exactly the ones
 * the sibling `/api/synapse/sparkjobdefinitions/[name]/run` GET already
 * returns for a caller-supplied `?batch=` — scheduling facts about a job on a
 * pool the caller can read, with no description of what it read or wrote.
 *
 * Deliberately DROPPED: `livyInfo` (jobCreationRequest = argv + conf, i.e.
 * storage paths and any credential passed as a job argument), `log` (driver log
 * tail), `errorInfo` (stack traces quote paths), `tags`, `submitterId`,
 * `submitterName`, `schedulerInfo`, `pluginInfo`, `artifactId`, `name` (the
 * submitting item's display name).
 */
export function redactUnattributedBatch(job: SparkBatchJob): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    result: job.result,
    appId: job.appId ?? null,
    submittedAt: job.submittedAt,
    sparkPoolName: job.sparkPoolName,
    /** Honest: the UI must be able to say WHY the log viewer is empty. */
    redacted: true,
    redactedReason:
      'this Livy batch was not submitted by this Spark job definition — Livy batch ids are pool-scoped, ' +
      'so only status is shown. Open the run from the item that submitted it to see its arguments and driver log.',
  };
}

export const GET = withWorkspaceOwner<{ id: string; runId: string }>(ITEM_TYPE, async (_req, { session, params, item }) => {
  const batchId = Number(params.runId);
  if (!Number.isFinite(batchId)) return jerr('invalid runId', 400);
  try {
    const pool = (item.state as any)?.spec?.pool;
    if (!pool) return jerr('spec.pool is not configured', 400);
    const job = await getSparkBatchJob(pool, batchId);
    // ONE attribution decision drives BOTH the write and the disclosure — they
    // cannot drift apart, which is exactly how round 2 shipped a closed write
    // beside an open read.
    const attributed = batchBelongsToItem(item, job);

    // --- LU-8 lineage harvest (best-effort, deduped, never throws) ----------
    // `args`/`conf` come from what Livy says was SUBMITTED. When Livy omits
    // `jobCreationRequest` we do NOT fall back to the item's current stored
    // draft: that draft may have been edited after the run, and stamping it
    // would attribute a fabricated edge to a real run (no-vaporware).
    const submitted = (job.livyInfo?.jobCreationRequest || {}) as {
      args?: string[];
      conf?: Record<string, string>;
    };
    const lineage = await harvestSparkBatchLineage(session, {
      workspaceId: item.workspaceId,
      synapseWorkspaceName: job.workspaceName || process.env.LOOM_SYNAPSE_WORKSPACE || 'synapse',
      poolName: job.sparkPoolName || pool,
      batchId,
      jobName: job.name || item.displayName,
      state: job.state,
      args: submitted.args,
      conf: submitted.conf,
      eventTime: job.submittedAt,
      attributed,
    });

    return NextResponse.json({
      ok: true,
      pool,
      job: attributed ? job : redactUnattributedBatch(job),
      lineage,
    });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
});
