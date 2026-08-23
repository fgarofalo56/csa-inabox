/**
 * GET /api/admin/estate/state — the estate's pause state, live.
 *
 * This is the READ half of the pause/resume feature and it does three things:
 *
 *   1. When the estate is RUNNING, it returns the DRY RUN (R-SCOPE-4): exactly
 *      what a pause would act on, each row with the owning tag that put it
 *      there, plus the POPULATION report so an empty preview explains itself
 *      instead of looking like a broken feature.
 *   2. When the estate is PAUSING or RESUMING, it POLLS — re-reading
 *      authoritative ARM for every snapshot resource and, on the resume side,
 *      issuing a real data-plane probe. This is what promotes PAUSING -> PAUSED
 *      and RESUMING -> RUNNING | RESUME_FAILED. The UI polls this route; the
 *      state machine advances here, never in the browser.
 *   3. It reports capacity risk (R-CAP-3) so the confirm dialog can state, per
 *      resource, what a resume might not get back.
 *
 * SAFE TO CALL ON PAGE LOAD. It performs ARM GETs and (on a resume poll) a
 * cheap data-plane query. It issues no pause or resume verb, ever.
 *
 * Authorization is `withTenantAdmin` from the route toolkit, NOT an inline
 * check. The wrapper takes the handler as an argument, so there is no
 * `if (gate) return gate;` line in this file for someone to delete — which is
 * the exact failure shape measured on 2026-08-07, when removing that one line
 * from `app/api/setup/deploy/route.ts` left THREE separate route-guard checkers
 * green over an open route.
 */
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiOk, apiHonestError } from '@/lib/api/respond';
import {
  applyPausePoll,
  applyResumePoll,
  armGateMessage,
  createArmActuator,
  discoverFromManifest,
  loadPauseSnapshot,
  planPause,
  pollPause,
  pollResume,
  previewToken,
  resolveDeployManifest,
  savePauseSnapshot,
  TYPICAL_RESUME_SECONDS,
  type EstateActuator,
} from '@/lib/estate/pause-orchestrator';
import { capacityPreflight, highRiskCount, summarizeResume } from '@/lib/estate/capacity-preflight';
import { tenantScopeId } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Build the RUNNING-state payload: the dry run + the population report + the
 * per-resource resume risk. No mutation, no snapshot write.
 */
async function runningPayload(actuator: EstateActuator) {
  const { manifest, entries, unresolved } = resolveDeployManifest();
  const discovered = await discoverFromManifest(entries, actuator.readTags);
  const plan = planPause(discovered, {
    scope: { kind: 'explicit-inventory', estateId: manifest.estateId },
    manifest,
  });
  const risks = capacityPreflight(plan.inventory.pausable);

  return {
    state: 'RUNNING' as const,
    estateId: manifest.estateId,
    preview: plan.dryRun,
    population: plan.population,
    outOfTier: plan.outOfTier,
    /** Types this tier covers that no env var named — an honest coverage gap. */
    unresolved,
    risks,
    highRisk: highRiskCount(risks),
    /**
     * The dry run is a REQUIREMENT before acting, so the pause route demands
     * this token back. It is not a security control (the caller is already a
     * tenant admin); it is a DRIFT control — the same shape as
     * `/api/admin/updates/apply`'s `confirmTag`. If the resolved set changes
     * between the preview and the confirm, the confirm is refused.
     */
    confirmToken: previewToken(plan.dryRun.wouldPause.map((r) => r.resourceId)),
    typicalResumeSeconds: TYPICAL_RESUME_SECONDS,
  };
}

export const GET = withTenantAdmin(async (_req, { session }) => {
  const tenantId = tenantScopeId(session);
  let actuator: EstateActuator;
  try {
    actuator = await createArmActuator();
  } catch (e) {
    // ARM is not reachable/configured. An honest gate, not a fake RUNNING.
    return apiHonestError(e, 503, armGateMessage(e));
  }

  const snapshot = await loadPauseSnapshot(tenantId).catch(() => null);

  // No snapshot, or a snapshot that says the estate is up -> show the preview.
  if (!snapshot || snapshot.state === 'RUNNING') {
    const payload = await runningPayload(actuator);
    return apiOk({ ...payload, snapshotId: snapshot?.id ?? null });
  }

  if (snapshot.state === 'PAUSING' || snapshot.state === 'PAUSED') {
    const poll = await pollPause(snapshot, actuator);
    if (poll.state !== snapshot.state) {
      await savePauseSnapshot(applyPausePoll(snapshot, poll)).catch(() => {});
    }
    return apiOk({
      state: poll.state,
      estateId: snapshot.estateId,
      snapshotId: snapshot.id,
      pausedAt: snapshot.pausedAt ?? null,
      progress: poll.progress,
      confirmed: poll.confirmed,
      total: poll.total,
      reason: poll.reason,
      resources: snapshot.resources,
      typicalResumeSeconds: TYPICAL_RESUME_SECONDS,
    });
  }

  // RESUMING or RESUME_FAILED — poll, which is what produces the verdict.
  const poll = await pollResume(snapshot, actuator);
  if (poll.state !== snapshot.state) {
    await savePauseSnapshot(applyResumePoll(snapshot, poll)).catch(() => {});
  }
  const summary = summarizeResume(poll.state, poll.outcomes, snapshot.resources);
  return apiOk({
    state: poll.state,
    estateId: snapshot.estateId,
    snapshotId: snapshot.id,
    resumeStartedAt: snapshot.resumeStartedAt ?? null,
    progress: poll.progress,
    outcomes: poll.outcomes,
    unconfirmed: poll.unconfirmed,
    terminal: poll.terminal,
    reason: poll.reason,
    summary,
    resources: snapshot.resources,
    typicalResumeSeconds: TYPICAL_RESUME_SECONDS,
  });
});
