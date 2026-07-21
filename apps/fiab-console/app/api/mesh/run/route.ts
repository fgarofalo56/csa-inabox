/**
 * POST /api/mesh/run — WS-9 execute a GOVERNED multi-agent mesh task.
 *
 * body { task: string, agentIds?: string[] }
 *
 * Runs the mesh: the lead (orchestrator) delegates to the member agents, EVERY
 * inter-agent hop is policy-checked (PDP + structural sovereignty) and audited,
 * per-agent MCP scoping + egress are enforced (air-gap = fail-closed), and the
 * lead synthesizes a single governed answer. Returns the full trace so the run
 * pane shows every policy decision + egress-blocked tool call.
 *
 * `agentIds` (optional) selects + orders the participating agents (first = lead);
 * omitted → the full registered mesh in seeded order. Azure-native, no Fabric.
 */
import { NextRequest } from 'next/server';
import { getSession, tenantScopeId } from '@/lib/auth/session';
import { apiOk, apiUnauthorized, apiBadRequest, apiHonestError, apiServerError } from '@/lib/api/respond';
import { listMeshAgents } from '@/lib/azure/agent-registry-store';
import { executeMeshTask } from '@/lib/azure/agent-mesh-run';
import { NoAoaiDeploymentError } from '@/lib/azure/data-agent-client';
import type { MeshAgentDef } from '@/lib/copilot/agent-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AOAI_GATE_HINT =
  'The mesh runs on your Azure OpenAI deployment. Deploy gpt-4o-mini (AI Foundry hub → Quota + usage), or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT and grant the Console UAMI "Cognitive Services OpenAI User". In a Gov deployment this is the direct *.openai.azure.us endpoint — no Fabric / Power BI needed.';

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
  const task = String(body?.task || '').trim();
  if (!task) return apiBadRequest('task required');
  const agentIds: string[] = Array.isArray(body?.agentIds)
    ? body.agentIds.map((x: unknown) => String(x)).filter(Boolean)
    : [];

  let all: MeshAgentDef[];
  try {
    all = await listMeshAgents(tenantId);
  } catch (e) {
    return apiServerError(e, 'could not load the agent mesh registry');
  }

  // Select + order the participating agents (first = lead).
  let agents: MeshAgentDef[];
  if (agentIds.length) {
    const byId = new Map(all.map((a) => [a.id, a]));
    agents = agentIds.map((id) => byId.get(id)).filter((a): a is MeshAgentDef => !!a);
  } else {
    agents = all;
  }
  if (agents.length === 0) {
    return apiBadRequest('no mesh agents selected — register or select at least a lead agent');
  }

  try {
    const result = await executeMeshTask(session, agents, task);
    return apiOk({ result });
  } catch (e) {
    if (e instanceof NoAoaiDeploymentError) return apiHonestError(e, 503, AOAI_GATE_HINT);
    return apiServerError(e, 'the mesh task failed');
  }
}
