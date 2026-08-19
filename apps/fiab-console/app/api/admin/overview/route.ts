/**
 * GET /api/admin/overview — live counts for the 14 admin-landing tiles.
 *
 * Replaces the static "Pick an area" EmptyState on /admin with real section
 * tiles, each showing a count fetched from its own backend. Every backend
 * fetch runs in parallel (Promise.all over self-catching tile helpers) so a
 * single absent / mis-configured source returns
 *   { count: null, gated: true, hint }
 * instead of blocking the other tiles. No mock numbers — per
 * .claude/rules/no-vaporware.md a source that isn't wired returns an honest
 * gate naming the exact env var / role to set, never a fabricated integer.
 *
 * Backends (all sovereign-cloud correct, NO Microsoft Fabric dependency per
 * .claude/rules/no-fabric-dependency.md — the capacity tile counts Azure
 * resources via ARM, NOT api.fabric.microsoft.com):
 *   workspaces, domains, items, auditEvents, permissions, attributeGroups,
 *   labeledItems, tenantSettings  — Cosmos (LOOM_COSMOS_ENDPOINT)
 *   users                          — Microsoft Graph GET /v1.0/users/$count
 *   capacity                       — ARM list-resources (LOOM_SUBSCRIPTION_ID)
 *   openAuditItems                 — ARM AlertsManagement fired alerts
 *   sensitivityLabels              — Microsoft Graph MIP sensitivity labels
 *
 * Auth: getSession() → 401, then tenant-admin → 403. Tenant isolation: every
 * Cosmos query over a /tenantId-partitioned container binds the caller's oid
 * (s.claims.oid) as the tenant partition key — cross-tenant leakage is
 * structurally impossible. TWO exceptions, each with its own reason:
 *   • `audit-log` partitions on /itemId and its rows carry either the actor's
 *     oid or the Entra tid, so it is read cross-partition, scoped to the
 *     caller's own [oid, tid] (lib/audit/audit-scope.ts, #2635).
 *   • the `domains` tile reads the per-TENANT domains document in
 *     tenant-settings, which #3282 keyed with `tenantScopeId()` (tid || oid).
 *     Keying it with the raw oid — as this route did until #3753 — resolved a
 *     PRIVATE, auto-seeded copy, so the tile disagreed with /admin/domains.
 *     Both scopes are threaded explicitly and BOTH are in the cache key.
 */
import { NextResponse } from 'next/server';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { tenantScopeId } from '@/lib/auth/session';
import { loadTenantDomains } from '@/lib/auth/load-domains';
import { buildScopedCacheKey, getOrComputeCached } from '@/lib/azure/query-result-cache';
import {
  workspacesContainer,
  itemsContainer,
  tenantSettingsContainer,
  auditLogContainer,
  featurePermissionsContainer,
  attributeGroupsContainer,
  labelAssignmentsContainer,
  costAnomalyRulesContainer,
  lakehouseInteropContainer,
  incidentsContainer,
} from '@/lib/azure/cosmos-client';
import type { SqlParameter } from '@azure/cosmos';
import { AUDIT_TENANT_PREDICATE, auditScopeIds } from '@/lib/audit/audit-scope';
import { getGraphHost, getGraphScope } from '@/lib/azure/cloud-endpoints';
import { listResources, listAlertHistory, queryLogs } from '@/lib/azure/monitor-client';
import { listSensitivityLabels } from '@/lib/azure/mip-graph-client';
import { countFlagsOff } from '@/lib/admin/runtime-flags';
import { RUM_CLOUD_ROLE } from '@/lib/telemetry/rum-shared';
import { allGateStatuses } from '@/lib/gates/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ----------------------------------------------------------------------------
// Tile result shape
// ----------------------------------------------------------------------------

export interface TileCount {
  /** Real integer from the backend, or null when the source is absent/gated. */
  count: number | null;
  /** True when count is null because the backend env/role/resource is missing. */
  gated: boolean;
  /** Human-readable remediation (env var / role / resource) when gated. */
  hint?: string;
}

