/**
 * GET  /api/items/aip-logic/[id]/bind-ontology
 *   → { ok, boundOntologyId, ontologies: OntologySummary[], surface?: OntologySurface }
 *     Lists the caller's saved ontologies and, when one is bound, its object /
 *     link / data-binding surface so Spindle logic grounds on the Weave.
 *
 * POST /api/items/aip-logic/[id]/bind-ontology  body: { ontologyId | "" }
 *   → { ok, updatedAt, surface | null }
 *     Persists (or clears, when ontologyId is empty) the binding on the
 *     aip-logic item's state and records a Thread edge aip-logic → ontology so
 *     lineage stays accurate. Spindle's invoke route then grounds the function
 *     on the bound ontology's entity types + Lakehouse/Warehouse data bindings.
 *
 * Azure-native (Cosmos only) — no Fabric workspace required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { listOntologies, loadOntologySurface } from '../../../_lib/palantir-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'aip-logic';

function err(error: string, status: number, code?: string) {
  return apiError(error, status, code ? { code } : undefined);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  const ontologies = await listOntologies(s.claims.oid);
  if (!id || id === 'new') return NextResponse.json({ ok: true, boundOntologyId: null, ontologies, surface: null });
  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return err('aip-logic not found', 404, 'not_found');
  const boundOntologyId = (fn.state as Record<string, unknown> | undefined)?.boundOntologyId as string | undefined;
  let surface = null;
  if (boundOntologyId) surface = await loadOntologySurface(boundOntologyId, s.claims.oid);
  return NextResponse.json({ ok: true, boundOntologyId: boundOntologyId || null, ontologies, surface });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the function before binding (no id yet)', 400, 'no_id');
  const body = await req.json().catch(() => ({} as any));
  const ontologyId = String(body?.ontologyId || '').trim();

  const fn = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!fn) return err('aip-logic not found', 404, 'not_found');

  // Clear binding when ontologyId is empty.
  if (!ontologyId) {
    const cleared = { ...((fn.state || {}) as Record<string, unknown>) };
    delete cleared.boundOntologyId;
    delete cleared.boundOntologyName;
    delete cleared.ontologyEntityTypes;
    const updated = await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state: cleared });
    if (!updated) return err('aip-logic not found', 404, 'not_found');
    return NextResponse.json({ ok: true, updatedAt: updated.updatedAt, surface: null });
  }

  const surface = await loadOntologySurface(ontologyId, s.claims.oid);
  if (!surface) return err('ontology not found', 404, 'ontology_not_found');

  const state = { ...((fn.state || {}) as Record<string, unknown>) };
  state.boundOntologyId = ontologyId;
  state.boundOntologyName = surface.displayName;
  state.ontologyEntityTypes = surface.classes.map((c) => c.name);
  const updated = await updateOwnedItem(id, ITEM_TYPE, s.claims.oid, { state });
  if (!updated) return err('aip-logic not found', 404, 'not_found');

  await recordThreadEdge(s, {
    fromItemId: id, fromType: ITEM_TYPE, fromName: fn.displayName,
    toItemId: ontologyId, toType: 'ontology', toName: surface.displayName,
    action: 'aip-logic-grounded-on',
  });
  return NextResponse.json({ ok: true, updatedAt: updated.updatedAt, surface });
}
