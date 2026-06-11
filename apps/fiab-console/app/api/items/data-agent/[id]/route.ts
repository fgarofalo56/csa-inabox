/**
 * Generic CRUD for the 'data-agent' item — the persistence handler the editor's
 * useItemState('data-agent', id) drives (GET → { state, updatedAt }; PATCH { state }).
 * Without it the editor PATCHed a 404 and lost edits while showing "Saved".
 * Backed by the shared tenant-scoped item-crud helpers. Action sub-routes
 * (chat / deploy / publish) are unaffected.
 *
 * DELETE additionally de-provisions any opt-in published backing — the Azure
 * AI Foundry Agent Service assistant (state.foundryAgentId) and the M365 /
 * Copilot Studio agent (state.m365Copilot) — so "delete" removes the agent from
 * the store AND its provisioned backing, not just the Cosmos record. Both
 * de-provision calls are best-effort: a missing endpoint or an already-deleted
 * remote agent never blocks the local delete (Azure-native default — neither is
 * required to exist).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem, deleteOwnedItem } from '../../_lib/item-crud';
import { deleteAgent as deleteFoundryAgent } from '@/lib/azure/foundry-agent-client';
import { deleteAgent as deleteCopilotStudioAgent } from '@/lib/azure/copilot-studio-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ id, displayName: '', state: {}, updatedAt: null });
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!item) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({
      id: item.id, displayName: item.displayName, description: item.description,
      state: item.state || {}, updatedAt: item.updatedAt || null,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ error: 'save the item before patching (no id yet)' }, { status: 400 });
  const body = await req.json().catch(() => ({} as any));
  try {
    const updated = await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, {
      displayName: body?.displayName,
      ...('description' in (body || {}) ? { description: body.description } : {}),
      ...(body?.state && typeof body.state === 'object' ? { state: body.state } : {}),
    });
    if (!updated) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, id: updated.id, updatedAt: updated.updatedAt });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  try {
    // Load first so we can de-provision the opt-in published backing.
    const item = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
    if (!item) {
      // Already gone (or never owned) — treat as success so the UI converges.
      return NextResponse.json({ ok: true, deprovisioned: {} });
    }
    const state = (item.state || {}) as Record<string, any>;
    const deprovisioned: { foundry?: string; m365?: string } = {};

    // 1) De-provision the published Azure AI Foundry assistant, if any.
    const foundryAgentId = state.foundryAgentId ? String(state.foundryAgentId) : '';
    if (foundryAgentId) {
      try {
        await deleteFoundryAgent('', foundryAgentId);
        deprovisioned.foundry = 'deleted';
      } catch (e: any) {
        // Honest best-effort: a missing endpoint (not_configured) or an
        // already-deleted remote agent must not block the local delete.
        deprovisioned.foundry = `skipped: ${e?.message || String(e)}`;
      }
    }

    // 2) De-provision the M365 / Copilot Studio agent, if published there.
    const m365 = state.m365Copilot;
    if (m365 && m365.envId && m365.agentId) {
      try {
        await deleteCopilotStudioAgent(String(m365.envId), String(m365.agentId));
        deprovisioned.m365 = 'deleted';
      } catch (e: any) {
        deprovisioned.m365 = `skipped: ${e?.message || String(e)}`;
      }
    }

    // 3) Remove the item from the store (also clears AI Search / catalog mirrors).
    await deleteOwnedItem(id, ITEM_TYPE, s.claims.oid);
    return NextResponse.json({ ok: true, deprovisioned });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || String(e) }, { status: 500 });
  }
}
