/**
 * /api/a2a/agent-cards/[kind]/[id] — ONE registered agent's generated A2A card.
 *
 *   GET → the spec-conformant Agent Card generated from the agent's REGISTERED
 *         platform metadata, plus the §4.4.1–§4.4.7 conformance report from
 *         `validateAgentCard`. `?raw=1` returns the bare card document (exactly
 *         what an A2A client would consume) instead of the envelope.
 *
 * `kind` is `data-agent` | `agent-flow` | `mesh`. Access is proven per kind —
 * a workspace-item agent through `loadOwnedItem` (role required), a mesh agent
 * through the tenant-scoped registry — so a caller can only read cards for
 * agents they can already see. Real Cosmos reads; Azure-native, no Fabric.
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { NextResponse } from 'next/server';
import { apiOk, apiBadRequest, apiNotFound, apiForbidden, apiHonestError } from '@/lib/api/respond';
import { tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { getMeshAgent } from '@/lib/azure/agent-registry-store';
import {
  generateValidatedAgentCard,
  registeredAgentFromItem,
  registeredAgentFromMeshAgent,
  type RegisteredAgentMeta,
} from '@/lib/copilot/a2a-agent-card';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['data-agent', 'agent-flow', 'mesh'] as const;
type CardKind = (typeof KINDS)[number];

function originOf(req: NextRequest): string {
  try {
    return new URL(req.url).origin.replace(/\/+$/, '');
  } catch {
    return (process.env.LOOM_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  }
}

export const GET = withSession<{ kind: string; id: string }>(async (req: NextRequest, { session, params }) => {
  const kind = params.kind as CardKind;
  const id = (params.id || '').trim();
  if (!KINDS.includes(kind)) return apiBadRequest(`kind must be one of ${KINDS.join(', ')}`);
  if (!id) return apiBadRequest('an agent id is required');

  const origin = originOf(req);
  const tenantId = tenantScopeId(session as SessionPayload);

  try {
    let meta: RegisteredAgentMeta;
    if (kind === 'mesh') {
      const agent = await getMeshAgent(tenantId, id);
      if (!agent) return apiNotFound('mesh agent not found');
      if (!agent.publishA2A) return apiForbidden(`agent "${agent.name}" is not published to the A2A hub`);
      meta = registeredAgentFromMeshAgent({
        agent: {
          id: agent.id, name: agent.name, description: agent.description,
          kind: agent.kind, egressProfile: agent.egressProfile,
        },
        endpoint: `${origin}/api/mesh/a2a/${encodeURIComponent(agent.id)}`,
        documentationUrl: `${origin}/learn`,
      });
    } else {
      const item = await loadOwnedItem(id, kind, tenantId, { allowReadRoles: true });
      if (!item) return apiNotFound(`${kind} not found, or you do not have access to it`);
      const state = (item.state as Record<string, unknown>) || {};
      if (state.mcpPublished !== true) {
        return apiForbidden(
          `This ${kind} is not published. Publish it first (Publish as MCP) to expose it as an A2A agent.`,
        );
      }
      meta = registeredAgentFromItem({
        item: { id: item.id, displayName: item.displayName, description: item.description, state },
        kind,
        endpoint: `${origin}/api/items/${kind}/${encodeURIComponent(item.id)}/a2a`,
        platformEndpoint: `${origin}/api/a2a`,
        documentationUrl: `${origin}/learn`,
      });
    }

    const { card, validation } = generateValidatedAgentCard(meta);
    const raw = req.nextUrl.searchParams.get('raw');
    if (raw === '1' || raw === 'true') return NextResponse.json(card);
    return apiOk({ kind, id, card, validation });
  } catch (e) {
    return apiHonestError(e, 502, 'could not generate the A2A agent card');
  }
});
