/**
 * Asynchronous, pollable `loom-docs` reindex job (#2929).
 *
 * WHY THIS EXISTS
 * ---------------
 * `POST /api/help-copilot/reindex` used to BLOCK for the whole corpus rebuild
 * (the route still declares `maxDuration = 300`). Front Door does not wait that
 * long: `platform/fiab/bicep/modules/admin-plane/front-door.bicep` never sets
 * `originResponseTimeoutSeconds`, so the AFD default (60s) applies — a full
 * rebuild of ~2.5k markdown files into tens of thousands of AI Search documents
 * cannot finish inside it, and the caller gets an EDGE 502 with no way to tell
 * "still building" from "crashed". A CI step that cannot distinguish those two
 * either fails on a healthy reindex or (worse) tolerates a broken one and
 * measures a stale index.
 *
 * So the POST now ACCEPTS the work (202) and returns immediately; callers poll
 * `GET /api/help-copilot/reindex` for terminal state. No gateway timeout is on
 * the critical path any more.
 *
 * REPLICA SCOPE — READ THIS BEFORE TRUSTING `getReindexJobStatus()`
 * ----------------------------------------------------------------
 * This status is **per-replica, in-memory**. The console runs multiple replicas
 * behind Front Door / ACA ingress, so a POST can land on replica A and a poll on
 * replica B, where the job is `idle` and always will be. Treating `idle` as
 * "finished" would be a poller that reports success having observed nothing —
 * the exact defect class this issue is about.
 *
 * Therefore the AUTHORITATIVE cross-replica completion signal is the DURABLE
 * corpus manifest, surfaced as `corpusFreshness()` → `state:'fresh'` (the
 * manifest is written into the same store as the chunks, so any replica sees
 * it). This module's job status is the *diagnostic + fast-fail* channel: it can
 * prove a run FAILED (and why) and that a run is in flight on this replica, but
 * only freshness can prove it SUCCEEDED. The route returns both and the CI
 * poller gates on freshness; see `scripts/ci/classify-reindex-result.mjs`.
 *
 * The background promise survives the HTTP response because the console is a
 * long-lived Node process on Container Apps (not a freeze-after-response
 * serverless host). If the replica is nevertheless recycled mid-run, freshness
 * simply never flips and the poller times out — which the classifier treats as
 * a FAILURE, never as a pass.
 */
import crypto from 'node:crypto';
import type { ReindexResult } from '@/lib/azure/loom-docs-index';

export type ReindexJobState = 'idle' | 'running' | 'succeeded' | 'failed';

export interface ReindexJobStatus {
  /** `idle` also means "no run has been started ON THIS REPLICA" — never read it as "done". */
  state: ReindexJobState;
  /** Opaque id of the most recent run started on this replica (null when idle). */
  jobId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Terminal result of the last completed run on this replica. */
  result: ReindexResult | null;
  /** Terminal error of the last failed run on this replica. */
  error: string | null;
}

interface JobRecord extends ReindexJobStatus {
  promise: Promise<void> | null;
}

const IDLE: JobRecord = {
  state: 'idle',
  jobId: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  result: null,
  error: null,
  promise: null,
};

let job: JobRecord = { ...IDLE };

/** Snapshot of the current job — never exposes the in-flight promise. */
export function getReindexJobStatus(): ReindexJobStatus {
  const { promise: _promise, ...status } = job;
  return { ...status };
}

export interface StartReindexJobOutcome {
  jobId: string;
  startedAt: string;
  /** True when a run was ALREADY in flight on this replica — the POST is idempotent. */
  alreadyRunning: boolean;
}

/**
 * Start a reindex in the background and return its handle immediately.
 *
 * Idempotent-by-restart: while a run is in flight on this replica the existing
 * handle is returned instead of starting a second concurrent rebuild (two
 * concurrent full rebuilds would race on the shared manifest). Once a run has
 * reached a terminal state a new POST starts a fresh one — so a failed run is
 * always retryable without an admin having to reset anything.
 *
 * `run` is injected so tests exercise the state machine without touching AI
 * Search / Cosmos.
 */
export function startReindexJob(run: () => Promise<ReindexResult>): StartReindexJobOutcome {
  if (job.state === 'running' && job.promise) {
    return { jobId: job.jobId!, startedAt: job.startedAt!, alreadyRunning: true };
  }

  const jobId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  const finish = (patch: Partial<JobRecord>) => {
    // Ignore a late completion from a SUPERSEDED run (a replica-recycle edge):
    // only the currently-tracked job may write its own terminal state.
    if (job.jobId !== jobId) return;
    const finishedAt = new Date().toISOString();
    job = {
      ...job,
      ...patch,
      finishedAt,
      durationMs: Date.now() - startedMs,
      promise: null,
    };
  };

  // Register as running BEFORE awaiting anything so a second POST arriving in
  // the same tick sees `running` rather than starting a duplicate rebuild.
  job = {
    state: 'running',
    jobId,
    startedAt,
    finishedAt: null,
    durationMs: null,
    result: null,
    error: null,
    promise: null,
  };

  const promise = (async () => {
    try {
      const result = await run();
      finish({
        state: result.ok ? 'succeeded' : 'failed',
        result,
        error: result.ok ? null : result.error || 'reindex reported ok:false',
      });
    } catch (e: unknown) {
      finish({
        state: 'failed',
        result: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  })();

  // Never let an unhandled rejection take the process down; `finish` above has
  // already recorded the failure.
  promise.catch(() => {});
  job = { ...job, promise };

  return { jobId, startedAt, alreadyRunning: false };
}

/** Test-only: reset the module singleton between cases. */
export function __resetReindexJob(): void {
  job = { ...IDLE };
}

/** Test-only: await the in-flight run (no-op when idle/terminal). */
export async function __awaitReindexJob(): Promise<void> {
  await job.promise;
}
