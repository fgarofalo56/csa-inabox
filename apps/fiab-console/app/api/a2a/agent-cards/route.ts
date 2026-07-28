/**
 * /api/a2a/agent-cards — authenticated A2A agent-card discovery catalog (B-N14d).
 *
 *   GET → every agent this caller can address over A2A, each with its generated
 *         spec-conformant card URL, its JSON-RPC endpoint, the §4.4.6 `tenant`
 *         routing id for addressing it behind the shared `/api/a2a` endpoint,
 *         and whether the generated card passes the spec validator.
 *
 * Why this is NOT under `/.well-known`: §14.3 registers `.well-known/agent-card.json`
 * for ONE agent card (Loom's platform card, served there already) and notes the
 * card "MAY contain public information … and SHOULD NOT include sensitive
 * credentials or internal implementation details". Enumerating a tenant's
 * agents is not public information, so the multi-agent catalog is
 * session-scoped here while the well-known path keeps serving the public
 * platform card.
 *
 * Real Cosmos reads (published data-agents + agent-flows the caller holds a
 * role on, plus the tenant's A2A-published mesh agents). Azure-native; no Fabric.
 */
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiHonestError } from '@/lib/api/respond';
import { tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import { listOwnedItems } from '@/app/api/items/_lib/item-crud';
import { listMeshAgents } from '@/lib/azure/agent-registry-store';
import {
  agentCardCatalogEntry,
  registeredAgentFromItem,
  registeredAgentFromMeshAgent,
  registeredPlatformAgent,
  A2A_WELL_KNOWN_PATH,
  type AgentCardCatalogEntry,
} from '@/lib/copilot/a2a-agent-card';
import { PLATFORM_SKILLS } from '@/lib/copilot/a2a-tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function originOf(req: NextRequest): string {
  try {
    return new URL(req.url).origin.replace(/\/+$/, '');
  } catch {
    return (process.env.LOOM_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  }
}

/** True when a data-agent / agent-flow item is published as a callable agent. */
function isPublished(state: Record<string, unknown> | null | undefined): boolean {
  return (state as Record<string, unknown> | undefined)?.mcpPublished === true;
}

export const GET = withSession(async (req: NextRequest, { session }) => {
  const origin = originOf(req);
  const tenantId = tenantScopeId(session as SessionPayload);
  const entries: AgentCardCatalogEntry[] = [];

  try {
    // 1. The platform card itself (public, at the registered well-known URI).
    entries.push(
      agentCardCatalogEntry(
        registeredPlatformAgent({ origin, skills: PLATFORM_SKILLS }),
        `${origin}${A2A_WELL_KNOWN_PATH}`,
      ),
    );

    // 2. Published data-agent / agent-flow items the caller holds a role on.
    for (const kind of ['data-agent', 'agent-flow'] as const) {
      const items = await listOwnedItems(kind, tenantId, { session: session as SessionPayload }).catch(() => []);
      for (const item of items) {
        if (!isPublished(item.state as Record<string, unknown> | undefined)) continue;
        const endpoint = `${origin}/api/items/${kind}/${encodeURIComponent(item.id)}/a2a`;
        entries.push(
          agentCardCatalogEntry(
            registeredAgentFromItem({
              item: {
                id: item.id,
                displayName: item.displayName,
                description: item.description,
                state: (item.state as Record<string, unknown>) || null,
              },
              kind,
              endpoint,
              platformEndpoint: `${origin}/api/a2a`,
              documentationUrl: `${origin}/learn`,
            }),
            endpoint,
          ),
        );
      }
    }

    // 3. Mesh agents this tenant published to the A2A hub.
    const mesh = await listMeshAgents(tenantId).catch(() => []);
    for (const agent of mesh) {
      if (!agent.publishA2A) continue;
      const endpoint = `${origin}/api/mesh/a2a/${encodeURIComponent(agent.id)}`;
      entries.push(
        agentCardCatalogEntry(
          registeredAgentFromMeshAgent({
            agent: {
              id: agent.id,
              name: agent.name,
              description: agent.description,
              kind: agent.kind,
              egressProfile: agent.egressProfile,
            },
            endpoint,
            documentationUrl: `${origin}/learn`,
          }),
          `${endpoint}/card`,
        ),
      );
    }

    return apiOk({
      wellKnown: `${origin}${A2A_WELL_KNOWN_PATH}`,
      total: entries.length,
      nonConformant: entries.filter((e) => !e.conformant).length,
      agents: entries,
    });
  } catch (e) {
    return apiHonestError(e, 502, 'could not build the A2A agent-card catalog');
  }
});
