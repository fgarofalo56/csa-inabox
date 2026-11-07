/**
 * ESTATE PAUSE - Container Apps discovery (operator decision 2026-10-22).
 *
 * WHY THIS MODULE EXISTS. The pause set was built ONLY from the deploy-emitted
 * manifest (`resolveDeployManifest`), which names exactly four things: the
 * Synapse dedicated pool, the ADX cluster, the AAS server and the SHIR scale set.
 * Container Apps were in the pause TIER (`ESTATE_PAUSE_TIER`) but no env var
 * names one, so nothing ever fed them to the planner: the idle auto-pause lane
 * could fire and still leave all ~29 apps, 13 of them at minReplicas >= 1,
 * billing. This module closes that gap by listing the Container Apps in the ONE
 * resource group the console already administers (`LOOM_ACA_RG`, else
 * `LOOM_ADMIN_RG`) and deciding, PER APP, whether it joins the pause set.
 *
 * OWNERSHIP IS STILL PER RESOURCE: an app joins only through the `loom-estate-id`
 * tag (the strongest signal in `resolveOwnership`); the resource-group name is
 * never an ownership signal, so a foreign app that shares the group is left alone.
 *
 * FAIL SAFE: anything this module cannot establish keeps the app RUNNING - an
 * unreadable setting, an unreadable scale range, an app with no estate tag, a
 * failed listing. Each is reported in `status`, never silently dropped.
 *
 * Pure classification (`classifyContainerApps`) is split from the ARM listing
 * (`listContainerApps`) so every branch is testable without a network.
 */
import type { EstateContainerAppsPolicy } from './estate-power-contract';
import { containerAppPauseGuard } from './pause-guards';
import { LOOM_ESTATE_TAG_KEY, type DiscoveredResource } from './pause-inventory';
import { classifyTagReadFailure, type DiscoveryReadFailure } from './pause-discovery-classify';

/** The subset of an ARM Container App list item this module reads. */
export interface ArmContainerApp {
  id?: string;
  name?: string;
  location?: string;
  tags?: Record<string, string> | null;
  properties?: { template?: { scale?: { minReplicas?: number; maxReplicas?: number } } };
}

export type ContainerAppRowState =
  /** In the pause set. */
  | 'will-pause'
  /** Held out by the console guard / never-pause list (reason names which). */
  | 'held-out'
  /** The operator exempted this app (per-app opt-out). */
  | 'exempt'
  /** Already scales to zero: nothing to save, nothing to restore. */
  | 'already-zero'
  /** No `loom-estate-id` tag naming this estate: ownership not established. */
  | 'not-owned'
  /** The list did not report a usable minReplicas: cannot be restored exactly. */
  | 'scale-unknown'
  /** The global Container Apps opt-out is on. */
  | 'opted-out'
  /** The auto-pause setting could not be read, so no opt-out can be honoured. */
  | 'setting-unreadable';

export interface ContainerAppRow {
  name: string;
  resourceId: string;
  state: ContainerAppRowState;
  reason: string;
  minReplicas?: number;
  maxReplicas?: number;
}

export interface ContainerAppsStatus {
  /** The policy that was applied (defaults when the setting is unreadable). */
  policy: EstateContainerAppsPolicy;
  /** False when the platform has no Container Apps here (AKS) or sub/RG are unknown. */
  configured: boolean;
  resourceGroup?: string;
  /** Why not configured, or why the listing failed - the truthful sentence. */
  note?: string;
  /** Set when the listing FAILED (distinct from an empty list). */
  listError?: string;
  listed: number;
  willPause: number;
  apps: ContainerAppRow[];
}

const emptyStatus = (policy: EstateContainerAppsPolicy, extra: Partial<ContainerAppsStatus>): ContainerAppsStatus => ({
  policy,
  configured: false,
  listed: 0,
  willPause: 0,
  apps: [],
  ...extra,
});

/**
 * PURE. Decide each listed app's fate. `discovered` holds ONLY the apps that join
 * the pause set; every other app is in `rows` with the reason it was left running.
 */
