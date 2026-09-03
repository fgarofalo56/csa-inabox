/**
 * BFF — GET (preview) / POST (apply) /api/admin/brain/ownership-backfill — #4255 W2.
 *
 * THE SECOND SANCTIONED MUTATION PATH out of the Brain surface, and the
 * narrowest one: it writes exactly one tag key, `loom-estate-id`, onto exactly
 * the resources this deployment's own deploy manifest names, and only after the
 * operator has confirmed the list.
 *
 * It sits beside `/api/admin/brain/perform` and follows the same contract:
 *
 *   - This file carries NO inline Azure verb. It parses, authorizes, delegates
 *     to `lib/brain-actions/ownership-backfill`, and audits. The ARM write
 *     lives in `lib/brain-actions/arm-tags.ts` — deliberately outside
 *     `lib/brain` and outside the roots `no-mutation-controls.test.tsx` scans,
 *     so the Brain's own tree stays honestly write-free.
 *   - The client supplies resource IDS and nothing else is believed. The
 *     server re-resolves the deploy manifest and re-reads every resource's
 *     tags before writing, and refuses any id its own fresh derivation does
 *     not produce as a candidate.
 *   - `withTenantAdmin`. Every attempt is audited with `mutatedAzure` recorded
 *     TRUTHFULLY: `true` only on a confirmed merge, `false` when ARM was never
 *     written, `'unconfirmed'` when a write was attempted and did not confirm.
 *
 * ── WHY THE PREVIEW IS A SEPARATE VERB ─────────────────────────────────────
 * The operator approves a LIST, so the list has to exist before anything is
 * written and it has to be produced by the same code path the apply re-derives
 * from. GET returns it — every manifest-named resource with its state and its
 * machine-readable reason, including the ones that CANNOT be tagged (an
 * unreadable resource, or one carrying another estate's tag). A confirmation
 * screen that shows only the actionable rows hides the reason the others are
 * missing, and "why is this not here" is the question the operator asked that
 * produced this whole workstream.
 */

import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiError, apiHonestError, apiOk, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  applyOwnershipBackfill,
  previewOwnershipBackfill,
  type BackfillApplyRequest,
} from '@/lib/brain-actions/ownership-backfill';
import { BrainActionArmError } from '@/lib/brain-actions/arm-tags';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_ID = 1024;
/** A confirmation list longer than the manifest can produce is a malformed request. */
const MAX_IDS = 200;

function parseApplyBody(raw: unknown): BackfillApplyRequest | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object';
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.resourceIds)) return 'resourceIds must be an array of ARM resource ids';
  if (b.resourceIds.length === 0) {
    return 'resourceIds is empty — nothing was confirmed, so nothing is attempted';
  }
  if (b.resourceIds.length > MAX_IDS) return `resourceIds carries more than ${MAX_IDS} entries`;
  const ids: string[] = [];
  for (const v of b.resourceIds) {
    if (typeof v !== 'string') return 'every entry of resourceIds must be a string';
    const id = v.trim();
    if (id === '') return 'resourceIds carries an empty entry';
    if (id.length > MAX_ID) return 'a resourceIds entry is too long';
    ids.push(id);
  }
  return { resourceIds: ids };
}

/**
 * GET — the PREVIEW. Reads ARM tags; writes nothing.
 *
 * Audited as a read: `mutatedAzure: false`, stated rather than omitted, so the
 * audit trail distinguishes "looked" from "tagged" without an inference.
 */
export const GET = withTenantAdmin(async (_req: NextRequest, { session }) => {
  try {
    const result = await previewOwnershipBackfill();
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      action: 'brain-ownership-backfill.preview',
      targetType: 'brain-estate',
      targetId: 'refusal' in result ? 'unresolved-estate' : result.preview.estateId,
      outcome: 'refusal' in result ? 'denied' : 'success',
      detail: {
        mutatedAzure: false,
        ...('refusal' in result
          ? { guard: result.refusal.guard, reason: result.refusal.reason }
          : {
              namedByDeploy: result.preview.namedByDeploy,
              actionable: result.preview.actionableResourceIds.length,
              states: result.preview.candidates.map((c) => ({
                resourceId: c.resourceId,
                state: c.state,
              })),
            }),
      },
      tenantId: session.claims.tid ?? session.claims.oid,
    });

    if ('refusal' in result) {
      return apiError(result.refusal.reason, 409, { guard: result.refusal.guard });
    }
    return apiOk({ preview: result.preview });
  } catch (e) {
    if (e instanceof BrainActionArmError) return apiHonestError(e, 503);
    return apiServerError(e);
  }
});

/**
 * POST — the APPLY. Tags only the confirmed ids that the server's own fresh
 * re-derivation still produces as candidates.
 */
export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = parseApplyBody(raw);
    if (typeof parsed === 'string') return apiBadRequest(parsed);

    const result = await applyOwnershipBackfill(parsed);

    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      action: 'brain-ownership-backfill.apply',
      targetType: 'brain-estate',
      targetId: 'refusal' in result ? 'unresolved-estate' : result.outcome.estateId,
      outcome:
        'refusal' in result
          ? 'denied'
          : result.outcome.failed > 0
            ? 'failure'
            : 'success',
      detail: {
        // TRUTHFUL: `true` only when ARM confirmed at least one merge,
        // `'unconfirmed'` when a write was attempted and did not confirm,
        // `false` when ARM was never written to (R7).
        mutatedAzure: 'refusal' in result ? false : result.outcome.mutatedAzure,
        requested: parsed.resourceIds.length,
        ...('refusal' in result
          ? { guard: result.refusal.guard, reason: result.refusal.reason }
          : {
              tagKey: result.outcome.tagKey,
              tagged: result.outcome.tagged,
              alreadyTagged: result.outcome.alreadyTagged,
              refused: result.outcome.refused,
              failed: result.outcome.failed,
              results: result.outcome.results,
            }),
      },
      tenantId: session.claims.tid ?? session.claims.oid,
    });

    if ('refusal' in result) {
      return apiError(result.refusal.reason, 409, { guard: result.refusal.guard });
    }
    return apiOk({ backfill: result.outcome });
  } catch (e) {
    if (e instanceof BrainActionArmError) return apiHonestError(e, 503);
    return apiServerError(e);
  }
});
