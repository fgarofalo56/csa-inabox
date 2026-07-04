/**
 * POST /api/items/aip-logic/[id]/deploy
 *
 * Publishes a Spindle (AIP-Logic) function as a real Azure AI Foundry Agent
 * Service agent so it can be invoked as a first-class agent (Palantir-AIP
 * "publish logic" equivalent). Composes the typed-input schema + ordered steps
 * + typed output into the agent instructions, and attaches the bound Weave
 * ontology's Lakehouse/Warehouse data bindings as agent tools.
 *
 *  - Missing LOOM_FOUNDRY_PROJECT_ENDPOINT / LOOM_FOUNDRY_PROJECT_ID →
 *    501 { ok:false, deferred:true, error, hint } so the editor surfaces an
 *    honest MessageBar (Foundry Agent Service is unsupported in Azure Gov;
 *    Spindle still runs via the Azure-native AOAI path — see invoke route).
 *  - On success → persists state.foundryAgentId + state.lastDeployedAt and
 *    returns the agent shape.
 *
 * Azure-native: reuses LOOM_FOUNDRY_* — no new env vars, no bicep change.
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
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { sourcesToFoundryTools } from '@/lib/azure/data-agent-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { resolveSpindleGrounding } from '../_spindle-grounding';
import { composeGraphPrompt } from '../_block-graph';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'aip-logic';

/** Build a Foundry-Agent-Service-compatible name from a Loom item id. */
function foundryAgentName(itemId: string): string {
  const base = `loom-spindle-${itemId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const trimmed = base.replace(/^-+|-+$/g, '').slice(0, 63);
  return trimmed.replace(/^-+|-+$/g, '') || `loom-spindle-${itemId.slice(0, 8)}`;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return apiServerError(e, 'cosmos error');
  }
  if (!item) return NextResponse.json({ ok: false, error: 'aip-logic function not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  const steps = Array.isArray(state.steps) ? state.steps : [];
  if (blocks.length === 0 && steps.length === 0) {
    return NextResponse.json({ ok: false, error: 'add at least one block before deploying' }, { status: 400 });
  }

  // Resolve the live AOAI deployment as the agent model (Azure-native default).
  let model: string;
  try {
    const target = await resolveAoaiTarget();
    model = target.deployment;
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json({
        ok: false,
        notDeployed: true,
        error: e.message,
        gate: {
          reason: 'Spindle agents publish against the live Azure OpenAI deployment.',
          remediation: 'Deploy a model on the AI Foundry hub (or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT). No Fabric required.',
        },
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }

  // Attach the bound ontology's data sources as agent tools.
  const boundOntologyId = (state.boundOntologyId as string | undefined) || undefined;
  const grounding = await resolveSpindleGrounding(boundOntologyId, session.claims.oid).catch(() => ({ sources: [], surface: null, entityTypes: [] }));
  const tools = sourcesToFoundryTools(grounding.sources);

  const agentName = foundryAgentName(item.id);
  const metadata: Record<string, string> = {
    loomItemId: item.id,
    loomItemType: ITEM_TYPE,
    loomWorkspaceId: item.workspaceId,
  };
  if (boundOntologyId) metadata.loomOntologyId = boundOntologyId.slice(0, 512);

  const agentBody: FoundryAgentBody = {
    name: agentName,
    model,
    instructions: composeGraphPrompt(state),
    tools,
    description: `Loom Spindle logic: ${item.displayName}`.slice(0, 512),
    metadata,
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
      foundryModel: model,
      lastDeployedAt: now,
    };
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item,
      state: nextState,
      updatedAt: now,
    });

    return NextResponse.json({ ok: true, agentId: agentName, projectId, agent, model, lastDeployedAt: now, item: resource });
  } catch (e: any) {
    if (e instanceof FoundryAgentNotConfiguredError) {
      return NextResponse.json({
        ok: false,
        deferred: true,
        error: e.message,
        hint: e.hint,
        gate: {
          reason: 'Foundry Agent Service is not configured (and is unsupported in Azure Government).',
          remediation: 'Set LOOM_FOUNDRY_PROJECT_ENDPOINT + LOOM_FOUNDRY_PROJECT_ID, or use the Azure-native Invoke path — Spindle runs against Azure OpenAI without the Agent Service.',
        },
      }, { status: 501 });
    }
    if (e instanceof FoundryAgentError) {
      return NextResponse.json({ ok: false, error: e.message, status: e.status, body: e.body }, { status: 502 });
    }
    return apiServerError(e);
  }
}
