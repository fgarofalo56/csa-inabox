/**
 * POST   /api/items/data-agent/[id]/publish-mcp   → publish the agent as an MCP server
 * DELETE /api/items/data-agent/[id]/publish-mcp   → unpublish
 *
 * DBX-9. Publishing flips `state.mcpPublished = true` (+ snapshot + tool name) in
 * Cosmos and returns the MCP endpoint URL + the `ask_<agent>` tool name + a
 * ready-to-paste MCP client config. The agent then answers questions over MCP at
 * `/api/items/data-agent/[id]/mcp` (real chatGrounded), gated on this flag.
 *
 * Owner-scoped (loadOwnedItem). An agent with no instructions/sources cannot be
 * published — same precondition as the Foundry publish.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { agentMcpToolName } from '@/lib/copilot/data-agent-mcp';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

function endpointFor(req: NextRequest, id: string): string {
  let origin = '';
  try { origin = new URL(req.url).origin; } catch { origin = process.env.LOOM_PUBLIC_BASE_URL || ''; }
  return `${origin.replace(/\/+$/, '')}/api/items/data-agent/${encodeURIComponent(id)}/mcp`;
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
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const instructions = String(state.instructions || state.systemPrompt || '').trim();
  if (!instructions) {
    return NextResponse.json({ ok: false, error: 'Agent instructions are empty — add instructions before publishing as MCP.' }, { status: 400 });
  }
  const sources = Array.isArray(state.sources) ? state.sources : [];
  if (sources.length === 0) {
    return NextResponse.json({ ok: false, error: 'Attach at least one data source before publishing as MCP.' }, { status: 400 });
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
    return apiServerError(e, 'could not publish agent as MCP');
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
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

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
    return apiServerError(e, 'could not unpublish agent');
  }
  return NextResponse.json({ ok: true, published: false });
}
