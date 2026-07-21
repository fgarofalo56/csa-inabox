/**
 * Governance-as-Code — policy-set storage. The authored `PolicyCodeSet` and the
 * last reconcile receipt live in the Cosmos `tenantSettings` container (one doc
 * per tenant), mirroring domain-sync / protection-policy persistence. No
 * separate container.
 */

import type { PolicyCodeSet } from './dsl';
import { normalizePolicyCodeSet, emptyPolicyCodeSet } from './dsl';
import type { PolicyReconcileReceipt } from './reconcile';

interface PolicyCodeSetDoc {
  id: string;
  tenantId: string;
  kind: 'policy-code-set';
  set: PolicyCodeSet;
  updatedAt: string;
  updatedBy: string;
}

interface PolicyCodeSnapshotDoc {
  id: string;
  tenantId: string;
  lastReceipt?: PolicyReconcileReceipt;
}

const setId = (tenantId: string) => `policy-code-set:${tenantId}`;
const snapshotId = (tenantId: string) => `policy-code-state:${tenantId}`;

/** Load the authored policy set, or an empty starter when none exists. */
export async function loadPolicySet(tenantId: string): Promise<{ set: PolicyCodeSet; exists: boolean }> {
  const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(setId(tenantId), tenantId).read<PolicyCodeSetDoc>();
    if (resource?.set) return { set: normalizePolicyCodeSet(resource.set), exists: true };
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { set: emptyPolicyCodeSet(), exists: false };
}

/** Persist the authored policy set (validated/normalized by the caller). */
export async function savePolicySet(tenantId: string, set: PolicyCodeSet, updatedBy: string): Promise<PolicyCodeSet> {
  const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
  const c = await tenantSettingsContainer();
  const normalized = normalizePolicyCodeSet({ ...set, updatedAt: new Date().toISOString(), updatedBy });
  const doc: PolicyCodeSetDoc = {
    id: setId(tenantId),
    tenantId,
    kind: 'policy-code-set',
    set: normalized,
    updatedAt: normalized.updatedAt!,
    updatedBy,
  };
  await c.items.upsert(doc);
  return normalized;
}

/** The last reconcile receipt (for the drift-status banner on load). */
export async function loadLastReceipt(tenantId: string): Promise<PolicyReconcileReceipt | null> {
  try {
    const { tenantSettingsContainer } = await import('@/lib/azure/cosmos-client');
    const c = await tenantSettingsContainer();
    const { resource } = await c.item(snapshotId(tenantId), tenantId).read<PolicyCodeSnapshotDoc>();
    return resource?.lastReceipt ?? null;
  } catch {
    return null;
  }
}
