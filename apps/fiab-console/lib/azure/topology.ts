/**
 * topology — the SINGLE deploy-target resolver for item-create flows.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before this module every ARM-touching client/route resolved its subscription
 * + resource group from flat, deployment-wide env vars
 * (`LOOM_SUBSCRIPTION_ID || LOOM_KUSTO_SUB`, `LOOM_DLZ_RG || LOOM_ADMIN_RG`, …).
 * That idiom was copy-pasted across ~15 files, so a multi-domain deployment had
 * no way to land a lakehouse/warehouse/eventhouse in the DLZ subscription that
 * actually OWNS the workspace's domain — everything went to the single admin
 * sub. `resolveDeployTarget(workspaceId, itemType)` collapses that duplication
 * into ONE code path so every editor/wizard routes the same way:
 *
 *   - **Domain-scoped items** (lakehouse, warehouse, eventhouse, kql-database,
 *     notebook, mirrored-database, …) resolve the owning workspace's domain →
 *     `domain.subscriptionIds[0]` + the domain DLZ resource group. That is the
 *     subscription the resource is created in.
 *   - **Shared / tenant items** (catalog, marketplace, governance domains, …)
 *     always stay in the admin plane (DMLZ): `LOOM_SUBSCRIPTION_ID` +
 *     `LOOM_ADMIN_RG`. They are tenant-wide surfaces, not domain-scoped.
 *   - **Single-sub deployments** (the default — empty `domain.subscriptionIds`)
 *     fall back to `LOOM_SUBSCRIPTION_ID` + `LOOM_DLZ_RG`, preserving the exact
 *     behaviour every existing deployment has today (no flag, no migration).
 *
 * The DLZ resource-group name is the shared contract string
 * `rg-csa-loom-dlz-{domain}-{location}` — IDENTICAL to the one
 * `platform/fiab/bicep/main.bicep` (the `dlz` / `dlzAccessPolicyRbac` /
 * `dlzItemCreateRbac` loops) and `scripts/csa-loom/bootstrap-dlz-rgs.sh` use, so
 * the registry, the IaC, and the bootstrap all agree on the same RG.
 *
 * HONEST GATE
 * -----------
 * When the domain sub differs from the admin sub, the Console UAMI can only
 * create resources there if it holds Contributor at that DLZ RG scope (Azure
 * RBAC is additive per-scope — MS Learn). `dlz-attach-itemcreate-rbac.bicep`
 * grants exactly that. When the grant is missing the ARM PUT 403s; callers run
 * `assertItemCreateReachable(target)` (a real ARM RG GET) which returns a
 * `DeployTargetGate` naming the exact role + a copy-paste `az role assignment
 * create` fix — no faked success (per no-vaporware.md).
 *
 * Sovereign-cloud aware: `armBase` always comes from `cloud-endpoints.armBase()`
 * (Commercial / GCC / GCC-High / IL5 / DoD); this module never re-derives an ARM
 * host. No Fabric / Power BI host is ever touched (no-fabric-dependency.md).
 */

