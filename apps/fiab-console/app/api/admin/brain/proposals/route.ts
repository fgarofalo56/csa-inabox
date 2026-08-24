/**
 * BFF — POST /api/admin/brain/proposals
 *
 * RECORDS A HUMAN DECISION. IT DOES NOT PERFORM ONE.
 *
 * This is the "a recommendation can be reviewed and approved by a human" half
 * of PRP §5's definition of done — and the word `approved` here means A PERSON
 * READ IT AND AGREED, nothing more. Approval writes an audit record. It does
 * not scale a replica, delete a resource, open a PR, or dispatch a workflow.
 * The proposed change is text the operator applies themselves.
 *
 * ── WHY AN APPROVE BUTTON EXISTS AT ALL, GIVEN RECOMMEND-ONLY ──────────────
 * Because "recommend-only" is not "no workflow". An operator triaging 30
 * findings needs somewhere to put "yes, this one" and "no, this is a false
 * positive", and that judgement is the most valuable data this system produces:
 * PRP §4 notes the findings ARE the training corpus for a later model, and a
 * corpus with no human labels is not one.
 *
 * ── THE THREE THINGS THAT MAKE THIS NOT A MUTATION ─────────────────────────
 *   1. Nothing in this module's dependency tree can reach an Azure write. The
 *      only sink is `emitAuditEvent`, which posts to the Log Analytics
 *      ingestion endpoint.
 *   2. `RemediationProposal` pins `mutatesAzure: false` and
 *      `requiresHumanApproval: true` as LITERAL types, so a "proposal" that
 *      executes is not constructible anywhere in the Brain.
 *   3. `__tests__/ui/no-mutation-controls.test.tsx` asserts it, both by walking
 *      every rendered control on the surface and by checking this route's own
 *      module graph.
 *
 * If a future release adds execution, it does NOT belong in this handler. It
 * belongs behind a separate route, a separate capability, and its own review —
 * PRP §1 decision 1 is a measured decision about blast radius, not a phase.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────
 * `withTenantAdmin`, never an inline check. See the sibling `graph/route.ts`
 * doc-block for why the wrapper rather than the idiom.
 */

import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiOk, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import type { ProposalDecision } from '../_lib/wire';

export const dynamic = 'force-dynamic';

const DECISIONS: readonly ProposalDecision[] = ['approved', 'dismissed'];

/** Bound the free-text note so one review cannot flood the audit stream. */
const MAX_NOTE = 2000;

function parseBody(raw: unknown): { findingId: string; decision: ProposalDecision; note: string } | string {
  if (typeof raw !== 'object' || raw === null) return 'body must be a JSON object';
  const b = raw as Record<string, unknown>;

  const findingId = typeof b.findingId === 'string' ? b.findingId.trim() : '';
  if (findingId === '') return 'findingId is required';
  if (findingId.length > 512) return 'findingId is too long';

  const decision = b.decision;
  if (typeof decision !== 'string' || !DECISIONS.includes(decision as ProposalDecision)) {
    return `decision must be one of: ${DECISIONS.join(', ')}`;
  }

  const note = typeof b.note === 'string' ? b.note.slice(0, MAX_NOTE) : '';
  return { findingId, decision: decision as ProposalDecision, note };
}

export const POST = withTenantAdmin(async (req: NextRequest, { session }) => {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = parseBody(raw);
    if (typeof parsed === 'string') return apiBadRequest(parsed);

    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      action: `brain-proposal.${parsed.decision}`,
      targetType: 'brain-finding',
      targetId: parsed.findingId,
      outcome: 'success',
      detail: {
        decision: parsed.decision,
        note: parsed.note,
        // Recorded on every row so an auditor reading the stream in a year does
        // not have to reconstruct whether this ever touched Azure. It did not.
        mutatedAzure: false,
        recommendOnly: true,
      },
      tenantId: session.claims.tid ?? session.claims.oid,
    });

    return apiOk({
      recorded: true,
      findingId: parsed.findingId,
      decision: parsed.decision,
      // Returned so the CLIENT can render the guarantee rather than assert it.
      mutatedAzure: false,
      note:
        parsed.decision === 'approved'
          ? 'Recorded. NOTHING was changed in Azure — the Brain is recommend-only. ' +
            'Apply the proposed change yourself in the repository.'
          : 'Recorded as dismissed. No change was made anywhere.',
    });
  } catch (e) {
    return apiServerError(e);
  }
});