export type OverviewTileKey =
  | 'workspaces' | 'domains' | 'items' | 'auditEvents' | 'permissions'
  | 'attributeGroups' | 'labeledItems' | 'tenantSettings'
  | 'users' | 'capacity' | 'openAuditItems' | 'sensitivityLabels'
  | 'runtimeFlags' | 'rumClientErrors' | 'diagnostics' | 'finops'
  | 'icebergTables' | 'openIncidents';

export type OverviewTiles = Record<OverviewTileKey, TileCount>;

// Remediation hints — surfaced verbatim in the tile tooltip when gated.
const COSMOS_HINT =
  'Cosmos not reachable — set LOOM_COSMOS_ENDPOINT (admin-plane/main.bicep apps[] env) and grant the Console UAMI "Cosmos DB Built-in Data Contributor" at account scope.';
const USERS_HINT =
  'Set LOOM_IDENTITY_PICKER_ENABLED=true. The Console UAMI\'s Graph User.Read.All is assigned by the csa-loom-post-deploy-bootstrap "Grant Identity Picker Graph AppRoles" step — re-run that job rather than granting it by hand.';
const ARM_HINT =
  'Set LOOM_SUBSCRIPTION_ID (+ any LOOM_*_RG) and grant the Console UAMI "Monitoring Reader"/"Reader" on the Loom subscription.';
const MIP_HINT =
  'Set LOOM_MIP_ENABLED=true. The Console UAMI\'s Graph InformationProtectionPolicy.Read.All is assigned by the csa-loom-post-deploy-bootstrap "Grant MIP+DLP Graph AppRoles" step — re-run that job rather than granting it by hand (a managed-identity app-role assignment needs no admin consent).';

/**
 * Run one tile's backend fetch, converting any failure into an honest gate.
 * Prefers a NotConfiguredError's own remediation (e.g. MipNotConfiguredError
 * carries hint.followUp) over the supplied default hint.
 */
async function tile(fn: () => Promise<number>, hint: string): Promise<TileCount> {
  try {
    return { count: await fn(), gated: false };
  } catch (e: any) {
    const own = e?.hint?.followUp || (typeof e?.hint === 'string' ? e.hint : undefined);
    return { count: null, gated: true, hint: own || hint };
  }
}

// ----------------------------------------------------------------------------
// Cosmos-backed counts
//
// `countWhereTenant` is for containers PARTITIONED ON /tenantId (workspaces,
// feature-permissions, attribute-groups, label-assignments, …): it binds the
// caller's oid both as the predicate value and as the partition key, so the
// read touches exactly one physical partition and cross-tenant leakage is
// structurally impossible.
//
// It is DELIBERATELY NOT usable for the `audit-log` container, which partitions
// on /itemId — see `auditEventCount` below and lib/audit/audit-scope.ts.
// ----------------------------------------------------------------------------

async function countWhereTenant(
  container: () => Promise<import('@azure/cosmos').Container>,
  tenantId: string,
  extra = '',
  params: SqlParameter[] = [],
): Promise<number> {
  const c = await container();
  const { resources } = await c.items.query<number>({
    query: `SELECT VALUE COUNT(1) FROM c WHERE c.tenantId = @t${extra}`,
    parameters: [{ name: '@t', value: tenantId }, ...params],
  }, { partitionKey: tenantId }).fetchAll();
  return resources[0] ?? 0;
}

/**
 * Audit events in the last 30 days — the `auditEvents` tile (#2635).
 *
 * Two deviations from `countWhereTenant`, BOTH mandatory, both explained in
 * lib/audit/audit-scope.ts:
 *   1. NO `partitionKey` option. The `audit-log` container partitions on
 *      `/itemId`, so passing the caller's oid as the partition key pinned the
 *      read to the partition `itemId === <caller oid>` — a partition no audit
 *      row can ever occupy (`itemId` is the item/target). The tile was
 *      structurally guaranteed to render 0, not merely under-count.
 *   2. `oid`-OR-`tid` tenant scope, matching the `/admin/audit-logs` reader
 *      (#2608), so the ~45 writers that record `tenantScopeId(session)` are
 *      visible. This surface is tenant-admin gated (`withTenantAdmin`), so it
 *      grants no visibility the audit viewer does not already grant.
 */
