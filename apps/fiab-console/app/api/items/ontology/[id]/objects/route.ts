/**
 * Weave (Semantic Ontology) Phase 1 — object instance write-back.
 *
 * GET  /api/items/ontology/[id]/objects?objectType=Customer&top=100
 *   → { ok, objectType, objects: [{ id, objectType, properties }] }
 *
 * POST /api/items/ontology/[id]/objects
 *   body: { objectType: string, properties?: Record<string, scalar> }
 *   → { ok, object } (201)  — REAL AGE write-back (a vertex persists in PostgreSQL)
 *
 * The ontology object/link/action TYPES are declared in the ontology DSL
 * (state.source → parseOntologyHierarchy classes). This route persists object
 * *instances* of a declared type as Apache AGE vertices over the Weave PG
 * flexible server (modules/landing-zone/postgres-weave.bicep, default-on).
 *
 * `objectType` MUST be a declared ontology class (loom-no-freeform-config — no
 * freeform vertex labels). Honest 503 (weaveGate) when the AGE backend env is
 * unset, naming LOOM_WEAVE_PG_FQDN + the bicep module. Azure-native; no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { objectTypeNames, objectTypeByName, validateObjectInstance } from '@/lib/editors/ontology-model';
import { weaveGate, createObject, listObjects } from '@/lib/azure/weave-ontology-store';
import { PostgresError } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

/**
 * Resolve the ontology's declared object-type names — prefers the structured
 * `state.objectTypes[]` model and falls back to the legacy `state.source` DSL.
 */
async function declaredTypes(id: string, oid: string): Promise<Set<string> | null> {
  const onto = await loadOwnedItem(id, ITEM_TYPE, oid);
  if (!onto) return null;
  return objectTypeNames((onto.state || {}) as Record<string, unknown>);
}

/** Only scalar property values are accepted (string/number/boolean). */
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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');
  const objectType = String(req.nextUrl.searchParams.get('objectType') || '').trim();
  const top = Number(req.nextUrl.searchParams.get('top')) || 100;
  if (!objectType) return err('objectType query param is required', 400, 'bad_request');

  const types = await declaredTypes(id, s.claims.oid);
  if (!types) return err('ontology not found', 404, 'not_found');
  if (!types.has(objectType)) {
    return err(`"${objectType}" is not a declared object type on this ontology`, 409, 'undeclared_type');
  }

  const gate = weaveGate();
  if (gate) {
    return err(`Weave ontology graph store not configured (${gate.missing}).`, 503, 'weave_not_configured', {
      reason: gate.detail,
      remediation: gate.remediation,
    });
  }

  try {
    const objects = await listObjects(objectType, top);
    return NextResponse.json({ ok: true, objectType, objects });
  } catch (e: unknown) {
    const status = e instanceof PostgresError ? e.status : 502;
    return err(`List objects failed: ${e instanceof Error ? e.message : String(e)}`, status, 'query_failed');
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const objectType = String((body as { objectType?: string }).objectType || '').trim();
  if (!objectType) return err('objectType is required', 400, 'bad_request');
  const props = sanitizeProps((body as { properties?: unknown }).properties);

  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const state = (onto.state || {}) as Record<string, unknown>;
  const types = objectTypeNames(state);
  if (!types.has(objectType)) {
    return err(`"${objectType}" is not a declared object type on this ontology`, 409, 'undeclared_type');
  }

  // Validate the supplied props against the object type's typed property schema
  // (required present, declared keys only, numeric/boolean coercion). When the
  // type declares no properties (legacy) any scalar bag is accepted.
  const ot = objectTypeByName(state, objectType);
  const validated = validateObjectInstance(ot, props);
  if (!validated.ok) return err(validated.error, 400, 'invalid_properties');

  const gate = weaveGate();
  if (gate) {
    return err(`Weave ontology graph store not configured (${gate.missing}).`, 503, 'weave_not_configured', {
      reason: gate.detail,
      remediation: gate.remediation,
    });
  }

  try {
    const object = await createObject(objectType, validated.values as Record<string, unknown>);
    return NextResponse.json({ ok: true, object }, { status: 201 });
  } catch (e: unknown) {
    const status = e instanceof PostgresError ? e.status : 502;
    return err(`Create object failed: ${e instanceof Error ? e.message : String(e)}`, status, 'write_failed');
  }
}
