/**
 * data-contract-store.ts — the Cosmos-backed registry for N6 (ODCS data
 * contracts ENFORCED at ingestion).
 *
 * Store: the `loom-data-contracts` container (PK /tenantId — the owner's Entra
 * oid, mirroring the Prep-for-AI / semantic-contract owner scoping), so both
 * "every contract I own" and the enforcement hot path's "which contracts govern
 * this ingestion target" are single-partition reads. Doc shape, ODCS 3.1
 * conversion/validation, and the MIG1 migrator registration live in the LEAF
 * `data-contract-model.ts` (imported by cosmos-client at module scope). The
 * container is ARM-provisioned in `landing-zone/cosmos.bicep`; the
 * createIfNotExists in cosmos-client's `ensure()` is the hotfix fallback.
 *
 * AUDIT standard (ATO): every privileged mutation here — registering/updating a
 * contract, importing an ODCS document, changing the enforcement mode, and
 * binding/unbinding an ingestion target — writes an `_auditLog` row via
 * `auditLogContainer()` AND fans out through `emitAuditEvent` (SIEM +
 * webhooks), the same standard as runtime-flags / semantic-contract.
 * `recordRun` is telemetry, not a privileged mutation, so it does not audit.
 *
 * Per-cloud: pure Loom + Azure — all clouds. **IL5**: the registry, the
 * enforcement decisions, and the dead-letter data all stay inside the
 * deployment's own Cosmos + ADLS; nothing calls out of the boundary, so the
 * full contract lifecycle runs DISCONNECTED in an air-gapped enclave.
 */

import { dataContractsContainer, auditLogContainer } from './cosmos-client';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import {
  DATA_CONTRACT_SCHEMA_VERSION,
  DEFAULT_ENFORCEMENT_MODE,
  bindingMatches,
  dataContractDocId,
  emptyDataContractDoc,
  normalizeEnforcementMode,
  withRun,
  type BindingKind,
  type DataContractBinding,
  type DataContractDoc,
  type EnforcementMode,
  type EnforcementRun,
  type OdcsContract,
} from './data-contract-model';

export type { DataContractDoc, DataContractBinding, EnforcementRun } from './data-contract-model';

const now = () => new Date().toISOString();

/** Actor context threaded from an owned route session (for the audit trail). */
export interface ContractActor {
  oid: string;
  /** UPN / email / display fallback. */
  who: string;
  tenantId: string;
}

/** Point-read one contract's registry doc. Null when it has never been saved. */
export async function getContractDoc(tenantId: string, itemId: string): Promise<DataContractDoc | null> {
  const c = await dataContractsContainer();
  try {
    const { resource } = await c.item(dataContractDocId(itemId), tenantId).read<DataContractDoc>();
    return resource ?? null;
  } catch (e: unknown) {
    if ((e as { code?: number })?.code === 404) return null;
    throw e;
  }
}

/** Every contract in the owner's registry (single-partition). */
export async function listContractDocs(tenantId: string): Promise<DataContractDoc[]> {
  const c = await dataContractsContainer();
  const { resources } = await c.items
    .query<DataContractDoc>({
      query: "SELECT * FROM c WHERE c.tenantId = @t AND c.docType = 'data-contract'",
      parameters: [{ name: '@t', value: tenantId }],
    })
    .fetchAll();
  return resources;
}

export interface SaveContractInput {
  itemId: string;
  displayName: string;
  workspaceId?: string;
  odcs: OdcsContract;
  /** Omitted keeps the stored mode (or the SAFE default on first save). */
  enforcementMode?: EnforcementMode;
  enforcementEnabled?: boolean;
}

/**
 * Register (or update) a contract. Upserts by `contract:<itemId>` under the
 * owner's partition. The ODCS document MUST already be validated by
 * `validateOdcs` — this store persists, it does not silently repair.
 */
export async function saveContractDoc(
  actor: ContractActor,
  input: SaveContractInput,
  auditAction: 'data-contract.save' | 'data-contract.import' = 'data-contract.save',
): Promise<DataContractDoc> {
  const itemId = String(input.itemId || '').trim();
  if (!itemId) throw new Error('saveContractDoc: itemId is required');
  const prior = await getContractDoc(actor.tenantId, itemId);
  const base = prior ?? emptyDataContractDoc(actor.tenantId, itemId, input.displayName, actor.who);
  const doc: DataContractDoc = {
    ...base,
    displayName: input.displayName || base.displayName,
    workspaceId: input.workspaceId ?? base.workspaceId,
    odcs: input.odcs,
    enforcement: {
      enabled: input.enforcementEnabled ?? base.enforcement?.enabled ?? true,
      mode: normalizeEnforcementMode(input.enforcementMode ?? base.enforcement?.mode ?? DEFAULT_ENFORCEMENT_MODE),
    },
    schemaVersion: DATA_CONTRACT_SCHEMA_VERSION,
    updatedAt: now(),
    updatedBy: actor.who,
  };
  const c = await dataContractsContainer();
  await c.items.upsert(doc);
  await audit(actor, auditAction, itemId, {
    priorVersion: prior?.odcs?.version ?? null,
    nextVersion: doc.odcs.version,
    status: doc.odcs.status,
    mode: doc.enforcement.mode,
  });
  return doc;
}

