/**
 * GET /api/mesh/a2a/[id]/card — WS-9 A2A hub: publish a mesh agent's agent card.
 *
 * Returns the A2A `agent.json` (name / description / url / skills / capabilities)
 * an external ADK / Foundry agent fetches to discover this Loom mesh agent and
 * delegate a task to it (POST /api/mesh/a2a/delegate). Only agents that opt into
 * `publishA2A` are exposed; every inbound delegation is still policy-checked +
 * audited by the mesh runner. This is how Loom agents publish OUT (WS-5.1/5.2).
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiUnauthorized, apiNotFound, apiForbidden, apiServerError } from '@/lib/api/respond';
import { NextResponse } from 'next/server';
import { getMeshAgent } from '@/lib/azure/agent-registry-store';
import { buildA2AAgentCard } from '@/lib/copilot/agent-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tenantId = tenantScopeId(session);
  const id = (await ctx.params).id;
  try {
    const agent = await getMeshAgent(tenantId, id);
    if (!agent) return apiNotFound('mesh agent not found');
    if (!agent.publishA2A) {
      return apiForbidden(`agent "${agent.name}" is not published to the A2A hub`);
    }
    let origin = process.env.LOOM_PUBLIC_BASE_URL || '';
    try {
      origin = new URL(req.url).origin;
    } catch {
      /* keep env fallback */
    }
    const card = buildA2AAgentCard(agent, origin);
    return NextResponse.json(card);
  } catch (e) {
    return apiServerError(e, 'could not build the A2A agent card');
  }
}
