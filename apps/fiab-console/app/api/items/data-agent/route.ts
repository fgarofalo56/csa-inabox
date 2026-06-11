/**
 * Collection CRUD for the 'data-agent' item type — the surface the
 * /data-agent page's lifecycle management drives.
 *
 *   GET  /api/items/data-agent          → list every data-agent the caller's
 *                                          tenant owns (id, displayName,
 *                                          description, state, timestamps).
 *                                          The pane derives status / sources
 *                                          count / last-updated client-side.
 *   POST /api/items/data-agent          → create a NEW data agent under a
 *                                          tenant-owned workspace.
 *        body { workspaceId, displayName, description?, state? }
 *        OR   { from: <existing data-agent id>, workspaceId?, displayName? }
 *             → DUPLICATE: clone the source agent's typed config (sources +
 *               instructions + grounding) MINUS its published/publish-only
 *               artifacts (publishedAt / foundryAgentId / m365Copilot / …) so
 *               the copy starts as an unpublished draft.
 *
 * Backed by the shared tenant-scoped item-crud helpers. The per-item
 * GET/PATCH/DELETE + action sub-routes (chat / publish / m365-copilot / …)
 * live under [id]/. Azure-native by default (no Fabric dependency): a
 * data-agent is a Cosmos item; publishing to Foundry / M365 is strictly
 * opt-in and gated in the publish routes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, jerr, listOwnedItems, loadOwnedItem } from '../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-agent';

/** Publish-only / runtime leaves that must NOT carry over to a duplicate. */
const PUBLISH_ONLY_KEYS = [
  'publishedAt',
  'publishedDescription',
  'publishedSnapshot',
  'foundryAgentId',
  'foundryProjectId',
  'lastDeployedAt',
  'm365Copilot',
  'status',
] as const;

function sanitizeForDuplicate(state: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...state };
  for (const k of PUBLISH_ONLY_KEYS) delete next[k];
  return next;
}

export async function GET() {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  try {
    const items = await listOwnedItems(ITEM_TYPE, session.claims.oid);
    // Project the leaves the pane renders directly; keep `state` for the
    // sources-count + status derivation (no extra round-trip per row).
    const rows = items.map((it) => ({
      id: it.id,
      workspaceId: it.workspaceId,
      displayName: it.displayName,
      description: it.description,
      state: it.state || {},
      createdAt: it.createdAt || null,
      updatedAt: it.updatedAt || null,
    }));
    return NextResponse.json({ ok: true, items: rows });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const body = await req.json().catch(() => ({} as any));

  try {
    // --- Duplicate path: clone an existing owned data agent ---------------
    if (body?.from) {
      const source = await loadOwnedItem(String(body.from), ITEM_TYPE, session.claims.oid);
      if (!source) return jerr('source data-agent not found', 404);
      const clonedState = sanitizeForDuplicate((source.state || {}) as Record<string, unknown>);
      const displayName = String(body?.displayName || `${source.displayName} (copy)`).slice(0, 200);
      const r = await createOwnedItem(session, ITEM_TYPE, {
        workspaceId: String(body?.workspaceId || source.workspaceId),
        displayName,
        description: source.description,
        state: clonedState,
        folderId: source.folderId ?? null,
      });
      if (!r.ok) return jerr(r.error, r.status);
      return NextResponse.json({ ok: true, item: r.item, duplicatedFrom: source.id }, { status: 201 });
    }

    // --- Create path -------------------------------------------------------
    const r = await createOwnedItem(session, ITEM_TYPE, {
      workspaceId: body?.workspaceId,
      displayName: body?.displayName,
      description: body?.description,
      // A fresh agent starts with an empty typed-source list + empty
      // instructions; the editor's Build tab fills these in.
      state: body?.state && typeof body.state === 'object' ? body.state : { sources: [], instructions: '' },
    });
    if (!r.ok) return jerr(r.error, r.status);
    return NextResponse.json({ ok: true, item: r.item }, { status: 201 });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
