/**
 * Tenant topology (audit-t157) — the deployed hub's coordinates.
 *
 * The tenant (first-run) deploy's post-bootstrap upserts ONE doc per tenant
 * (id='tenant-topology', PK /tenantId) into the Cosmos `loom` DB holding the
 * hub's Azure-native coordinates (VNet / LAW / DNS zones / ADX / catalog +
 * Console & Activator UAMI ids). The Setup Wizard "Add landing zone" flow and
 * the orchestrator's dlz-attach path read it so hub coordinates are NEVER
 * free-typed (loom-no-freeform-config) — they are Azure resource ids, no Fabric
 * handles (no-fabric-dependency).
 *
 * `tenantTopologyExists()` is the first-run discriminator: when it returns
 * false the Setup Wizard is in first-run (topology='tenant') mode; once a hub
 * exists it is true and only dlz-attach is allowed.
 */
import { tenantTopologyContainer } from '@/lib/azure/cosmos-client';

/** Hub coordinates persisted at tenant-deploy time. All Azure-native ids. */
export interface TenantTopology {
  id: string; // always 'tenant-topology'
  tenantId: string;
  hubSubscriptionId?: string;
  location?: string;
  boundary?: string;
  hubVnetId?: string;
  hubLawId?: string;
  hubAppInsightsConnectionString?: string;
  hubPrivateDnsZoneIds?: Record<string, string>;
  hubAdxClusterRgName?: string;
  hubAdxClusterPrincipalId?: string;
  hubCatalogEndpoint?: string;
  hubAiServicesAccountName?: string;
  hubConsolePrincipalId?: string;
  hubConsoleUamiName?: string;
  hubConsoleUamiAppId?: string;
  hubConsoleUamiId?: string;
  hubActivatorPrincipalId?: string;
  updatedAt?: string;
  /**
   * Where these coordinates came from. `cosmos` = the post-deploy bootstrap
   * upsert (full coordinates). `console-env` = synthesised from the running
   * Console's own wired environment when the bootstrap doc is absent — proves
   * the hub exists (the Console is running IN it) so the Setup Wizard does not
   * falsely report "no hub", even though only the env-available subset of
   * coordinates is populated.
   */
  source?: 'cosmos' | 'console-env';
}

/** The single doc id every tenant-topology row uses (one hub per tenant). */
export const TENANT_TOPOLOGY_DOC_ID = 'tenant-topology';

/**
 * Partition value for the tenant-topology doc. Unlike the user-scoped tenant
 * containers (which use `session.claims.oid`), the topology doc is written by
 * the post-deploy bootstrap script which has NO user session — so it is keyed
 * by the Entra tenant id (stable + available to both the bootstrap and the
 * Console runtime). One hub per Entra tenant.
 */
export function resolveTenantPartition(): string {
  return (process.env.LOOM_TENANT_ID || process.env.AZURE_TENANT_ID || '').trim();
}

/** The hub-coordinate keys forwarded to the orchestrator / main.bicep hub* params. */
export const HUB_COORDINATE_KEYS = [
  'hubVnetId',
  'hubLawId',
  'hubAppInsightsConnectionString',
  'hubPrivateDnsZoneIds',
  'hubAdxClusterRgName',
  'hubAdxClusterPrincipalId',
  'hubCatalogEndpoint',
  'hubAiServicesAccountName',
  'hubConsolePrincipalId',
  'hubConsoleUamiName',
  'hubConsoleUamiAppId',
  'hubConsoleUamiId',
  'hubActivatorPrincipalId',
] as const;

/**
 * Read the tenant-topology doc for the given tenant. Returns null when no hub
 * has been deployed yet (first-run) or when Cosmos is unreachable — callers
 * MUST distinguish "no hub" (first-run) from an infra error via {@link getTenantTopologySafe}.
 */
