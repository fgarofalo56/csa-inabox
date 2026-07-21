/**
 * Ontology-Over-Everything (WS-6 / BTB-1) — the RESOLVER route.
 *
 * GET /api/items/ontology/[id]/resolve?objectType=Customer[&top=100]
 *   → { ok, objectType, sources: [{ itemId, itemName, sourceKind, resolved,
 *        rowCount, gate? }], instances: [{ id, objectType, properties }],
 *        security: { restricted, filteredCount } }
 *
 * Resolves an ontology object type through EVERY item bound to it (its
 * `state.ontologyBinding`) — a lakehouse table, a KQL stream, and a semantic
 * measure all resolve as typed instances of the SAME object type — and returns
 * the merged instance set. Each source is queried against its REAL backend
 * (Synapse Serverless/Dedicated, ADX, Azure-native DAX, WS-3.2 zero-copy
 * engineObject); a source whose backend is unconfigured reports an honest gate
 * in `sources[].gate` (per no-vaporware.md), the others still resolve.
 *
 * WS-4.3 object-level security is applied to the resolved instances (row-filter +
 * property-mask by the caller's Entra groups), exactly as the AGE `/objects`
 * route does — access policy resolves THROUGH the ontology, over rows that never
 * lived in AGE. Azure-native + sovereign; no Fabric / Power BI.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { objectTypeNames, objectTypeByName } from '@/lib/editors/ontology-model';
import {
  normalizeObjectSecurity, objectTypeSecurity, secureInstances,
} from '@/lib/foundry/object-security';
import { auditObjectSecurity } from '@/lib/azure/object-security-audit';
import { discoverOntologyBindings, resolveOntologyObjectInstances } from '@/lib/foundry/ontology-resolver';
import { parseAsOf, isLive, asOfLabel, TimeMachineError } from '@/lib/time-machine/time-machine';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the ontology first', 400, { code: 'no_id' });

  const objectType = String(req.nextUrl.searchParams.get('objectType') || '').trim();
  if (!objectType) return apiError('objectType query param is required', 400, { code: 'bad_request' });
  const top = Number(req.nextUrl.searchParams.get('top')) || 100;

  // WS-10.3 Time-Machine — one `asOf` param threaded to every bound source's
  // native time-travel. Absent/`live` ⇒ current state (byte-identical to before);
  // a malformed value is a precise 400 (never a silent live read).
  let asOf;
  try {
    asOf = parseAsOf(req.nextUrl.searchParams.get('asOf'));
  } catch (e) {
    if (e instanceof TimeMachineError) return apiError(e.message, 400, { code: 'bad_asof' });
    throw e;
  }

  // Owner/workspace-ACL gate (read-only) + PDP item-level read check.
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid, { allowReadRoles: true });
  if (!onto) return apiError('ontology not found', 404, { code: 'not_found' });
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: ITEM_TYPE }, 'read');
  if (blocked) return blocked;

  const state = (onto.state || {}) as Record<string, unknown>;
  if (!objectTypeNames(state).has(objectType)) {
    return apiError(`"${objectType}" is not a declared object type on this ontology`, 409, { code: 'undeclared_type' });
  }

  try {
    const ot = objectTypeByName(state, objectType);
    const bindings = await discoverOntologyBindings(onto);
    const forType = bindings.filter((b) => b.binding.objectType === objectType);
    const { sources, instances } = await resolveOntologyObjectInstances(
      forType, objectType, ot, { top, tenantId: s.claims.oid, asOf },
    );

    // WS-4.3 object-level security over the resolved instances — access policy
    // resolves through the ontology, not just over AGE-native instances.
    const security = normalizeObjectSecurity(state.objectSecurity);
    const sec = objectTypeSecurity(security, objectType);
    const callerGroups = s.claims.groups || [];
    const bypass = isTenantAdminTier(s);
    const secured = secureInstances(sec, callerGroups, instances, bypass);
    if (secured.restricted) {
      const maskedProps = Array.from(new Set(secured.objects.flatMap((o) => o.maskedProperties || [])));
      auditObjectSecurity(s, {
        ontologyId: id, ontologyName: onto.displayName, decision: 'read-masked', objectType,
        maskedProperties: maskedProps, filteredCount: secured.filteredCount, callerGroups,
        nowIso: new Date().toISOString(),
      });
    }

    return apiOk({
      objectType,
      asOf: { live: isLive(asOf), label: asOfLabel(asOf) },
      sources: sources.map((src) => ({
        itemId: src.itemId,
        itemName: src.itemName,
        sourceKind: src.sourceKind,
        resolved: src.resolved,
        rowCount: src.rowCount,
        ...(src.gate ? { gate: src.gate } : {}),
      })),
      instances: secured.objects,
      security: secured.restricted
        ? { restricted: true, filteredCount: secured.filteredCount }
        : { restricted: false },
      note: forType.length === 0
        ? `No item binds to "${objectType}" yet — use the "Bind to ontology" Weave on a lakehouse / KQL / semantic-model.`
        : undefined,
    });
  } catch (e) {
    return apiServerError(e, 'resolve failed', 'resolve_failed');
  }
}
