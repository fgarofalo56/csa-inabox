/**
 * Governance policy store — the tenant DLP / masking / RLS / retention / access
 * policy document, persisted as a single Cosmos doc in the tenant-settings
 * container under `policies:<tenantId>`.
 *
 * Extracted from app/api/governance/policies/route.ts so the policy store is
 * shared by both the policies CRUD route and the DLP policy-library route
 * (one-click preset enable) — a single source of truth for the doc shape, the
 * seed, and the Cosmos gate. No Microsoft Fabric / Power BI dependency: this is
 * a Loom-native Cosmos store read by downstream enforcement (Synapse SQL /
 * lakehouse query gate / restrict-access).
 */
import { tenantSettingsContainer, CosmosNotConfiguredError } from '@/lib/azure/cosmos-client';
import type { AccessPermission, AccessScopeType, PrincipalType } from '@/lib/azure/access-policy-client';
import { defaultDlpPolicyBody, type DlpPolicyRule, type DlpPresetCategory } from '@/lib/governance/dlp-policy-library';
export type { DlpPolicyRule, DlpPresetCategory } from '@/lib/governance/dlp-policy-library';

export interface PolicyEnforcement {
  status: 'active' | 'pending' | 'error';
  roleName?: string;
  roleAssignmentId?: string;
  detail?: string;
}

export interface Policy {
  id: string;
  name: string;
  kind: 'DLP' | 'Masking' | 'RLS' | 'Retention' | 'Access';
  scope: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  // DLP-kind structured fields (real rule shape — SITs + action + condition).
  dlp?: DlpPolicyRule;
  /** Preset provenance, e.g. `preset:pci-dss`. Absent for hand-authored policies. */
  source?: string;
  /** True for the seeded best-practice default policy. */
  builtin?: boolean;
  /** Compliance category for grouping (from the preset). */
  category?: DlpPresetCategory;
  // Access-kind structured fields (enable real RBAC enforcement).
  principalId?: string;
  principalName?: string;
  principalType?: PrincipalType;
  scopeType?: AccessScopeType;
  scopeRef?: string;
  permission?: AccessPermission;
  /** Result of the real RBAC grant for Access policies. */
  enforcement?: PolicyEnforcement;
}

export interface PoliciesDoc {
  id: string;
  tenantId: string;
  kind: 'policies';
  items: Policy[];
  updatedAt: string;
}

/** Build the seeded best-practice default DLP policy for a brand-new tenant doc. */
function seedItems(tenantId: string): Policy[] {
  const body = defaultDlpPolicyBody();
  return [{
    id: crypto.randomUUID(),
    name: body.name,
    kind: body.kind,
    scope: body.scope,
    rule: body.rule,
    enabled: body.enabled,
    createdAt: new Date().toISOString(),
    createdBy: `system:${tenantId}`,
    dlp: body.dlp,
    source: body.source,
    builtin: body.builtin,
    category: body.category,
  }];
}

/**
 * Read the tenant policy doc, seeding a best-practice default DLP policy when
 * the doc is first created (DLP default-on, out of box). Idempotent — the seed
 * only runs on the initial create, so an operator who later disables or deletes
 * the default is not fought by a re-seed.
 */
export async function loadOrSeedPolicies(tenantId: string): Promise<PoliciesDoc> {
  const c = await tenantSettingsContainer();
  const docId = `policies:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<PoliciesDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: PoliciesDoc = {
    id: docId, tenantId, kind: 'policies',
    items: seedItems(tenantId),
    updatedAt: new Date().toISOString(),
  };
  await c.items.create(seed);
  return seed;
}

/** Persist the policy doc (updates `updatedAt`). */
export async function savePolicies(doc: PoliciesDoc): Promise<PoliciesDoc> {
  const c = await tenantSettingsContainer();
  doc.updatedAt = new Date().toISOString();
  await c.item(doc.id, doc.tenantId).replace(doc);
  return doc;
}

export { CosmosNotConfiguredError };