export async function getTenantTopology(tenantId?: string): Promise<TenantTopology | null> {
  const pk = (tenantId || resolveTenantPartition()).trim();
  if (!pk) return null;
  const container = await tenantTopologyContainer();
  try {
    const { resource } = await container
      .item(TENANT_TOPOLOGY_DOC_ID, pk)
      .read<TenantTopology>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

/** Result of a tenant-topology read that never throws — distinguishes states. */
export interface TenantTopologyState {
  /** true when a hub exists (subsequent runs → dlz-attach only). */
  exists: boolean;
  topology: TenantTopology | null;
  /** Set when Cosmos could not be reached — neither first-run nor a real hub. */
  error?: string;
}

/**
 * Synthesise hub coordinates from the RUNNING Console's own wired environment.
 *
 * The admin-plane bicep wires the Console app with its hub coordinates
 * (LOOM_SUBSCRIPTION_ID + LOOM_ADMIN_RG at minimum — the Console literally runs
 * inside the admin/hub RG). When BOTH are present the hub demonstrably exists,
 * regardless of whether the post-deploy bootstrap upserted the tenant-topology
 * Cosmos doc. This is the fix for the Setup Wizard falsely reporting
 * "No hub is deployed yet" on a live, running console: a missing Cosmos doc is
 * NOT proof of a missing hub.
 *
 * Returns null only when the Console is genuinely not wired to a hub (no
 * subscription/admin-RG env) — i.e. a true first-run install target.
 */
export function deriveTopologyFromConsoleEnv(): TenantTopology | null {
  const sub = (process.env.LOOM_SUBSCRIPTION_ID || '').trim();
  const adminRg = (process.env.LOOM_ADMIN_RG || '').trim();
  // Both are required to assert "the Console is running in a deployed hub".
  if (!sub || !adminRg) return null;
  const lawResourceId = (process.env.LOOM_LOG_ANALYTICS_RESOURCE_ID || '').trim();
  const region = (process.env.LOOM_LOCATION || process.env.LOOM_REGION || '').trim();
  const boundary = (process.env.LOOM_CLOUD_BOUNDARY || process.env.LOOM_CLOUD || '').trim();
  const appInsights = (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || '').trim();
  return {
    id: TENANT_TOPOLOGY_DOC_ID,
    tenantId: resolveTenantPartition(),
    hubSubscriptionId: sub,
    hubAdxClusterRgName: adminRg, // best-available admin-RG handle for display
    ...(region ? { location: region } : {}),
    ...(boundary ? { boundary } : {}),
    ...(lawResourceId ? { hubLawId: lawResourceId } : {}),
    ...(appInsights ? { hubAppInsightsConnectionString: appInsights } : {}),
    source: 'console-env',
  };
}

/** Read the topology doc, mapping a missing doc to {exists:false} and infra
 * failures to {error}. Never throws — the wizard needs all three outcomes.
 *
 * When the Cosmos doc is absent (or Cosmos is unreachable) we fall back to the
 * Console's own wired hub coordinates ({@link deriveTopologyFromConsoleEnv}):
 * a running Console proves its hub exists, so the wizard must not report
 * first-run. Only when NEITHER the doc nor the env coordinates are present do we
 * report exists:false (a genuine first-run install target). */
export async function getTenantTopologySafe(tenantId?: string): Promise<TenantTopologyState> {
  try {
    const topology = await getTenantTopology(tenantId);
    if (topology) return { exists: true, topology: { ...topology, source: topology.source ?? 'cosmos' } };
    // No Cosmos doc — but the running Console may itself be the hub.
    const envTopology = deriveTopologyFromConsoleEnv();
    if (envTopology) return { exists: true, topology: envTopology };
    return { exists: false, topology: null };
  } catch (e: any) {
    // Cosmos unreachable. If the Console is wired to a hub, the hub still
    // exists — report it (env-derived) rather than blocking the wizard on a
    // transient Cosmos read error.
    const envTopology = deriveTopologyFromConsoleEnv();
    if (envTopology) return { exists: true, topology: envTopology };
    return { exists: false, topology: null, error: e?.message ?? String(e) };
  }
}
