/**
 * POST /api/items/data-agent/[id]/publish
 *
 * Publishes a Loom data agent to the Azure AI Foundry Agent Service:
 *   1. Composes a prompt-agent definition from the typed config (agent
 *      instructions + typed sources → tools) and upserts it via
 *      createOrUpdateAgent (real Foundry Agent Service call).
 *   2. Snapshots the published config + flips publishedAt in Cosmos.
 *   3. Returns the workspace_id (Foundry projectId) + artifact_id (agent name)
 *      pair that downstream Foundry / Copilot Studio connections paste in.
 *
 * Body (optional): { description?: string }
 *
 * Foundry Agent Service not configured → 501 + hint (honest infra gate).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  createOrUpdateAgent,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
  getProjectId,
  type FoundryAgentBody,
} from '@/lib/azure/foundry-agent-client';
import { sourcesToFoundryTools, type DataAgentSource } from '@/lib/azure/data-agent-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

function foundryAgentName(itemId: string): string {
  const base = `loom-data-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(0, 63);
  return trimmed.replace(/^-+|-+$/g, '') || `loom-data-${itemId.slice(0, 8)}`;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const instructions = String(state.instructions || state.systemPrompt || '').trim();
  if (!instructions) {
    return NextResponse.json({ ok: false, error: 'Agent instructions are empty — add instructions before publishing.' }, { status: 400 });
  }
  const sources: DataAgentSource[] = Array.isArray(state.sources) ? (state.sources as DataAgentSource[]) : [];
  if (sources.length === 0) {
    return NextResponse.json({ ok: false, error: 'Attach at least one data source before publishing.' }, { status: 400 });
  }
  const description = String(body?.description || state.description || `Loom data agent: ${item.displayName}`).slice(0, 512);

  const agentName = foundryAgentName(item.id);
  // The NL2SQL/NL2DAX orchestration model defaults to the resolved hub AOAI
  // deployment name; consumers can override on their side.
  const model = String(state.model || process.env.LOOM_AOAI_DEPLOYMENT || 'gpt-4o-mini');

  const agentBody: FoundryAgentBody = {
    name: agentName,
    model,
    instructions,
    tools: sourcesToFoundryTools(sources),
    description,
    metadata: {
      loomItemId: item.id,
      loomItemType: ITEM_TYPE,
      loomWorkspaceId: item.workspaceId,
      loomSourceCount: String(sources.length),
    },
    kind: 'prompt',
  };

  try {
    const projectId = getProjectId();
    const agent = await createOrUpdateAgent(projectId, agentName, agentBody);
    const now = new Date().toISOString();
    const nextState: Record<string, unknown> = {
      ...state,
      foundryAgentId: agentName,
      foundryProjectId: projectId,
      publishedAt: now,
      publishedDescription: description,
      // Snapshot the published config so the draft can drift independently.
      publishedSnapshot: { instructions, sources, description },
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item, state: nextState, updatedAt: now,
    });
    return NextResponse.json({
      ok: true,
      agentId: agentName,
      projectId,
      workspaceId: projectId,   // the GUID pair Foundry / Copilot Studio paste as secrets
      artifactId: agentName,
      publishedAt: now,
      agent,
      item: resource,
    });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json({ ok: false, deferred: true, error: e.message, hint: e.hint }, { status: 501 });
    }
    if (e instanceof FoundryAgentError) {
      return NextResponse.json({ ok: false, error: e.message, status: e.status, body: e.body }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
