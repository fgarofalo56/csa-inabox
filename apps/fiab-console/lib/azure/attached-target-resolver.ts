/**
 * attached-target-resolver — registry-first backend resolution (§2.5).
 *
 * Item / navigator backends resolve their coordinates from env today
 * (LOOM_SYNAPSE_WORKSPACE, LOOM_KUSTO_CLUSTER_URI, the ADLS account env) with an
 * Azure-native default (no-fabric-dependency.md). This module lets a caller that
 * HAS a session consult the Landing-Zone Service Registry FIRST: when an existing
 * service of the right kind is attached (day-0 BYO or day-2 attach), its
 * `armResourceId` supplies the coordinates; otherwise the caller keeps its env
 * default. Additive + safe — when the registry is empty every resolver returns
 * null and behaviour is unchanged.
 *
 * The resolvers take a `tenantId` (the registry PK) so they are usable from any
 * BFF route that has a session; the data-plane clients expose thin async
 * variants that thread this through.
 */
import { resolveAttachedService } from './attached-services-store';
import { kustoClusterUri } from './cloud-endpoints';

/** Resolved Synapse workspace name (bare, no suffix) attached to a landing zone. */
export async function resolveSynapseWorkspaceName(
  tenantId: string,
  landingZoneId?: string,
): Promise<string | null> {
  try {
    const svc = await resolveAttachedService(tenantId, 'synapse', landingZoneId);
    if (!svc) return null;
    // The Synapse workspace name is the resource name = last ARM id segment.
    return armName(svc.armResourceId) || svc.displayName || null;
  } catch {
    return null;
  }
}

/**
 * Resolved ADX cluster URI for an attached ADX/Kusto service. The cluster URI is
 * derived from the cluster name + region via the sovereign-cloud-correct
 * `cloud-endpoints.kustoClusterUri()`. The region comes from the registry doc's
 * `location` (captured at attach); without it we cannot build a correct URI, so
 * we return null and the caller keeps its env default (safe + additive).
 */
export async function resolveAdxClusterUri(
  tenantId: string,
  landingZoneId?: string,
): Promise<string | null> {
  try {
    const svc = await resolveAttachedService(tenantId, 'adx', landingZoneId);
    if (!svc) return null;
    const name = armName(svc.armResourceId) || svc.displayName;
    const region = (svc.location || '').replace(/\s+/g, '').toLowerCase();
    if (!name || !region) return null;
    return kustoClusterUri(name, region);
  } catch {
    return null;
  }
}

/** Resolved ADLS / storage account name attached to a landing zone. */
export async function resolveAdlsAccountName(
  tenantId: string,
  landingZoneId?: string,
): Promise<string | null> {
  try {
    const svc = await resolveAttachedService(tenantId, 'storage-adls', landingZoneId);
    if (!svc) return null;
    return armName(svc.armResourceId) || svc.displayName || null;
  } catch {
    return null;
  }
}

/** Last segment (resource name) of an ARM resource id. */
function armName(id: string): string {
  const parts = (id || '').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}
