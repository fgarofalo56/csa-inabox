/**
 * GET /api/admin/overview — live counts for the 12 admin-landing tiles.
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
 * Auth: getSession() → 401. Tenant isolation: every Cosmos query binds the
 * caller's oid (s.claims.oid) as the tenant partition key — cross-tenant
 * leakage is structurally impossible.
 */
import { NextResponse } from 'next/server';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import { getSession } from '@/lib/auth/session';
import {
  workspacesContainer,
  itemsContainer,
  tenantSettingsContainer,
  auditLogContainer,
  featurePermissionsContainer,
  attributeGroupsContainer,
  labelAssignmentsContainer,
} from '@/lib/azure/cosmos-client';
import type { SqlParameter } from '@azure/cosmos';
import { getGraphHost, getGraphScope } from '@/lib/azure/cloud-endpoints';
import { listResources, listAlertHistory } from '@/lib/azure/monitor-client';
import { listSensitivityLabels } from '@/lib/azure/mip-graph-client';

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
  | 'users' | 'capacity' | 'openAuditItems' | 'sensitivityLabels';

export type OverviewTiles = Record<OverviewTileKey, TileCount>;

// Remediation hints — surfaced verbatim in the tile tooltip when gated.
const COSMOS_HINT =
  'Cosmos not reachable — set LOOM_COSMOS_ENDPOINT (admin-plane/main.bicep apps[] env) and grant the Console UAMI "Cosmos DB Built-in Data Contributor" at account scope.';
const USERS_HINT =
  'Set LOOM_IDENTITY_PICKER_ENABLED=true and grant the Console UAMI Graph User.Read.All (run scripts/csa-loom/grant-identity-graph-approles.sh, then admin-consent).';
const ARM_HINT =
  'Set LOOM_SUBSCRIPTION_ID (+ any LOOM_*_RG) and grant the Console UAMI "Monitoring Reader"/"Reader" on the Loom subscription.';
const MIP_HINT =
  'Set LOOM_MIP_ENABLED=true and grant the Console UAMI Graph InformationProtectionPolicy.Read.All (run scripts/csa-loom/grant-graph-approles.sh, then admin-consent).';

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
// Cosmos-backed counts (all tenant-isolated on /tenantId = caller oid)
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

/** Domains live as an items[] array inside the tenant-settings `domains:<t>` doc. */
async function domainsCount(tenantId: string): Promise<number> {
  const c = await tenantSettingsContainer();
  try {
    const { resource } = await c.item(`domains:${tenantId}`, tenantId).read<{ items?: unknown[] }>();
    return (resource?.items || []).length;
  } catch (e: any) {
    if (e?.code === 404) return 0; // not seeded yet — a real zero, not a gate
    throw e;
  }
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
// Route
// ----------------------------------------------------------------------------

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;

  const [
    workspaces, domains, items, auditEvents, permissions, attributeGroups,
    labeledItems, tenantSettings, users, capacity, openAuditItems, sensitivityLabels,
  ] = await Promise.all([
    tile(() => countWhereTenant(workspacesContainer, tenantId), COSMOS_HINT),
    tile(() => domainsCount(tenantId), COSMOS_HINT),
    tile(() => itemsCount(tenantId), COSMOS_HINT),
    tile(() => countWhereTenant(
      auditLogContainer, tenantId,
      ' AND c.at >= @since',
      [{ name: '@since', value: new Date(Date.now() - 30 * 24 * 3600_000).toISOString() }],
    ), COSMOS_HINT),
    tile(() => countWhereTenant(featurePermissionsContainer, tenantId), COSMOS_HINT),
    tile(() => countWhereTenant(attributeGroupsContainer, tenantId), COSMOS_HINT),
    tile(() => countWhereTenant(labelAssignmentsContainer, tenantId), COSMOS_HINT),
    tile(() => tenantSettingsCount(tenantId), COSMOS_HINT),
    tile(() => usersCount(), USERS_HINT),
    tile(() => capacityResourceCount(), ARM_HINT),
    tile(() => openAuditItemsCount(), ARM_HINT),
    tile(() => sensitivityLabelCount(), MIP_HINT),
  ]);

  const tiles: OverviewTiles = {
    workspaces, domains, items, auditEvents, permissions, attributeGroups,
    labeledItems, tenantSettings, users, capacity, openAuditItems, sensitivityLabels,
  };
  return NextResponse.json({ ok: true, tiles });
}
