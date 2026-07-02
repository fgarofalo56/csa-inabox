/**
 * Weave (Semantic Ontology) Phase 1 — ACTION TYPE write-back executor.
 *
 * GET  /api/items/ontology/[id]/run-action
 *   → { ok, actionTypes: [{ name, objectType, kind, params? }] }  (declared types)
 *
 * POST /api/items/ontology/[id]/run-action
 *   body: { action: string, params?: { id?, ...properties } }
 *   → { ok, action, kind, objectType, object|deleted }  — REAL AGE write-back.
 *
 * This is the Palantir-class piece: an *action type* is declared on the ontology
 * item's state.actionTypes[] (objectType + kind create|update|delete + param
 * names). POSTing runs the declared action against Apache AGE inside a single
 * PostgreSQL transaction (AGE is ACID → durable write-back). It generalizes the
 * read-only workshop-app/run-action into a create/update/delete write-back with
 * the same honest-gate ergonomics.
 *
 * The action's objectType MUST be a declared ontology class
 * (loom-no-freeform-config). Honest 503 (weaveGate) when the AGE backend env is
 * unset, naming LOOM_WEAVE_PG_FQDN + modules/landing-zone/postgres-weave.bicep.
 * Azure-native; no Microsoft Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { objectTypeNames, normalizeOntoActionTypes, validateActionRun } from '@/lib/editors/ontology-model';
import { weaveGate, runActionType, type WeaveActionType } from '@/lib/azure/weave-ontology-store';
import { PostgresError } from '@/lib/azure/postgres-flex-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return NextResponse.json({ ok: true, actionTypes: [] });
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const actionTypes = normalizeOntoActionTypes(((onto.state || {}) as Record<string, unknown>).actionTypes);
  return NextResponse.json({ ok: true, actionTypes });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const actionName = String((body as { action?: string }).action || '').trim();
  if (!actionName) return err('action is required', 400, 'bad_request');
  const rawParams = ((body as { params?: unknown }).params || {}) as Record<string, unknown>;

  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const state = (onto.state || {}) as Record<string, unknown>;
  const actionTypes = normalizeOntoActionTypes(state.actionTypes);
  const action = actionTypes.find((a) => a.name === actionName);
  if (!action) {
    return err(`Action "${actionName}" is not declared on this ontology. Add it under Action types first.`, 409, 'undeclared_action');
  }

  // The action's objectType must still be a declared object type (it could have
  // been removed after the action was declared).
  const classNames = objectTypeNames(state);
  if (!classNames.has(action.objectType)) {
    return err(`Action "${actionName}" targets object type "${action.objectType}" which is no longer declared on this ontology.`, 409, 'undeclared_type');
  }

  // Validate + coerce the typed parameters against the declared schema.
  const validated = validateActionRun(action, rawParams);
  if (!validated.ok) return err(validated.error, 400, 'invalid_parameters');
  const runParams: Record<string, unknown> = { ...validated.values };
  // The target object id (update/delete) is not a declared property — pass it
  // through verbatim when supplied.
  const rawId = (rawParams as { id?: unknown }).id;
  if (rawId !== undefined && rawId !== null && rawId !== '') runParams.id = String(rawId);

  const gate = weaveGate();
  if (gate) {
    return err(`Weave ontology graph store not configured (${gate.missing}).`, 503, 'weave_not_configured', {
      reason: gate.detail,
      remediation: gate.remediation,
    });
  }

  try {
    const weaveAction: WeaveActionType = { name: action.name, objectType: action.objectType, kind: action.kind };
    const result = await runActionType(weaveAction, runParams);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const status = e instanceof PostgresError ? e.status : 502;
    return err(`Action "${actionName}" failed: ${e instanceof Error ? e.message : String(e)}`, status, 'action_failed');
  }
}
