/**
 * ESTATE POWER — the shared handler logic behind BOTH entry points (PRP-02 step 3,
 * #4876):
 *   - the cookie routes   /api/admin/estate/{state,pause,resume}  (withTenantAdmin)
 *   - the service-principal route  /api/estate/power  (verified Entra bearer)
 *
 * The bodies were MOVED here from the three cookie routes unchanged (the only
 * edits: identity now comes from an {@link EstateCaller} instead of a session
 * object, SP-originated audit rows carry `via`/`appId` through
 * `caller.auditExtra` (which is {} for a cookie session, so those rows are
 * byte-identical to before), and state/preview responses gain a `power` block).
 * One implementation means the two entry points cannot drift on the arming
 * gate, the typed confirm, or the drift token.
 *
 * Authorization is NOT in this file. Each entry point authorizes its own caller
 * (`withTenantAdmin` / `verifyEstatePowerCaller`) and then builds the caller.
 * The cookie route files carry the long-form safety documentation.
 */
import { randomUUID } from 'node:crypto';
import { apiOk, apiError, apiConflict, apiHonestError } from '@/lib/api/respond';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { randomId } from '@/lib/util/random-id';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  applyPausePoll,
  applyResumePoll,
  armGateMessage,
  createArmActuator,
  createManifestTagReader,
  discoverFromManifest,
  ESTATE_PAUSE_ENABLED_ENV,
  evaluateDrift,
  loadPauseSnapshot,
  partitionDiscovery,
  planPause,
  pollPause,
  pollResume,
  previewToken,
  resolveDeployManifest,
  savePauseSnapshot,
  startPause,
  startResume,
  TYPICAL_RESUME_SECONDS,
  type EstateActuator,
} from '@/lib/estate/pause-orchestrator';
import {
  capacityPreflight,
  classifyActuationFailure,
  highRiskCount,
  remediationFor,
  summarizeResume,
} from '@/lib/estate/capacity-preflight';
import { detectLoomCloud } from '@/lib/azure/cloud-boundary';
import { loadActivity } from '@/lib/estate/estate-activity';
import { loadAutoPause } from '@/lib/estate/estate-autopause';
import type { EstatePowerStatus } from '@/lib/estate/estate-power-contract';
import { resolveReadVerdict, type EstatePauseSnapshot } from '@/lib/estate/pause-state';

/** Who is acting, however they authenticated. */
export interface EstateCaller {
  /** Cosmos partition for the snapshot: the tenant id (`tid`), else the oid. */
  tenantId: string;
  /** Display identity for audit rows (upn / email / oid, or the SP appid). */
  who: string;
  actorOid: string;
  actorTid: string;
  /** Extra audit fields: {} for a cookie session, {via, appId} for the SP route. */
  auditExtra: Record<string, unknown>;
}

/** Cosmos audit row, mirroring the `/admin/updates` shape. */
export async function audit(caller: EstateCaller, kind: string, fields: Record<string, unknown>) {
  try {
    const c = await auditLogContainer();
    await c.items.create({
      id: randomId('audit', 8),
      itemId: 'loom-estate-pause',
      tenantId: caller.tenantId,
      who: caller.who,
      at: new Date().toISOString(),
      kind,
      ...caller.auditExtra,
      ...fields,
    }).catch(() => {});
  } catch { /* best-effort; never blocks the operation */ }
}

/** Added to every state / preview response: idle time, auto-pause setting, last pause/resume. */
export async function buildPowerStatus(
  tenantId: string,
  snapshot: EstatePauseSnapshot | null,
): Promise<EstatePowerStatus> {
  const [activity, autoPause] = await Promise.all([loadActivity(tenantId), loadAutoPause(tenantId)]);
  return {
    activity,
    autoPause,
    lastPausedAt: snapshot?.pausedAt ?? null,
    lastResumedAt: snapshot?.resumeConfirmedAt ?? null,
  };
}

export interface PauseBody {
  /** Typed confirmation — must equal the estate id exactly. */
  confirm?: string;
  /** The preview token. REQUIRED on a real pause (#3989). */
  confirmToken?: string;
  /** When true, resolve + preview and return WITHOUT acting. */
  dryRun?: boolean;
}

/**
 * Build the RUNNING-state payload: the dry run + the population report + the
 * per-resource resume risk. No mutation, no snapshot write.
 *
 * The per-candidate `readPower` is an authoritative ARM GET, which is what puts
 * the LIVE SKU and power state in front of the operator before they confirm. It
 * is bounded by the pause tier (at most a handful of resources) and mutates
 * nothing.
 */
