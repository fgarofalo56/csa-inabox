/**
 * AI Foundry Agents — list + create/update.
 *
 *   GET  /api/foundry/agents
 *     → { ok, agents: FoundryAgent[], projectId }
 *   POST /api/foundry/agents
 *     body { name, model, instructions, tools?, description?, metadata?, kind? }
 *     → { ok, agent: FoundryAgent }
 *
 * Real Foundry Agent Service REST (lib/azure/foundry-agent-client). Honest gate
 * (HTTP 501, code:'not_configured') when LOOM_FOUNDRY_PROJECT_ENDPOINT isn't
 * configured — no mock agents. Mirrors app/api/data-agent/run-steps/route.ts.
 * See .claude/rules/no-vaporware.md.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listAgents,
  createOrUpdateAgent,
  getProjectId,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
  type FoundryAgentBody,
} from '@/lib/azure/foundry-agent-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Map a thrown error to the honest gate / passthrough response. */
function errorResponse(e: any): NextResponse {
  if (e instanceof FoundryAgentNotConfiguredError) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: e.message, hint: e.hint, missing: 'LOOM_FOUNDRY_PROJECT_ENDPOINT' },
      { status: 501 },
    );
  }
  const status = e instanceof FoundryAgentError ? e.status : 502;
  return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const projectId = getProjectId(); // throws FoundryAgentNotConfiguredError when unconfigured
    const agents = await listAgents(projectId);
    return NextResponse.json({ ok: true, agents, projectId });
  } catch (e: any) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  const instructions = typeof body?.instructions === 'string' ? body.instructions : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name (agent identifier) required' }, { status: 400 });
  if (!model) return NextResponse.json({ ok: false, error: 'model (deployment name) required' }, { status: 400 });
  if (!instructions.trim()) return NextResponse.json({ ok: false, error: 'instructions required' }, { status: 400 });

  const agentBody: FoundryAgentBody = {
    name,
    model,
    instructions,
    ...(Array.isArray(body?.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(typeof body?.description === 'string' && body.description.trim() ? { description: body.description.trim() } : {}),
    ...(body?.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata } : {}),
    ...(typeof body?.kind === 'string' ? { kind: body.kind } : {}),
  };

  try {
    const projectId = getProjectId();
    const agent = await createOrUpdateAgent(projectId, name, agentBody);
    return NextResponse.json({ ok: true, agent });
  } catch (e: any) {
    return errorResponse(e);
  }
}
