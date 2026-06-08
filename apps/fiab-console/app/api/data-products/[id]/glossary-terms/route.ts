/**
 * /api/data-products/[id]/glossary-terms
 *
 * F10 "Linked resources" — Glossary terms section. Attaches REAL Purview
 * classic-Data-Map glossary terms to a Loom data-product item and persists the
 * link in the item's `state.glossaryLinks[]` (Cosmos). The Purview side-effect
 * (assigning the term to the registered Unified-Catalog data product entity) is
 * best-effort: even when Purview is unprovisioned the link still saves so the
 * UI round-trips. Azure-native default — no Fabric/Power BI dependency.
 *
 *   GET    → { ok, links }                          — linked terms for this item
 *   POST   { termGuid, name, glossaryGuid? }        — link a term; { ok, link, links, applied }
 *   DELETE ?termGuid=<g>  (or ?name=<n>)            — unlink a term; { ok, links }
 *
 * Status semantics:
 *   200/201 — Cosmos updated (link saved/removed). `applied` flags whether the
 *             Purview assignedEntities call also succeeded.
 *   401     — unauthenticated.
 *   404     — data-product item not found / not owned by caller's tenant.
 *   422     — missing termGuid/name in the body.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  applyGlossaryTerm,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { loadOwnedItem, updateOwnedItem } from '../../../items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

interface GlossaryLink { name: string; guid?: string; glossaryGuid?: string; }

function err(error: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: false, error, ...extra }, { status });
}

function readLinks(state: Record<string, unknown>): GlossaryLink[] {
  const raw = state.glossaryLinks;
  return Array.isArray(raw) ? (raw as GlossaryLink[]) : [];
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);
  return NextResponse.json({ ok: true, links: readLinks((item.state || {}) as Record<string, unknown>) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  let body: any;
  try { body = await req.json(); } catch { return err('invalid JSON', 400); }

  const termGuid: string | undefined = typeof body?.termGuid === 'string' ? body.termGuid.trim() : undefined;
  const name: string | undefined = typeof body?.name === 'string' ? body.name.trim() : undefined;
  const glossaryGuid: string | undefined = typeof body?.glossaryGuid === 'string' ? body.glossaryGuid.trim() : undefined;
  if (!name) return err('term name is required', 422, { field: 'name' });

  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);

  const state = (item.state || {}) as Record<string, unknown>;
  const links = readLinks(state);
  // Idempotent: don't double-add the same term (by guid when present, else name).
  const already = links.some((l) => (termGuid && l.guid === termGuid) || (!termGuid && l.name === name));
  if (!already) links.push({ name, guid: termGuid, glossaryGuid });

  // Best-effort Purview assignment to the registered Unified-Catalog product
  // entity. The Cosmos link is the source of truth; Purview is a propagation.
  let applied = false;
  let applyNote: string | undefined;
  const purviewEntityGuid = (state.purviewDataProductId as string) || undefined;
  if (termGuid && purviewEntityGuid) {
    try {
      await applyGlossaryTerm(termGuid, purviewEntityGuid);
      applied = true;
    } catch (e: any) {
      if (e instanceof PurviewNotConfiguredError) {
        applyNote = 'Purview not provisioned (LOOM_PURVIEW_ACCOUNT unset) — term saved to the catalog item only.';
      } else if (e instanceof PurviewError) {
        applyNote = `Purview assignedEntities call failed (HTTP ${e.status}) — term saved to the catalog item only.`;
      } else {
        applyNote = `Purview assignment skipped: ${e?.message || String(e)}`;
      }
    }
  } else if (termGuid && !purviewEntityGuid) {
    applyNote = 'Data product not registered with Purview yet — term saved to the catalog item only.';
  }

  const updated = await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, {
    state: { ...state, glossaryLinks: links },
  });
  if (!updated) return err('failed to persist glossary link to Cosmos', 500);

  return NextResponse.json(
    { ok: true, link: { name, guid: termGuid, glossaryGuid }, links, applied, ...(applyNote ? { note: applyNote } : {}) },
    { status: already ? 200 : 201 },
  );
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  const termGuid = req.nextUrl.searchParams.get('termGuid') || undefined;
  const name = req.nextUrl.searchParams.get('name') || undefined;
  if (!termGuid && !name) return err('termGuid or name query param is required', 422);

  const item = await loadOwnedItem((await ctx.params).id, ITEM_TYPE, session.claims.oid);
  if (!item) return err('data-product item not found', 404);

  const state = (item.state || {}) as Record<string, unknown>;
  const links = readLinks(state).filter((l) =>
    termGuid ? l.guid !== termGuid : l.name !== name,
  );

  const updated = await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, {
    state: { ...state, glossaryLinks: links },
  });
  if (!updated) return err('failed to persist glossary unlink to Cosmos', 500);

  return NextResponse.json({ ok: true, links });
}
