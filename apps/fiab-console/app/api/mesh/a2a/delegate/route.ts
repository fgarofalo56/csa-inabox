/**
 * POST /api/mesh/a2a/delegate — WS-9 A2A hub inbound: an external agent delegates
 * a task INTO the Loom mesh.
 *
 * body { agentId: string, task: string }
 *
 * The A2A boundary gate: only an agent that `publishA2A` may be targeted — a
 * refused entry returns 403 (the structural sovereignty rule). Once admitted, the
 * task runs through the SAME governed mesh runner (policy-checked + audited hops,
 * per-agent MCP scoping, egress fail-closed) as an internal run. When the target is
 * the orchestrator, its member agents (governance / pipeline / BI) participate.
 *
 * External callers authenticate through the platform front door (Entra session /
 * Loom PAT) exactly like every other BFF route — this route does not widen access.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiForbidden, apiHonestError, apiServerError } from '@/lib/api/respond';
import { getMeshAgent, listMeshAgents } from '@/lib/azure/agent-registry-store';
import { executeMeshTask } from '@/lib/azure/agent-mesh-run';
import { NoAoaiDeploymentError } from '@/lib/azure/data-agent-client';
import type { MeshAgentDef } from '@/lib/copilot/agent-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const tenantId = tenantScopeId(session);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('invalid JSON body');
  }
  const agentId = String(body?.agentId || '').trim();
  const task = String(body?.task || '').trim();
  if (!agentId || !task) return apiBadRequest('agentId and task are required');

  let target: MeshAgentDef | null;
  try {
    target = await getMeshAgent(tenantId, agentId);
  } catch (e) {
    return apiServerError(e, 'could not load the target mesh agent');
  }
  if (!target) return apiBadRequest('target mesh agent not found');
  // A2A boundary gate — only published agents accept external delegation.
  if (!target.publishA2A) {
    return apiForbidden(`agent "${target.name}" is not published to the A2A hub — external delegation refused`);
  }

  // Assemble the participating agents (orchestrator target → include its members).
  let agents: MeshAgentDef[] = [target];
  if (target.kind === 'orchestrator') {
    try {
      const all = await listMeshAgents(tenantId);
      agents = [target, ...all.filter((a) => a.id !== target!.id && a.kind !== 'orchestrator')];
    } catch (e) {
      return apiServerError(e, 'could not load the mesh registry');
    }
  }

  try {
    const result = await executeMeshTask(session, agents, task, { external: false });
    return apiOk({ result, via: 'a2a-hub', delegatedTo: target.id });
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) {
      return apiHonestError(e, 503, 'The mesh runs on your Azure OpenAI deployment — deploy a model or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.');
    }
    return apiServerError(e, 'the A2A delegation failed');
  }
}