async function auditEventCount(scopeIds: string[], since: string): Promise<number> {
  const c = await auditLogContainer();
  const { resources } = await c.items.query<number>({
    query: `SELECT VALUE COUNT(1) FROM c WHERE ${AUDIT_TENANT_PREDICATE} AND c.at >= @since`,
    parameters: [
      { name: '@tenants', value: scopeIds },
      { name: '@since', value: since },
    ],
  }).fetchAll();
  return resources[0] ?? 0;
}

/** Tenant-wide item count: resolve the tenant's workspaces, then count their items. */
async function itemsCount(tenantId: string): Promise<number> {
  const wsC = await workspacesContainer();
  const { resources: wss } = await wsC.items.query<{ id: string }>({
    query: 'SELECT c.id FROM c WHERE c.tenantId = @t',
    parameters: [{ name: '@t', value: tenantId }],
  }, { partitionKey: tenantId }).fetchAll();
  const wsIds = wss.map((w) => w.id);
  if (!wsIds.length) return 0;
  const itC = await itemsContainer();
  const { resources } = await itC.items.query<number>({
    query: 'SELECT VALUE COUNT(1) FROM c WHERE ARRAY_CONTAINS(@w, c.workspaceId)',
    parameters: [{ name: '@w', value: wsIds }],
  }).fetchAll();
  return resources[0] ?? 0;
}

/**
 * Domains live as an items[] array inside the tenant-settings `domains:<t>` doc.
 *
 * #3753 — keyed by the caller's raw `claims.oid` this counted a PRIVATE,
 * auto-seeded copy of the domain list rather than the tenant's authoritative one
 * (#3282 moved that document onto `tenantScopeId()`). Reads through the guarded
 * `loadTenantDomains` chokepoint so the count agrees with /admin/domains.
 */
async function domainsCount(domainScope: string): Promise<number> {
  return (await loadTenantDomains(domainScope)).length;
}

/** Enabled tenant-wide switches = count of true boolean fields in the settings doc. */
async function tenantSettingsCount(tenantId: string): Promise<number> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(tenantId, tenantId).read<{ settings?: Record<string, unknown> }>();
    const settings = resource?.settings || {};
    return Object.values(settings).filter((v) => v === true).length;
  } catch (e: any) {
    if (e?.code === 404) return 0;
    throw e;
  }
}

// ----------------------------------------------------------------------------
// Microsoft Graph — directory user count via /v1.0/users/$count
// ----------------------------------------------------------------------------

function graphCredential() {
  return uamiArmCredential();
}

/**
 * Directory user count. GET /v1.0/users/$count returns a bare integer
 * (Content-Type text/plain) and REQUIRES the `ConsistencyLevel: eventual`
 * header. Gated behind LOOM_IDENTITY_PICKER_ENABLED so a deployment without
 * the Graph User.Read.All grant shows the honest remediation instead of a 403.
 */
