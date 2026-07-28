/**
 * POST /api/governance/copilot/ask — B-N14b, the NL governance copilot.
 *
 * Body: `{ question: string }`
 * 200  `{ ok:true, ...GovernanceAnswer }` — the narrated answer plus the typed
 *      policy-path citations it rests on, the silos that could not be read, and
 *      the honest AOAI gate when no model is deployed (the citations are still
 *      returned in that case — evidence without interpretation beats nothing).
 * 400  `{ ok:false, error }` — no question.
 * 401  `{ ok:false, error:'unauthenticated' }`
 *
 * The answer is scoped to the CALLER's tenant partition (`session.claims.oid`,
 * the same partition every governance store uses), so a question can never
 * retrieve another tenant's grants. This route only READS — it never mutates a
 * policy, a grant, or a contract.
 *
 * Azure-native (no-fabric-dependency.md): Cosmos + in-VNet Azure OpenAI only.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError } from '@/lib/api/respond';
import { askGovernance } from '@/lib/governance/nl-governance-copilot';

export const POST = withSession(async (req: NextRequest, { session }) => {
  let body: { question?: unknown } = {};
  try {
    body = (await req.json()) as { question?: unknown };
  } catch {
    /* fall through to validation */
  }
  const question = String(body.question ?? '').trim();
  if (!question) return apiError('A question is required.', 400);
  if (question.length > 2000) return apiError('The question is too long (2000 character maximum).', 400);

  const answer = await askGovernance({ question, tenantId: session.claims.oid });
  return apiOk({ ...answer });
});
