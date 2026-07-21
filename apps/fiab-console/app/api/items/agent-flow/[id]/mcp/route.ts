/**
 * /api/items/agent-flow/[id]/mcp — the MCP server for a published Loom agent flow (WS-5.1).
 *
 *   POST → JSON-RPC 2.0 (initialize / ping / tools/list / tools/call / batch).
 *          The single tool `ask_<flow>` RUNS the whole flow: grounded data +
 *          ontology-object nodes, real MCP-server tool calls, sub-agent handoffs,
 *          and the inline guardrails — via the shared runAgentFlowTurn executor.
 *   GET  → an unauthenticated-safe discovery doc (owner-scoped fields only).
 *
 * Auth: getApiSession — a Console cookie session OR a scoped API token
 * (`Authorization: Bearer loom_pat_…`), so an external MCP client authenticates
 * with the publisher's token. Owner-scoped (loadOwnedItem); only serves once the
 * flow has been published as MCP (state.mcpPublished). Real backend, Azure-native
 * (Azure OpenAI + the flow's bound Loom items) — no Microsoft Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getApiSession } from '@/lib/auth/api-session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { NoAoaiDeploymentError } from '@/lib/azure/data-agent-client';
import { runAgentFlowTurn } from '@/lib/azure/agent-flow-execute';
import type { AgentFlowState } from '@/lib/azure/agent-flow-run';
import {
  handleAgentMcpMethod, agentMcpToolName, MCP_PROTOCOL_VERSION, RPC,
  type AgentMcpContext, type ChatTurnLike,
} from '@/lib/copilot/data-agent-mcp';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';

function rpcError(id: unknown, code: number, message: string, status = 200) {
  return NextResponse.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status });
}

async function loadPublishedFlow(req: NextRequest, id: string): Promise<
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
    return { ok: false, status: 502, code: RPC.INTERNAL, message: 'cosmos error loading flow' };
  }
  if (!item) return { ok: false, status: 404, code: RPC.METHOD_NOT_FOUND, message: 'agent-flow not found' };
  const published = (item.state as Record<string, unknown> | undefined)?.mcpPublished === true;
  if (!published) {
    return { ok: false, status: 403, code: RPC.UNAUTHORIZED, message: 'This agent flow is not published as MCP. Publish it first (Publish as MCP).' };
  }
  return { ok: true, item, oid: session.claims.oid };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: any;
  try { body = await req.json(); } catch { return rpcError(null, RPC.PARSE, 'Invalid JSON'); }

  const loaded = await loadPublishedFlow(req, id);
  if (!loaded.ok) return rpcError(Array.isArray(body) ? null : body?.id, loaded.code, loaded.message, loaded.status);

  const { item, oid } = loaded;
  const flowName = item.displayName || 'Agent flow';
  const state = (item.state || {}) as AgentFlowState & Record<string, unknown>;
  const toolName = (typeof state.mcpToolName === 'string' && state.mcpToolName) || agentMcpToolName(flowName);

  // The real backend the ask_<flow> tool calls: run one full flow turn.
  const ask = async (question: string, history: ChatTurnLike[]): Promise<string> => {
    try {
      const turn = await runAgentFlowTurn(state, oid, question, history as any);
      return turn.answer || '(the flow returned no answer)';
    } catch (e: any) {
      if (e instanceof NoAoaiDeploymentError) {
        throw new Error(`${e.message} — deploy a model from the AI Foundry hub "Quota + usage" tab, or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT.`);
      }
      throw e;
    }
  };

  const mcpCtx: AgentMcpContext = { toolName, agentName: flowName, description: item.description, ask };

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
  const loaded = await loadPublishedFlow(req, id);
  if (!loaded.ok) return NextResponse.json({ ok: false, error: loaded.message }, { status: loaded.status });
  const state = (loaded.item.state || {}) as Record<string, unknown>;
  const toolName = (typeof state.mcpToolName === 'string' && state.mcpToolName) || agentMcpToolName(loaded.item.displayName || id);
  return NextResponse.json({
    ok: true,
    server: 'csa-loom-agent-flow',
    flow: loaded.item.displayName,
    protocol: 'mcp/json-rpc-2.0',
    protocolVersion: MCP_PROTOCOL_VERSION,
    transport: 'http',
    endpoint: `/api/items/agent-flow/${id}/mcp`,
    methods: ['initialize', 'ping', 'tools/list', 'tools/call'],
    tools: [toolName],
    published: true,
  });
}
