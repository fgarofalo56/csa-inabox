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
import {
  defaultLabelPolicyBody,
  type LabelPolicyBody, type LabelPresetCategory,
} from '@/lib/governance/label-policy-library';
import { accessPoliciesDocId } from '@/lib/governance/access-policy-doc';
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
  kind: 'DLP' | 'Label' | 'Masking' | 'RLS' | 'Retention' | 'Access';
  scope: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  // DLP-kind structured fields (real rule shape — SITs + action + condition).
  dlp?: DlpPolicyRule;
  // Label-kind structured fields (MIP label-policy shape — Loom-native).
  label?: LabelPolicyBody;
  /** Preset provenance, e.g. `preset:pci-dss`. Absent for hand-authored policies. */
  source?: string;
  /** True for the seeded best-practice default policy. */
  builtin?: boolean;
  /** Compliance category for grouping (from the preset). */
  category?: DlpPresetCategory | LabelPresetCategory;
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
  /** Built-in default source-keys already seeded once — so a later disable/delete
   *  by an operator is never re-seeded (day-one default-on, without fighting opt-out). */
  seededDefaults?: string[];
  /** The owner's Entra tenant, stamped when the owner lists their policies
   *  (`stampPoliciesTenant`). Lets an admin find this doc's pre-existing Access
   *  policies without relying on the owner having created a workspace. */
  tid?: string;
  updatedAt: string;
}

/** Turn a preset body ({name,kind,...}) into a persisted Policy for a tenant. */
function policyFromBody(body: any, tenantId: string): Policy {
  return {
    id: crypto.randomUUID(),
    name: body.name,
    kind: body.kind,
    scope: body.scope,
    rule: body.rule,
    enabled: body.enabled,
    createdAt: new Date().toISOString(),
    createdBy: `system:${tenantId}`,
    dlp: body.dlp,
    label: body.label,
    source: body.source,
    builtin: body.builtin,
    category: body.category,
  };
}

/** The built-in defaults seeded day-one: best-practice DLP + label policy. */
function builtinDefaults() {
  const dlp = defaultDlpPolicyBody();
  const label = defaultLabelPolicyBody();
  // Key is namespaced by KIND: both defaults use the preset id 'loom-baseline',
  // so keying/matching by source alone would let the DLP pass shadow the Label
  // pass and never seed the label default. Match presence by kind + source too.
  return [
    { key: `DLP:${dlp.source}`, kind: dlp.kind, source: dlp.source, body: dlp },
    { key: `Label:${label.source}`, kind: label.kind, source: label.source, body: label },
  ];
}

/** Build the seeded best-practice defaults for a brand-new tenant doc. */
function seedItems(tenantId: string): Policy[] {
  return builtinDefaults().map((d) => policyFromBody(d.body, tenantId));
}

/**
 * Ensure every built-in default has been seeded ONCE (default-on, day one) —
 * covering EXISTING tenant docs created before a given default existed. Records
 * each seeded (kind-namespaced) key in `seededDefaults` so a later operator
 * disable/delete is respected (never re-seeded). Returns true when the doc was
 * mutated.
 */
function ensureSeededDefaults(doc: PoliciesDoc, tenantId: string): boolean {
  const seeded = new Set(doc.seededDefaults || []);
  let changed = false;
  for (const d of builtinDefaults()) {
    if (seeded.has(d.key)) continue;               // already seeded once — respect opt-out
    if (!doc.items.some((p) => p.kind === d.kind && p.source === d.source)) {
      doc.items.push(policyFromBody(d.body, tenantId));
      changed = true;
    }
    seeded.add(d.key);
    changed = true;
  }
  if (changed) doc.seededDefaults = Array.from(seeded);
  return changed;
}

/**
 * Read the tenant policy doc, seeding best-practice default DLP + label policies
 * so both are ON day one (out of box). Idempotent — each default is seeded at
 * most once per tenant (tracked in `seededDefaults`), so an operator who later
 * disables or deletes a default is not fought by a re-seed.
 */
export async function loadOrSeedPolicies(tenantId: string): Promise<PoliciesDoc> {
  const c = await tenantSettingsContainer();
  const docId = `policies:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<PoliciesDoc>();
    if (resource) {
      // Existing doc: backfill any built-in default not yet seeded (fixes tenants
      // whose doc predates a default — e.g. the label policy / broadened DLP).
      if (ensureSeededDefaults(resource, tenantId)) return await savePolicies(resource);
      return resource;
    }
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: PoliciesDoc = {
    id: docId, tenantId, kind: 'policies',
    items: seedItems(tenantId),
    seededDefaults: builtinDefaults().map((d) => d.key),
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

/** Read a user's `policies:<oid>` doc WITHOUT seeding it (null when absent). */
export async function readPoliciesDoc(ownerId: string): Promise<PoliciesDoc | null> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(`policies:${ownerId}`, ownerId).read<PoliciesDoc>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

// ── Tenant-scoped Access policies ─────────────────────────────────────────────
//
// Access policies are managed by tenant admins and apply to the whole tenant,
// so they are recorded ONCE per tenant rather than in the author's own
// `policies:<oid>` doc: `access-policies:<tenantScope>` in partition
// `<tenantScope>`, where tenantScope = tenantScopeId(session) = the Entra `tid`
// (or the oid for a tid-less single-operator session). Every admin in the
// tenant reads and manages the same doc.
//
// Access policies written before this change live in their author's
// `policies:<oid>` doc. They are NOT moved or deleted; the policies route lists
// them beside the tenant doc (see `listLegacyAccessPolicyDocs` in lib/governance/legacy-access-policies.ts).

export interface AccessPoliciesDoc {
  id: string;
  tenantId: string;
  kind: 'access-policies';
  items: Policy[];
  updatedAt: string;
}

/** The doc id of a tenant's Access-policy doc. */
export { accessPoliciesDocId };

/**
 * Read the tenant's Access-policy doc. Returns an EMPTY, not-yet-persisted doc
 * when none exists (nothing is written on read); `saveAccessPolicies` upserts.
 */
export async function readAccessPolicies(tenantScope: string): Promise<AccessPoliciesDoc> {
  const c = await tenantSettingsContainer();
  const id = accessPoliciesDocId(tenantScope);
  try {
    const { resource } = await c.item(id, tenantScope).read<AccessPoliciesDoc>();
    if (resource) return { ...resource, items: Array.isArray(resource.items) ? resource.items : [] };
  } catch (e: any) {
    if (e?.code !== 404) throw e;
  }
  return { id, tenantId: tenantScope, kind: 'access-policies', items: [], updatedAt: new Date(0).toISOString() };
}

/** Persist the tenant Access-policy doc (upsert — the first save creates it). */
export async function saveAccessPolicies(doc: AccessPoliciesDoc): Promise<AccessPoliciesDoc> {
  const c = await tenantSettingsContainer();
  doc.updatedAt = new Date().toISOString();
  await c.items.upsert(doc);
  return doc;
}

/**
 * Record the owner's Entra tenant on their own `policies:<oid>` doc, once.
 * Called with the owner's own session only (their `tid` claim), so the stamp is
 * never written from a request body. Returns the (possibly updated) doc.
 */
export async function stampPoliciesTenant(doc: PoliciesDoc, tid: string | undefined): Promise<PoliciesDoc> {
  if (!tid || doc.tid) return doc;
  doc.tid = tid;
  return savePolicies(doc);
}


export { CosmosNotConfiguredError };
