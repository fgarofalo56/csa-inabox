// Engine drift reconciler (#5482 item 6). A rendered engine revision can move without any job running: a control-plane release that
// changes what is rendered (the edge-router NetworkPolicy peer of #5481 is the measured case, a tenant on dev01 answering 504 through
// the router because its old policy drops it), a stamp baseUrl or quota PATCH, a re-created tenant identity. Nothing re-applied such an
// engine: applyAndVerify only runs inside a job, and the console's self-heal stops at an engine that is `ready`. auto-bind-by-default
// item 3 says a stale binding repairs itself, so the control plane compares and re-applies on its own, at startup and on a timer.
//
// One pass:
//   - per HEALTHY stamp that has tenants, ONE runCommand lists every managed engine Deployment with its annotations
//     (FhirEngineHost.listEngineConfigs). The deployed annotation is the truth this compares against: it is what the engine runs, and it
//     is the only record of a tenant's overrides and partitions, which the fresh render needs. A revision "recorded at the last
//     successful apply" would be cheaper only for the revision itself, would still need this read for the render inputs, and does not
//     exist for any engine applied before this change (the dev01 tenant is one), so it is not used.
//   - per ACTIVE tenant with an engine, the same resolve + render the jobs use (two ARM deployment reads: stamp and tenant manifest). A
//     tenant that is creating, draining, suspended or destroying is never touched; neither is an engine whose annotations do not parse.
//   - when the rendered revision differs from the running one, submit fhir-tenant.reconcile with an idempotency key derived from the
//     rendered revision, the running revision and the UTC day. The job id is a hash of (kind, tenant, key), so every replica and every
//     restart that observes the same drift on the same day lands on the SAME job record (the store's create is conditional; the loser
//     gets the winner's record). The day term lets a drift that recurs after a successful reconcile, or a job that exhausted its retries,
//     be tried again the next day instead of never.
//   - at most RECONCILE_MAX_INFLIGHT reconcile jobs are queued or running (read from the job store, so it counts other replicas' jobs
//     too). A stamp with N stale tenants is worked through over several passes, never N concurrent applies at boot. Two replicas starting
//     together can each read the count before the other submits, so the hard ceiling is replicas x RECONCILE_MAX_INFLIGHT (4 at
//     maxReplicas 2). The jobs themselves stay in TENANT_ENGINE_GROUP, so per tenant they serialise with every other engine job (#5442).
//   - a failed reconcile job is retried while its attempts are below RECONCILE_MAX_ATTEMPTS; retry() is etag-guarded, so two replicas
//     cannot both re-queue it.
//
// Fail closed: a stamp that cannot be listed, or a tenant that cannot be rendered, is logged with its code and skipped. Nothing here
// changes an engine; only the job does, and the job re-reads and re-renders before it applies.

import { HttpError } from '../http/errors.js';
import type { JobRunner } from './runner.js';
import { RECONCILE_KIND, renderedRevisionFor, type FhirTenantJobDeps } from './fhir-tenant-jobs.js';
import { JobFailure } from './types.js';

export const RECONCILE_MAX_INFLIGHT = 2;
export const RECONCILE_MAX_ATTEMPTS = 3;
/** One pass costs one runCommand per healthy stamp plus two ARM deployment reads per active tenant with an engine, per replica. */
export const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;
export const RECONCILE_REQUESTED_BY = 'system:engine-reconciler';

const REVISION = /^[0-9a-f]{64}$/;

export interface ReconcileDeps extends FhirTenantJobDeps {
  jobs: Pick<JobRunner, 'submit' | 'retry' | 'list'>;
  log: (event: string, fields: Record<string, string | number>) => void;
  now: () => Date;
  maxInflight?: number;
  maxAttempts?: number;
}

export interface ReconcilePass {
  /** Tenants whose engine runs the revision this control plane renders. */
  current: string[];
  /** A new reconcile job was created. */
  submitted: string[];
  /** A failed reconcile job for the same drift was re-queued. */
  retried: string[];
  /** A reconcile job for the same drift is already queued or running (this or another replica). */
  pending: string[];
  /** Stale, but the in-flight ceiling was reached; a later pass takes it. */
  deferred: string[];
  /** Stale, and today's job for this drift already ended without fixing it (succeeded, or failed out of attempts). */
  stuck: string[];
  skipped: Array<{ tenantId: string; reason: string }>;
  /** Stamps that were not listed, with the code why. */
  unlisted: Array<{ stampId: string; reason: string }>;
}

/** `rev:<rendered 32 hex>:<running 32 hex>:<yyyymmdd UTC>`: 78 chars, inside the runner's 80-char key limit. */
export function reconcileKey(rendered: string, running: string, now: Date): string {
  return `rev:${rendered.slice(0, 32)}:${running.slice(0, 32)}:${now.toISOString().slice(0, 10).replaceAll('-', '')}`;
}

