/**
 * /api/items/data-contract/[id]/odcs  (N6 — ODCS 3.1 registry surface)
 *
 * The portable, enforceable face of a Loom data contract:
 *
 *   GET    → EXPORT. Returns the registered ODCS v3.1 document (or, before the
 *            first register, the document derived from the item's typed
 *            designer state) plus the enforcement posture, the ingestion
 *            bindings, and the pass/fail run trend.
 *   PUT    → REGISTER. Converts the item's designer state to ODCS 3.1, VALIDATES
 *            it, and upserts the registry doc (audited).
 *   POST   → IMPORT. Validates a pasted/uploaded ODCS 3.1 document against the
 *            standard and reports PRECISE per-field errors (`{path, message}`)
 *            — it NEVER silently accepts. On success the item's typed designer
 *            state is replaced from the document and the registry doc is
 *            upserted (audited).
 *   PATCH  → enforcement posture (`mode` / `enabled`) and ingestion bindings
 *            (`bind` / `unbind`) — every mutation audited.
 *
 * The enforcement DEFAULT is `warn-quarantine` (quarantine violating rows to
 * the Bronze `_rejected` dead-letter path, alert, and STILL land the rest);
 * `hard-reject` is an explicit per-contract opt-in surfaced as a dropdown.
 *
 * Azure-native, no Microsoft Fabric / Power BI: the registry is the
 * deployment's own Cosmos. **IL5**: fully in-boundary and air-gap capable.
 */
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import {
  BINDING_KINDS,
  ENFORCEMENT_MODES,
  contractTrend,
  emptyDataContractDoc,
  fromOdcs,
  normalizeBindingKind,
  normalizeEnforcementMode,
  toOdcs,
  validateOdcs,
  type OdcsStatus,
} from '@/lib/azure/data-contract-model';
import {
  getContractDoc, saveContractDoc, setEnforcement, upsertBinding, removeBinding,
  type ContractActor,
} from '@/lib/azure/data-contract-store';
import { sanitizeContract, type DataContract } from '@/lib/dataproducts/contract';
import { updateOwnedItem } from '@/app/api/items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-contract';

/** The physical object name the ODCS schema object describes. */
function objectNameOf(state: Record<string, unknown>, fallback: string): string {
  const table = String(state.databaseTable || '').trim();
  return table || fallback;
}

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req, { session, item }) => {
  try {
    const state = (item.state || {}) as Record<string, unknown>;
    const stored = await getContractDoc(session.claims.oid, item.id);
    const odcs = stored?.odcs ?? toOdcs(state.contract as DataContract | undefined, {
      id: item.id,
      name: item.displayName || 'Data contract',
      objectName: objectNameOf(state, item.displayName || 'dataset'),
      status: 'draft',
    });
    const doc = stored ?? emptyDataContractDoc(session.claims.oid, item.id, item.displayName || 'Data contract', session.claims.upn || session.claims.oid);
    return apiOk({
      registered: !!stored,
      odcs,
      enforcement: doc.enforcement,
      bindings: doc.bindings,
      runs: doc.runs.slice(0, 20),
      trend: contractTrend(doc),
      enforcementModes: ENFORCEMENT_MODES,
      bindingKinds: BINDING_KINDS,
    });
  } catch (e) {
    return apiServerError(e, 'could not read the data contract registry', 'data_contract_read_failed');
  }
});

export const PUT = withWorkspaceOwner(ITEM_TYPE, async (req, { session, item }) => {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const state = (item.state || {}) as Record<string, unknown>;
  const status = String((body as Record<string, unknown>).status || 'draft') as OdcsStatus;
  const odcs = toOdcs(state.contract as DataContract | undefined, {
    id: item.id,
    name: item.displayName || 'Data contract',
    objectName: objectNameOf(state, item.displayName || 'dataset'),
    status,
    domain: typeof state.domainId === 'string' ? state.domainId : undefined,
  });
  // Register only a document that passes the SAME validator imports go through.
  const check = validateOdcs(odcs);
  if (!check.ok || !check.contract) {
    return apiError('the designer state does not produce a valid ODCS 3.1 document', 400, { errors: check.errors });
  }
  try {
    const actor: ContractActor = { oid: session.claims.oid, who: session.claims.upn || session.claims.oid, tenantId: session.claims.oid };
    const doc = await saveContractDoc(actor, {
      itemId: item.id,
      displayName: item.displayName || 'Data contract',
      workspaceId: item.workspaceId,
      odcs: check.contract,
    });
    return apiOk({ registered: true, odcs: doc.odcs, enforcement: doc.enforcement, bindings: doc.bindings, trend: contractTrend(doc) });
  } catch (e) {
    return apiServerError(e, 'could not register the data contract', 'data_contract_register_failed');
  }
});

