/**
 * #5099 phase C - the carried Phase B review findings. Every `it` names the input
 * that breaks it (assertion-design.md).
 *
 *   (a) resume: a database's consumers wait for the database, and never start when it failed
 *   (b) pause : a consumer's `dispatched` scale-to-zero is read back before the database stops
 *   (c) gateway: the console's custom hostnames (env list, vanity domain, listener) hold it out
 */
import { describe, it, expect } from 'vitest';
import {
  applyResumePoll,
  confirmConsumersStopped,
  planPause,
  pollResume,
  startPause,
  startResume,
  type EstateActuator,
} from '../pause-orchestrator';
import { armPowerReading, type EstatePauseSnapshot, type EstatePowerState, type PausedResourceSnapshot } from '../pause-state';
import type { DiscoveredResource, PauseScope } from '../pause-inventory';
import { orderForPause } from '../pause-tier';
import { CONSUMERS_TAG_KEY } from '../pause-guards';
import { appGatewayBackendGuard, consoleIdentifiers, type GatewayBackendConfig } from '../pause-appgateway-guard';

const ESTATE = 'loom:estate-c';
const SUB = 'sub-c';
const ours = { 'loom-estate-id': ESTATE };
const SCOPE: PauseScope = { kind: 'explicit-inventory', estateId: ESTATE };
const idOf = (type: string, name: string) => `/subscriptions/${SUB}/resourceGroups/rg-c/providers/${type}/${name}`;

const res = (type: string, name: string, tags: Record<string, string>): DiscoveredResource => ({
  resourceId: idOf(type, name), resourceType: type.toLowerCase(), name, resourceGroup: 'rg-c', subscriptionId: SUB,
  tags, discoverySource: 'deploy-manifest',
});
const aca = (name: string) => res('Microsoft.App/containerApps', name, ours);
const pg = (name: string, consumers: string) =>
  res('Microsoft.DBforPostgreSQL/flexibleServers', name, { ...ours, [CONSUMERS_TAG_KEY]: consumers });

const PGID = idOf('Microsoft.DBforPostgreSQL/flexibleServers', 'psql-o');
const entry = (type: string, name: string, extra: Partial<PausedResourceSnapshot> = {}): PausedResourceSnapshot => ({
  resourceId: idOf(type, name), resourceType: type.toLowerCase(), name, resourceGroup: 'rg-c', subscriptionId: SUB,
  prePausePowerState: 'Online', powerStateSource: 'arm', powerStateReadAt: '2026-10-10T00:00:00.000Z',
  powerStateApiVersion: 'x', ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' }, ...extra,
} as PausedResourceSnapshot);
const pausedSnap = (): EstatePauseSnapshot => ({
  schemaVersion: 1, id: 'snap', tenantId: 't1', estateId: ESTATE, state: 'PAUSED',
  createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', pausedAt: '2026-10-10T00:00:00.000Z',
  createdBy: 'x',
  resources: [
    entry('Microsoft.DBforPostgreSQL/flexibleServers', 'psql-o', { consumers: ['app-a', 'app-b'] }),
    entry('Microsoft.App/containerApps', 'app-a'),
    entry('Microsoft.App/containerApps', 'app-b'),
    entry('Microsoft.App/containerApps', 'free-app'),
  ],
} as unknown as EstatePauseSnapshot);

function resumeActuator(opts: { failResume?: string[]; power?: Record<string, EstatePowerState> } = {}) {
  const calls: string[] = [];
  const power = { ...(opts.power ?? {}) };
  const actuator: EstateActuator = {
    readTags: async () => null,
    readPower: async (r) => ({
      reading: armPowerReading({ resourceId: r.resourceId, powerState: power[r.resourceId] ?? 'Paused', armApiVersion: 'x' }),
    }),
    pause: async () => ({ ok: true, detail: 'x' }),
    resume: async (e) => {
      calls.push(`resume:${e.name}`);
      if (opts.failResume?.includes(e.name)) return { ok: false, detail: 'rejected', error: 'boom' };
      return { ok: true, detail: 'accepted' };
    },
    probeServable: async () => ({ servable: true, probed: true, detail: 'ok' }),
  };
  return { actuator, calls, power };
}

