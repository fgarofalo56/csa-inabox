/**
 * POST /api/items/data-agent/[id]/deploy
 *
 * Phase 1 — deploy stub with 501-gate.
 *
 * Loads the data-agent Cosmos item (state.systemPrompt + state.model +
 * state.sources / sqlEndpoints / kqlDatabases / lakehousePaths +
 * state.examples), builds an Azure AI Foundry Agent Service payload, and
 * calls createOrUpdateAgent.
 *
 *  - Missing LOOM_FOUNDRY_PROJECT_ENDPOINT / LOOM_FOUNDRY_PROJECT_ID →
 *    501 { ok: false, deferred: true, error, hint } so the editor can
 *    surface an honest MessageBar (see .claude/rules/no-vaporware.md).
 *
 *  - On success → persists state.foundryAgentId + state.lastDeployedAt back
 *    to the Cosmos item.
 *
 * Phase 2+ replaces the invented Model / Synapse-Serverless fields with the
 * typed five-source picker from the parity spec and wires the test-chat pane
 * via Assistants `threads.messages.create` + `runs.create`.
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
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

function foundryAgentName(itemId: string): string {
  const base = `loom-data-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(0, 63);
  return trimmed.replace(/^-+|-+$/g, '') || `loom-data-${itemId.slice(0, 8)}`;
}

/**
 * Synthesize a "tools" array from the legacy free-text source bindings.
 * Phase 2 replaces this with the typed five-source picker that emits
 * structured Lakehouse / Warehouse / KQL / PBI / Ontology / Graph entries.
 */
function legacyToolsFromState(state: Record<string, unknown>): Array<Record<string, unknown>> {
  const tools: Array<Record<string, unknown>> = [];
  const sql = String(state.sqlEndpoints || '').trim();
  if (sql) tools.push({ type: 'warehouse', binding: sql });
  const kql = String(state.kqlDatabases || '').trim();
  if (kql) tools.push({ type: 'kql-database', binding: kql });
  const lake = String(state.lakehousePaths || '').trim();
  if (lake) tools.push({ type: 'lakehouse', binding: lake });
  return tools;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return apiServerError(e, 'cosmos error');
  }
  if (!item) {
    return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });
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
  if (typeof state.sources === 'string' && state.sources) {
    metadata.loomSources = state.sources.slice(0, 512);
  }

  const body: FoundryAgentBody = {
    name: agentName,
    model,
    instructions: systemPrompt,
    tools: legacyToolsFromState(state),
    description: `Loom data-agent: ${item.displayName}`.slice(0, 512),
    metadata,
    kind: 'prompt',
  };

  try {
    const projectId = getProjectId();
    const agent = await createOrUpdateAgent(projectId, agentName, body);

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
