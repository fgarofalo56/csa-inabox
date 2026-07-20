/**
 * Ontology Object View (WS-4.1) — per-instance object viewer data (Palantir
 * Foundry "Object Views" parity, row Foundry-1.1-A8).
 *
 * GET /api/items/ontology/[id]/objects/[vertexId]/view?objectType=Customer
 *   → { ok, objectType, object, view:{panels,timeProp,valueProp,geoProp},
 *       properties, titleKey, linked:[{linkType,direction,label,neighbors[]}],
 *       timeseries:{columns,rows,columnTypes}|null, geo:GeoJSON|null }
 *
 * Every panel is assembled from REAL Apache-AGE data (no-vaporware):
 *   - object      → getObject (a single AGE vertex by numeric id, type-scoped)
 *   - linked      → traverseObject (a real cypher MATCH over the graph), grouped
 *                   by (link type × direction)
 *   - timeseries  → a real (timestamp, numeric) property series over the
 *                   instance + its linked objects
 *   - map         → real geopoint / geoshape properties → GeoJSON
 * Honest 503 (weaveGate) when the AGE backend env is unset; honest empty panels
 * when a panel's data genuinely isn't present. Azure-native, no Fabric.
 *
 * AUTHZ: session + `loadOwnedItem(id, 'ontology', oid)` — the owner/workspace-ACL
 * check scopes the ontology (and thus its object graph) to the caller, so a
 * signed-in user can only view instances of an ontology they can access.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdminTier } from '@/lib/auth/domain-role';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { loadOwnedItem } from '../../../../../_lib/item-crud';
import { objectTypeNames, objectTypeByName, normalizeLinkTypes } from '@/lib/editors/ontology-model';
import {
  normalizeObjectSecurity, objectTypeSecurity, secureInstances, maskProperties, isRowVisible,
} from '@/lib/foundry/object-security';
import { auditObjectSecurity } from '@/lib/azure/object-security-audit';
import { weaveGate, getObject } from '@/lib/azure/weave-ontology-store';
import { traverseObject } from '@/lib/azure/weave-explore';
import { PostgresError } from '@/lib/azure/postgres-flex-client';
import { apiError, apiHonestError } from '@/lib/api/respond';
import {
  resolveObjectView, shapeLinkedSections, toTimeseriesGrid, toGeoFeatureCollection,
  type RawNeighbor, type ViewRecord,
} from '@/lib/foundry/object-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'ontology';

// Delegates to the shared apiError envelope (bff-errors: no raw NextResponse envelopes).
function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return apiError(error, status, { ...(code ? { code } : {}), ...(gate ? { gate } : {}) });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; vertexId: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id, vertexId } = await ctx.params;
  if (!id || id === 'new') return err('save the ontology first', 400, 'no_id');
  const objectType = String(req.nextUrl.searchParams.get('objectType') || '').trim();
  if (!objectType) return err('objectType query param is required', 400, 'bad_request');
  if (!vertexId || !/^\d+$/.test(vertexId)) return err('vertexId must be the numeric AGE id', 400, 'bad_request');

  // Owner/ACL-scope the ontology to the caller (loadOwnedItem is the guard) +
  // PDP item-level read check (reuses the EH Phase-1 PDP authorize path).
  const onto = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!onto) return err('ontology not found', 404, 'not_found');
  const blocked = await pdpCheck(s, { level: 'item', id, itemType: ITEM_TYPE }, 'read');
  if (blocked) return blocked;
  const state = (onto.state || {}) as Record<string, unknown>;
  const types = objectTypeNames(state);
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

  // WS-4.3 object-level security context (Entra-group markings). Tenant admins
  // bypass (mirrors the PDP short-circuit).
  const security = normalizeObjectSecurity(state.objectSecurity);
  const callerGroups = s.claims.groups || [];
  const bypass = isTenantAdminTier(s);
  const anchorSec = objectTypeSecurity(security, objectType);

  try {
    const object = await getObject(objectType, vertexId);
    if (!object) return err(`No ${objectType} instance with AGE id ${vertexId}`, 404, 'not_found');

    // Row-level marking on the ANCHOR: a caller not cleared for this instance's
    // marking value cannot view it at all (server-side 403, audited).
    if (!isRowVisible(anchorSec, callerGroups, object.properties, bypass)) {
      auditObjectSecurity(s, {
        ontologyId: id, ontologyName: onto.displayName, decision: 'read-masked', objectType,
        targetId: String(object.id), filteredCount: 1, callerGroups, nowIso: new Date().toISOString(),
      });
      return err('You are not cleared to view this object.', 403, 'row_forbidden');
    }

    // Real link traversal from this vertex (both directions), grouped per type.
    const neighborsRaw = (await traverseObject(objectType, vertexId, 200)) as RawNeighbor[];

    // Property-mask the anchor; row-filter + property-mask each linked neighbour
    // (per its own object type's markings) so masked values never leave the
    // server via a linked panel / timeseries / map.
    const anchorMask = maskProperties(anchorSec, callerGroups, object.properties, bypass);
    let neighborRestricted = false;
    const securedNeighbors: RawNeighbor[] = [];
    for (const n of neighborsRaw) {
      if (!n || !n.neighbor) continue;
      const nSec = objectTypeSecurity(security, n.neighbor.objectType);
      const one = secureInstances(nSec, callerGroups, [{ id: n.neighbor.id, objectType: n.neighbor.objectType, properties: n.neighbor.properties }], bypass);
      if (one.filteredCount > 0) { neighborRestricted = true; continue; } // row-hidden neighbour
      if (one.restricted) neighborRestricted = true;
      const sn = one.objects[0];
      securedNeighbors.push({ linkType: n.linkType, direction: n.direction, neighbor: { id: sn.id, objectType: sn.objectType, properties: sn.properties } });
    }
    const restricted = anchorMask.maskedProperties.length > 0 || neighborRestricted;
    if (restricted) {
      auditObjectSecurity(s, {
        ontologyId: id, ontologyName: onto.displayName, decision: 'read-masked', objectType,
        targetId: String(object.id), maskedProperties: anchorMask.maskedProperties, callerGroups,
        nowIso: new Date().toISOString(),
      });
    }

    const linkTypes = normalizeLinkTypes(state.linkTypes);
    const linked = shapeLinkedSections(securedNeighbors, linkTypes);

    // Resolve the configurable view (persisted per type, else auto-derived).
    const ot = objectTypeByName(state, objectType);
    const rawConfig = (state.objectViews as Record<string, unknown> | undefined)?.[objectType];
    const view = resolveObjectView(ot, rawConfig);

    // Panel data sources: the SECURED instance + every secured linked neighbour.
    const records: ViewRecord[] = [
      { id: object.id, objectType: object.objectType, properties: anchorMask.properties },
      ...securedNeighbors.map((n) => ({ id: n.neighbor.id, objectType: n.neighbor.objectType, properties: n.neighbor.properties })),
    ];
    const timeseries = toTimeseriesGrid(records, { timeProp: view.timeProp, valueProp: view.valueProp });
    const geo = toGeoFeatureCollection(records, { geoProp: view.geoProp });

    // A linked neighbour may supply timeseries/map data the anchor type doesn't
    // declare — surface those panels too rather than hide real data.
    const panels = [...view.panels];
    if (timeseries && !panels.includes('timeseries')) panels.push('timeseries');
    if (geo && !panels.includes('map')) panels.push('map');

    return NextResponse.json({
      ok: true,
      objectType,
      object: { id: object.id, objectType: object.objectType, properties: anchorMask.properties },
      view: { ...view, panels },
      properties: ot?.properties ?? [],
      titleKey: ot?.titleKey ?? null,
      linked,
      timeseries,
      geo,
      security: restricted
        ? { restricted: true, maskedProperties: anchorMask.maskedProperties }
        : { restricted: false },
    });
  } catch (e: unknown) {
    const status = e instanceof PostgresError ? e.status : 502;
    return err(`Object view failed: ${e instanceof Error ? e.message : String(e)}`, status, 'query_failed');
  }
}
