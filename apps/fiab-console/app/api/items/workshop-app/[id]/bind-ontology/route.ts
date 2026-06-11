/**
 * GET  /api/items/workshop-app/[id]/bind-ontology
 *   → { ok, boundOntologyId, ontologies: OntologySummary[], surface?: OntologySurface }
 *     Lists the caller's saved ontologies and, when one is bound, its object /
 *     link surface (parsed entity types) so the editor can render object views.
 *
 * POST /api/items/workshop-app/[id]/bind-ontology  body: { ontologyId }
 *   → { ok, updatedAt, surface }
 *     Persists the binding on the workshop-app item's state and records a Thread
 *     edge workshop-app → ontology so lineage stays accurate.
 *
 * Azure-native (Cosmos only) — no Fabric workspace required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { listOntologies, loadOntologySurface } from '../../../_lib/palantir-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'workshop-app';

function err(error: string, status: number, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  const ontologies = await listOntologies(s.claims.oid);
  if (!id || id === 'new') return NextResponse.json({ ok: true, boundOntologyId: null, ontologies, surface: null });
  const app = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!app) return err('workshop-app not found', 404, 'not_found');
  const boundOntologyId = (app.state as Record<string, unknown> | undefined)?.boundOntologyId as string | undefined;
  let surface = null;
  if (boundOntologyId) surface = await loadOntologySurface(boundOntologyId, s.claims.oid);
  return NextResponse.json({ ok: true, boundOntologyId: boundOntologyId || null, ontologies, surface });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the app before binding (no id yet)', 400, 'no_id');
  const body = await req.json().catch(() => ({} as any));
  const ontologyId = String(body?.ontologyId || '').trim();
  if (!ontologyId) return err('ontologyId is required', 400, 'missing_ontology');

  const app = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!app) return err('workshop-app not found', 404, 'not_found');
  const surface = await loadOntologySurface(ontologyId, s.claims.oid);
  if (!surface) return err('ontology not found', 404, 'ontology_not_found');

  const state = { ...((app.state || {}) as Record<string, unknown>) };
  state.boundOntologyId = ontologyId;
  state.boundOntologyName = surface.displayName;
  const updated = await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
  if (!updated) return err('workshop-app not found', 404, 'not_found');

  await recordThreadEdge(s, {
    fromItemId: id, fromType: ITEM_TYPE, fromName: app.displayName,
    toItemId: ontologyId, toType: 'ontology', toName: surface.displayName,
    action: 'workshop-bind-ontology',
  });
  return NextResponse.json({ ok: true, updatedAt: updated.updatedAt, surface });
}