function codeOf(e: unknown): string {
  if (e instanceof JobFailure) return e.code;
  if (e instanceof HttpError) return `http_${e.status}`;
  return e instanceof Error ? e.name : 'unknown';
}

export async function reconcileEnginesOnce(d: ReconcileDeps): Promise<ReconcilePass> {
  const max = d.maxInflight ?? RECONCILE_MAX_INFLIGHT;
  const maxAttempts = d.maxAttempts ?? RECONCILE_MAX_ATTEMPTS;
  const out: ReconcilePass = { current: [], submitted: [], retried: [], pending: [], deferred: [], stuck: [], skipped: [], unlisted: [] };
  let inflight = (await d.jobs.list()).filter((j) => j.kind === RECONCILE_KIND && (j.state === 'queued' || j.state === 'running')).length;
  const tenants = await d.tenants.list(500);
  const skip = (tenantId: string, reason: string): void => {
    out.skipped.push({ tenantId, reason });
    d.log('engine_reconcile.skipped', { tenant: tenantId, reason });
  };

  for (const stamp of await d.stamps.list(500)) {
    const onStamp = tenants.filter((t) => t.stampId === stamp.id);
    if (onStamp.length === 0) continue;
    if (stamp.status !== 'healthy') {
      out.unlisted.push({ stampId: stamp.id, reason: `stamp_${stamp.status}` });
      continue;
    }
    let listed;
    try {
      listed = await d.engine.listEngineConfigs(stamp.id);
    } catch (e) {
      out.unlisted.push({ stampId: stamp.id, reason: codeOf(e) });
      d.log('engine_reconcile.list_failed', { stamp: stamp.id, code: codeOf(e) });
      continue;
    }
    const byTenant = new Map(listed.map((l) => [l.tenantId, l]));
    for (const t of onStamp) {
      const engine = byTenant.get(t.id);
      if (!engine) continue; // no engine: creating one is fhir-tenant.create's job, not a reconcile's
      if (t.status !== 'active') {
        skip(t.id, `tenant_${t.status}`);
        continue;
      }
      if (!engine.config) {
        skip(t.id, engine.problem ?? 'engine_unreadable');
        continue;
      }
      const running = engine.config.revision;
      if (!REVISION.test(running)) {
        skip(t.id, 'engine_revision_unrecognised');
        continue;
      }
      if (!engine.config.partitioning) {
        skip(t.id, 'partition_mode_off'); // applyAndVerify would refuse it (ADR-003); a job would only fail
        continue;
      }
      try {
        const rendered = await renderedRevisionFor(d, t.id, engine.config);
        if (rendered === running) {
          out.current.push(t.id);
          continue;
        }
        if (inflight >= max) {
          out.deferred.push(t.id);
          continue;
        }
        const { job, created } = await d.jobs.submit({
          kind: RECONCILE_KIND,
          subjectType: 'tenant',
          subjectId: t.id,
          idempotencyKey: reconcileKey(rendered, running, d.now()),
          input: { expectedRevision: rendered, runningRevision: running },
          requestedBy: RECONCILE_REQUESTED_BY,
        });
        if (created) {
          inflight++;
          out.submitted.push(t.id);
          d.log('engine_reconcile.submitted', { tenant: t.id, jobId: job.id, rendered: rendered.slice(0, 12), running: running.slice(0, 12) });
        } else if (job.state === 'queued' || job.state === 'running') {
          out.pending.push(t.id);
        } else if (job.state === 'failed' && job.attempts < maxAttempts) {
          try {
            await d.jobs.retry(job.id);
            inflight++;
            out.retried.push(t.id);
            d.log('engine_reconcile.retried', { tenant: t.id, jobId: job.id, attempts: job.attempts, code: job.error?.code ?? 'unknown' });
          } catch (e) {
            if (!(e instanceof HttpError && e.status === 409)) throw e;
            out.pending.push(t.id); // another replica re-queued it first
          }
        } else {
          out.stuck.push(t.id);
          d.log('engine_reconcile.stuck', { tenant: t.id, jobId: job.id, state: job.state, attempts: job.attempts, code: job.error?.code ?? 'none' });
        }
      } catch (e) {
        skip(t.id, codeOf(e));
      }
    }
  }
  d.log('engine_reconcile.pass', {
    current: out.current.length,
    submitted: out.submitted.length,
    retried: out.retried.length,
    pending: out.pending.length,
    deferred: out.deferred.length,
    stuck: out.stuck.length,
    skipped: out.skipped.length,
    unlisted: out.unlisted.length,
  });
  return out;
}

/** Run a pass now (startup) and every `intervalMs`. Passes never overlap in one process. Returns the stop function. */
export function scheduleEngineReconcile(
  pass: () => Promise<unknown>,
  log: (event: string, fields: Record<string, string | number>) => void,
  intervalMs = RECONCILE_INTERVAL_MS,
): () => void {
  let busy = false;
  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await pass();
    } catch (e) {
      log('engine_reconcile.error', { code: codeOf(e) });
    } finally {
      busy = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
