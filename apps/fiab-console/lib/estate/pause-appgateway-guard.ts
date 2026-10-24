/**
 * ESTATE PAUSE - the Application Gateway BACKEND guard (#5099 phase B).
 *
 * WHY. The Loom Application Gateway (`modules/admin-plane/app-gateway.bicep`) is
 * the public-IP path to the console for users without VPN. Stopping it would make
 * the surface that RESUMES the estate unreachable for exactly those users, so a
 * gateway whose backend pools target the console must never be stopped.
 *
 * HOW IT DECIDES. It reads the gateway's `backendAddressPools` from ARM and holds
 * the gateway out (left running) unless it can POSITIVELY establish that no pool
 * targets the console. It fails safe in every direction it cannot see:
 *
 *   - the console cannot be identified (no app name, no console URL)   -> held out
 *   - the console runs on AKS (a backend is an ingress address)         -> held out
 *   - the config read failed, or the pools are not in the response      -> held out
 *     ("could not establish"; never read as "no pools")
 *   - a pool address is an FQDN naming the console (its host, its app
 *     name, or any host containing "console")                           -> held out
 *   - a pool address is an IP with no FQDN: an IP cannot be shown not
 *     to be the console's (the shipped gateway targets the ACA environment
 *     static IP)                                                        -> held out
 *
 * One pure function (`appGatewayBackendGuard`) is used by BOTH the plan-time read
 * (`resolveGatewayHolds`) and the act-time re-check in the actuator, so the
 * preview and the mutation cannot disagree about the rule.
 */
import type { DiscoveredResource } from './pause-inventory';
import type { DiscoveryReadFailure } from './pause-discovery-classify';
import { ESTATE_READ_RETRY, isThrottleError } from './pause-throttle';

export const APP_GATEWAY_TYPE = 'microsoft.network/applicationgateways';
const APP_GATEWAY_API_VERSION = '2024-05-01';

/** The slice of an Application Gateway GET this guard reads. */
export interface GatewayBackendConfig {
  properties?: {
    backendAddressPools?: Array<{
      name?: string;
      properties?: { backendAddresses?: Array<{ fqdn?: string; ipAddress?: string }> };
    }>;
  };
}

/** The console's own identifiers, from this process's environment. */
export function consoleIdentifiers(env: NodeJS.ProcessEnv = process.env): { names: string[]; hosts: string[] } {
  const names = new Set<string>();
  for (const k of ['CONTAINER_APP_NAME', 'LOOM_CONSOLE_APP_NAME']) {
    const v = String(env[k] ?? '').trim().toLowerCase();
    if (v) names.add(v);
  }
  const hosts = new Set<string>();
  const hostOf = (raw: string): string => {
    try {
      return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase();
    } catch {
      return raw.toLowerCase();
    }
  };
  for (const k of [
    'LOOM_PUBLIC_BASE_URL',
    'LOOM_CONSOLE_BASE_URL',
    'LOOM_CONSOLE_PUBLIC_URL',
    'LOOM_CONSOLE_URL',
    'CONTAINER_APP_HOSTNAME',
  ]) {
    const v = String(env[k] ?? '').trim();
    if (v) hosts.add(hostOf(v));
  }
  return { names: [...names], hosts: [...hosts] };
}

/**
 * PURE. May this gateway be stopped, given its (already read) config?
 * `config === null` means the read did not establish a config.
 */
