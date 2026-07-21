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
import { tenantScopeId } from '@/lib/auth/session';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { objectTypeNames, normalizeOntoActionTypes, validateActionRun, evaluateSubmissionCriteria } from '@/lib/editors/ontology-model';
import { normalizeObjectSecurity, actionSecurity, isActionAllowed } from '@/lib/foundry/object-security';
import { auditObjectSecurity } from '@/lib/azure/object-security-audit';
import { weaveGate, runActionType, type WeaveActionType } from '@/lib/azure/weave-ontology-store';
import { PostgresError } from '@/lib/azure/postgres-flex-client';
import { recordActionJustification, isValidReason, MIN_JUSTIFICATION_LEN } from '@/lib/azure/action-justification-store';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { paramsHash, findUsableApproval, requestApproval, consumeApproval } from '@/lib/azure/action-approval-store';
import { getRegisteredFunction } from '@/lib/azure/function-registry-store';
import { functionRuntimeGate, invokeFunction, interpretVerdict } from '@/lib/azure/loom-function-runtime';

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
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: ITEM_TYPE }, 'write');
  if (blocked) return blocked;
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

  // WS-4.3 object-level security: an ACTION marking gates who may run this
  // write-back by Entra group. Enforced server-side (403) + audited BEFORE any
  // validation or write. Tenant admins bypass (mirrors the PDP short-circuit).
  const security = normalizeObjectSecurity(state.objectSecurity);
  const callerGroups = s.claims.groups || [];
  const bypass = isTenantAdminTier(s);
  if (!isActionAllowed(security, actionName, callerGroups, bypass)) {
    const allow = actionSecurity(security, actionName)?.allowGroups.map((g) => g.name || g.id) || [];
    auditObjectSecurity(s, {
      ontologyId: id, ontologyName: onto.displayName, decision: 'action-denied', action: actionName,
      objectType: action.objectType, callerGroups, nowIso: new Date().toISOString(),
    });
    return err(
      `Action "${actionName}" is restricted — your account is not in a security group cleared to run it${allow.length ? ` (allowed: ${allow.join(', ')})` : ''}.`,
      403,
      'action_forbidden',
    );
  }
  // A gated action the caller WAS cleared to run — record the authorization
  // decision so the trail shows who ran a restricted action (best-effort).
  if (!bypass && actionSecurity(security, actionName)) {
    auditObjectSecurity(s, {
      ontologyId: id, ontologyName: onto.displayName, decision: 'action-allowed', action: actionName,
      objectType: action.objectType, callerGroups, nowIso: new Date().toISOString(),
    });
  }

  // Checkpoint (Foundry-parity row 4.7): a justification-gated action requires a
  // written reason BEFORE it runs. Enforced only when the action opts in
  // (requiresJustification) so existing actions are unchanged.
  const reason = String((body as { reason?: string }).reason || '');
  if (action.requiresJustification && !isValidReason(reason)) {
    return err(
      `Action "${actionName}" requires a justification — provide a reason of at least ${MIN_JUSTIFICATION_LEN} characters before running it.`,
      422,
      'justification_required',
    );
  }

  // Validate + coerce the typed parameters against the declared schema.
  const validated = validateActionRun(action, rawParams);
  if (!validated.ok) return err(validated.error, 400, 'invalid_parameters');

  // Enforce the action's submission criteria (Foundry-parity row 2.4) on the
  // coerced values, before any write-back.
  const criteria = evaluateSubmissionCriteria(action, validated.values);
  if (!criteria.ok) return err(criteria.error, 422, 'criteria_failed');

  const runParams: Record<string, unknown> = { ...validated.values };
  // The target object id (update/delete) is not a declared property — pass it
  // through verbatim when supplied.
  const rawId = (rawParams as { id?: unknown }).id;
  if (rawId !== undefined && rawId !== null && rawId !== '') runParams.id = String(rawId);

  // WS-4.2 functions-on-objects: an action may delegate final validation to a
  // REGISTERED function executed on the Loom UDF runtime (Azure-native). It is
  // invoked with the coerced params + target context; a non-`valid` verdict
  // BLOCKS the write (422). Fail-closed — a missing function/runtime is an
  // honest gate, never a silent pass (no-vaporware.md).
  if (action.validationFunction) {
    const fn = await getRegisteredFunction(tenantScopeId(s), action.validationFunction.name, action.validationFunction.version);
    if (!fn) {
      return err(
        `Action "${actionName}" validates via function "${action.validationFunction.name}", which is not registered. Register it under Functions first.`,
        409, 'validation_function_missing',
      );
    }
    const fnGate = functionRuntimeGate(fn);
    if (fnGate) {
      return err(`Validation function runtime not configured (${fnGate.missing}).`, 503, 'function_runtime_not_configured', {
        reason: fnGate.detail, remediation: fnGate.remediation,
      });
    }
    const targetIdForFn = typeof runParams.id === 'string' ? runParams.id : undefined;
    const invoke = await invokeFunction(fn, {
      action: action.name, objectType: action.objectType, kind: action.kind,
      id: targetIdForFn, parameters: validated.values,
    });
    if (invoke.status >= 500 || (!invoke.ok && invoke.error)) {
      return err(`Validation function "${fn.name}@${fn.version}" failed to run: ${invoke.error || `HTTP ${invoke.status}`}`, 502, 'validation_function_error');
    }
    const verdict = interpretVerdict(invoke.value);
    if (!verdict.valid) {
      return err(verdict.message || `Action "${actionName}" was rejected by validation function "${fn.name}".`, 422, 'validation_failed');
    }
  }

  const gate = weaveGate();
  if (gate) {
    return err(`Weave ontology graph store not configured (${gate.missing}).`, 503, 'weave_not_configured', {
      reason: gate.detail,
      remediation: gate.remediation,
    });
  }

  // Approval gate (Foundry-parity row 4.6): a run is blocked until an approver
  // approves the request for the EXACT parameters. Approvals are one-shot.
  let approvalToConsume: string | undefined;
  if (action.requiresApproval) {
    const hash = paramsHash(runParams);
    const usable = await findUsableApproval(id, action.name, hash);
    if (!usable) {
      const reqRec = await requestApproval(s, {
        ontologyId: id, ontologyName: onto.displayName, action: action.name,
        objectType: action.objectType, actionKind: action.kind, params: runParams, nowIso: new Date().toISOString(),
      });
      return NextResponse.json(
        { ok: false, code: 'approval_required', error: `Action "${actionName}" requires approval — a request has been submitted for review.`, requestId: reqRec.id },
        { status: 202 },
      );
    }
    approvalToConsume = usable.id;
  }

  const recordJust = action.requiresJustification;
  const targetId = typeof runParams.id === 'string' ? runParams.id : undefined;
  try {
    const weaveAction: WeaveActionType = { name: action.name, objectType: action.objectType, kind: action.kind };
    const result = await runActionType(weaveAction, runParams);
    let justificationId: string | undefined;
    if (recordJust) {
      const detail = result.kind === 'delete'
        ? `deleted ${result.deleted ?? 0}`
        : `vertex id ${result.object?.id ?? '?'}`;
      try {
        const rec = await recordActionJustification(s, {
          ontologyId: id, ontologyName: onto.displayName, action: action.name,
          objectType: action.objectType, actionKind: action.kind, targetId,
          reason, outcome: 'succeeded', detail, nowIso: new Date().toISOString(),
        });
        justificationId = rec.id;
      } catch { /* audit best-effort — never fail the run on a record miss */ }
    }
    // Side effect (Foundry-parity row 2.4): emit a Thread lineage edge (which
    // also flows to Purview when configured). Best-effort — never fails the run.
    let lineageEmitted = false;
    if (action.emitLineage) {
      try {
        const objId = result.object?.id != null ? String(result.object.id) : (targetId || action.objectType);
        await recordThreadEdge(s, {
          fromItemId: id, fromType: 'ontology', fromName: onto.displayName,
          toItemId: `${action.objectType}:${objId}`, toType: 'ontology-object', toName: action.objectType,
          action: `action:${action.name}`,
        });
        lineageEmitted = true;
      } catch { /* lineage is best-effort */ }
    }
    if (approvalToConsume) { try { await consumeApproval(approvalToConsume, id); } catch { /* best-effort */ } }
    return NextResponse.json({ ...result, ...(justificationId ? { justificationId } : {}), ...(lineageEmitted ? { lineageEmitted } : {}) });
  } catch (e: unknown) {
    const status = e instanceof PostgresError ? e.status : 502;
    const msg = e instanceof Error ? e.message : String(e);
    if (recordJust) {
      try {
        await recordActionJustification(s, {
          ontologyId: id, ontologyName: onto.displayName, action: action.name,
          objectType: action.objectType, actionKind: action.kind, targetId,
          reason, outcome: 'failed', detail: msg, nowIso: new Date().toISOString(),
        });
      } catch { /* best-effort */ }
    }
    return err(`Action "${actionName}" failed: ${msg}`, status, 'action_failed');
  }
}
