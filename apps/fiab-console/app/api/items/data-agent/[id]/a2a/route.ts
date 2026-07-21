/**
 * /api/items/data-agent/[id]/a2a — a published Loom data agent's A2A endpoint (WS-5.2).
 *
 *   GET  → the per-agent A2A card (Loom agent registered as an A2A agent card).
 *   POST → JSON-RPC A2A delegation (message/send / tasks/get / tasks/cancel). The
 *          delegated task runs the agent's REAL grounded chat (chatGrounded).
 *
 * Sibling of the agent's MCP endpoint (../mcp): same publish flag (mcpPublished =
 * "published as a callable agent"), same auth (getApiSession — cookie or Bearer
 * loom_pat_…), same real AOAI backend. Owner-scoped; audited. Azure-native; no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/lib/auth/api-session';
import { tenantScopeId } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { enrichSemanticModelSources } from '../../../semantic-model/_lib/prep-for-ai-store';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig, type ChatTurn } from '@/lib/azure/data-agent-client';
import { handleA2aRpc, A2A_ERROR } from '@/lib/copilot/a2a-protocol';
import { buildItemAgentCard, buildItemA2aContext } from '@/lib/copilot/a2a-item-server';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

function endpointFor(req: NextRequest, id: string): string {
  let origin = '';
  try { origin = new URL(req.url).origin; } catch { origin = process.env.LOOM_PUBLIC_BASE_URL || ''; }
  return `${origin.replace(/\/+$/, '')}/api/items/data-agent/${encodeURIComponent(id)}/a2a`;
}

function stateToConfig(state: Record<string, unknown>): DataAgentConfig {
  const sources = Array.isArray(state.sources) ? (state.sources as any[]) : [];
  return {
    instructions: String(state.instructions || state.systemPrompt || ''),
    description: state.description ? String(state.description) : undefined,
    sources: sources.map((s) => ({
      id: String(s.id || s.name || ''), type: s.type, name: String(s.name || ''),
      tables: s.tables ? String(s.tables) : undefined,
      description: s.description ? String(s.description) : undefined,
      instructions: s.instructions ? String(s.instructions) : undefined,
      examples: Array.isArray(s.examples) ? s.examples : undefined,
      aiSearch: s.aiSearch && typeof s.aiSearch === 'object' ? s.aiSearch : undefined,
      graph: s.graph && typeof s.graph === 'object' ? s.graph : undefined,
    })),
  };
}

async function loadPublished(req: NextRequest, id: string) {
  const session = await getApiSession(req);
  if (!session) return { ok: false as const, status: 401, code: A2A_ERROR.INVALID_REQUEST, message: 'unauthenticated — present a Console session cookie or an Authorization: Bearer loom_pat_… token' };
  let item: WorkspaceItem | null;
  try { item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid); }
  catch { return { ok: false as const, status: 502, code: A2A_ERROR.INTERNAL, message: 'cosmos error loading agent' }; }
  if (!item) return { ok: false as const, status: 404, code: A2A_ERROR.TASK_NOT_FOUND, message: 'data-agent not found' };
  if ((item.state as Record<string, unknown> | undefined)?.mcpPublished !== true) {
    return { ok: false as const, status: 403, code: A2A_ERROR.INVALID_REQUEST, message: 'This data agent is not published. Publish it first (Publish as MCP) to expose it as an A2A agent.' };
  }
  return { ok: true as const, item, session };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await loadPublished(req, id);
  if (!loaded.ok) return NextResponse.json({ ok: false, error: loaded.message }, { status: loaded.status });
  return NextResponse.json(buildItemAgentCard({
    name: loaded.item.displayName || 'Data agent', description: loaded.item.description,
    endpoint: endpointFor(req, id), kind: 'data agent',
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
  const agentName = item.displayName || 'Data agent';
  const state = (item.state || {}) as Record<string, unknown>;

  const ask = async (question: string): Promise<string> => {
    const cfg = stateToConfig(state);
    cfg.sources = await enrichSemanticModelSources(cfg.sources, oid);
    try {
      const answer = await chatGrounded(cfg, [] as ChatTurn[], question, { tenantId: oid });
      return answer.answer || '(the agent returned no answer)';
    } catch (e: any) {
      if (e instanceof NoAoaiDeploymentError) throw new Error(`${e.message} — deploy a model, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.`);
      throw e;
    }
  };

  const card = buildItemAgentCard({ name: agentName, description: item.description, endpoint: endpointFor(req, id), kind: 'data agent' });
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
