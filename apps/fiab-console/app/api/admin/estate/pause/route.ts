/**
 * POST /api/admin/estate/pause — pause the Loom estate (PAUSE tier only).
 *
 * ── WHAT THIS DOES AND WHAT IT REFUSES TO DO ───────────────────────────────
 * Does:    issues the NATIVE pause/stop/suspend verb on the resources this Loom
 *          install is positively established to own. Nothing is deleted, no SKU
 *          is changed, no data is touched.
 * Refuses: to act on anything not POSITIVELY identified as this estate's; to act
 *          on a set that changed since the operator saw the preview; to act
 *          without a typed confirmation; to report PAUSED on a dispatch.
 *
 * ── THE SAFETY GATES, IN THE ORDER THEY RUN ────────────────────────────────
 *   0. `LOOM_ESTATE_PAUSE_ENABLED` — THE ARMING SWITCH, unset by default in
 *      every cloud. The deploy DOES set every env var the manifest is built
 *      from (`LOOM_SYNAPSE_DEDICATED_POOL`, `LOOM_KUSTO_CLUSTER_NAME`,
 *      `LOOM_AAS_SERVER_NAME`, …), so without this gate merging would arm a
 *      one-click pause of ~$3,000/mo on an estate that auto-rolls on every
 *      merge, with no live receipt that resume works and R-CAP-2 unimplemented.
 *      See `ESTATE_PAUSE_ENABLED_ENV` for the full reasoning.
 *   1. `withTenantAdmin` — the wrapper, never an inline check. See the note in
 *      `../state/route.ts`: `enforceCapability`/`requireTenantAdmin` return
 *      `NextResponse | null`, so the authorization IS the caller's
 *      `if (gate) return gate;` line — and on 2026-08-07 deleting that one line
 *      left three separate route-guard checkers green over an open route. The
 *      wrapper takes the handler as an ARGUMENT, so there is no line to delete.
 *   2. `confirm` — a typed echo of the estate id. The repo's established
 *      destructive-action guard (`admin/scaling/adx/route.ts` echoes the cluster
 *      name). There is no per-route CSRF token in this codebase.
 *   3. `confirmToken` — a DRIFT guard, 409 on mismatch, exactly like
 *      `/api/admin/updates/apply`'s `confirmTag`. The operator confirmed a
 *      SPECIFIC set of resources; if the resolved set has changed since, we
 *      refuse rather than pause something they never saw. REQUIRED (#3989): an
 *      absent token is refused too, because the previous `body.confirmToken &&
 *      …` shape let any caller skip the gate by omitting the field while the
 *      error text still promised the guarantee it was no longer providing.
 *      #4243: the comparison is `evaluateDrift`, never a raw `!==` — a "the
 *      set changed" refusal is issued ONLY on a positively-observed change;
 *      a failed (throttled/unreachable) discovery read refuses with a RETRY
 *      message instead, and every refusal on this gate writes an audit row.
 *   4. Re-verify per resource, inside the orchestrator, immediately before each
 *      ARM call (R-SCOPE-3), and actuate the VERIFIED id (`assertActuationTarget`).
 *
 * Returns 202 with the per-resource dispatch results. The estate is left
 * PAUSING; `GET /api/admin/estate/state` is what confirms it reached PAUSED,
 * from fresh authoritative ARM reads.
 *
 * Dual audit per §7: `auditLogContainer()` (Cosmos) + `emitAuditEvent()` (SIEM).
 */
import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiConflict, apiHonestError } from '@/lib/api/respond';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { randomId } from '@/lib/util/random-id';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { tenantScopeId } from '@/lib/auth/session';
import {
  armGateMessage,
  createArmActuator,
  createManifestTagReader,
  discoverFromManifest,
  ESTATE_PAUSE_ENABLED_ENV,
  evaluateDrift,
  loadPauseSnapshot,
  partitionDiscovery,
  planPause,
  previewToken,
  resolveDeployManifest,
  savePauseSnapshot,
  startPause,
  type EstateActuator,
} from '@/lib/estate/pause-orchestrator';
import { capacityPreflight, highRiskCount } from '@/lib/estate/capacity-preflight';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PauseBody {
  /** Typed confirmation — must equal the estate id exactly. */
  confirm?: string;
  /**
   * The preview token from GET /state (or from this route's own `dryRun`).
   * REQUIRED on a real pause — refused (409) when it is absent AND when the set
   * has drifted (#3989). Kept optional in the TYPE because it is parsed from an
   * untrusted JSON body, never because the route tolerates its absence.
   */
  confirmToken?: string;
  /** When true, resolve + preview and return WITHOUT acting. */
  dryRun?: boolean;
}

