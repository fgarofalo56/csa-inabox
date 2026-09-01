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
 *      sinks are `emitAuditEvent` (Log Analytics ingestion) and the Cosmos
 *      recommendation-state store — a decision record, not an Azure resource.
 *   2. `RemediationProposal` pins `mutatesAzure: false` and
 *      `requiresHumanApproval: true` as LITERAL types, so a "proposal" that
 *      executes is not constructible anywhere in the Brain.
 *   3. `__tests__/ui/no-mutation-controls.test.tsx` asserts it, both by walking
 *      every rendered control on the surface and by checking this route's own
 *      module graph.
 *
 * Execution EXISTS as of #4242 — and, exactly as this doc-block always said it
 * must, it lives behind a SEPARATE route (`../perform`), a separate capability
 * (`lib/brain-actions/**`, outside `lib/brain`), and its own guard chain +
 * review. This handler still performs nothing: approving here records a
 * decision, and the perform route re-derives every guard from scratch when —
 * and only when — the operator explicitly invokes it.
 *
 * ── DECISIONS NOW PERSIST (the decision-amnesia fix, #4242) ────────────────
 * This route used to fire-and-forget the audit event, so a page reload forgot
 * every approved/dismissed. Decisions are now ALSO written to the per-finding
 * recommendation-state store; when that store is not configured the response
 * says so honestly (`persisted: false` + the reason) instead of pretending.
 *
 * ── AUTHORIZATION ──────────────────────────────────────────────────────────
 * `withTenantAdmin`, never an inline check. See the sibling `graph/route.ts`
 * doc-block for why the wrapper rather than the idiom.
 */

import type { NextRequest } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { apiBadRequest, apiOk, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { recommendationStateStore } from '@/lib/brain-actions/state-store';
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

    // The decision-amnesia fix (#4242): persist the decision per finding so a
    // reload still knows it. FAIL SOFT with disclosure — the audit row above is
    // already written, and a deployment without the store keeps working while
    // the response says exactly what did not persist (R7).
    let persisted = true;
    let persistError: string | undefined;
    try {
      await recommendationStateStore().recordDecision(
        parsed.findingId,
        parsed.decision,
        { oid: session.claims.oid, upn: session.claims.upn },
        parsed.note || undefined,
      );
    } catch (e) {
      persisted = false;
      persistError = e instanceof Error ? e.message : String(e);
    }

    return apiOk({
      recorded: true,
      persisted,
      ...(persistError ? { persistError } : {}),
      findingId: parsed.findingId,
      decision: parsed.decision,
      // Returned so the CLIENT can render the guarantee rather than assert it.
      mutatedAzure: false,
      note:
        parsed.decision === 'approved'
          ? 'Recorded. NOTHING was changed in Azure — recording an approval never ' +
            'executes anything. Performing the change is a separate, explicit action ' +
            'with its own guards (the perform route), or a repository edit you make.'
          : 'Recorded as dismissed. No change was made anywhere.',
    });
  } catch (e) {
    return apiServerError(e);
  }
});
