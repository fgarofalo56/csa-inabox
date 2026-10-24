/**
 * #5099 phase B - the Application Gateway BACKEND guard. A gateway that fronts the
 * console must never be stopped (resume would be unreachable for non-VPN users),
 * and anything the guard cannot establish is held out. Each case names the input
 * that would break it (assertion-design.md).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  APP_GATEWAY_TYPE,
  appGatewayBackendGuard,
  consoleIdentifiers,
  judgeGateway,
  resolveGatewayHolds,
  type GatewayBackendConfig,
} from '../pause-appgateway-guard';
import { appGatewayTagGuard } from '../pause-guards';
import { planPause } from '../pause-orchestrator';
import { orderForPause, orderForResume } from '../pause-tier';
import type { DiscoveredResource } from '../pause-inventory';

const ENV = {
  CONTAINER_APP_NAME: 'loom-console',
  LOOM_PUBLIC_BASE_URL: 'https://loom.contoso.example/',
} as unknown as NodeJS.ProcessEnv;

const cfg = (...pools: Array<{ name: string; addrs: Array<{ fqdn?: string; ipAddress?: string }> }>): GatewayBackendConfig => ({
  properties: {
    backendAddressPools: pools.map((p) => ({ name: p.name, properties: { backendAddresses: p.addrs } })),
  },
});
const gw = { name: 'agw-x' };
const verdict = (c: GatewayBackendConfig | null, env = ENV) => appGatewayBackendGuard(gw, c, env);

describe('appGatewayBackendGuard', () => {
  // Breaks if: a pool whose FQDN embeds the console app name is not recognised.
  it('a pool targeting the console by APP NAME in its FQDN is held out, naming the pool and address', () => {
    const v = verdict(cfg({ name: 'console-backend', addrs: [{ fqdn: 'loom-console.internal.env.azurecontainerapps.io' }] }));
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain("pool 'console-backend'");
    expect(v.reason).toContain('loom-console.internal.env.azurecontainerapps.io');
  });

  // Breaks if: the console's PUBLIC host (from the console URL env) is not matched - it contains neither "console" nor the app name.
  it('a pool targeting the console by its configured public HOST is held out', () => {
    const v = verdict(cfg({ name: 'p', addrs: [{ fqdn: 'loom.contoso.example' }] }));
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('loom.contoso.example');
  });

  // Breaks if: any host containing "console" is not held out (a differently named console revision).
  it('a host named like a console is held out even when the app name differs', () => {
    expect(verdict(cfg({ name: 'p', addrs: [{ fqdn: 'ca-loom-console-eu.example.net' }] })).eligible).toBe(false);
  });

  // Breaks if: the guard holds out EVERYTHING (the positive path must exist, or the hold-out tests prove nothing).
  it('a gateway whose pools target unrelated FQDNs is eligible', () => {
    const v = verdict(cfg({ name: 'shop', addrs: [{ fqdn: 'shop.contoso.example' }] }, { name: 'api', addrs: [{ fqdn: 'api.contoso.example' }] }));
    expect(v.eligible).toBe(true);
  });

  // Breaks if: an empty pool list is conflated with a missing one in either direction.
  it('an EMPTY pool array is eligible, but a MISSING pool property is held out', () => {
    expect(verdict({ properties: { backendAddressPools: [] } }).eligible).toBe(true);
    const v = verdict({ properties: {} });
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('not present in the ARM response');
  });

  // Breaks if: an IP-only pool (the shipped gateway targets the ACA environment IP) is read as "not the console".
  it('an IP-only backend cannot be shown not to be the console and is held out', () => {
    const v = verdict(cfg({ name: 'console-backend', addrs: [{ ipAddress: '10.0.4.20' }] }));
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('10.0.4.20');
  });

  // Breaks if: a failed config read is treated as "no pools".
  it('a null config (read failed) is held out as "could not be established"', () => {
    const v = verdict(null);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('could not be established');
  });

  // Breaks if: with no console identity the guard can still say eligible (it has nothing to compare against).
  it('an unidentifiable console holds EVERY gateway out, even a clean one', () => {
    const v = verdict(cfg({ name: 'shop', addrs: [{ fqdn: 'shop.contoso.example' }] }), {} as NodeJS.ProcessEnv);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('could not identify the console');
  });

  // Breaks if: on containerPlatform=aks a gateway (whose backend is an ingress address) is judged by FQDN alone.
  it('on AKS the gateway is held out', () => {
    const v = verdict(cfg({ name: 'shop', addrs: [{ fqdn: 'shop.contoso.example' }] }), { ...ENV, LOOM_CONTAINER_PLATFORM: 'aks' } as NodeJS.ProcessEnv);
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain('AKS');
  });

  // Breaks if: the console URL host extraction fails for a bare host or a URL with a path.
  it('consoleIdentifiers lifts app names and hosts from the environment', () => {
    const ids = consoleIdentifiers({
      CONTAINER_APP_NAME: 'Loom-Console',
      LOOM_CONSOLE_URL: 'https://x.example/path?q=1',
      LOOM_PUBLIC_BASE_URL: 'bare.example',
    } as unknown as NodeJS.ProcessEnv);
    expect(ids.names).toEqual(['loom-console']);
    expect(ids.hosts.sort()).toEqual(['bare.example', 'x.example']);
  });
});

describe('judgeGateway / resolveGatewayHolds', () => {
  const rid = (n: string) => `/subscriptions/s/resourceGroups/r/providers/Microsoft.Network/applicationGateways/${n}`;
  const dr = (type: string, name: string): DiscoveredResource => ({
    resourceId: type === 'gw' ? rid(name) : `/subscriptions/s/resourceGroups/r/providers/Microsoft.Compute/virtualMachines/${name}`,
    resourceType: type === 'gw' ? APP_GATEWAY_TYPE : 'microsoft.compute/virtualmachines',
    name, resourceGroup: 'r', subscriptionId: 's', tags: {}, discoverySource: 'resource-graph',
  });

  // Breaks if: a thrown read becomes eligible, or loses its raw error (R7: say what happened).
  it('an unreadable config is held out with the raw error, flagged throttled only on a 429', async () => {
    const boom = await judgeGateway({ resourceId: rid('a'), name: 'a' }, async () => { throw new Error('ARM GET failed 403: nope'); }, ENV);
    expect(boom.eligible).toBe(false);
    expect(boom.reason).toContain('could not be established');
    expect(boom.reason).toContain('failed 403');
    expect(boom.throttled).toBeUndefined();
    const hot = await judgeGateway({ resourceId: rid('a'), name: 'a' }, async () => { throw new Error('ARM GET x was throttled (429) twice'); }, ENV);
    expect(hot.throttled).toBe(true);
  });

  // Breaks if: the reader is called for non-gateways (extra network edges in every estate), or a hold is lost.
  it('reads ONLY gateways; holds the console-facing one; a throttled read becomes a read failure', async () => {
    const read = vi.fn(async (id: string) =>
      id.endsWith('/front')
        ? cfg({ name: 'p', addrs: [{ fqdn: 'loom-console.x.io' }] })
        : id.endsWith('/hot') ? Promise.reject(new Error('was throttled (429)')) : cfg({ name: 'p', addrs: [{ fqdn: 'shop.example' }] }),
    );
    const out = await resolveGatewayHolds([dr('gw', 'front'), dr('gw', 'clean'), dr('gw', 'hot'), dr('vm', 'vm1')], read, ENV);
    expect(read).toHaveBeenCalledTimes(3); // 3 gateways, NOT the VM
    expect([...out.holds.keys()].sort()).toEqual([rid('front').toLowerCase(), rid('hot').toLowerCase()].sort());
    expect(out.holds.has(rid('clean').toLowerCase())).toBe(false);
    expect(out.readFailures.map((f) => f.name)).toEqual(['hot']); // only the throttled one
  });
});

describe('planPause with gateway holds + tag guard + rank', () => {
  const SCOPE = { kind: 'explicit-inventory' as const, estateId: 'loom:e' };
  const g = (name: string, tags: Record<string, string> = { 'loom-estate-id': 'loom:e' }): DiscoveredResource => ({
    resourceId: `/subscriptions/s/resourceGroups/r/providers/Microsoft.Network/applicationGateways/${name}`,
    resourceType: APP_GATEWAY_TYPE, name, resourceGroup: 'r', subscriptionId: 's', tags, discoverySource: 'deploy-manifest',
  });

  // Breaks if: planPause ignores `holds`, so a gateway fronting the console stays in wouldPause.
  it('a held gateway is out of the pause set and listed with its reason; an unheld one is in', () => {
    const set = [g('front'), g('clean')];
    const holds = new Map([[set[0].resourceId.toLowerCase(), 'agw front targets the console. Left RUNNING.']]);
    const plan = planPause(set, { scope: SCOPE, selfAppName: 'loom-console', holds });
    expect(plan.dryRun.wouldPause.map((r) => r.name)).toEqual(['clean']);
    expect(plan.outOfTier.map((o) => [o.name, o.reason])).toEqual([['front', 'agw front targets the console. Left RUNNING.']]);
  });

  // Breaks if: the exempt stamp (what bicep adds to the console gateway) stops holding a gateway out.
  it('loom-estate-pause=exempt holds a gateway out; unreadable tags do too', () => {
    expect(appGatewayTagGuard({ name: 'a', tags: { 'loom-estate-pause': 'exempt' } }).eligible).toBe(false);
    expect(appGatewayTagGuard({ name: 'a', tags: null }).eligible).toBe(false);
    expect(appGatewayTagGuard({ name: 'a', tags: {} }).eligible).toBe(true);
    const plan = planPause([g('x', { 'loom-estate-id': 'loom:e', 'loom-estate-pause': 'exempt' })], { scope: SCOPE, selfAppName: 'loom-console' });
    expect(plan.dryRun.wouldPause).toEqual([]);
  });

  // Breaks if: the gateway ranks as a consumer (2) or data (1): it must resume FIRST and pause LAST (platform, rank 0).
  it('resumes before data and consumers, pauses after them', () => {
    const app = { resourceType: 'microsoft.app/containerapps', n: 'app' };
    const db = { resourceType: 'microsoft.dbforpostgresql/flexibleservers', n: 'db' };
    const gwr = { resourceType: APP_GATEWAY_TYPE, n: 'gw' };
    expect(orderForResume([app, db, gwr]).map((x) => x.n)).toEqual(['gw', 'db', 'app']);
    expect(orderForPause([gwr, db, app]).map((x) => x.n)).toEqual(['app', 'db', 'gw']);
  });
});