import {
  ChainedTokenCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from '@azure/identity';
import { AcaManagedIdentityCredential } from '@/lib/azure/aca-managed-identity';
import { armBase, armScope } from './cloud-endpoints';
import { fetchWithTimeout } from './fetch-with-timeout';
import { getDomainsStore, type LoomDomain } from './domains-client';
import { workspacesContainer } from './cosmos-client';

// ---------------------------------------------------------------------------
// Item-type taxonomy
// ---------------------------------------------------------------------------

/**
 * Item types whose backend is domain-scoped (lands in the owning domain's DLZ
 * subscription). This is the set the ARM-touching create paths route through
 * `resolveDeployTarget`. It is intentionally permissive — any item type NOT in
 * the shared/tenant set below is treated as domain-scoped.
 */
export type DomainScopedItemType =
  | 'lakehouse'
  | 'warehouse'
  | 'eventhouse'
  | 'kql-database'
  | 'kql-queryset'
  | 'kql-dashboard'
  | 'notebook'
  | 'synapse-notebook'
  | 'databricks-notebook'
  | 'databricks-sql-warehouse'
  | 'mirrored-database'
  | 'mirrored-databricks'
  | 'data-pipeline'
  | 'eventstream'
  | 'semantic-model'
  | 'report'
  | 'activator';

/** Any item type — callers pass arbitrary strings; resolution never throws on an
 * unknown type, it just treats it as domain-scoped. */
export type ItemType = DomainScopedItemType | (string & {});

/**
 * Shared / tenant-wide surfaces that always live in the admin plane (DMLZ),
 * regardless of which domain the caller is in. Catalog, marketplace, and the
 * governance domain registry are tenant-scoped, not domain-scoped.
 */
const SHARED_TENANT_PREFIXES = [
  'catalog',
  'data-catalog',
  'marketplace',
  'governance',
  'governance-domain',
  'domain',
  'glossary',
  'glossary-term',
  'purview',
  'data-product',
  'metastore',
] as const;

/**
 * True when `itemType` is a shared/tenant surface that must stay in the admin
 * plane (DMLZ) rather than route to a domain subscription. Pure — unit-testable
 * without any Azure/Cosmos dependency.
 */
export function isSharedTenantItem(itemType: string): boolean {
  const t = (itemType || '').trim().toLowerCase();
  if (!t) return false;
  return SHARED_TENANT_PREFIXES.some((p) => t === p || t.startsWith(`${p}-`) || t.startsWith(`${p}/`));
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type DeployTier = 'dlz' | 'dmlz';

/** The resolved subscription + resource group an item-create should target. */
export interface DeployTarget {
  ok: true;
  subscriptionId: string;
  resourceGroup: string;
  /** 'dmlz' = admin plane (shared/tenant items); 'dlz' = a domain landing zone. */
  tier: DeployTier;
  /** Domain id that owns the workspace (absent for shared/tenant + single-sub). */
  domainId?: string;
  /** Domain name (used to derive the DLZ RG). */
  domainName?: string;
  /** Sovereign-correct ARM control-plane base, from cloud-endpoints.armBase(). */
  armBase: string;
}

/**
 * Honest gate returned when the Console UAMI cannot reach the resolved domain
 * subscription (403 on a preflight ARM read). Names the exact grant and a
 * copy-paste fix — never a faked success.
 */
export interface DeployTargetGate {
  ok: false;
  reason: string;
  /** Human-readable, exact grant the UAMI is missing. */
  missingGrant: string;
  /** Copy-paste `az role assignment create` that wires the grant. */
  fixScript: string;
  /** Set true so callers can surface a redeploy/RBAC remediation MessageBar. */
  redeploy: true;
  subscriptionId: string;
  resourceGroup: string;
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const env = (k: string) => (process.env[k] || '').trim();

/** Deployment region used to derive the DLZ RG name (matches bicep `location`). */
function deployLocation(): string {
  return env('LOOM_LOCATION') || env('LOOM_REGION') || 'eastus2';
}

/**
 * The DLZ resource-group name for a domain — the SHARED CONTRACT string used by
 * `main.bicep` (the `dlz`/`dlzAccessPolicyRbac`/`dlzItemCreateRbac` loops) and
 * `scripts/csa-loom/bootstrap-dlz-rgs.sh`. Domain names are slugged the same way
 * bicep receives them (lower-case, no spaces). Pure — unit-testable.
 */
export function deriveDlzResourceGroup(domainName: string, location?: string): string {
  const slug = (domainName || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `rg-csa-loom-dlz-${slug}-${location || deployLocation()}`;
}

/** The admin-plane (DMLZ) target — shared/tenant items live here. */
export function dmlzTarget(): DeployTarget {
  return {
    ok: true,
    subscriptionId: env('LOOM_SUBSCRIPTION_ID'),
    resourceGroup: env('LOOM_ADMIN_RG') || env('LOOM_DLZ_RG'),
    tier: 'dmlz',
    armBase: armBase(),
  };
}

/** The single-sub default target (empty domain registry → existing behaviour). */
function singleSubTarget(): DeployTarget {
  return {
    ok: true,
    subscriptionId: env('LOOM_SUBSCRIPTION_ID'),
    resourceGroup: env('LOOM_DLZ_RG') || env('LOOM_ADMIN_RG'),
    tier: 'dlz',
    armBase: armBase(),
  };
}

// ---------------------------------------------------------------------------
// Pure resolution (no I/O — given the workspace + domain records)
// ---------------------------------------------------------------------------

/** Minimal workspace shape topology needs (a subset of the Cosmos doc). */
export interface WorkspaceTopologyInput {
  id: string;
  domain?: string;
}

/**
 * Resolve a deploy target from already-loaded records. Separated from the Cosmos
 * I/O so the routing logic is unit-testable without a live Cosmos / ARM.
 *
 * Order: shared/tenant → DMLZ; else workspace.domain → domain.subscriptionIds[0]
 * + (domain.dlzResourceGroup ?? derived); else single-sub fallback.
 */
export function resolveTargetFromRecords(
  itemType: ItemType,
  workspace: WorkspaceTopologyInput | null | undefined,
  domains: Pick<LoomDomain, 'id' | 'name' | 'subscriptionIds' | 'dlzResourceGroup'>[],
): DeployTarget {
  if (isSharedTenantItem(itemType)) return dmlzTarget();

  const domainId = workspace?.domain;
  if (!domainId) return singleSubTarget();

  const domain = domains.find((d) => d.id === domainId);
  const primarySub = domain?.subscriptionIds?.[0]?.trim();

  // Empty registry (single-sub default) → existing behaviour, no behaviour change.
  if (!domain || !primarySub) return singleSubTarget();

  const rg = (domain.dlzResourceGroup || '').trim() || deriveDlzResourceGroup(domain.name);
  return {
    ok: true,
    subscriptionId: primarySub,
    resourceGroup: rg,
    tier: 'dlz',
    domainId: domain.id,
    domainName: domain.name,
    armBase: armBase(),
  };
}

// ---------------------------------------------------------------------------
// resolveDeployTarget — the public entry point (Cosmos-backed)
// ---------------------------------------------------------------------------

/** Cross-partition read of a workspace doc by id (id alone, tenant unknown). */
async function readWorkspaceById(workspaceId: string): Promise<WorkspaceTopologyInput | null> {
  if (!workspaceId) return null;
  const c = await workspacesContainer();
  const { resources } = await c.items
    .query<WorkspaceTopologyInput>({
      query: 'SELECT c.id, c.domain, c.tenantId FROM c WHERE c.id = @id',
      parameters: [{ name: '@id', value: workspaceId }],
    })
    .fetchAll();
  return resources[0] || null;
}

/**
 * THE single resolver every item-create path calls. Reads the owning workspace
 * (→ its domain) and the governance domain registry, then routes:
 *   shared/tenant → DMLZ; domain → domain.subscriptionIds[0] + DLZ RG;
 *   empty registry / no domain → single-sub fallback.
 *
 * Never throws on a missing workspace/domain — it falls back to the single-sub
 * target so unconfigured deployments keep working (per ui-parity: no behaviour
 * change when one sub). The 403 reachability gate is a SEPARATE, opt-in
 * preflight (`assertItemCreateReachable`) so resolution stays fast + pure of ARM.
 */
export async function resolveDeployTarget(workspaceId: string, itemType: ItemType): Promise<DeployTarget> {
  // Shared/tenant items never depend on the workspace's domain — short-circuit.
  if (isSharedTenantItem(itemType)) return dmlzTarget();

  const workspace = await readWorkspaceById(workspaceId).catch(() => null);
  if (!workspace?.domain) return singleSubTarget();

  // Tenant scope for the domain lookup: the workspace's tenant when present,
  // else the configured Entra tenant. listDomains is tenant-partitioned.
  const tenantId =
    (workspace as { tenantId?: string }).tenantId ||
    env('LOOM_ENTRA_TENANT_ID') ||
    env('AZURE_TENANT_ID');
  let domains: LoomDomain[] = [];
  try {
    domains = tenantId ? await getDomainsStore().listDomains(tenantId) : [];
  } catch {
    // Domain registry unreachable → single-sub fallback (never blocks creates).
    return singleSubTarget();
  }
  return resolveTargetFromRecords(itemType, workspace, domains);
}

// ---------------------------------------------------------------------------
// Honest 403 gate
// ---------------------------------------------------------------------------

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new AcaManagedIdentityCredential(),
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Contributor — built-in role GUID (global across every tenant/cloud). */
const CONTRIBUTOR_ROLE_ID = 'b24988ac-6180-42a0-ab88-20f7382dd24c';

/**
 * Build the honest remediation for a missing item-create grant on the resolved
 * domain subscription. Pure — unit-testable. Names the EXACT role + scope and a
 * copy-paste `az role assignment create` (mirrors the dlz-attach RBAC bicep).
 */
export function buildItemCreateGate(target: DeployTarget, reason?: string): DeployTargetGate {
  const principal = uamiClientId || '<uami-client-id>';
  const scope = `/subscriptions/${target.subscriptionId}/resourceGroups/${target.resourceGroup}`;
  const missingGrant =
    `Console UAMI (clientId ${principal}) needs role "Contributor" ` +
    `(${CONTRIBUTOR_ROLE_ID}) on resource group ${target.resourceGroup} in subscription ` +
    `${target.subscriptionId}${target.domainName ? ` (domain "${target.domainName}")` : ''}. ` +
    `This is the grant wired by platform/fiab/bicep/modules/admin-plane/dlz-attach-itemcreate-rbac.bicep ` +
    `(the dlzItemCreateRbac loop in main.bicep).`;
  const fixScript = [
    '# CSA Loom — grant the Console UAMI Contributor on the domain DLZ resource group so item-create ARM PUTs succeed.',
    '# Run in Azure Cloud Shell (PowerShell) or local pwsh with the Az CLI. <uami-object-id> is the UAMI principalId.',
    `az account set --subscription "${target.subscriptionId}"`,
    `az role assignment create \\`,
    `  --assignee-object-id <uami-object-id> --assignee-principal-type ServicePrincipal \\`,
    `  --role "${CONTRIBUTOR_ROLE_ID}" \\`,
    `  --scope "${scope}"`,
  ].join('\n');
  return {
    ok: false,
    reason: reason || 'The Console UAMI is not authorized on the domain subscription.',
    missingGrant,
    fixScript,
    redeploy: true,
    subscriptionId: target.subscriptionId,
    resourceGroup: target.resourceGroup,
  };
}

/**
 * Preflight: confirm the Console UAMI can actually reach the resolved deploy
 * target by doing a real ARM resource-group GET. Returns `null` when reachable,
 * or a `DeployTargetGate` (naming the missing Contributor grant + fix) on 403 /
 * 404. Callers run this before the item-create PUT so a cross-sub permission gap
 * surfaces as an honest remediation instead of an opaque 403 from the PUT.
 *
 * Real ARM REST, no mocks. The DMLZ/admin tier is always reachable (the UAMI
 * lives there) so we only probe domain DLZ targets.
 */
export async function assertItemCreateReachable(target: DeployTarget): Promise<DeployTargetGate | null> {
  if (target.tier !== 'dlz' || !target.subscriptionId || !target.resourceGroup) return null;
  let token: { token: string } | null = null;
  try {
    token = await credential.getToken(armScope());
  } catch {
    token = null;
  }
  if (!token?.token) {
    return buildItemCreateGate(target, 'Failed to acquire an ARM token for the Console UAMI.');
  }
  const url =
    `${target.armBase}/subscriptions/${target.subscriptionId}/resourcegroups/` +
    `${encodeURIComponent(target.resourceGroup)}?api-version=2021-04-01`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
    });
  } catch (e: any) {
    return buildItemCreateGate(target, `ARM resource-group probe failed: ${e?.message || String(e)}`);
  }
  if (res.status === 403) {
    return buildItemCreateGate(target, 'Azure RBAC denied the Console UAMI on the domain resource group (403).');
  }
  if (res.status === 404) {
    return buildItemCreateGate(
      target,
      `Resource group ${target.resourceGroup} was not found in subscription ${target.subscriptionId}. ` +
        'Run scripts/csa-loom/bootstrap-dlz-rgs.sh (or deploy main.bicep in multi-sub mode) to create it.',
    );
  }
  // 200 (reachable) or any other status (auth ok, treat as reachable — the
  // actual create PUT will surface a precise error if something else is wrong).
  return null;
}

// ---------------------------------------------------------------------------
// prepareItemCreate — the ONE call every item-create route makes
// ---------------------------------------------------------------------------

/** Type guard: the resolve result is the honest 403/404 gate (not a target). */
export function isDeployTargetGate(r: DeployTarget | DeployTargetGate): r is DeployTargetGate {
  return r.ok === false;
}

/**
 * The single entry point an item-create / provision route calls before it
 * touches ARM: resolve the deploy target for the owning workspace + item type
 * (`resolveDeployTarget`), then preflight the Console UAMI's reach with a real
 * ARM resource-group GET (`assertItemCreateReachable`).
 *
 *   - Returns a ready-to-create `DeployTarget` when the resolved subscription is
 *     reachable (the common case — single-sub deployments are always reachable,
 *     the UAMI lives there).
 *   - Returns a `DeployTargetGate` (naming the exact missing Contributor grant +
 *     a copy-paste `az role assignment create` fix) when a cross-sub domain DLZ
 *     subscription is NOT reachable, so the route can answer with a structured
 *     remediation (409) instead of letting the create PUT surface an opaque 403.
 *
 * Routes branch on `isDeployTargetGate(result)`. This is what wires the honest
 * gate into the live request path — `assertItemCreateReachable` is never called
 * speculatively, only here, immediately before a real create.
 */
export async function prepareItemCreate(
  workspaceId: string,
  itemType: ItemType,
): Promise<DeployTarget | DeployTargetGate> {
  const target = await resolveDeployTarget(workspaceId, itemType);
  const gate = await assertItemCreateReachable(target);
  return gate ?? target;
}
