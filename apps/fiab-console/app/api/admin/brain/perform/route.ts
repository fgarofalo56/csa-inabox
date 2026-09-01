/**
 * BFF — POST /api/admin/brain/perform (+ GET read-back) — #4242.
 *
 * THE ONLY MUTATION PATH FROM A BRAIN RECOMMENDATION TO AZURE. The sibling
 * proposals route records decisions and performs nothing; ITS doc-block called
 * for exactly this shape: "a separate route, a separate capability, and its
 * own review". This is that route, and the four-layer inertness contract on
 * the Brain itself is UNCHANGED by its existence:
 *
 *   - `RemediationProposal` still pins `mutatesAzure: false` /
 *     `requiresHumanApproval: true` as literal types with build-checked
 *     assertions — no finding ever carries an actuator.
 *   - `assertInertRemediation` still rejects actuator keys at any depth over
 *     everything the Brain produces.
 *   - The executor mapping is a SERVER-SIDE registry keyed by detector kind in
 *     `lib/brain-actions/**` — deliberately outside `lib/brain` — never a
 *     payload on the finding.
 *   - This file contains NO inline Azure verb; it delegates to the guarded
 *     orchestrator, and `no-mutation-controls.test.tsx` asserts that.
 *
 * ── GUARDS, ALL SERVER-SIDE, ALL RE-DERIVED AT EXECUTE TIME ────────────────
 * The client supplies three lookup keys and (on the confirm leg) a staged
 * token. Everything else is re-derived here: `withTenantAdmin`; a fresh
 * snapshot rebuild whose collection must be COMPLETE (#4015/#4016 — a proposal
 * from a partial estate pull must refuse to perform); ownership re-confirmed
 * from a fresh tag read; detector not vacuous, population not blind; the
 * subject's ARM id resolved from the server's OWN snapshot (a client-supplied
 * resource id is never accepted); a fresh authoritative ARM GET that must
 * still match the finding's evidence; and — every phase-1 executor being
 * destructive — a two-step staged confirm modeled on the auto-tune ARM_CLASSES
 * gate: the first call stages and returns a bounded single-use token, only the
 * second call presenting it executes.
 *
 * ── EVERY ATTEMPT IS AUDITED ───────────────────────────────────────────────
 * `brain-perform.<detector>` with the receipt, and `mutatedAzure` recorded
 * TRUTHFULLY: `true` only on a confirmed write, `false` on refusals/stagings
 * that never reached ARM, and `'unconfirmed'` on a failed write — a failed
 * call establishes neither outcome, and claiming it did would be the R7
 * failure.
 */

import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import {
  apiBadRequest,
  apiError,
  apiHonestError,
  apiOk,
  apiServerError,
} from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { performRecommendation, type PerformOutcome } from '@/lib/brain-actions/perform';
import { performRegistryEntries } from '@/lib/brain-actions/registry';
import {
  BrainActionsNotConfiguredError,
  recommendationStateStore,
} from '@/lib/brain-actions/state-store';
import type { PerformRequest } from '@/lib/brain-actions/types';
import { AcaNotConfiguredError } from '@/lib/azure/container-apps-arm-client';
import { ResourceGraphCollectionError } from '../_lib/arg-collect';
import { loadSnapshot } from '../_lib/snapshot';

export const dynamic = 'force-dynamic';

const MAX_ID = 512;

function parseBody(raw: unknown): PerformRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object';
  const b = raw as Record<string, unknown>;

  const findingId = typeof b.findingId === 'string' ? b.findingId.trim() : '';
  if (findingId === '') return 'findingId is required';
  if (findingId.length > MAX_ID) return 'findingId is too long';

  const detector = typeof b.detector === 'string' ? b.detector.trim() : '';
  if (detector === '') return 'detector is required';
  if (detector.length > MAX_ID) return 'detector is too long';

  const subjectNodeId = typeof b.subjectNodeId === 'string' ? b.subjectNodeId.trim() : '';
  if (subjectNodeId === '') return 'subjectNodeId is required';
  if (subjectNodeId.length > MAX_ID) return 'subjectNodeId is too long';

  const confirmToken =
    typeof b.confirmToken === 'string' && b.confirmToken.trim() !== ''
      ? b.confirmToken.trim()
      : undefined;

  return { findingId, detector, subjectNodeId, ...(confirmToken ? { confirmToken } : {}) };
}