export function classifyContainerApps(args: {
  apps: readonly ArmContainerApp[];
  policy: EstateContainerAppsPolicy;
  /** True when the stored setting could not be read: no opt-out can be honoured. */
  settingUnreadable: boolean;
  estateId: string;
  subscriptionId: string;
  resourceGroup: string;
  selfAppName: string | undefined;
}): { discovered: DiscoveredResource[]; rows: ContainerAppRow[] } {
  const exempt = new Set(args.policy.exempt.map((n) => n.toLowerCase()));
  const discovered: DiscoveredResource[] = [];
  const rows: ContainerAppRow[] = [];

  for (const app of args.apps) {
    const name = String(app.name ?? '').trim();
    const resourceId = String(app.id ?? '').trim();
    if (!name || !resourceId) continue; // an item with no identity cannot be addressed at all
    const min = app.properties?.template?.scale?.minReplicas;
    const max = app.properties?.template?.scale?.maxReplicas;
    const base = {
      name,
      resourceId,
      ...(typeof min === 'number' ? { minReplicas: min } : {}),
      ...(typeof max === 'number' ? { maxReplicas: max } : {}),
    };
    const row = (state: ContainerAppRowState, reason: string) => rows.push({ ...base, state, reason });

    if (args.settingUnreadable) {
      row('setting-unreadable', `${name} is left RUNNING: the auto-pause setting could not be read, so Loom cannot tell whether this app was exempted.`);
      continue;
    }
    if (!args.policy.enabled) {
      row('opted-out', `${name} is left RUNNING: Container Apps are opted out of pause (global switch off).`);
      continue;
    }
    // The console guard (console identity, never-pause list, exempt/resume-surface
    // tags) is evaluated FIRST and on the real tags, so a held-out app can never be
    // reported as "will pause" by any later branch.
    const guard = containerAppPauseGuard({ name, tags: app.tags ?? null }, args.selfAppName);
    if (!guard.eligible) {
      row('held-out', guard.reason);
      continue;
    }
    if (exempt.has(name.toLowerCase())) {
      row('exempt', `${name} is left RUNNING: exempted from auto-pause by the operator.`);
      continue;
    }
    const estateTag = Object.entries(app.tags ?? {}).find(([k]) => k.toLowerCase() === LOOM_ESTATE_TAG_KEY)?.[1];
    if (estateTag !== args.estateId) {
      row(
        'not-owned',
        estateTag
          ? `${name} carries ${LOOM_ESTATE_TAG_KEY}='${estateTag}', a different estate from '${args.estateId}'. Left RUNNING.`
          : `${name} carries no ${LOOM_ESTATE_TAG_KEY} tag, so it cannot be established that it belongs to estate '${args.estateId}'. Left RUNNING.`,
      );
      continue;
    }
    if (typeof min !== 'number' || typeof max !== 'number') {
      row('scale-unknown', `${name} did not report both minReplicas and maxReplicas, so its range could not be restored exactly. Left RUNNING.`);
      continue;
    }
    if (min === 0) {
      row('already-zero', `${name} already scales to zero (minReplicas 0); pausing it would save nothing.`);
      continue;
    }
    row('will-pause', `${name} runs minReplicas ${min}/${max}; it is scaled to 0 on pause and restored to exactly ${min}/${max} on resume.`);
    discovered.push({
      resourceId,
      resourceType: 'microsoft.app/containerapps',
      name,
      resourceGroup: args.resourceGroup,
      subscriptionId: args.subscriptionId,
      ...(app.location ? { location: app.location } : {}),
      tags: app.tags ?? {},
      discoverySource: 'arm-rg-list',
    });
  }
  return { discovered, rows };
}

