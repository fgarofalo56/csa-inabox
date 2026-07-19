/**
 * Object Explorer (Foundry-parity row 2.6) — cross-type object browse + traverse.
 *
 *   GET  ?mode=facets                     → { facets: [{objectType,count}], types }
 *   GET  ?mode=search&type=T&q=…&top=N    → { objects: WeaveObject[] }
 *   GET  ?mode=traverse&type=T&from=<id>  → { neighbors: [{linkType,direction,neighbor}] }
 *   GET  ?mode=saved                      → { explorations: [{name,type,q}] }
 *   POST { name, type, q }                → save an exploration to item.state
 *   DELETE ?name=…                        → remove a saved exploration
 *
 * Reuses the shipped AGE store (weave-explore over weave-ontology-store); honest
 * weaveGate 503 when the graph backend is unconfigured. Owner-scoped like the
 * sibling ontology routes. Azure-native (Apache AGE on PG) — no Fabric.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import { objectTypeNames } from '@/lib/editors/ontology-model';
import { weaveGate } from '@/lib/azure/weave-ontology-store';
import { objectFacets, searchObjects, traverseObject } from '@/lib/azure/weave-explore';
import { PostgresError } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

interface SavedExploration { name: string; type: string; q?: string }

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiError('Ontology not found', 404, { code: 'not_found' });
    const state = (item.state || {}) as Record<string, unknown>;
    const declared = [...objectTypeNames(state)];
    const mode = (req.nextUrl.searchParams.get('mode') || 'facets').trim();

    if (mode === 'saved') {
      return apiOk({ explorations: Array.isArray(state.explorations) ? state.explorations : [] });
    }

    const gate = weaveGate();
    if (gate) return apiError(gate.detail, 503, { code: 'weave_not_configured', missing: gate.missing, remediation: gate.remediation });

    if (mode === 'facets') {
      const facets = await objectFacets(declared);
      return apiOk({ facets, types: declared });
    }
    const type = (req.nextUrl.searchParams.get('type') || '').trim();
    if (!type || !declared.includes(type)) {
      return apiError('type must be a declared ontology object type.', 400, { code: 'bad_type' });
    }
    const top = Number(req.nextUrl.searchParams.get('top')) || 100;
    if (mode === 'search') {
      const objects = await searchObjects(type, req.nextUrl.searchParams.get('q') || '', top);
      return apiOk({ objectType: type, objects });
    }
    if (mode === 'traverse') {
      const from = (req.nextUrl.searchParams.get('from') || '').trim();
      if (!from) return apiError('from (the object AGE id) is required for traverse.', 400, { code: 'bad_from' });
      const neighbors = await traverseObject(type, from, top);
      return apiOk({ from, objectType: type, neighbors });
    }
    return apiError(`Unknown mode '${mode}'.`, 400, { code: 'bad_mode' });
  } catch (e) {
    if (e instanceof PostgresError) return apiError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502, { code: 'query_failed' });
    return apiServerError(e, 'object explorer query failed');
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiError('Ontology not found', 404, { code: 'not_found' });
    const body = (await req.json().catch(() => ({}))) as SavedExploration;
    const name = String(body.name || '').trim().slice(0, 80);
    const type = String(body.type || '').trim();
    if (!name || !type) return apiError('name and type are required.', 400);
    const state = (item.state || {}) as Record<string, unknown>;
    if (!objectTypeNames(state).has(type)) return apiError('type must be a declared object type.', 400, { code: 'bad_type' });
    const existing = (Array.isArray(state.explorations) ? state.explorations : []) as SavedExploration[];
    const next = [...existing.filter((e) => e.name !== name), { name, type, q: String(body.q || '').slice(0, 200) || undefined }].slice(0, 50);
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: { ...state, explorations: next } });
    return apiOk({ explorations: next });
  } catch (e) {
    return apiServerError(e, 'failed to save the exploration');
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  try {
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiError('Ontology not found', 404, { code: 'not_found' });
    const name = (req.nextUrl.searchParams.get('name') || '').trim();
    if (!name) return apiError('name is required.', 400);
    const state = (item.state || {}) as Record<string, unknown>;
    const existing = (Array.isArray(state.explorations) ? state.explorations : []) as SavedExploration[];
    const next = existing.filter((e) => e.name !== name);
    await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: { ...state, explorations: next } });
    return apiOk({ explorations: next });
  } catch (e) {
    return apiServerError(e, 'failed to remove the exploration');
  }
}