async function runningPayload(actuator: EstateActuator) {
  const { manifest, entries, unresolved, manifestGated, namedByDeploy, gateReason } =
    resolveDeployManifest();
  // #4243 — discovery goes through the 429-retrying manifest tag reader, so a
  // transient throttle does not silently shrink the preview the operator sees.
  // A deploy-named id ARM POSITIVELY reports absent is excluded here exactly
  // as the pause POST excludes it, so the two sides mint the same token while
  // the absence persists — and it is surfaced in `absent`, never dropped.
  const discovered = await discoverFromManifest(entries, createManifestTagReader());
  const { present, absent, readFailures } = partitionDiscovery(discovered, entries);
  const plan = planPause(present, {
    scope: { kind: 'explicit-inventory', estateId: manifest.estateId },
    manifest,
    ...(gateReason ? { gateReason } : {}),
    namedByDeploy,
  });

  // R-CAP-3 — read the live SKU so the confirm dialog names what is at risk.
  const live: Record<string, { sku?: string; powerState?: string }> = {};
  for (const c of plan.inventory.pausable) {
    const power = await actuator.readPower(c.resource);
    live[c.resource.resourceId.toLowerCase()] = {
      ...(power.sku?.name ? { sku: power.sku.name } : {}),
      ...(power.reading ? { powerState: power.reading.powerState } : {}),
    };
  }
  const risks = capacityPreflight(plan.inventory.pausable, live);

  return {
    state: 'RUNNING' as const,
    estateId: manifest.estateId,
    /** Which Azure boundary this console is bound to. See the cloud note below. */
    cloud: detectLoomCloud(),
    preview: plan.dryRun,
    population: plan.population,
    outOfTier: plan.outOfTier,
    /** Types this tier covers that no env var named — an honest coverage gap. */
    unresolved,
    /** True when the deploy names resources but the opt-in is unset. */
    manifestGated,
    risks,
    highRisk: highRiskCount(risks),
    /**
     * The dry run is a REQUIREMENT before acting, so the pause route demands
     * this token back. It is not a security control (the caller is already a
     * tenant admin); it is a DRIFT control — the same shape as
     * `/api/admin/updates/apply`'s `confirmTag`. If the resolved set has
     * POSITIVELY changed between the preview and the confirm, the confirm is
     * refused. #4243: the token is computed over the STABLE manifest-named
     * population plus the positively-established set, with this preview's
     * read-failure count embedded — so a throttled read can no longer
     * manufacture a "the set changed" refusal over an unchanged estate.
     */
    confirmToken: previewToken({
      manifestIds: present.map((d) => d.resourceId),
      establishedIds: plan.dryRun.wouldPause.map((r) => r.resourceId),
      readFailures: readFailures.length,
    }),
    /** Discovery reads that failed — the preview may be partial when non-empty. */
    readFailures,
    /** Deploy-named ids ARM positively reports absent — excluded, with the env remediation. */
    absent,
    typicalResumeSeconds: TYPICAL_RESUME_SECONDS,
  };
}

/** State read (GET). Identical for the cookie and SP entry points. */
export async function handleStateRead(caller: EstateCaller) {
  const { tenantId } = caller;
  let actuator: EstateActuator;
  try {
    actuator = await createArmActuator();
  } catch (e) {
    // ARM is not reachable/configured. An honest gate, not a fake RUNNING.
    return apiHonestError(e, 503, armGateMessage(e));
  }

  const snapshot = await loadPauseSnapshot(tenantId).catch(() => null);
  const power = await buildPowerStatus(tenantId, snapshot);

  // No snapshot, or a snapshot that says the estate is up -> show the preview.
  if (!snapshot || snapshot.state === 'RUNNING') {
    const payload = await runningPayload(actuator);
    return apiOk({ ...payload, snapshotId: snapshot?.id ?? null, power });
  }

  if (snapshot.state === 'PAUSING' || snapshot.state === 'PAUSED') {
    const poll = await pollPause(snapshot, actuator);
    if (poll.state !== snapshot.state) {
      await savePauseSnapshot(applyPausePoll(snapshot, poll)).catch(() => {});
    }
    return apiOk({
      state: poll.state,
      estateId: snapshot.estateId,
      cloud: detectLoomCloud(),
      snapshotId: snapshot.id,
      pausedAt: snapshot.pausedAt ?? null,
      progress: poll.progress,
      confirmed: poll.confirmed,
      total: poll.total,
      drifted: poll.drifted,
      driftedResources: poll.driftedResources,
      reason: poll.reason,
      resources: snapshot.resources,
      typicalResumeSeconds: TYPICAL_RESUME_SECONDS,
      power,
    });
  }

  // RESUMING or RESUME_FAILED — poll, which is what produces the verdict.
  const poll = await pollResume(snapshot, actuator);
  // A read persists only a LEGAL transition (see resolveReadVerdict): an
  // illegal RESUME_FAILED -> RUNNING used to throw here and 500 every read.
  const verdict = resolveReadVerdict(snapshot.state, poll);
  if (verdict.persist) {
    await savePauseSnapshot(applyResumePoll(snapshot, poll)).catch(() => {});
  }
  const illegal = verdict.state !== poll.state;
  // When the stored state is kept over a better poll, summarizeResume's
  // RESUME_FAILED headline ("N NOT confirmed running") would be false — say why instead.
  const summary = illegal
    ? { headline: verdict.reason, details: [] }
    : summarizeResume(poll.state, poll.outcomes, snapshot.resources);
  return apiOk({
    state: verdict.state,
    estateId: snapshot.estateId,
    cloud: detectLoomCloud(),
    snapshotId: snapshot.id,
    resumeStartedAt: snapshot.resumeStartedAt ?? null,
    progress: poll.progress,
    outcomes: poll.outcomes,
    unconfirmed: poll.unconfirmed,
    terminal: poll.terminal,
    reason: verdict.reason,
    summary,
    resources: snapshot.resources,
    typicalResumeSeconds: TYPICAL_RESUME_SECONDS,
    power,
  });
}

