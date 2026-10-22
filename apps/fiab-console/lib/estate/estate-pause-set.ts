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
 * The full discovered set in PAUSE order: manifest-named rows plus the policy-
 * selected Container Apps, consumers before data services (see `orderForPause`).
 */
export function mergeForPause(
  manifestPresent: readonly DiscoveredResource[],
  ext: PauseSetExtension,
): DiscoveredResource[] {
  return orderForPause([...manifestPresent, ...ext.discovered]);
}
