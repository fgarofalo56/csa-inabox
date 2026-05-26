/**
 * POST /api/items/operations-agent/[id]/deploy
 *
 * Phase 1 — deploy stub with 501-gate.
 *
 * Loads the operations-agent Cosmos item (state.systemPrompt + state.model +
 * state.tools + state.eventhouse + state.ontology), builds an Azure AI
 * Foundry Agent Service payload, and calls createOrUpdateAgent.
 *
 *  - Missing LOOM_FOUNDRY_PROJECT_ENDPOINT / LOOM_FOUNDRY_PROJECT_ID →
 *    501 { ok: false, deferred: true, error, hint } so the editor can
 *    surface an honest MessageBar instead of pretending to deploy
 *    (see .claude/rules/no-vaporware.md).
 *
 *  - On success → persists state.foundryAgentId + state.lastDeployedAt back
 *    to the Cosmos item and returns the agent shape.
 *
 * No catalog edits, no bicep edits — Phase 2+ wires runtime invocation,
 * playbook generation, and Activator handshake.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import {
  createOrUpdateAgent,
  FoundryAgentNotConfiguredError,
  FoundryAgentError,
  getProjectId,
  type FoundryAgentBody,
} from '@/lib/azure/foundry-agent-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'operations-agent';

/** Build a Foundry-Agent-Service-compatible name from a Loom item id. */
function foundryAgentName(itemId: string): string {
  // Names: alphanumeric + hyphens, max 63 chars, must start/end alphanumeric.
  const base = `loom-ops-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(0, 63);
  return trimmed.replace(/^-+|-+$/g, '') || `loom-ops-${itemId.slice(0, 8)}`;
}

function parseToolsCsv(raw: unknown): Array<Record<string, unknown>> {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((tool) => ({ type: tool }));
}

export async function POST(_req: NextRequest, ctx: { params: { id: string } }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(ctx.params.id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) {
    return NextResponse.json({ ok: false, error: 'operations-agent item not found' }, { status: 404 });
  }

  const state = (item.state || {}) as Record<string, unknown>;
  const systemPrompt = String(state.systemPrompt || '').trim();
  const model = String(state.model || '').trim();
  if (!systemPrompt) {
    return NextResponse.json({
      ok: false,
      error: 'systemPrompt is empty — write agent instructions before deploying',
    }, { status: 400 });
  }
  if (!model) {
    return NextResponse.json({
      ok: false,
      error: 'model is empty — set a model deployment name (e.g. gpt-4o) before deploying',
    }, { status: 400 });
  }

  const agentName = foundryAgentName(item.id);
  const metadata: Record<string, string> = {
    loomItemId: item.id,
    loomItemType: ITEM_TYPE,
    loomWorkspaceId: item.workspaceId,
  };
  if (typeof state.eventhouse === 'string' && state.eventhouse) {
    metadata.loomEventhouseId = state.eventhouse.slice(0, 512);
  }
  if (typeof state.ontology === 'string' && state.ontology) {
    metadata.loomOntologyId = state.ontology.slice(0, 512);
  }

  const body: FoundryAgentBody = {
    name: agentName,
    model,
    instructions: systemPrompt,
    tools: parseToolsCsv(state.tools),
    description: `Loom operations-agent: ${item.displayName}`.slice(0, 512),
    metadata,
    kind: 'prompt',
  };

  try {
    const projectId = getProjectId();
    const agent = await createOrUpdateAgent(projectId, agentName, body);

    // Persist deployment receipt back to Cosmos.
    const now = new Date().toISOString();
    const nextState: Record<string, unknown> = {
      ...state,
      foundryAgentId: agentName,
      foundryProjectId: projectId,
      lastDeployedAt: now,
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item,
      state: nextState,
      updatedAt: now,
    });

    return NextResponse.json({
      ok: true,
      agentId: agentName,
      projectId,
      agent,
      lastDeployedAt: now,
      item: resource,
    });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        deferred: true,
        error: e.message,
        hint: e.hint,
      }, { status: 501 });
    }
    if (e instanceof FoundryAgentError) {
      return NextResponse.json({
        ok: false,
        error: e.message,
        status: e.status,
        body: e.body,
      }, { status: 502 });
    }
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
    }, { status: 500 });
  }
}