/** Pause / dry-run preview (POST). */
export async function handlePausePost(caller: EstateCaller, body: PauseBody) {
  const { tenantId, who } = caller;
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
    const power = await buildPowerStatus(tenantId, await loadPauseSnapshot(tenantId).catch(() => null));
    return apiOk({
      power,
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
    await audit(caller, 'estate-pause.not-armed', {
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
    await audit(caller, `estate-pause.refused-${verdict.kind}`, {
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
    await audit(caller, 'estate-pause.absent-excluded', {
      estateId: manifest.estateId,
      absent: absent.map((a) => ({ id: a.resourceId, fromEnv: a.fromEnv, error: a.error })),
    });
  }

  // --- Nothing to do. Say so LOUDLY rather than reporting a successful pause
  //     of zero resources, which is the vaporware shape.
  if (plan.population.empty) {
    await audit(caller, 'estate-pause.no-population', {
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

  await audit(caller, 'estate-pause.start', {
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
    await audit(caller, 'estate-pause.captured-nothing', {
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
    await audit(caller, 'estate-pause.all-dispatches-rejected', {
      estateId: manifest.estateId,
      actions: run.actions.map((a) => ({ id: a.resourceId, status: a.status, error: a.error })),
    });
    emitAuditEvent({
      actorOid: caller.actorOid,
      actorUpn: who,
      action: 'platform.estate-pause',
      targetType: 'loom-estate',
      targetId: manifest.estateId,
      tenantId: caller.actorTid || tenantId,
      outcome: 'failure',
      detail: {
      ...caller.auditExtra,
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

  await audit(caller, failed.length ? 'estate-pause.partial' : 'estate-pause.dispatched', {
    estateId: manifest.estateId,
    snapshotId: run.snapshot.id,
    actions: run.actions.map((a) => ({ id: a.resourceId, status: a.status, error: a.error })),
  });
  emitAuditEvent({
    actorOid: caller.actorOid,
    actorUpn: who,
    action: 'platform.estate-pause',
    targetType: 'loom-estate',
    targetId: manifest.estateId,
    tenantId: caller.actorTid || tenantId,
    outcome: failed.length ? 'failure' : 'success',
    detail: {
      ...caller.auditExtra,
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
}

/** Resume (POST). */
export async function handleResumePost(caller: EstateCaller) {
  const { tenantId, who } = caller;
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

  await audit(caller, 'estate-resume.start', {
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

  await audit(caller, failed.length ? 'estate-resume.partial-dispatch' : 'estate-resume.dispatched', {
    estateId: snapshot.estateId,
    snapshotId: snapshot.id,
    dispatches: run.dispatches.map((d) => ({ id: d.resourceId, status: d.status, error: d.error })),
    failureKinds: failures.map((f) => f.kind),
  });
  emitAuditEvent({
    actorOid: caller.actorOid,
    actorUpn: who,
    action: 'platform.estate-resume',
    targetType: 'loom-estate',
    targetId: snapshot.estateId,
    tenantId: caller.actorTid || tenantId,
    outcome: failed.length ? 'failure' : 'success',
    detail: {
      ...caller.auditExtra,
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
}