/** `mutatedAzure` for the audit row, stated only as firmly as it was established. */
function mutatedAzureFor(outcome: PerformOutcome): boolean | string {
  if (outcome.kind === 'performed') return true;
  if (outcome.kind === 'failed') {
    return 'unconfirmed — the write was attempted and its outcome was not confirmed';
  }
  return false;
}

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = parseBody(raw);
    if (typeof parsed === 'string') return apiBadRequest(parsed);

    const actor = { oid: session.claims.oid, upn: session.claims.upn };
    const outcome = await performRecommendation(parsed, actor, { loadSnapshot });

    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      action: `brain-perform.${parsed.detector}`,
      targetType: 'brain-finding',
      targetId: parsed.findingId,
      outcome:
        outcome.kind === 'performed' || outcome.kind === 'staged'
          ? 'success'
          : outcome.kind === 'failed'
            ? 'failure'
            : 'denied',
      detail: {
        stage: outcome.kind,
        subjectNodeId: parsed.subjectNodeId,
        mutatedAzure: mutatedAzureFor(outcome),
        ...(outcome.kind === 'not-performable' ? { reason: outcome.reason } : {}),
        ...(outcome.kind === 'refused'
          ? { guard: outcome.refusal.guard, reason: outcome.refusal.reason }
          : {}),
        ...(outcome.kind === 'staged'
          ? { executor: outcome.executor, expiresAt: outcome.expiresAt }
          : {}),
        ...(outcome.kind === 'performed' ? { receipt: outcome.receipt } : {}),
        ...(outcome.kind === 'failed'
          ? { executor: outcome.executor, error: outcome.error }
          : {}),
      },
      tenantId: session.claims.tid ?? session.claims.oid,
    });

    switch (outcome.kind) {
      case 'not-performable':
        return apiError(outcome.reason, 409, {
          performable: false,
          detector: parsed.detector,
        });
      case 'refused':
        return apiError(outcome.refusal.reason, 409, {
          performable: true,
          guard: outcome.refusal.guard,
        });
      case 'staged':
        return apiOk({
          staged: true,
          performed: false,
          executor: outcome.executor,
          confirmToken: outcome.confirmToken,
          expiresAt: outcome.expiresAt,
          note:
            'This change is DESTRUCTIVE, so nothing was executed yet. Re-affirm by ' +
            'calling this endpoint again with the confirmToken before it expires. ' +
            'Nothing was changed in Azure.',
        });
      case 'performed':
        return apiOk({ performed: true, receipt: outcome.receipt });
      default:
        // Narrowed to the 'failed' arm — the remaining union member.
        return apiError(outcome.error, 502, {
          performed: false,
          executor: outcome.executor,
          mutationConfirmed: false,
        });
    }
  } catch (e) {
    if (
      e instanceof ResourceGraphCollectionError ||
      e instanceof AcaNotConfiguredError ||
      e instanceof BrainActionsNotConfiguredError
    ) {
      // Honest infra gates: the message names exactly what is missing or what
      // failed, and nothing was performed.
      return apiHonestError(e, 503);
    }
    return apiServerError(e);
  }
});

/**
 * GET — the state read-back: recorded per-finding states (a finding with no
 * record is `open`) plus the registry's performability map, so the UI can
 * render Perform actions and honest not-performable reasons from server truth
 * rather than guessing.
 */
export const GET = withTenantAdmin(async (req: NextRequest) => {
  try {
    const findingId = req.nextUrl.searchParams.get('findingId')?.trim() || undefined;
    const states = await recommendationStateStore().read(findingId);
    return apiOk({
      states,
      performability: performRegistryEntries(),
    });
  } catch (e) {
    if (e instanceof BrainActionsNotConfiguredError) return apiHonestError(e, 503);
    return apiServerError(e);
  }
});