async function usersCount(): Promise<number> {
  if (process.env.LOOM_IDENTITY_PICKER_ENABLED !== 'true') {
    throw new Error('LOOM_IDENTITY_PICKER_ENABLED not set');
  }
  const tok = await graphCredential().getToken(getGraphScope());
  if (!tok?.token) throw new Error('Failed to acquire Microsoft Graph token');
  const url = `${getGraphHost().replace(/\/+$/, '')}/v1.0/users/$count`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${tok.token}`,
      ConsistencyLevel: 'eventual',
      accept: 'text/plain',
    },
    cache: 'no-store',
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`Graph users/$count ${res.status}: ${text.slice(0, 200)}`);
  const n = parseInt(text, 10);
  if (!Number.isFinite(n)) throw new Error('Graph $count did not return an integer');
  return n;
}

// ----------------------------------------------------------------------------
// ARM — Azure resource count + fired-alert count (Azure-native, no Fabric)
// ----------------------------------------------------------------------------

/** Count of Azure resources Loom deployed across its RGs (the /admin/capacity backend). */
async function capacityResourceCount(): Promise<number> {
  return (await listResources()).length;
}

/** Open audit items = alert instances currently in the "Fired" monitor condition (30d). */
async function openAuditItemsCount(): Promise<number> {
  const events = await listAlertHistory({ days: 30 });
  return events.filter((e) => e.monitorCondition === 'Fired').length;
}

// ----------------------------------------------------------------------------
// Microsoft Graph MIP — sensitivity-label count
// ----------------------------------------------------------------------------

async function sensitivityLabelCount(): Promise<number> {
  return (await listSensitivityLabels()).length;
}

// ----------------------------------------------------------------------------
// RUM1 — client JS errors (24 h) from the App Insights workspace tables
// ----------------------------------------------------------------------------

/** Browser-side unhandled errors in the last 24 h (AppExceptions, RUM role).
 * Throws MonitorNotConfiguredError when the LAW workspace is unset → gated tile. */
async function rumClientErrorCount(): Promise<number> {
  const r = await queryLogs(
    `AppExceptions | where AppRoleName == '${RUM_CLOUD_ROLE}' | summarize n = count()`,
    'P1D',
  );
  const i = r.columns.indexOf('n');
  const n = Number(r.rows[0]?.[i] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// ----------------------------------------------------------------------------
// DIAG1 — blocked config gates (the "issues you would bundle for support")
// ----------------------------------------------------------------------------

/** Blocked gates right now — an in-process registry pass, never network-gated. */
async function blockedGateCount(): Promise<number> {
  return allGateStatuses().filter((g) => g.status === 'blocked').length;
}

// ----------------------------------------------------------------------------
// Route
// ----------------------------------------------------------------------------

export const GET = withTenantAdmin(async (_req, { session }) => {
  const tenantId = session.claims.oid;
  // The domains document is per-TENANT and keyed by tenantScopeId() since #3282
  // — a DIFFERENT scope from `tenantId` above, which keys the oid-partitioned
  // workspaces/items containers. Threaded explicitly (and into the cache key)
  // rather than derived inside computeTiles, which has no session (#3753).
  const domainScope = tenantScopeId(session);
  // Audit-log rows are NOT partitioned on tenantId and are written under either
  // the actor's oid or the Entra tid — see lib/audit/audit-scope.ts (#2635).
  const auditScope = auditScopeIds(session.claims);

  // Cached 2 min + SWR: 12 parallel cross-partition Cosmos counts + ARM +
  // Graph reads per paint — at scale that is the Admin landing page's whole
  // budget. One cached crawl serves every admin (perf directive 2026-07-15).
  const { value: tiles } = await getOrComputeCached(
    buildScopedCacheKey('admin/overview', { tenantId, domainScope, auditScope: auditScope.join('|') }),
    'admin',
    () => computeTiles(tenantId, domainScope, auditScope),
    { ttlMs: 2 * 60_000, staleWhileRevalidate: true, budgetMs: 22_000, serveStaleOnError: true },
  );
  return NextResponse.json({ ok: true, tiles });
});

async function computeTiles(
  tenantId: string,
  domainScope: string,
  auditScope: string[],
): Promise<OverviewTiles> {
  const [
    workspaces, domains, items, auditEvents, permissions, attributeGroups,
    labeledItems, tenantSettings, users, capacity, openAuditItems, sensitivityLabels,
    runtimeFlags, rumClientErrors, diagnostics, finops, icebergTables, openIncidents,
  ] = await Promise.all([
    tile(() => countWhereTenant(workspacesContainer, tenantId), COSMOS_HINT),
    tile(() => domainsCount(domainScope), COSMOS_HINT),
    tile(() => itemsCount(tenantId), COSMOS_HINT),
    tile(() => auditEventCount(
      auditScope,
      new Date(Date.now() - 30 * 24 * 3600_000).toISOString(),
    ), COSMOS_HINT),
    tile(() => countWhereTenant(featurePermissionsContainer, tenantId), COSMOS_HINT),
    tile(() => countWhereTenant(attributeGroupsContainer, tenantId), COSMOS_HINT),
    tile(() => countWhereTenant(labelAssignmentsContainer, tenantId), COSMOS_HINT),
    tile(() => tenantSettingsCount(tenantId), COSMOS_HINT),
    tile(() => usersCount(), USERS_HINT),
    tile(() => capacityResourceCount(), ARM_HINT),
    tile(() => openAuditItemsCount(), ARM_HINT),
    tile(() => sensitivityLabelCount(), MIP_HINT),
    // FLAG0 — runtime kill-switches currently flipped OFF (surfaces reverted).
    tile(() => countFlagsOff(), COSMOS_HINT),
    // RUM1 — browser JS errors (24 h) from AppExceptions (role loom-console-browser).
    tile(() => rumClientErrorCount(),
      'Set LOOM_LOG_ANALYTICS_WORKSPACE_ID (auto-derived from the monitoring module) and grant the Console UAMI "Log Analytics Reader" on the workspace to count client-side errors.'),
    // DIAG1 — blocked config gates worth bundling for support (in-process).
    tile(() => blockedGateCount(), COSMOS_HINT),
    // C4 — enabled cost-anomaly watch rules (the FinOps hub's C3 monitor).
    tile(() => finopsRulesCount(), COSMOS_HINT),
    // N1 — tables exposed to external engines as Iceberg (Delta ✓ + Iceberg ✓).
    tile(() => icebergExposedTableCount(tenantId), COSMOS_HINT),
    // N17 — open data-observability incidents (monitor trips + N7d findings).
    tile(() => openIncidentCount(tenantId), COSMOS_HINT),
  ]);

  return {
    workspaces, domains, items, auditEvents, permissions, attributeGroups,
    labeledItems, tenantSettings, users, capacity, openAuditItems, sensitivityLabels,
    runtimeFlags, rumClientErrors, diagnostics, finops, icebergTables, openIncidents,
  };
}

/** N17 — count OPEN incidents (single-partition scan on /tenantId). */
async function openIncidentCount(tenantId: string): Promise<number> {
  const c = await incidentsContainer();
  const { resources } = await c.items
    .query<number>(
      {
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.tenantId = @t AND c.docType = 'incident' AND c.status = 'open'",
        parameters: [{ name: '@t', value: tenantId }],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();
  return Number(resources?.[0] ?? 0);
}

/** C4 — count enabled cost-anomaly watch rules (single-partition scan). */
async function finopsRulesCount(): Promise<number> {
  const c = await costAnomalyRulesContainer();
  const { resources } = await c.items
    .query<number>({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.docType = 'cost-anomaly-rule' AND (NOT IS_DEFINED(c.enabled) OR c.enabled = true)" })
    .fetchAll();
  return Number(resources?.[0] ?? 0);
}

/**
 * N1 — count the Delta tables this tenant has ALSO exposed as Apache Iceberg.
 * Single-partition read of loom-lakehouse-interop; the rows are the real state
 * the Interop tab writes, so the tile can never show a fabricated number.
 */
async function icebergExposedTableCount(tenantId: string): Promise<number> {
  const c = await lakehouseInteropContainer();
  const { resources } = await c.items
    .query<{ tables?: Array<{ iceberg?: boolean }> }>(
      {
        query: "SELECT c.tables FROM c WHERE c.tenantId = @t AND c.docType = 'lakehouse-interop'",
        parameters: [{ name: '@t', value: tenantId }],
      },
      { partitionKey: tenantId },
    )
    .fetchAll();
  let n = 0;
  for (const doc of resources || []) {
    for (const t of doc?.tables || []) if (t?.iceberg) n += 1;
  }
  return n;
}
