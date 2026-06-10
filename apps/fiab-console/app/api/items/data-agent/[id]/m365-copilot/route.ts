/**
 * Data agent → publish to Microsoft 365 Copilot.
 *
 *   GET  /api/items/data-agent/[id]/m365-copilot
 *        → { ok, configured, gate?, environments?, defaultEnvId?, published? }
 *          Lists the Power Platform environments the maker can target and the
 *          current M365-publish linkage stored on the item. When the Dataverse
 *          application-user credentials are not configured, returns an honest
 *          gate (no mock environments) so the editor renders a MessageBar.
 *
 *   POST /api/items/data-agent/[id]/m365-copilot
 *        body: { envId, displayName?, description?, instructions?, starterPrompts? }
 *        → ensures a Copilot Studio agent exists for this data agent (grounded
 *          on the agent's instructions), attaches the Microsoft 365 Copilot +
 *          Teams channel, publishes it, and persists the linkage to Cosmos.
 *
 * Real Dataverse / Copilot Studio REST end-to-end via copilot-studio-client.
 * Honest infra-gate when Dataverse creds are missing (per no-vaporware.md).
 * No hard dependency on Microsoft Fabric — Copilot Studio agents live in
 * Dataverse, an Azure-native Power Platform store (per no-fabric-dependency.md).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  copilotStudioConfigGate,
  defaultCopilotStudioEnvId,
  listEnvironments,
  publishDataAgentToM365,
  getM365PublishStatus,
  CopilotStudioError,
} from '@/lib/azure/copilot-studio-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

interface M365Linkage {
  envId: string;
  agentId: string;
  channelId?: string;
  displayName: string;
  publishedAt: string;
  adminReviewRequired: boolean;
}

function gateResponse(gate: { message?: string; missing?: string }) {
  return NextResponse.json(
    {
      ok: false,
      configured: false,
      gate: {
        error: gate.message || 'Copilot Studio (Dataverse) not configured.',
        missing: gate.missing,
        bicep: 'platform/fiab/bicep/modules/admin-plane/main.bicep',
        doc: 'docs/fiab/dataverse-app-user.md',
      },
    },
    { status: 200 },
  );
}

function handleErr(e: any) {
  const status = e instanceof CopilotStudioError ? e.status : 502;
  return NextResponse.json(
    { ok: false, error: e?.message || String(e), body: e?.body, status },
    { status: status >= 400 && status < 600 ? status : 502 },
  );
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const published = (state.m365Copilot as M365Linkage | undefined) || null;

  const gate = copilotStudioConfigGate();
  if (!gate.configured) {
    return NextResponse.json({ ok: true, configured: false, gate: { error: gate.message, missing: gate.missing }, published });
  }

  // List environments the maker can target. A Dataverse/BAP failure here is an
  // honest backend error, not a gate — surface it precisely.
  try {
    const environments = await listEnvironments();
    const dataverseEnvs = environments.filter((e) => e.hasDataverse);

    // If we have a linkage, refresh its live publish state (best-effort).
    let liveStatus: Awaited<ReturnType<typeof getM365PublishStatus>> = null;
    if (published?.envId && published?.agentId) {
      try { liveStatus = await getM365PublishStatus(published.envId, { agentId: published.agentId }); } catch { /* non-fatal */ }
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      environments: dataverseEnvs.map((e) => ({ id: e.id, displayName: e.displayName, dataverseHost: e.dataverseHost })),
      defaultEnvId: defaultCopilotStudioEnvId() || dataverseEnvs[0]?.id,
      published,
      liveStatus,
    });
  } catch (e: any) {
    return handleErr(e);
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({} as any));

  const gate = copilotStudioConfigGate();
  if (!gate.configured) return gateResponse(gate);

  const envId = String(body?.envId || defaultCopilotStudioEnvId() || '').trim();
  if (!envId) {
    return NextResponse.json({ ok: false, error: 'envId is required (select a Power Platform environment).' }, { status: 400 });
  }

  let item: WorkspaceItem | null;
  try {
    item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'cosmos error' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'data-agent item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const instructions = String(body?.instructions || state.instructions || state.systemPrompt || '').trim();
  if (!instructions) {
    return NextResponse.json({ ok: false, error: 'Agent instructions are empty — add instructions before publishing.' }, { status: 400 });
  }
  const displayName = String(body?.displayName || state.alias || item.displayName || `Loom data agent ${item.id.slice(0, 8)}`).slice(0, 100);
  const description = String(body?.description || state.description || `Loom data agent: ${item.displayName}`).slice(0, 1000);
  const starterPrompts: string[] = Array.isArray(body?.starterPrompts)
    ? body.starterPrompts.map(String).filter(Boolean).slice(0, 6)
    : [];

  // Reuse the previously linked Copilot Studio agent when republishing into the
  // same environment, so we update in place instead of creating duplicates.
  const existing = (state.m365Copilot as M365Linkage | undefined) || null;
  const existingAgentId = existing && existing.envId === envId ? existing.agentId : undefined;

  try {
    const result = await publishDataAgentToM365({
      envId,
      displayName,
      description,
      instructions,
      starterPrompts,
      existingAgentId,
    });

    const linkage: M365Linkage = {
      envId: result.envId,
      agentId: result.agentId,
      channelId: result.channelId,
      displayName,
      publishedAt: result.publishedAt,
      adminReviewRequired: result.adminReviewRequired,
    };
    const nextState: Record<string, unknown> = { ...state, m365Copilot: linkage };
    const now = new Date().toISOString();
    const items = await itemsContainer();
    const { resource } = await items.item(item.id, item.workspaceId).replace<WorkspaceItem>({
      ...item, state: nextState, updatedAt: now,
    });

    return NextResponse.json({
      ...result,
      ok: true,
      displayName,
      linkage,
      item: resource,
      message: result.adminReviewRequired
        ? 'Published to Microsoft 365 Copilot. A tenant admin must approve it in Microsoft 365 admin centre (Agents → Requests) before users can discover and chat it.'
        : 'Published to Microsoft 365 Copilot.',
    });
  } catch (e: any) {
    return handleErr(e);
  }
}
