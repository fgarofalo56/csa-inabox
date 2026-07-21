/**
 * POST   /api/items/agent-flow/[id]/publish-mcp   → publish the flow as an MCP server
 * DELETE /api/items/agent-flow/[id]/publish-mcp   → unpublish
 *
 * WS-5.1. Publishing flips `state.mcpPublished = true` (+ tool name + timestamp)
 * in Cosmos and returns the MCP endpoint URL + the `ask_<flow>` tool name + a
 * ready-to-paste MCP client config. The flow then answers questions over MCP at
 * `/api/items/agent-flow/[id]/mcp` (real runAgentFlowTurn — grounded data +
 * ontology-object + real MCP tools + sub-agent handoffs + guardrails), gated on
 * this flag. The same endpoint IS the flow's callable API (JSON-RPC over HTTPS).
 *
 * Owner-scoped (loadOwnedItem). A flow with no orchestrator instructions AND no
 * tools/sub-agents cannot be published (nothing to run) — an honest precondition.
 * Azure-native, sovereign — no Microsoft Fabric (no-fabric-dependency.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { agentMcpToolName } from '@/lib/copilot/data-agent-mcp';
import { flowTools } from '@/lib/azure/agent-flow-run';
import { normalizeSubAgents } from '@/lib/copilot/connected-agents';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'agent-flow';

function endpointFor(req: NextRequest, id: string): string {
  let origin = '';
  try { origin = new URL(req.url).origin; } catch { origin = process.env.LOOM_PUBLIC_BASE_URL || ''; }
  return `${origin.replace(/\/+$/, '')}/api/items/agent-flow/${encodeURIComponent(id)}/mcp`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return apiServerError(e, 'cosmos error');
  }
  if (!item) return NextResponse.json({ ok: false, error: 'agent-flow item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const instructions = String(state.instructions || state.systemPrompt || '').trim();
  const tools = flowTools(state as any);
  const subAgents = normalizeSubAgents(state.subAgents);
  if (!instructions && tools.length === 0 && subAgents.length === 0) {
    return NextResponse.json({ ok: false, error: 'Add orchestrator instructions and at least one tool or connected agent before publishing this flow as MCP.' }, { status: 400 });
  }

  const toolName = agentMcpToolName(item.displayName || id);
  const now = new Date().toISOString();
  const nextState: Record<string, unknown> = {
    ...state,
    mcpPublished: true,
    mcpPublishedAt: now,
    mcpToolName: toolName,
  };
  try {
    const items = await itemsContainer();
    await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({ ...item, state: nextState, updatedAt: now });
  } catch (e: any) {
    return apiServerError(e, 'could not publish flow as MCP');
  }

  const endpoint = endpointFor(req, id);
  return NextResponse.json({
    ok: true,
    published: true,
    toolName,
    endpoint,
    publishedAt: now,
    // A ready-to-paste MCP client config (streamable-http transport + a Loom API token).
    mcpClientConfig: {
      mcpServers: {
        [toolName]: {
          type: 'http',
          url: endpoint,
          headers: { Authorization: 'Bearer loom_pat_<your-token>' },
        },
      },
    },
  });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return apiServerError(e, 'cosmos error');
  }
  if (!item) return NextResponse.json({ ok: false, error: 'agent-flow item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  try {
    const items = await itemsContainer();
    await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item,
      state: { ...state, mcpPublished: false, mcpUnpublishedAt: now },
      updatedAt: now,
    });
  } catch (e: any) {
    return apiServerError(e, 'could not unpublish flow');
  }
  return NextResponse.json({ ok: true, published: false });
}
