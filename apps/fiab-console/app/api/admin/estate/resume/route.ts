/**
 * POST /api/admin/estate/resume — bring the paused Loom estate back up.
 *
 * ── THE ONE THING THIS ROUTE MUST NEVER DO ─────────────────────────────────
 * Report success it has not established. Resume is a ~15-minute operation at
 * best (ADX ~10 min plus unbounded hot-cache rehydration; a Synapse pool
 * "several minutes", and it reports `ONLINE` 2-3 minutes BEFORE it can serve a
 * query). No HTTP request that starts a resume can possibly know how it ended.
 *
 * So this route returns **202 Accepted** with the estate in `RESUMING` and a
 * `monitorUrl`. `GET /api/admin/estate/state` is what confirms the outcome, and
 * it produces `RUNNING` only when EVERY resource passes BOTH an authoritative
 * ARM read AND a real data-plane probe. Anything less is `RESUME_FAILED`
 * (R-CAP-4) — a distinct, loud state with a per-resource remediation, never a
 * spinner that eventually says "done".
 *
 * ── AND THE THING IT MUST BE ABLE TO DO ────────────────────────────────────
 * Work when the pause did not. Azure does not reserve capacity while a resource
 * is stopped: on 2026-08-22 the GCC-High ADX cluster auto-stopped and could not
 * restart (`InsufficientResourcesForSubscription`). When that happens the
 * response CLASSIFIES the failure and names the declared fallback SKU rather
 * than emitting a stack trace. Applying the fallback automatically (R-CAP-2) is
 * a tracked follow-up and is deliberately NOT done here — Loom will not change
 * the operator's SKU without being asked.
 *
 * Authorization is `withTenantAdmin` — the wrapper, never an inline check. No
 * typed confirmation: resume is the SAFE direction, and per PRP §5 an operator
 * must always be able to bring the estate back with one click.
 *
 * ── AND IT IS DELIBERATELY *NOT* BEHIND `LOOM_ESTATE_PAUSE_ENABLED` ───────
 * The pause route is. This one is not, and that asymmetry is the point: the
 * arming switch exists to stop an unvalidated feature from STOPPING things, not
 * to stop an operator from starting them again. Gating resume would mean an
 * estate paused while the flag was set becomes unrecoverable through the
 * product the moment someone unsets it — turning a safety control into an
 * outage. Resume is transitively gated anyway: it needs a persisted snapshot,
 * and only a gated pause can create one.
 *
 * ── CLOUD BOUNDARY ─────────────────────────────────────────────────────────
 * Cloud-agnostic via `armBase()`, but **Azure Government is UNTESTED** — no Gov
 * deploy, no Gov ARM call. Named as untested per `cloud-parity.md`; PRP work
 * item W7 owns the Gov path.
 *
 * Dual audit per §7: `auditLogContainer()` (Cosmos) + `emitAuditEvent()` (SIEM).
 */
import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiConflict, apiHonestError } from '@/lib/api/respond';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { randomId } from '@/lib/util/random-id';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { tenantScopeId } from '@/lib/auth/session';
import {
  armGateMessage,
  createArmActuator,
  loadPauseSnapshot,
  savePauseSnapshot,
  startResume,
  TYPICAL_RESUME_SECONDS,
  type EstateActuator,
} from '@/lib/estate/pause-orchestrator';
import { classifyActuationFailure, remediationFor } from '@/lib/estate/capacity-preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function audit(tenantId: string, who: string, kind: string, fields: Record<string, unknown>) {
  try {
    const c = await auditLogContainer();
    await c.items.create({
      id: randomId('audit', 8),
      itemId: 'loom-estate-pause',
      tenantId,
      who,
      at: new Date().toISOString(),
      kind,
      ...fields,
    }).catch(() => {});
  } catch { /* best-effort; never blocks the operation */ }
}

