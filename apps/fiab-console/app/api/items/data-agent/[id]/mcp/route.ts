/**
 * /api/items/data-agent/[id]/mcp — the MCP server for a published Loom data agent (DBX-9).
 *
 *   POST → JSON-RPC 2.0 (initialize / ping / tools/list / tools/call / batch).
 *          The single tool `ask_<agent>` runs the agent's real grounded chat.
 *   GET  → an unauthenticated-safe discovery doc (owner-scoped fields only).
 *
 * Auth: getApiSession — a Console cookie session OR a scoped API token
 * (`Authorization: Bearer loom_pat_…`), so an external MCP client (Claude
 * Desktop, Agent 365, Foundry, or Loom's own Copilot) authenticates with the
 * publisher's token. The agent is owner-scoped (loadOwnedItem) and only serves
 * once it has been published as MCP (state.mcpPublished) — an honest gate
 * otherwise. Real backend: chatGrounded against the live AOAI deployment.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/lib/auth/api-session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { enrichSemanticModelSources } from '../../../semantic-model/_lib/prep-for-ai-store';
import { chatGrounded, NoAoaiDeploymentError, type DataAgentConfig, type ChatTurn } from '@/lib/azure/data-agent-client';
import {
  handleAgentMcpMethod, agentMcpToolName, MCP_PROTOCOL_VERSION, RPC,
  type AgentMcpContext, type ChatTurnLike,
} from '@/lib/copilot/data-agent-mcp';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
}

/** Build the agent's grounded config from its persisted state (mirrors the chat route). */
function stateToConfig(state: Record<string, unknown>): DataAgentConfig {
  const sources = Array.isArray(state.sources) ? (state.sources as any[]) : [];
  return {
    instructions: String(state.instructions || state.systemPrompt || ''),
    description: state.description ? String(state.description) : undefined,
    sources: sources.map((s) => ({
      id: String(s.id || s.name || ''),
      type: s.type,
      name: String(s.name || ''),
      tables: s.tables ? String(s.tables) : undefined,
      description: s.description ? String(s.description) : undefined,
      instructions: s.instructions ? String(s.instructions) : undefined,
      examples: Array.isArray(s.examples) ? s.examples : undefined,
      aiSearch: s.aiSearch && typeof s.aiSearch === 'object' ? s.aiSearch : undefined,
      graph: s.graph && typeof s.graph === 'object' ? s.graph : undefined,
    })),
  };
}

async function loadPublishedAgent(req: NextRequest, id: string): Promise<
  | { ok: true; item: WorkspaceItem; oid: string }
  | { ok: false; status: number; code: number; message: string }
> {
  const session = await getApiSession(req);
  if (!session) {
    return { ok: false, status: 401, code: RPC.UNAUTHORIZED, message: 'unauthenticated — present a Console session cookie or an Authorization: Bearer loom_pat_… token' };
  }
  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch {
    return { ok: false, status: 502, code: RPC.INTERNAL, message: 'cosmos error loading agent' };
  }
  if (!item) return { ok: false, status: 404, code: RPC.METHOD_NOT_FOUND, message: 'data-agent not found' };
  const published = (item.state as Record<string, unknown> | undefined)?.mcpPublished === true;
  if (!published) {
    return { ok: false, status: 403, code: RPC.UNAUTHORIZED, message: 'This data agent is not published as MCP. Publish it first (Publish as MCP).' };
  }
  return { ok: true, item, oid: session.claims.oid };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return rpcError(null, RPC.PARSE, 'Invalid JSON'); }

  const loaded = await loadPublishedAgent(req, id);
  if (!loaded.ok) return rpcError(Array.isArray(body) ? null : body?.id, loaded.code, loaded.message, loaded.status);

  const { item, oid } = loaded;
  const agentName = item.displayName || 'Data agent';
  const state = (item.state || {}) as Record<string, unknown>;
  const toolName = (typeof state.mcpToolName === 'string' && state.mcpToolName) || agentMcpToolName(agentName);

  // The real backend the ask_<agent> tool calls: build the grounded config and
  // run one turn against the live AOAI deployment.
  const ask = async (question: string, history: ChatTurnLike[]): Promise<string> => {
    const cfg = stateToConfig(state);
    cfg.sources = await enrichSemanticModelSources(cfg.sources, oid);
    try {
      const answer = await chatGrounded(cfg, history as ChatTurn[], question, { tenantId: oid });
      return answer.answer || '(the agent returned no answer)';
    } catch (e: any) {
      if (e instanceof NoAoaiDeploymentError) {
        throw new Error(`${e.message} — deploy a model from the AI Foundry hub "Quota + usage" tab, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.`);
      }
      throw e;
    }
  };

  const mcpCtx: AgentMcpContext = { toolName, agentName, description: item.description, ask };

  // JSON-RPC batch (array) or single request.
  if (Array.isArray(body)) {
    const out = [];
    for (const single of body) {
      const r = await handleAgentMcpMethod(single, mcpCtx);
      if (r !== null) out.push(r);
    }
    return NextResponse.json(out);
  }

  const { jsonrpc, id: rpcId, method } = body || {};
  if (jsonrpc !== '2.0' || typeof method !== 'string') {
    return rpcError(rpcId, RPC.INVALID_REQUEST, 'Expected a JSON-RPC 2.0 request with a method');
  }
  const out = await handleAgentMcpMethod(body, mcpCtx);
  if (out === null) return new NextResponse(null, { status: 204 }); // notification
  return NextResponse.json(out);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const loaded = await loadPublishedAgent(req, id);
  if (!loaded.ok) return NextResponse.json({ ok: false, error: loaded.message }, { status: loaded.status });
  const state = (loaded.item.state || {}) as Record<string, unknown>;
  const toolName = (typeof state.mcpToolName === 'string' && state.mcpToolName) || agentMcpToolName(loaded.item.displayName || id);
  return NextResponse.json({
    ok: true,
    server: 'csa-loom-data-agent',
    agent: loaded.item.displayName,
    protocol: 'mcp/json-rpc-2.0',
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'http',
    endpoint: `/api/items/data-agent/${id}/mcp`,
    methods: ['initialize', 'ping', 'tools/list', 'tools/call'],
    tools: [toolName],
    published: true,
  });
}
