/**
 * ESTATE PAUSE - the Container Apps half of the pause set, resolved against the
 * stored auto-pause policy. Split out of `estate-power-handlers.ts` so the
 * handlers only compose: manifest-named resources + policy-selected Container
 * Apps, ordered consumers-first for the pause dispatch.
 */
import type { DiscoveredResource } from './pause-inventory';
import type { DiscoveryReadFailure } from './pause-discovery-classify';
import { loadAutoPause } from './estate-autopause';
import { discoverContainerApps, type ContainerAppsStatus } from './pause-container-apps';
import { orderForPause } from './pause-tier';
import { discoverByEstateTag, unionDiscovered, type TagDiscoveryResult } from './pause-tag-discovery';

export interface PauseSetExtension {
  /** Container Apps that join the pause set, to merge with the manifest-named rows. */
  discovered: DiscoveredResource[];
  /** Per-app fate + the policy applied, returned to the panel and the audit trail. */
  status: ContainerAppsStatus;
  /** Throttled listing = nothing established = the pause refuses and says retry. */
  readFailures: DiscoveryReadFailure[];
}

/** Resolve the Container Apps for `tenantId` under the stored policy. Never throws. */
export async function resolveContainerAppsForPause(
  tenantId: string,
  estateId: string,
): Promise<PauseSetExtension> {
  const setting = await loadAutoPause(tenantId);
  return discoverContainerApps({
    policy: setting.containerApps,
    settingUnreadable: setting.source === 'unreadable',
    estateId,
  });
}

/**
 * The full discovered set in PAUSE order: manifest-named rows, the policy-selected
 * Container Apps, and the estate-tagged resources (#5099), consumers before data
 * services (see `orderForPause`). The tagged rows are UNIONED in by lower-cased id
 * and never displace a manifest or Container Apps row, so nothing that was
 * discovered before can change.
 */
export function mergeForPause(
  manifestPresent: readonly DiscoveredResource[],
  ext: PauseSetExtension,
  tagged?: TagDiscoveryResult,
): DiscoveredResource[] {
  const base = [...manifestPresent, ...ext.discovered];
  return orderForPause(tagged ? unionDiscovered(base, tagged.discovered) : base);
}

/** Resolve the estate-tagged resources for `estateId` (Resource Graph). Never throws. */
export function resolveTaggedForPause(estateId: string): Promise<TagDiscoveryResult> {
  return discoverByEstateTag({ estateId });
}