export const POST = withTenantAdmin(async (_req: NextRequest, { session }) => {
  const tenantId = tenantScopeId(session);
  const who = session.claims.upn || session.claims.email || session.claims.oid;

  const snapshot = await loadPauseSnapshot(tenantId).catch(() => null);
  if (!snapshot) {
    return apiError(
      'There is no pause snapshot for this tenant, so there is nothing to resume. Loom restores an '
        + 'estate from the snapshot it captured at pause time — it does not guess at what the estate '
        + 'used to look like.',
      404,
    );
  }
  if (snapshot.state === 'RUNNING') {
    return apiConflict(
      'The estate is already RUNNING. Nothing to resume.',
    );
  }
  if (snapshot.state === 'RESUMING') {
    return apiConflict(
      'A resume is already in flight. Poll /api/admin/estate/state — issuing a second resume would '
        + 'restart the settle window and hide how long the first one has actually been running.',
    );
  }
  if (snapshot.resources.length === 0) {
    // Defence in depth. `startPause` refuses to persist an empty PAUSING
    // snapshot precisely so this cannot happen, because `deriveResumeState`
    // returns RUNNING for an empty resource list — a whole no-op that would
    // render as a successful resume.
    return apiConflict(
      'The pause snapshot contains ZERO resources, so a "successful" resume of it would establish '
        + 'nothing. Refusing to report success over an empty snapshot.',
    );
  }

  let actuator: EstateActuator;
  try {
    actuator = await createArmActuator();
  } catch (e) {
    return apiHonestError(e, 503, armGateMessage(e));
  }

  await audit(tenantId, who, 'estate-resume.start', {
    estateId: snapshot.estateId,
    snapshotId: snapshot.id,
    resources: snapshot.resources.map((r) => r.resourceId),
  });

  const run = await startResume(snapshot, actuator);
  await savePauseSnapshot(run.snapshot);

  const failed = run.dispatches.filter((d) => d.status === 'failed');
  const byId = new Map(snapshot.resources.map((r) => [r.resourceId, r]));

  // R6 — classify every rejection and hand back a concrete remediation now,
  // rather than making the operator wait out the poll to learn it was refused.
  const failures = failed.map((d) => {
    const { kind } = classifyActuationFailure(d.error);
    const entry = byId.get(d.resourceId);
    return {
      resourceId: d.resourceId,
      name: d.name,
      kind,
      error: d.error,
      remediation: entry
        ? remediationFor(kind, entry, d.error)
        : `${d.name} is not in the snapshot, so no remediation could be derived.`,
    };
  });

  await audit(tenantId, who, failed.length ? 'estate-resume.partial-dispatch' : 'estate-resume.dispatched', {
    estateId: snapshot.estateId,
    snapshotId: snapshot.id,
    dispatches: run.dispatches.map((d) => ({ id: d.resourceId, status: d.status, error: d.error })),
    failureKinds: failures.map((f) => f.kind),
  });
  emitAuditEvent({
    actorOid: session.claims.oid,
    actorUpn: who,
    action: 'platform.estate-resume',
    targetType: 'loom-estate',
    targetId: snapshot.estateId,
    tenantId: session.claims.tid || tenantId,
    outcome: failed.length ? 'failure' : 'success',
    detail: {
      snapshotId: snapshot.id,
      dispatched: run.dispatches.filter((d) => d.status === 'dispatched').length,
      failed: failed.length,
      failureKinds: failures.map((f) => f.kind),
    },
  });

  const eta = Math.max(
    0,
    ...snapshot.resources.map((r) => TYPICAL_RESUME_SECONDS[r.resourceType.toLowerCase()] ?? 0),
  );

  return apiOk(
    {
      // RESUMING. Never RUNNING — this response cannot know.
      state: run.snapshot.state,
      estateId: snapshot.estateId,
      snapshotId: snapshot.id,
      dispatches: run.dispatches,
      failures,
      monitorUrl: '/api/admin/estate/state',
      typicalResumeSeconds: TYPICAL_RESUME_SECONDS,
      etaSeconds: eta,
      message:
        `Resume dispatched. The estate is RESUMING — typically about ${Math.round(eta / 60)} minute(s) `
        + 'for the slowest resource, though Microsoft publishes no guaranteed figure and ADX cache '
        + 'rehydration is unbounded. Poll /api/admin/estate/state: it reports RUNNING only once every '
        + 'resource passes BOTH an ARM read and a real request to the service, and RESUME_FAILED '
        + 'otherwise.'
        + (failed.length
          ? ` ${failed.length} resource(s) were REJECTED at dispatch — see \`failures\` for the class `
            + 'and the remediation of each.'
          : ''),
    },
    { status: 202 },
  );
});
