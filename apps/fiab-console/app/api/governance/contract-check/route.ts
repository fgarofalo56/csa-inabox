/**
 * POST /api/governance/contract-check — B-N14c, the shared pre-proposal
 * data-contract check.
 *
 * The ONE place any copilot surface grades a proposed pipeline / dataflow / SQL
 * against the N6 ODCS contracts. Surfaces whose backend is a streaming route
 * (the SQL editor Copilot pane) call this AFTER the proposal text arrives;
 * surfaces whose backend is a JSON route (Dataflow Gen2 Copilot, the pipeline
 * Copilot tool) get the same result inline, from the same
 * `checkProposalContracts` helper — one implementation, no fork.
 *
 * Body: `{ kind:'sql'|'pipeline'|'dataflow', text?: string, spec?: unknown }`
 * 200  `{ ok:true, check: ContractCheck }` — including the honest `skipped`
 *      reason when the flag is off or the registry could not be read.
 * 400  `{ ok:false, error }`
 * 401  `{ ok:false, error:'unauthenticated' }`
 *
 * Read-only: it reads the contract registry and returns a verdict. It never
 * applies, mutates, or blocks anything server-side — the surface decides what to
 * do with a `blocked` proposal.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { checkProposalContracts } from '@/lib/copilot/contract-guard';
import type { ProposalKind } from '@/lib/copilot/contract-validation';

const KINDS: readonly ProposalKind[] = ['sql', 'pipeline', 'dataflow'];
/** Proposal text cap — a copilot suggestion, not a data payload. */
const MAX_TEXT = 200_000;

export const POST = withSession(async (req: NextRequest, { session }) => {
  let body: { kind?: unknown; text?: unknown; spec?: unknown } = {};
  try {
    body = (await req.json()) as { kind?: unknown; text?: unknown; spec?: unknown };
  } catch {
    return apiError('Invalid JSON body.', 400);
  }
  const kind = String(body.kind ?? '').toLowerCase() as ProposalKind;
  if (!KINDS.includes(kind)) {
    return apiError(`kind must be one of: ${KINDS.join(', ')}`, 400);
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.length > MAX_TEXT) return apiError('The proposal is too large to check.', 400);
  if (!text.trim() && body.spec == null) {
    return apiError('Either text or spec is required.', 400);
  }

  const check = await checkProposalContracts(session.claims.oid, { kind, text, spec: body.spec });
  return apiOk({ check });
});
