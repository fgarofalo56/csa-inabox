/**
 * /api/items/agent-flow/[id]/a2a — a published Loom agent flow's A2A endpoint (WS-5.2).
 *
 *   GET  → the per-flow A2A card (Loom agent registered as an A2A agent card).
 *   POST → JSON-RPC A2A delegation (message/send / tasks/get / tasks/cancel). The
 *          delegated task RUNS the whole flow (runAgentFlowTurn — grounded data +
 *          ontology-object nodes + MCP tools + sub-agent handoffs + guardrails).
 *
 * Sibling of the flow's MCP endpoint (../mcp): same publish flag, same auth
 * (getApiSession), same real Azure backend. Owner-scoped; audited. No Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/lib/auth/api-session';
import { tenantScopeId } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { NoAoaiDeploymentError } from '@/lib/azure/data-agent-client';
import { runAgentFlowTurn } from '@/lib/azure/agent-flow-execute';
import type { AgentFlowState } from '@/lib/azure/agent-flow-run';
import { handleA2aRpc, A2A_ERROR } from '@/lib/copilot/a2a-protocol';
import { buildItemAgentCard, buildItemA2aContext } from '@/lib/copilot/a2a-item-server';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';

function endpointFor(req: NextRequest, id: string): string {
  let origin = '';
  try { origin = new URL(req.url).origin; } catch { origin = process.env.LOOM_PUBLIC_BASE_URL || ''; }
  return `${origin.replace(/\/+$/, '')}/api/items/agent-flow/${encodeURIComponent(id)}/a2a`;
}

async function loadPublished(req: NextRequest, id: string) {
  const session = await getApiSession(req);
  if (!session) return { ok: false as const, status: 401, code: A2A_ERROR.INVALID_REQUEST, message: 'unauthenticated — present a Console session cookie or an Authorization: Bearer loom_pat_… token' };
  let item: WorkspaceItem | null;
  try { item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid); }
  catch { return { ok: false as const, status: 502, code: A2A_ERROR.INTERNAL, message: 'cosmos error loading flow' }; }
  if (!item) return { ok: false as const, status: 404, code: A2A_ERROR.TASK_NOT_FOUND, message: 'agent-flow not found' };
  if ((item.state as Record<string, unknown> | undefined)?.mcpPublished !== true) {
    return { ok: false as const, status: 403, code: A2A_ERROR.INVALID_REQUEST, message: 'This agent flow is not published. Publish it first (Publish as MCP) to expose it as an A2A agent.' };
  }
  return { ok: true as const, item, session };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await loadPublished(req, id);
  if (!loaded.ok) return NextResponse.json({ ok: false, error: loaded.message }, { status: loaded.status });
  return NextResponse.json(buildItemAgentCard({
    name: loaded.item.displayName || 'Agent flow', description: loaded.item.description,
    endpoint: endpointFor(req, id), kind: 'agent flow',
  }));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ jsonrpc: '2.0', id: null, error: { code: A2A_ERROR.PARSE, message: 'Invalid JSON' } }); }

  const loaded = await loadPublished(req, id);
  if (!loaded.ok) {
    return NextResponse.json({ jsonrpc: '2.0', id: Array.isArray(body) ? null : body?.id ?? null, error: { code: loaded.code, message: loaded.message } }, { status: loaded.status });
  }
  const { item, session } = loaded;
  const oid = session.claims.oid;
  const flowName = item.displayName || 'Agent flow';
  const state = (item.state || {}) as AgentFlowState & Record<string, unknown>;

  const ask = async (question: string): Promise<string> => {
    try {
      const turn = await runAgentFlowTurn(state, oid, question, []);
      return turn.answer || '(the flow returned no answer)';
    } catch (e: any) {
      if (e instanceof NoAoaiDeploymentError) throw new Error(`${e.message} — deploy a model, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.`);
      throw e;
    }
  };

  const card = buildItemAgentCard({ name: flowName, description: item.description, endpoint: endpointFor(req, id), kind: 'agent flow' });
  const a2aCtx = buildItemA2aContext({
    card, ask, tenantId: tenantScopeId(session), actorOid: oid,
    actorUpn: session.claims.upn || session.claims.email || oid,
  });

  if (Array.isArray(body)) {
    const out = [];
    for (const single of body) out.push(await handleA2aRpc(single, a2aCtx));
    return NextResponse.json(out);
  }
  const { jsonrpc, id: rpcId, method } = body || {};
  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return NextResponse.json({ jsonrpc: '2.0', id: rpcId ?? null, error: { code: A2A_ERROR.INVALID_REQUEST, message: 'Expected a JSON-RPC 2.0 request with a method' } });
  }
  return NextResponse.json(await handleA2aRpc(body, a2aCtx));
}