export const POST = withWorkspaceOwner(ITEM_TYPE, async (req, { session, item }) => {
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const raw = (body as Record<string, unknown>).odcs ?? body;
  const check = validateOdcs(raw);
  if (!check.ok || !check.contract) {
    // NEVER silently accepts — every failure names the exact field.
    return apiError('the document is not a valid ODCS 3.1 data contract', 400, {
      errors: check.errors,
      errorCount: check.errors.length,
    });
  }
  try {
    // Replace the typed designer state from the imported document so the editor
    // renders exactly what was imported (round-trip fidelity).
    const contract = sanitizeContract(fromOdcs(check.contract));
    const state = { ...((item.state || {}) as Record<string, unknown>), contract: contract ?? undefined };
    await updateOwnedItem(item.id, ITEM_TYPE, session.claims.oid, { state });

    const actor: ContractActor = { oid: session.claims.oid, who: session.claims.upn || session.claims.oid, tenantId: session.claims.oid };
    const doc = await saveContractDoc(actor, {
      itemId: item.id,
      displayName: item.displayName || 'Data contract',
      workspaceId: item.workspaceId,
      odcs: check.contract,
    }, 'data-contract.import');
    return apiOk({
      imported: true,
      odcs: doc.odcs,
      contract,
      enforcement: doc.enforcement,
      bindings: doc.bindings,
    });
  } catch (e) {
    return apiServerError(e, 'could not import the ODCS document', 'data_contract_import_failed');
  }
});

export const PATCH = withWorkspaceOwner(ITEM_TYPE, async (req, { session, item }) => {
  const body = await req.json().catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
  const actor: ContractActor = { oid: session.claims.oid, who: session.claims.upn || session.claims.oid, tenantId: session.claims.oid };
  try {
    if (body.action === 'bind') {
      const kind = normalizeBindingKind(body.kind);
      if (!kind) return apiError(`kind must be one of ${BINDING_KINDS.join(', ')}`, 400);
      const targetItemId = String(body.targetItemId || '').trim();
      if (!targetItemId) return apiError('targetItemId is required', 400);
      const doc = await upsertBinding(actor, item.id, {
        id: String(body.bindingId || `${kind}:${targetItemId}:${String(body.dataset || '*')}`),
        kind,
        targetItemId,
        targetItemName: body.targetItemName ? String(body.targetItemName) : undefined,
        dataset: String(body.dataset || '*').trim() || '*',
        enabled: body.enabled !== false,
      });
      if (!doc) return apiError('register the contract before binding an ingestion target', 409);
      return apiOk({ bindings: doc.bindings });
    }
    if (body.action === 'unbind') {
      const bindingId = String(body.bindingId || '').trim();
      if (!bindingId) return apiError('bindingId is required', 400);
      const doc = await removeBinding(actor, item.id, bindingId);
      if (!doc) return apiError('contract not registered', 409);
      return apiOk({ bindings: doc.bindings });
    }
    // Enforcement posture.
    const mode = body.mode !== undefined ? normalizeEnforcementMode(body.mode) : undefined;
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
    if (mode === undefined && enabled === undefined) {
      return apiError(`nothing to change — send { mode } (${ENFORCEMENT_MODES.join(' | ')}), { enabled }, or { action: 'bind' | 'unbind' }`, 400);
    }
    const doc = await setEnforcement(actor, item.id, { mode, enabled });
    if (!doc) return apiError('register the contract before changing its enforcement posture', 409);
    return apiOk({ enforcement: doc.enforcement });
  } catch (e) {
    return apiServerError(e, 'could not update the data contract', 'data_contract_update_failed');
  }
});
