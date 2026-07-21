/**
 * POST /api/thread/bind-to-ontology — Loom Thread edge (WS-6 / BTB-1).
 *
 * Binds a data item (lakehouse / warehouse / KQL / SQL / semantic-model) to a
 * Weave ontology OBJECT TYPE: the item's rows become typed instances of that
 * object type via the ontology resolver. This is the substrate edge — the same
 * object type can be bound from many items (a lakehouse table + a KQL stream + a
 * semantic measure all resolving as ONE object).
 *
 * The binding is persisted on the SOURCE item's Cosmos `state.ontologyBinding`
 * (an OntologyBinding). A Thread lineage edge (source → ontology) is recorded so
 * the binding shows in Weave lineage + Purview. Real owner-scoped Cosmos writes,
 * no mocks. Azure-native (Cosmos + AGE) — no Fabric.
 *
 * Body: { from: { id, type, name }, values: { ontologyId, objectType, sourceRef, keyColumn? } }
 * Returns: { ok, message, link, linkLabel }
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem, updateOwnedItem } from '../../items/_lib/item-crud';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import { objectTypeNames } from '@/lib/editors/ontology-model';
import {
  type OntologyBindingSourceKind, type OntologyBinding, normalizeOntologyBinding,
} from '@/lib/foundry/ontology-binding';
import { apiError, apiOk, apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Map the source item's slug → the binding source kind the resolver dispatches on. */
const SOURCE_KIND_BY_TYPE: Record<string, OntologyBindingSourceKind> = {
  'lakehouse': 'lakehouse-table',
  'synapse-serverless-sql-pool': 'lakehouse-table',
  'warehouse': 'warehouse-table',
  'synapse-dedicated-sql-pool': 'warehouse-table',
  'kql-database': 'kql',
  'semantic-model': 'semantic-measure',
  'azure-sql-database': 'azure-sql',
};

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401, { code: 'unauthenticated' });
  const oid = session.claims.oid;

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const from = (body as { from?: { id?: string; type?: string; name?: string } }).from || {};
  const values = (body as { values?: Record<string, unknown> }).values || {};
  const fromId = String(from.id || '').trim();
  const fromType = String(from.type || '').trim();
  if (!fromId || !fromType) return apiError('missing source item', 400, { code: 'missing_source' });

  const kind = SOURCE_KIND_BY_TYPE[fromType];
  if (!kind) return apiError(`${fromType} cannot be bound to an ontology object type`, 400, { code: 'unbindable_type' });

  const ontologyId = String(values.ontologyId || '').trim();
  const objectType = String(values.objectType || '').trim();
  const sourceRef = String(values.sourceRef || '').trim();
  const keyColumn = String(values.keyColumn || '').trim();
  if (!ontologyId) return apiError('choose an ontology to bind to', 400, { code: 'no_ontology' });
  if (!objectType) return apiError('enter the object type this data materializes', 400, { code: 'no_object_type' });
  if (!sourceRef) return apiError('enter the source table / stream / measure this object type reads from', 400, { code: 'no_source_ref' });

  try {
    const src = await loadOwnedItem(fromId, fromType, oid);
    if (!src) return apiError('source item not found', 404, { code: 'not_found' });

    const onto = await loadOwnedItem(ontologyId, 'ontology', oid);
    if (!onto) return apiError('ontology not found in your tenant', 404, { code: 'ontology_not_found' });

    // The object type MUST be declared on the ontology (loom-no-freeform-config —
    // no binding to a phantom type).
    if (!objectTypeNames((onto.state || {}) as Record<string, unknown>).has(objectType)) {
      return apiError(`"${objectType}" is not a declared object type on ontology "${onto.displayName}"`, 409, { code: 'undeclared_type' });
    }

    const source: OntologyBinding['source'] = {
      kind,
      ref: sourceRef,
      sourceItemId: fromId,
      ...(fromType === 'lakehouse' ? { lakehouseId: fromId } : {}),
    };
    const rawBinding: OntologyBinding = {
      ontologyId,
      ontologyName: onto.displayName,
      objectType,
      source,
      ...(keyColumn ? { keyColumn } : {}),
      boundAt: new Date().toISOString(),
    };
    // Round-trip through the normalizer so the persisted shape is canonical.
    const binding = normalizeOntologyBinding(rawBinding);
    if (!binding) return apiError('binding is invalid — check the object type and source reference', 400, { code: 'bad_binding' });

    const nextState = { ...((src.state || {}) as Record<string, unknown>), ontologyBinding: binding };
    const updated = await updateOwnedItem(fromId, fromType, oid, { state: nextState });
    if (!updated) return apiError('failed to persist the binding', 500, { code: 'persist_failed' });

    await recordThreadEdge(session, {
      fromItemId: fromId, fromType, fromName: from.name || src.displayName,
      toItemId: ontologyId, toType: 'ontology', toName: onto.displayName,
      action: 'bind-to-ontology',
    });

    return apiOk({
      message: `Bound "${from.name || src.displayName}" to ontology object type "${objectType}". Its rows now resolve as ${objectType} instances.`,
      link: `/items/ontology/${ontologyId}`,
      linkLabel: 'Open the Ontology',
      objectType,
      sourceKind: kind,
    });
  } catch (e) {
    return apiServerError(e, 'failed to bind to ontology', 'bind_failed');
  }
}
