/**
 * /api/mesh/agents/[id] — WS-9 mesh agent read / update / delete (tenant-scoped).
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiNotFound, apiServerError } from '@/lib/api/respond';
import { getMeshAgent, upsertMeshAgent, deleteMeshAgent } from '@/lib/azure/agent-registry-store';
import { normalizeMeshAgent } from '@/lib/copilot/agent-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tenantId = tenantScopeId(session);
  const id = (await ctx.params).id;
  try {
    const agent = await getMeshAgent(tenantId, id);
    if (!agent) return apiNotFound('mesh agent not found');
    return apiOk({ agent });
  } catch (e) {
    return apiServerError(e, 'could not load the mesh agent');
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tenantId = tenantScopeId(session);
  const id = (await ctx.params).id;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('invalid JSON body');
  }
  try {
    const existing = await getMeshAgent(tenantId, id);
    if (!existing) return apiNotFound('mesh agent not found');
    const merged = normalizeMeshAgent({ ...existing, ...body, id, tenantId }, tenantId);
    if (!merged) return apiBadRequest('a mesh agent requires at least a name');
    merged.builtin = existing.builtin;
    merged.createdAt = existing.createdAt;
    merged.createdBy = existing.createdBy;
    const saved = await upsertMeshAgent(merged);
    return apiOk({ agent: saved });
  } catch (e) {
    return apiServerError(e, 'could not update the mesh agent');
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tenantId = tenantScopeId(session);
  const id = (await ctx.params).id;
  try {
    await deleteMeshAgent(tenantId, id);
    return apiOk({ deleted: id });
  } catch (e) {
    return apiServerError(e, 'could not delete the mesh agent');
  }
}