describe('(a) resume: consumers wait for the database', () => {
  // Breaks if: consumers are dispatched right after the DB request again (calls would hold app-a/app-b).
  it('DB start accepted: ONLY the DB and the unrelated app are dispatched; app-a/app-b are held and recorded', async () => {
    const { actuator, calls } = resumeActuator();
    const run = await startResume(pausedSnap(), actuator);
    expect(calls).toEqual(['resume:psql-o', 'resume:free-app']);
    expect((run.snapshot.resumeHeld ?? []).map((h) => [h.name, h.dbName])).toEqual([['app-a', 'psql-o'], ['app-b', 'psql-o']]);
    const a = run.dispatches.find((d) => d.name === 'app-a');
    expect(a).toMatchObject({ status: 'skipped' });
    expect(a?.detail).toContain('held until psql-o reads Online');
  });

  // Breaks if: the failed-DB branch is deleted (consumers would then be held forever or dispatched).
  it('DB start FAILED: consumers are skipped "database not started", never dispatched, never held', async () => {
    const { actuator, calls } = resumeActuator({ failResume: ['psql-o'] });
    const run = await startResume(pausedSnap(), actuator);
    expect(calls).toEqual(['resume:psql-o', 'resume:free-app']); // no resume:app-a / resume:app-b
    expect(run.snapshot.resumeHeld).toEqual([]);
    for (const n of ['app-a', 'app-b']) {
      const d = run.dispatches.find((x) => x.name === n);
      expect(d?.status).toBe('skipped');
      expect(d?.detail).toContain('database not started');
      expect(d?.error).toBe('database-not-started:psql-o');
    }
    // positive: the app that does not depend on the database is still started
    expect(run.dispatches.find((x) => x.name === 'free-app')?.status).toBe('dispatched');
  });

  // Breaks if: the poll starts held consumers before the DB reads Online (or never starts them after).
  it('pollResume starts held consumers only once the DB reads Online, and then clears the hold', async () => {
    const { actuator, calls, power } = resumeActuator();
    const run = await startResume(pausedSnap(), actuator);
    calls.length = 0;
    const resuming = run.snapshot;

    power[PGID] = 'Resuming';
    const early = await pollResume(resuming, actuator);
    expect(calls).toEqual([]); // DB still Resuming: nothing started
    expect(early.resumeHeld?.map((h) => h.name)).toEqual(['app-a', 'app-b']);

    power[PGID] = 'Online';
    const late = await pollResume(resuming, actuator);
    expect(calls).toEqual(['resume:app-a', 'resume:app-b']);
    expect(late.resumeHeld).toEqual([]);
    // and the persisted fold carries the cleared hold (otherwise every poll would re-start them)
    expect(applyResumePoll(resuming, { ...late, state: 'RESUMING' }).resumeHeld).toEqual([]);
  });
});

describe('(b) pause: a consumer must READ BACK stopped before its database is stopped', () => {
  const discovery = [aca('app-a'), pg('psql-o', 'app-a')];
  const dbName = 'psql-o';

  function pauseActuator(consumerReads: Array<{ state: EstatePowerState | null; replicas?: number }>) {
    const calls: string[] = [];
    let reads = 0;
    const actuator: EstateActuator = {
      readTags: async (id) => discovery.find((d) => d.resourceId === id)?.tags ?? null,
      readPower: async (r) => {
        if (r.name === 'app-a') {
          // The pre-pause read (first) says Online; later reads follow the script.
          if (reads === 0) { reads += 1; return { reading: armPowerReading({ resourceId: r.resourceId, powerState: 'Online', armApiVersion: 'x' }), replicaCount: 1 }; }
          const next = consumerReads[Math.min(reads - 1, consumerReads.length - 1)];
          reads += 1;
          if (next.state === null) return { reading: null, error: 'read denied' };
          return { reading: armPowerReading({ resourceId: r.resourceId, powerState: next.state, armApiVersion: 'x' }), replicaCount: next.replicas };
        }
        return { reading: armPowerReading({ resourceId: r.resourceId, powerState: 'Online', armApiVersion: 'x' }) };
      },
      pause: async (c) => { calls.push(`pause:${c.resource.name}`); return { ok: true, detail: 'accepted' }; },
      resume: async () => ({ ok: true, detail: 'x' }),
      probeServable: async () => ({ servable: true, probed: true, detail: 'ok' }),
    };
    return { actuator, calls };
  }
  const run = async (actuator: EstateActuator) =>
    startPause(planPause(orderForPause(discovery), { scope: SCOPE, selfAppName: 'loom-console' }), actuator, {
      snapshotId: 's', tenantId: 't1', estateId: ESTATE, readManifest: async () => null, selfAppName: 'loom-console',
      consumerDrain: { attempts: 3, delayMs: 0 },
    });

  // Breaks if: `dispatched` is trusted as stopped again (the DB stop would be sent while app-a has 2 replicas).
  it('consumer still has 2 replicas on every read: the DB is held out and pause:psql-o is NEVER sent', async () => {
    const { actuator, calls } = pauseActuator([{ state: 'Online', replicas: 2 }]);
    const r = await run(actuator);
    expect(calls).toEqual(['pause:app-a']);
    const d = r.actions.find((a) => a.name === dbName);
    expect(d?.status).toBe('skipped');
    expect(d?.detail).toContain('could not be confirmed stopped after 3 read(s)');
    expect(d?.detail).toContain('2 replica(s)');
  });

  // Breaks if: the read-back never accepts a drained consumer (positive control: the DB stop IS sent after it drains).
  it('consumer drains on the 2nd read-back: the DB is stopped', async () => {
    const { actuator, calls } = pauseActuator([{ state: 'Online', replicas: 1 }, { state: 'Paused', replicas: 0 }]);
    const r = await run(actuator);
    expect(calls).toEqual(['pause:app-a', 'pause:psql-o']);
    expect(r.actions.find((a) => a.name === dbName)?.status).toBe('dispatched');
  });

  // Breaks if: an unreadable consumer is read as stopped (fail open).
  it('consumer power read fails: the DB is held out with the read error', async () => {
    const { actuator, calls } = pauseActuator([{ state: null }]);
    const r = await run(actuator);
    expect(calls).toEqual(['pause:app-a']);
    expect(r.actions.find((a) => a.name === dbName)?.detail).toContain('read denied');
  });

  // Breaks if: a zero replica count alone (state still reads Online) is not accepted, or a non-zero one is.
  it('confirmConsumersStopped: replicas 0 is stopped even if the state word is Online; 1 is not', async () => {
    const acts = [{ resourceId: idOf('Microsoft.App/containerApps', 'app-a'), name: 'app-a', resourceType: 'microsoft.app/containerapps', status: 'dispatched' }];
    const mk = (replicaCount: number) => ({
      readPower: async (r: { resourceId: string }) => ({ reading: armPowerReading({ resourceId: r.resourceId, powerState: 'Online', armApiVersion: 'x' }), replicaCount }),
    });
    expect(await confirmConsumersStopped(['app-a'], acts, mk(0), { attempts: 1, delayMs: 0 })).toEqual({ ok: true });
    const bad = await confirmConsumersStopped(['app-a'], acts, mk(1), { attempts: 1, delayMs: 0 });
    expect(bad.ok).toBe(false);
  });
});

