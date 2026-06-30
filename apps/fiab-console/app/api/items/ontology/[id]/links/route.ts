/**
 * Weave (Semantic Ontology) Phase 1 — link instance write-back.
 *
 * POST /api/items/ontology/[id]/links
 *   body: { fromObjectType, fromId, linkType, toObjectType, toId, properties? }
 *   → { ok, link } (201)  — REAL AGE write-back (an edge persists in PostgreSQL)
 *
 * Link instances connect two existing object instances (matched by their AGE
 * vertex ids) with a typed edge. `fromObjectType` / `toObjectType` must be
 * declared ontology classes (loom-no-freeform-config). `linkType` is the edge
 * label — for Phase 1 we accept any safe label (the ontology IS_A links are
 * derived from the class hierarchy; instance links are operator-defined edges).
 *
 * Honest 503 (weaveGate) when the AGE backend env is unset. Azure-native; no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { objectTypeNames, normalizeLinkTypes } from '@/lib/editors/ontology-model';
import { weaveGate, createLink } from '@/lib/azure/weave-ontology-store';
import { PostgresError } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

function sanitizeProps(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^[A-Za-z_][\w]{0,62}$/.test(k)) continue;
      if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    }
  }
  return out;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const fromObjectType = String((body as { fromObjectType?: string }).fromObjectType || '').trim();
  const toObjectType = String((body as { toObjectType?: string }).toObjectType || '').trim();
  const linkType = String((body as { linkType?: string }).linkType || '').trim();
  const fromId = String((body as { fromId?: string }).fromId || '').trim();
  const toId = String((body as { toId?: string }).toId || '').trim();
  const props = sanitizeProps((body as { properties?: unknown }).properties);

  if (!fromObjectType || !toObjectType || !linkType || !fromId || !toId) {
    return err('fromObjectType, fromId, linkType, toObjectType, toId are required', 400, 'bad_request');
  }
  if (!/^[A-Za-z_][\w]{0,62}$/.test(linkType)) {
    return err('linkType must be a valid identifier (letters, digits, underscore)', 400, 'bad_link_type');
  }

  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const state = (onto.state || {}) as Record<string, unknown>;
  const types = objectTypeNames(state);
  if (!types.has(fromObjectType)) return err(`"${fromObjectType}" is not a declared object type`, 409, 'undeclared_from');
  if (!types.has(toObjectType)) return err(`"${toObjectType}" is not a declared object type`, 409, 'undeclared_to');

  // When the ontology declares link types, the edge must use one of them and its
  // endpoints must match the link type's from/to object types (typed link
  // instance). When no link types are declared (legacy), any safe label is
  // accepted between two declared object types.
  const linkTypes = normalizeLinkTypes(state.linkTypes);
  if (linkTypes.length > 0) {
    const lt = linkTypes.find((l) => l.apiName === linkType);
    if (!lt) return err(`"${linkType}" is not a declared link type on this ontology`, 409, 'undeclared_link');
    if (lt.fromType !== fromObjectType || lt.toType !== toObjectType) {
      return err(`Link type "${linkType}" connects ${lt.fromType} → ${lt.toType}, not ${fromObjectType} → ${toObjectType}.`, 409, 'link_endpoint_mismatch');
    }
  }

  const gate = weaveGate();
  if (gate) {
    return err(`Weave ontology graph store not configured (${gate.missing}).`, 503, 'weave_not_configured', {
      reason: gate.detail,
      remediation: gate.remediation,
    });
  }

  try {
    const link = await createLink(fromObjectType, fromId, linkType, toObjectType, toId, props);
    return NextResponse.json({ ok: true, link }, { status: 201 });
  } catch (e: unknown) {
    const status = e instanceof PostgresError ? e.status : 502;
    return err(`Create link failed: ${e instanceof Error ? e.message : String(e)}`, status, 'write_failed');
  }
}