/** The ARM list, paged. Throws on any failure (the caller classifies it). */
export async function listContainerApps(subscriptionId: string, resourceGroup: string): Promise<ArmContainerApp[]> {
  const { armGetWithRetry } = await import('@/lib/azure/arm-client');
  const out: ArmContainerApp[] = [];
  let path: string | undefined =
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps?api-version=2024-03-01`;
  for (let page = 0; path && page < 20; page++) {
    const body: { value?: ArmContainerApp[]; nextLink?: string } = await armGetWithRetry(path);
    out.push(...(body.value ?? []));
    path = body.nextLink || undefined;
  }
  if (path) throw new Error('Container Apps list did not finish within 20 pages; refusing a partial list.');
  return out;
}

/**
 * Discover the Container Apps that join the pause set. Never throws.
 *
 * A THROTTLED list becomes a `DiscoveryReadFailure`, which the existing
 * reads-failed gate turns into a "retry" refusal (nothing established). Any other
 * failure leaves the apps out and says so in `status.listError` - it must not
 * block the pause of the data services, which do not depend on this list.
 */
export async function discoverContainerApps(args: {
  policy: EstateContainerAppsPolicy;
  settingUnreadable: boolean;
  estateId: string;
  env?: NodeJS.ProcessEnv;
  list?: (subscriptionId: string, resourceGroup: string) => Promise<ArmContainerApp[]>;
}): Promise<{ discovered: DiscoveredResource[]; status: ContainerAppsStatus; readFailures: DiscoveryReadFailure[] }> {
  const env = args.env ?? process.env;
  const v = (k: string) => (env[k] || '').trim();
  const none = (extra: Partial<ContainerAppsStatus>) => ({
    discovered: [] as DiscoveredResource[],
    status: emptyStatus(args.policy, extra),
    readFailures: [] as DiscoveryReadFailure[],
  });

  if (v('LOOM_CONTAINER_PLATFORM').toLowerCase() === 'aks') {
    return none({ note: 'This deployment runs its containers on AKS (LOOM_CONTAINER_PLATFORM=aks), not Azure Container Apps, so there are no Container Apps to pause here.' });
  }
  const subscriptionId = v('LOOM_SUBSCRIPTION_ID');
  const resourceGroup = v('LOOM_ACA_RG') || v('LOOM_ADMIN_RG');
  if (!subscriptionId || !resourceGroup) {
    return none({ note: 'The console does not know its Container Apps resource group (LOOM_SUBSCRIPTION_ID / LOOM_ACA_RG or LOOM_ADMIN_RG unset), so no Container App can be listed.' });
  }
  // Global opt-out and an unreadable setting both mean "touch nothing": skip the
  // ARM call entirely, but still LIST so the panel can show each app and why it
  // is held. A failed list in those states is reported, never blocking.
  const list = args.list ?? listContainerApps;
  let apps: ArmContainerApp[];
  try {
    apps = await list(subscriptionId, resourceGroup);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const kind = classifyTagReadFailure(error);
    const status = emptyStatus(args.policy, {
      configured: true,
      resourceGroup,
      listError: error.slice(0, 300),
      note: kind === 'throttled'
        ? 'Azure rate-limited the Container Apps listing; no Container App is in this preview. Retry.'
        : 'The Container Apps in the resource group could not be listed, so none is in this preview. Nothing about them was established.',
    });
    const blocking = kind === 'throttled' && args.policy.enabled && !args.settingUnreadable;
    return {
      discovered: [],
      status,
      readFailures: blocking
        ? [{
            resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps`,
            name: `Container Apps in ${resourceGroup}`,
            error,
            kind: 'throttled',
            throttled: true,
          }]
        : [],
    };
  }

  const { discovered, rows } = classifyContainerApps({
    apps,
    policy: args.policy,
    settingUnreadable: args.settingUnreadable,
    estateId: args.estateId,
    subscriptionId,
    resourceGroup,
    selfAppName: env.CONTAINER_APP_NAME,
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    discovered,
    status: {
      policy: args.policy,
      configured: true,
      resourceGroup,
      listed: rows.length,
      willPause: discovered.length,
      apps: rows,
    },
    readFailures: [],
  };
}
