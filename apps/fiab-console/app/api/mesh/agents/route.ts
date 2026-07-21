/**
 * /api/mesh/agents — WS-9 Sovereign Agent Mesh registry (list + create).
 *
 *   GET  → every registered mesh agent for the tenant (seeds the built-in
 *          governance / pipeline / BI / orchestrator trio on first access).
 *   POST → register a new mesh agent (structured body — no free-form config).
 *
 * Tenant-scoped: the registry container is partitioned by tenantId and every
 * read/write is keyed on the caller's tenant, so no cross-tenant access.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiServerError } from '@/lib/api/respond';
import { listMeshAgents, upsertMeshAgent } from '@/lib/azure/agent-registry-store';
import { normalizeMeshAgent } from '@/lib/copilot/agent-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tenantId = tenantScopeId(session);
  try {
    const agents = await listMeshAgents(tenantId);
    return apiOk({ agents });
  } catch (e) {
    return apiServerError(e, 'could not load the agent mesh registry');
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tenantId = tenantScopeId(session);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('invalid JSON body');
  }
  const agent = normalizeMeshAgent(body, tenantId);
  if (!agent) return apiBadRequest('a mesh agent requires at least a name');
  agent.tenantId = tenantId;
  agent.createdBy = session.claims.oid;
  try {
    const saved = await upsertMeshAgent(agent);
    return apiOk({ agent: saved });
  } catch (e) {
    return apiServerError(e, 'could not register the mesh agent');
  }
}