/** Change the enforcement posture (audited — this is a privileged mutation). */
export async function setEnforcement(
  actor: ContractActor,
  itemId: string,
  next: { mode?: EnforcementMode; enabled?: boolean },
): Promise<DataContractDoc | null> {
  const doc = await getContractDoc(actor.tenantId, itemId);
  if (!doc) return null;
  const prior = { ...doc.enforcement };
  const updated: DataContractDoc = {
    ...doc,
    enforcement: {
      enabled: next.enabled ?? prior.enabled,
      mode: normalizeEnforcementMode(next.mode ?? prior.mode),
    },
    updatedAt: now(),
    updatedBy: actor.who,
  };
  const c = await dataContractsContainer();
  await c.items.upsert(updated);
  await audit(actor, 'data-contract.enforcement', itemId, { prior, next: updated.enforcement });
  return updated;
}

/** Bind an ingestion target to this contract (audited). */
export async function upsertBinding(
  actor: ContractActor,
  itemId: string,
  binding: Omit<DataContractBinding, 'boundAt' | 'boundBy'>,
): Promise<DataContractDoc | null> {
  const doc = await getContractDoc(actor.tenantId, itemId);
  if (!doc) return null;
  const row: DataContractBinding = { ...binding, boundAt: now(), boundBy: actor.who };
  const bindings = [...(doc.bindings || []).filter((b) => b.id !== row.id), row];
  const updated: DataContractDoc = { ...doc, bindings, updatedAt: now(), updatedBy: actor.who };
  const c = await dataContractsContainer();
  await c.items.upsert(updated);
  await audit(actor, 'data-contract.bind', itemId, { binding: row });
  return updated;
}

/** Remove a binding (audited). */
export async function removeBinding(
  actor: ContractActor, itemId: string, bindingId: string,
): Promise<DataContractDoc | null> {
  const doc = await getContractDoc(actor.tenantId, itemId);
  if (!doc) return null;
  const removed = (doc.bindings || []).find((b) => b.id === bindingId) || null;
  const updated: DataContractDoc = {
    ...doc,
    bindings: (doc.bindings || []).filter((b) => b.id !== bindingId),
    updatedAt: now(),
    updatedBy: actor.who,
  };
  const c = await dataContractsContainer();
  await c.items.upsert(updated);
  await audit(actor, 'data-contract.unbind', itemId, { bindingId, removed });
  return updated;
}

/**
 * THE enforcement-hot-path lookup: every ENABLED contract in the owner's
 * registry whose binding governs (kind, targetItemId, dataset). Single
 * partition read + a pure in-memory match — no per-ingest fan-out.
 *
 * Returns [] (never throws) when Cosmos is unreachable: enforcement is a guard,
 * and a guard that cannot be read must not take down the ingestion path. The
 * caller records the honest "contract lookup unavailable" note.
 */
export async function contractsForTarget(
  tenantId: string, kind: BindingKind, targetItemId: string, dataset: string,
): Promise<DataContractDoc[]> {
  try {
    const docs = await listContractDocs(tenantId);
    return docs.filter(
      (d) => d.enforcement?.enabled !== false &&
        (d.bindings || []).some((b) => bindingMatches(b, kind, targetItemId, dataset)),
    );
  } catch {
    return [];
  }
}

/**
 * Append an enforcement run to the contract's bounded history (the pass/fail
 * trend the governance registry charts). Best-effort: never throws, so a
 * telemetry hiccup can never fail a real ingestion.
 */
export async function recordRun(tenantId: string, itemId: string, run: EnforcementRun): Promise<void> {
  try {
    const doc = await getContractDoc(tenantId, itemId);
    if (!doc) return;
    const c = await dataContractsContainer();
    await c.items.upsert(withRun(doc, run));
  } catch {
    /* telemetry is never allowed to fail the ingestion path */
  }
}

// ── Audit ──────────────────────────────────────────────────────────────────

async function audit(
  actor: ContractActor, action: string, itemId: string, detail: Record<string, unknown>,
): Promise<void> {
  const at = now();
  try {
    const c = await auditLogContainer();
    await c.items
      .create({
        id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        itemId: `data-contract:${itemId}`,
        tenantId: actor.tenantId,
        who: actor.who,
        actorOid: actor.oid,
        at,
        kind: action,
        target: itemId,
        detail,
      })
      .catch(() => undefined);
  } catch {
    /* audit failures are non-blocking, matching every other admin mutation */
  }
  emitAuditEvent({
    actorOid: actor.oid,
    actorUpn: actor.who,
    action,
    targetType: 'data-contract',
    targetId: itemId,
    tenantId: actor.tenantId,
    detail,
  });
}