/** Cosmos audit row, mirroring the `/admin/updates` shape. */
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

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  const tenantId = tenantScopeId(session);
  const who = session.claims.upn || session.claims.email || session.claims.oid;
  const body = (await req.json().catch(() => ({}))) as PauseBody;

  let actuator: EstateActuator;
  try {
    actuator = await createArmActuator();
  } catch (e) {
    return apiHonestError(e, 503, armGateMessage(e));
  }

  // --- Resolve the set. Per RESOURCE, from the deploy manifest + the estate
  //     ownership tag. Never by subscription, never by resource-group name.
  //     Discovery reads go through the 429-retrying manifest tag reader
  //     (#4243) so one throttled read does not silently shrink the preview.
  const { manifest, entries, unresolved, manifestGated, namedByDeploy, gateReason } =
    resolveDeployManifest();
  const discovered = await discoverFromManifest(entries, createManifestTagReader());
  // #4243 review round 1 — a deploy-named id ARM POSITIVELY reports absent
  // (404/ResourceNotFound) is EXCLUDED from the population, symmetrically with
  // GET /state, so the token stays coherent while the absence persists. It is
  // surfaced (`absent` + audit row below), never silently dropped. Unreadable
  // rows (throttled/timeout) stay IN the population and refuse below.
  const { present, absent, readFailures } = partitionDiscovery(discovered, entries);
  const plan = planPause(present, {
    scope: { kind: 'explicit-inventory', estateId: manifest.estateId },
    manifest,
    ...(gateReason ? { gateReason } : {}),
    namedByDeploy,
  });

  // R-CAP-3 — the live SKU, so the risk names the thing at risk.
  const live: Record<string, { sku?: string; powerState?: string }> = {};
  for (const c of plan.inventory.pausable) {
    const power = await actuator.readPower(c.resource);
    live[c.resource.resourceId.toLowerCase()] = {
      ...(power.sku?.name ? { sku: power.sku.name } : {}),
      ...(power.reading ? { powerState: power.reading.powerState } : {}),
    };
  }
  const risks = capacityPreflight(plan.inventory.pausable, live);

  // #4243 — the token is computed over the STABLE addressable population
  // (deploy-named minus positively-absent) plus the positively-established
  // set, with the read-failure count embedded. `evaluateDrift` below is the
  // only comparator; the raw `!==` is gone.
  const manifestIds = present.map((d) => d.resourceId);
  const establishedIds = plan.dryRun.wouldPause.map((r) => r.resourceId);
  const token = previewToken({ manifestIds, establishedIds, readFailures: readFailures.length });

  if (body.dryRun) {
    return apiOk({
      dryRun: true,
      estateId: manifest.estateId,
      preview: plan.dryRun,
      population: plan.population,
      outOfTier: plan.outOfTier,
      unresolved,
      manifestGated,
      risks,
      highRisk: highRiskCount(risks),
      confirmToken: token,
      /** Discovery reads that failed — the preview may be partial when non-empty. */
      readFailures,
      /** Deploy-named ids ARM positively reports absent — excluded, with the env remediation. */
      absent,
    });
  }

  // --- THE ARMING GATE. Refused BEFORE the typed confirmation, so an operator
  //     who has not armed the feature is told that, rather than being told
  //     their confirmation string was wrong.
  //
  //     Gated on the SWITCH, not on the evidence source. The review asked for
  //     the manifest path specifically, because that is what is live today —
  //     but the reasons the gate exists (no live pause/resume receipt in any
  //     cloud, R-CAP-2 unimplemented so a capacity-failed resume is manual
  //     recovery) apply just as much to a tag-owned resource. Holding only the
  //     manifest would arm the feature the instant #3922 stamps the first tag,
  //     which is precisely when nobody is expecting it to become live.
  if (manifestGated) {
    await audit(tenantId, who, 'estate-pause.not-armed', {
      estateId: manifest.estateId,
      namedByDeploy,
      wouldPause: plan.dryRun.wouldPause.length,
    });
    return apiError(
      gateReason
        ?? `Estate pause is not armed: ${ESTATE_PAUSE_ENABLED_ENV} is not set on this console. `
          + 'No pause has ever been run from this code against a live Azure resource, and automatic '
          + 'fallback-SKU recovery (R-CAP-2) is not implemented, so a capacity-failed resume would be '
          + 'manual recovery.',
      409,
      {
        notArmed: true,
        requiredEnv: ESTATE_PAUSE_ENABLED_ENV,
        namedByDeploy,
        population: plan.population,
        preview: plan.dryRun,
      },
    );
  }

  // --- Gate 2: typed confirmation.
  if ((body.confirm || '').trim() !== manifest.estateId) {
    return apiError(
      `Confirmation mismatch: type the estate id "${manifest.estateId}" to pause it. `
        + 'Pausing stops compute across the estate; the typed echo is the guard against an '
        + 'accidental click.',
      400,
      { expected: manifest.estateId },
    );
  }

  // --- Gate 3: drift. The operator confirmed a SPECIFIC set.
  //
  // #3989 — THIS USED TO BE `if (body.confirmToken && body.confirmToken !== token)`,
  // and `confirmToken` is OPTIONAL, so the `&&` short-circuited: a caller that
  // simply omitted the field skipped the gate entirely. A POSITIVE match is
  // required.
  //
  // #4243 — and the comparison itself lied. The token used to hash the
  // TRANSIENTLY-READABLE set, so one throttled tag read (manufactured by the
  // console's own read-warmer saturating the UAMI's ARM budget) changed the
  // token over an UNCHANGED estate, and the refusal asserted "the set changed"
  // — a cause the code never established (deploy-integrity R7). On 2026-08-31
  // that was the live Pause failure, and because this branch wrote NO audit
  // row it took an elimination proof to even identify. `evaluateDrift` is now
  // the only comparator: it distinguishes positively-left-the-set (refuse as
  // drift, honestly) from read-failed (refuse with retry — nothing established
  // a change) from unchanged (proceed) — and EVERY refusal writes the same
  // Cosmos audit row the other branches do.
  const verdict = evaluateDrift({
    confirmToken: body.confirmToken,
    manifestIds,
    establishedIds,
    readFailures,
  });
  if (verdict.kind !== 'proceed') {
    await audit(tenantId, who, `estate-pause.refused-${verdict.kind}`, {
      estateId: manifest.estateId,
      confirmToken: body.confirmToken ?? null,
      currentToken: token,
      ...(verdict.kind === 'reads-failed'
        ? { failedReads: verdict.failures.map((f) => ({ id: f.resourceId, throttled: f.throttled, error: f.error })) }
        : {}),
      ...(verdict.kind === 'manifest-changed' || verdict.kind === 'set-changed'
        ? { confirmedCount: verdict.confirmedCount, currentCount: verdict.currentCount }
        : {}),
      ...(verdict.kind === 'preview-degraded' ? { previewFailures: verdict.previewFailures } : {}),
    });
    switch (verdict.kind) {
      case 'no-token':
        // "You sent no token" is not "your token is stale": different events,
        // different remediations, reported separately.
        return apiConflict(
          'This request carried no preview token, so Loom has NOT established that you have seen '
            + `the set it would pause (the estate currently resolves ${token}). \`confirmToken\` is `
            + 'REQUIRED, not optional — it is the only evidence that the set you approved is the set '
            + 'that exists now. Preview first (POST this route with `dryRun:true`, or GET '
            + '/api/admin/estate/state) and send back the `confirmToken` it returns.',
        );
      case 'stale-token':
        return apiConflict(
          'The preview token this request carried is not one this console can read (it may predate '
            + 'a console update). That does NOT establish that the estate changed — it establishes '
            + 'only that this token cannot vouch for the current set. Re-open the preview and '
            + 'confirm the current set.',
        );
      case 'manifest-changed':
        return apiConflict(
          'The deploy-named population changed between the preview you confirmed and now '
            + `(your preview covered ${verdict.confirmedCount} deploy-named resource(s); the estate `
            + `now resolves ${verdict.currentCount}). This is a positively-observed change — the `
            + 'population is the deploy-named set minus anything ARM positively reports absent, '
            + 'never a failed-read artifact: either the deploy environment changed, or a named '
            + 'resource appeared or was removed. Re-open the preview and confirm the current set — '
            + 'Loom will not pause resources you have not seen.',
        );
      case 'reads-failed':
        return apiError(
          `${verdict.failures.length} tag read(s) failed (throttled/unreachable) — nothing `
            + 'established the estate changed; retry. Loom will not compare a fully-read preview '
            + 'against a partially-read present, and it will not pause while membership is only '
            + `partially known. Affected: ${verdict.failures
              .map((f) => `${f.name} (${f.throttled ? 'throttled' : 'unreachable'})`)
              .join(', ')}. Nothing was paused.`,
          409,
          { readFailures: verdict.failures },
        );
      case 'preview-degraded':
        return apiConflict(
          `The preview you confirmed was computed while ${verdict.previewFailures} tag read(s) were `
            + 'failing, so the set it showed you may have been incomplete. Nothing established that '
            + 'the estate changed — but Loom will not pause against a preview it knows was partial. '
            + 'Re-open the preview (its reads are succeeding now) and confirm the full set.',
        );
      case 'set-changed':
        return apiConflict(
          'The set of resources to pause changed between the preview you confirmed and now '
            + `(you confirmed ${verdict.confirmedCount} resource(s), the estate now positively `
            + `resolves ${verdict.currentCount} — both measured with every tag read succeeding). `
            + 'Re-open the preview and confirm the current set — Loom will not pause resources you '
            + 'have not seen.',
        );
    }
  }

  // --- #4243 review round 1: record every positive-absence exclusion the
  //     moment the drift gate has passed, so a pause that proceeds without a
  //     deploy-named resource leaves a trace naming the env values to fix.
  if (absent.length > 0) {
    await audit(tenantId, who, 'estate-pause.absent-excluded', {
      estateId: manifest.estateId,
      absent: absent.map((a) => ({ id: a.resourceId, fromEnv: a.fromEnv, error: a.error })),
    });
  }

  // --- Nothing to do. Say so LOUDLY rather than reporting a successful pause
  //     of zero resources, which is the vaporware shape.
  if (plan.population.empty) {
    await audit(tenantId, who, 'estate-pause.no-population', {
      estateId: manifest.estateId,
      examined: plan.population.examined,
      tagCensus: plan.population.tagCensus,
      absentExcluded: absent.length,
    });
    return apiError(plan.population.statement, 409, {
      population: plan.population,
      preview: plan.dryRun,
      unresolved,
      absent,
      trackedBy: 3922,
    });
  }

  // --- Refuse to re-pause an estate that is already paused or mid-transition.
  const existing = await loadPauseSnapshot(tenantId).catch(() => null);
  if (existing && existing.state !== 'RUNNING') {
    return apiConflict(
      `The estate is already ${existing.state}. Wait for it to settle, or resume it first — `
        + 'a second pause over an in-flight one would overwrite the snapshot that resume restores from.',
    );
  }

  await audit(tenantId, who, 'estate-pause.start', {
    estateId: manifest.estateId,
    resources: plan.dryRun.wouldPause.map((r) => ({ id: r.resourceId, mechanism: r.mechanism })),
    highRisk: highRiskCount(risks),
  });

  const run = await startPause(plan, actuator, {
    snapshotId: randomUUID(),
    tenantId,
    estateId: manifest.estateId,
    // A CALLBACK, not the manifest we resolved above. W1 removed the ability to
    // hand `reverifyBeforeAct` a pre-fetched manifest so stale ownership data
    // cannot be replayed against a live mutation — this re-reads the console's
    // environment at the moment each resource is about to be touched.
    readManifest: async () => resolveDeployManifest().manifest,
    createdBy: who,
  });

  // A run where every candidate was skipped captured nothing. `startPause`
  // records that as RUNNING rather than as an empty PAUSING snapshot; report it
  // as the no-op it is, with the per-resource reasons.
  if (run.capturedNone) {
    await audit(tenantId, who, 'estate-pause.captured-nothing', {
      estateId: manifest.estateId,
      actions: run.actions.map((a) => ({ id: a.resourceId, status: a.status })),
    });
    return apiError(
      'Nothing was paused. Every candidate was left running — see `actions` for the reason on each. '
        + 'This is the fail-safe path: Loom never acts on a resource whose ownership or pre-pause '
        + 'state it could not establish.',
      409,
      { actions: run.actions, population: plan.population },
    );
  }

  const dispatched = run.actions.filter((a) => a.status === 'dispatched');
  const failed = run.actions.filter((a) => a.status === 'failed');

  // #4243 — the ZERO-DISPATCH shape. Every mutation was REJECTED and none was
  // accepted: nothing is transitioning, so persisting a PAUSING snapshot would
  // record an in-flight pause that does not exist — one that polls to "0 of N
  // confirmed" forever and blocks a retry with "already PAUSING". The honest
  // behaviour, pinned by test: save NOTHING, audit the failure, and return the
  // per-resource states plainly. (Review round 1: the headline states COUNTS —
  // it must not say "still RUNNING" when an already-paused row means one
  // resource is physically stopped. All-already-paused with zero failures
  // still saves: that snapshot settles to PAUSED on the first poll, truly.)
  if (dispatched.length === 0 && failed.length > 0) {
    const alreadyPaused = run.actions.filter((a) => a.status === 'already-paused').length;
    const skipped = run.actions.filter((a) => a.status === 'skipped').length;
    await audit(tenantId, who, 'estate-pause.all-dispatches-rejected', {
      estateId: manifest.estateId,
      actions: run.actions.map((a) => ({ id: a.resourceId, status: a.status, error: a.error })),
    });
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: who,
      action: 'platform.estate-pause',
      targetType: 'loom-estate',
      targetId: manifest.estateId,
      tenantId: session.claims.tid || tenantId,
      outcome: 'failure',
      detail: {
        dispatched: 0,
        failed: failed.length,
        resources: run.actions.map((a) => ({ id: a.resourceId, status: a.status })),
      },
    });
    return apiError(
      `Nothing was set in motion: of ${run.actions.length} action(s), ARM REJECTED ${failed.length}, `
        + `${alreadyPaused} were already paused before Loom looked, ${skipped} were skipped, and NONE `
        + 'was accepted. No snapshot was recorded and there is no in-flight pause to poll — each '
        + 'resource keeps exactly the state reported in `actions`. Fix what the rejections name and '
        + 'press Pause again.',
      502,
      { actions: run.actions, population: plan.population },
    );
  }

  await savePauseSnapshot(run.snapshot);

  await audit(tenantId, who, failed.length ? 'estate-pause.partial' : 'estate-pause.dispatched', {
    estateId: manifest.estateId,
    snapshotId: run.snapshot.id,
    actions: run.actions.map((a) => ({ id: a.resourceId, status: a.status, error: a.error })),
  });
  emitAuditEvent({
    actorOid: session.claims.oid,
    actorUpn: who,
    action: 'platform.estate-pause',
    targetType: 'loom-estate',
    targetId: manifest.estateId,
    tenantId: session.claims.tid || tenantId,
    outcome: failed.length ? 'failure' : 'success',
    detail: {
      snapshotId: run.snapshot.id,
      dispatched: dispatched.length,
      failed: failed.length,
      resources: run.actions.map((a) => ({ id: a.resourceId, status: a.status })),
    },
  });

  return apiOk(
    {
      // PAUSING, never PAUSED. Every Azure pause verb is a 202 long-running
      // operation; PAUSED is only ever claimed by GET /state after a fresh
      // authoritative ARM read confirms every resource stopped.
      state: run.snapshot.state,
      estateId: manifest.estateId,
      snapshotId: run.snapshot.id,
      actions: run.actions,
      risks,
      population: plan.population,
      /** Deploy-named ids ARM positively reports absent — excluded, with the env remediation. */
      absent,
      monitorUrl: '/api/admin/estate/state',
      message:
        `Pause dispatched to ${dispatched.length} resource(s)`
        + (failed.length ? `; ${failed.length} were REJECTED by ARM (see actions).` : '.')
        + (absent.length
          ? ` ${absent.length} deploy-named resource(s) were EXCLUDED because ARM positively reports `
            + 'they do not exist — see `absent` for the env values to fix.'
          : '')
        + ' The estate is PAUSING — poll /api/admin/estate/state, which promotes it to PAUSED only '
        + 'once ARM confirms every resource stopped.',
    },
    { status: 202 },
  );
});