export function appGatewayBackendGuard(
  gateway: { name: string },
  config: GatewayBackendConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): { eligible: boolean; reason: string } {
  const hold = (why: string) => ({ eligible: false, reason: `${gateway.name} is held out: ${why} Left RUNNING.` });
  const ids = consoleIdentifiers(env);
  if (ids.names.length === 0 && ids.hosts.length === 0) {
    return hold(
      'this process could not identify the console (no CONTAINER_APP_NAME and no console URL), so it could not establish that no backend pool targets it.',
    );
  }
  const platform = String(env.LOOM_CONTAINER_PLATFORM ?? '').trim().toLowerCase();
  if (platform === 'aks' || String(env.KUBERNETES_SERVICE_HOST ?? '').trim() !== '') {
    return hold(
      'the console runs on AKS, where a gateway backend is an ingress address that cannot be matched to the console, so it could not be established that no pool targets it.',
    );
  }
  if (!config) return hold('its backend pools could not be established (the gateway config read did not succeed).');
  const pools = config.properties?.backendAddressPools;
  if (!Array.isArray(pools)) {
    return hold('its backend pools were not present in the ARM response, so they could not be established.');
  }
  for (const pool of pools) {
    const poolName = String(pool?.name ?? 'unnamed');
    for (const addr of pool?.properties?.backendAddresses ?? []) {
      const fqdn = String(addr?.fqdn ?? '').trim().toLowerCase();
      const ip = String(addr?.ipAddress ?? '').trim();
      if (fqdn) {
        const match =
          ids.hosts.includes(fqdn) || ids.names.some((n) => fqdn.includes(n)) || fqdn.includes('console');
        if (match) {
          return hold(`its backend pool '${poolName}' targets ${fqdn}, the console, and stopping the gateway would make the resume surface unreachable.`);
        }
      } else if (ip) {
        return hold(
          `its backend pool '${poolName}' targets the IP address ${ip} with no FQDN, and an IP cannot be shown not to be the console's (the shipped gateway targets the Container Apps environment IP).`,
        );
      }
    }
  }
  return { eligible: true, reason: `${gateway.name}: no backend pool targets the console.` };
}

/** Reads a gateway's config. Throws on failure. */
export type GatewayConfigReader = (resourceId: string) => Promise<GatewayBackendConfig>;

async function defaultReader(resourceId: string): Promise<GatewayBackendConfig> {
  const { armGetWithRetry } = await import('@/lib/azure/arm-client');
  return armGetWithRetry<GatewayBackendConfig>(`${resourceId}?api-version=${APP_GATEWAY_API_VERSION}`, ESTATE_READ_RETRY);
}

/** Read + judge ONE gateway. Never throws. */
export async function judgeGateway(
  gateway: { resourceId: string; name: string },
  read: GatewayConfigReader = defaultReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ eligible: boolean; reason: string; readError?: string; throttled?: boolean }> {
  let config: GatewayBackendConfig | null = null;
  try {
    config = await read(gateway.resourceId);
  } catch (e) {
    const readError = e instanceof Error ? e.message : String(e);
    const verdict = appGatewayBackendGuard(gateway, null, env);
    return {
      ...verdict,
      reason: `${verdict.reason.replace(/ Left RUNNING\.$/, '')} Raw: ${readError.slice(0, 200)} Left RUNNING.`,
      readError,
      ...(isThrottleError(e) || /throttled \(429\)|failed 429\b/.test(readError) ? { throttled: true } : {}),
    };
  }
  return appGatewayBackendGuard(gateway, config, env);
}

/**
 * Plan-time: judge every Application Gateway in the discovered set. Returns the
 * held-out ids (lower-cased) with the reason, plus a read failure for each
 * THROTTLED read so the pause refuses with "retry" rather than minting a
 * set-changed refusal over an unchanged estate (#4243).
 */
export async function resolveGatewayHolds(
  present: readonly DiscoveredResource[],
  read: GatewayConfigReader = defaultReader,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ holds: Map<string, string>; readFailures: DiscoveryReadFailure[] }> {
  const holds = new Map<string, string>();
  const readFailures: DiscoveryReadFailure[] = [];
  for (const r of present) {
    if (String(r.resourceType).toLowerCase() !== APP_GATEWAY_TYPE) continue;
    const v = await judgeGateway(r, read, env);
    if (v.eligible) continue;
    holds.set(r.resourceId.toLowerCase(), v.reason);
    if (v.throttled) {
      readFailures.push({
        resourceId: r.resourceId,
        name: r.name,
        error: v.readError ?? v.reason,
        kind: 'throttled',
        throttled: true,
      });
    }
  }
  return { holds, readFailures };
}