describe('(c) App Gateway: the console custom hostname holds the gateway out', () => {
  const baseEnv = { CONTAINER_APP_NAME: 'loom-console', LOOM_PUBLIC_BASE_URL: 'https://loom.contoso.example/' };
  const withEnv = (extra: Record<string, string> = {}) => ({ ...baseEnv, ...extra }) as unknown as NodeJS.ProcessEnv;
  const pool = (fqdn: string): GatewayBackendConfig => ({
    properties: { backendAddressPools: [{ name: 'p', properties: { backendAddresses: [{ fqdn }] } }] },
  });
  const gw = { name: 'agw' };

  // Breaks if: LOOM_CONSOLE_HOSTNAMES is not read. The CONTRAST row is the point: the same pool is eligible
  // when the hostname is unknown, which is exactly the hole being closed.
  it('a pool on a vanity hostname held ONLY when the console knows it (env list)', () => {
    const cfg = pool('portal.vanity.example');
    expect(appGatewayBackendGuard(gw, cfg, withEnv()).eligible).toBe(true); // unknown host: indistinguishable from another app
    const known = appGatewayBackendGuard(gw, cfg, withEnv({ LOOM_CONSOLE_HOSTNAMES: 'a.example, Portal.Vanity.Example' }));
    expect(known.eligible).toBe(false);
    expect(known.reason).toContain('portal.vanity.example');
  });

  // Breaks if: the vanity-domain / public-url envs are dropped from the identity set.
  it('LOOM_VANITY_DOMAIN and LOOM_PUBLIC_URL feed the console host set', () => {
    const ids = consoleIdentifiers(withEnv({ LOOM_VANITY_DOMAIN: 'loom.vanity.example', LOOM_PUBLIC_URL: 'https://x.example/path' }));
    expect(ids.hosts).toEqual(expect.arrayContaining(['loom.contoso.example', 'loom.vanity.example', 'x.example']));
  });

  // Breaks if: the listener check is deleted: the pool is an unrelated FQDN, only the LISTENER serves the console host.
  it('a listener serving a console hostname holds the gateway out even when the pool address looks unrelated', () => {
    const cfg: GatewayBackendConfig = {
      properties: {
        httpListeners: [{ name: 'https-l', properties: { hostNames: ['other.example', 'Loom.Contoso.Example'] } }],
        backendAddressPools: [{ name: 'p', properties: { backendAddresses: [{ fqdn: 'shop.example' }] } }],
      },
    };
    const v = appGatewayBackendGuard(gw, cfg, withEnv());
    expect(v.eligible).toBe(false);
    expect(v.reason).toContain("listener 'https-l'");
    // positive: the same gateway without that listener host is eligible
    const clean = { properties: { ...cfg.properties, httpListeners: [{ name: 'l', properties: { hostName: 'other.example' } }] } };
    expect(appGatewayBackendGuard(gw, clean, withEnv()).eligible).toBe(true);
  });

  // Breaks if: the identity-unknown hold is lost when the new env keys are added (still held out with no identity).
  it('no console identity at all is still held out', () => {
    expect(appGatewayBackendGuard(gw, pool('x.example'), {} as NodeJS.ProcessEnv).eligible).toBe(false);
  });
});
