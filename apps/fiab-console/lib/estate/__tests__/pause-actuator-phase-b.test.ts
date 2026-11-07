/**
 * #5099 phase B - the actuator verbs for PostgreSQL / MySQL flexible servers,
 * Application Gateway and Power BI Embedded. The ARM transport is stubbed and the
 * URL that would go on the wire is asserted. Each case names the input that breaks it.
 *
 * Verbs/fields/api-versions: Microsoft Learn REST reference, 2026-10-23
 * (PostgreSQL servers/stop, MySQL servers/stop, applicationGateways/stop,
 * powerBIEmbedded capacities/suspend; states per each "Get" page).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const armGet = vi.fn();
const armPost = vi.fn();
vi.mock('@/lib/azure/arm-client', () => ({
  armGet: (...a: unknown[]) => armGet(...a),
  armGetWithRetry: (p: unknown) => armGet(p),
  armPost: (...a: unknown[]) => armPost(...a),
  armPatch: vi.fn(),
  armPut: vi.fn(),
  armDelete: vi.fn(),
}));

import {
  createArmActuator,
  normalizePowerState,
  pollPause,
  type EstateActuator,
} from '../pause-orchestrator';
import type { PauseCandidate } from '../pause-inventory';
import { newPauseSnapshot, type PausedResourceSnapshot } from '../pause-state';

const base = '/subscriptions/sub-b/resourceGroups/rg-b/providers';
const ids = {
  pg: `${base}/Microsoft.DBforPostgreSQL/flexibleServers/pg-b`,
  my: `${base}/Microsoft.DBforMySQL/flexibleServers/my-b`,
  gw: `${base}/Microsoft.Network/applicationGateways/agw-b`,
  pbi: `${base}/Microsoft.PowerBIDedicated/capacities/pbi-b`,
};
const types = {
  pg: 'microsoft.dbforpostgresql/flexibleservers',
  my: 'microsoft.dbformysql/flexibleservers',
  gw: 'microsoft.network/applicationgateways',
  pbi: 'microsoft.powerbidedicated/capacities',
} as const;
type Kind = keyof typeof ids;
const VERSION: Record<Kind, string> = { pg: '2024-08-01', my: '2023-12-30', gw: '2024-05-01', pbi: '2021-01-01' };

function candidate(kind: Kind): PauseCandidate {
  return {
    resource: {
      resourceId: ids[kind], resourceType: types[kind], name: `${kind}-b`,
      resourceGroup: 'rg-b', subscriptionId: 'sub-b', tags: {}, discoverySource: 'deploy-manifest',
    },
    spec: { resourceType: types[kind], label: kind, mechanism: 'arm-stop-action', capacityConstrained: false, armApiVersion: 'x' },
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' },
  };
}
function entry(kind: Kind, over?: Partial<PausedResourceSnapshot>): PausedResourceSnapshot {
  return {
    resourceId: ids[kind], resourceType: types[kind], name: `${kind}-b`, resourceGroup: 'rg-b',
    subscriptionId: 'sub-b', prePausePowerState: 'Online', powerStateSource: 'arm',
    powerStateReadAt: '2026-10-23T00:00:00.000Z', powerStateApiVersion: 'x',
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 't' }, ...over,
  };
}
const res = (kind: Kind) => ({ resourceId: ids[kind], resourceType: types[kind], name: `${kind}-b` });

/** What each provider reports in its own field. */
function body(kind: Kind, raw: string) {
  return kind === 'gw'
    ? { properties: { operationalState: raw, backendAddressPools: [{ name: 'p', properties: { backendAddresses: [{ fqdn: 'shop.example' }] } }] } }
    : { properties: { state: raw }, sku: { name: 'S', tier: 'T' } };
}

const ENV_KEYS = ['CONTAINER_APP_NAME', 'LOOM_PUBLIC_BASE_URL', 'LOOM_CONTAINER_PLATFORM', 'KUBERNETES_SERVICE_HOST'];
let saved: Record<string, string | undefined>;

let actuator: EstateActuator;
beforeEach(async () => {
  armGet.mockReset();
  armPost.mockReset();
  armPost.mockResolvedValue({});
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.CONTAINER_APP_NAME = 'loom-console';
  actuator = await createArmActuator();
  return () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
});

describe('normalizePowerState for the phase-B types', () => {
  const cases: Array<[string, string, string]> = [
    // [type, ARM raw, expected]. Each row breaks if that mapping is wrong.
    [types.pg, 'Ready', 'Online'],
    [types.pg, 'Stopped', 'Stopped'],
    [types.pg, 'Stopping', 'Pausing'],
    [types.pg, 'Starting', 'Starting'],
    [types.pg, 'Updating', 'Scaling'], // NOT Online: a server mid-update must not be snapshotted as running-and-stable
    [types.pg, 'Disabled', 'Unknown'], // a disabled/moved server is left alone, not "paused"
    [types.pg, 'Dropping', 'Unknown'],
    [types.my, 'Ready', 'Online'],
    [types.my, 'Stopped', 'Stopped'],
    [types.gw, 'Running', 'Online'],
    [types.gw, 'Stopped', 'Stopped'],
    [types.gw, 'Stopping', 'Pausing'],
    [types.gw, 'Starting', 'Starting'],
    [types.pbi, 'Succeeded', 'Online'],
    [types.pbi, 'Paused', 'Paused'],
    [types.pbi, 'Suspended', 'Paused'],
    [types.pbi, 'Suspending', 'Pausing'],
    [types.pbi, 'Resuming', 'Resuming'],
    [types.pbi, 'Failed', 'Unknown'], // a failed capacity is in trouble, not stopped
    [types.pbi, 'Deleting', 'Unknown'],
  ];
  it.each(cases)('%s %s -> %s', (type, raw, expected) => {
    expect(normalizePowerState(type, raw)).toBe(expected);
  });
  // Breaks if: an empty/garbage value maps to a state (Unknown must stay Unknown: Unknown != Paused).
  it('empty and unrecognised values are Unknown for every type', () => {
    for (const t of Object.values(types)) {
      expect(normalizePowerState(t, '')).toBe('Unknown');
      expect(normalizePowerState(t, 'Gibberish')).toBe('Unknown');
    }
  });
});

describe('pause: the exact verb, path and api-version', () => {
  // Breaks if: any verb, api-version or id is wrong - this is the string ARM receives.
  it('PostgreSQL and MySQL POST /stop; Power BI POST /suspend', async () => {
    for (const [kind, verb] of [['pg', 'stop'], ['my', 'stop'], ['pbi', 'suspend']] as const) {
      armPost.mockClear();
      const r = await actuator.pause(candidate(kind));
      expect(r.ok).toBe(true);
      expect(armPost).toHaveBeenCalledTimes(1);
      expect(String(armPost.mock.calls[0][0])).toBe(`${ids[kind]}/${verb}?api-version=${VERSION[kind]}`);
    }
  });

  // Breaks if: the gateway stops WITHOUT first reading its pools (the clean-pool case proves the read is the gate).
  it('App Gateway with a clean backend POSTs /stop after reading its config', async () => {
    armGet.mockResolvedValue(body('gw', 'Running'));
    const r = await actuator.pause(candidate('gw'));
    expect(r.ok).toBe(true);
    expect(armGet).toHaveBeenCalledWith(`${ids.gw}?api-version=2024-05-01`);
    expect(String(armPost.mock.calls[0][0])).toBe(`${ids.gw}/stop?api-version=2024-05-01`);
  });

  // Breaks if: the act-time re-check is dropped, so a gateway that the plan did not hold out stops with the console behind it.
  it('ACT TIME: a gateway fronting the console is HELD (not failed), and NO stop is sent', async () => {
    armGet.mockResolvedValue({
      properties: { backendAddressPools: [{ name: 'console-backend', properties: { backendAddresses: [{ fqdn: 'loom-console.internal.x.io' }] } }] },
    });
    const r = await actuator.pause(candidate('gw'));
    expect(r.held).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('console-backend');
    expect(armPost).not.toHaveBeenCalled();
  });

  // Breaks if: an unreadable gateway config falls through to a stop.
  it('ACT TIME: an unreadable gateway config is HELD with "could not be established"; NO stop is sent', async () => {
    armGet.mockRejectedValue(new Error('ARM GET failed 403: forbidden'));
    const r = await actuator.pause(candidate('gw'));
    expect(r.held).toBe(true);
    expect(r.detail).toContain('could not be established');
    expect(armPost).not.toHaveBeenCalled();
  });

  // Breaks if: a rejected ARM verb is reported as accepted.
  it('a rejected POST surfaces as ok:false with the ARM text, never success', async () => {
    armPost.mockRejectedValue(new Error('ARM POST failed 409: ServerIsNotReady'));
    const r = await actuator.pause(candidate('pg'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ServerIsNotReady');
  });
});

describe('resume: read FIRST, start only a stopped resource', () => {
  // Breaks if: the start verb/path/version is wrong for any type.
  it('a Stopped PostgreSQL / MySQL / gateway POSTs /start; a Paused capacity POSTs /resume', async () => {
    const cases: Array<[Kind, string, string]> = [
      ['pg', 'Stopped', 'start'], ['my', 'Stopped', 'start'], ['gw', 'Stopped', 'start'], ['pbi', 'Paused', 'resume'],
    ];
    for (const [kind, raw, verb] of cases) {
      armPost.mockClear();
      armGet.mockResolvedValue(body(kind, raw));
      const r = await actuator.resume(entry(kind));
      expect(r.ok).toBe(true);
      expect(String(armPost.mock.calls[0][0])).toBe(`${ids[kind]}/${verb}?api-version=${VERSION[kind]}`);
    }
  });

  // Breaks if: a server Azure already auto-restarted (7 d PostgreSQL / 30 d MySQL) gets a blind start, which
  // ARM refuses with ServerIsNotStopped and which would turn a healthy estate into RESUME_FAILED.
  it('an ALREADY-RUNNING server is a true "already running"; no start is sent', async () => {
    armGet.mockResolvedValue(body('pg', 'Ready'));
    const r = await actuator.resume(entry('pg'));
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('already reports');
    expect(r.detail).toContain('no start was sent');
    expect(armPost).not.toHaveBeenCalled();
  });

  // Breaks if: a FAILED pre-read becomes success (or sends a start blind).
  it('a failed pre-start read is ok:false with the raw error, NO start sent, never success', async () => {
    armGet.mockRejectedValue(new Error('ARM GET failed 500: boom'));
    const r = await actuator.resume(entry('pg'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('failed 500');
    expect(r.detail).toContain('NOT established');
    expect(armPost).not.toHaveBeenCalled();
  });

  // Breaks if: a server mid-operation ('Updating') is sent a start (ARM would answer ServerIsNotStopped).
  it("'Updating' (neither stopped nor running) is ok:false with no start", async () => {
    armGet.mockResolvedValue(body('pg', 'Updating'));
    const r = await actuator.resume(entry('pg'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('phase-b-not-stopped:Updating');
    expect(armPost).not.toHaveBeenCalled();
  });

  // Breaks if: a resource already starting gets a second start.
  it("'Starting' gets no second start and is ok:true", async () => {
    armGet.mockResolvedValue(body('gw', 'Starting'));
    const r = await actuator.resume(entry('gw'));
    expect(r.ok).toBe(true);
    expect(armPost).not.toHaveBeenCalled();
  });
});

describe('readPower / probeServable read the right field', () => {
  // Breaks if: the gateway's operationalState is read from properties.state (undefined -> Unknown).
  it('reads properties.state (PostgreSQL, MySQL, Power BI) and properties.operationalState (gateway)', async () => {
    for (const [kind, raw, expected] of [
      ['pg', 'Ready', 'Online'], ['my', 'Stopped', 'Stopped'], ['gw', 'Stopped', 'Stopped'], ['pbi', 'Paused', 'Paused'],
    ] as const) {
      armGet.mockResolvedValue(body(kind, raw));
      const p = await actuator.readPower(res(kind));
      expect(p.reading?.powerState).toBe(expected);
      expect(p.reading?.armApiVersion).toBe(VERSION[kind]);
    }
  });

  // Breaks if: a failed read yields a reading (it must be null + the error, never a default).
  it('a failed read has reading:null and the error', async () => {
    armGet.mockRejectedValue(new Error('ARM GET failed 500: boom'));
    const p = await actuator.readPower(res('pg'));
    expect(p.reading).toBeNull();
    expect(p.error).toContain('failed 500');
  });

  // Breaks if: a running server is not servable, or a stopped one is.
  it('probeServable: Ready is servable (control-plane evidence, said so); Stopped is not; an error is not', async () => {
    armGet.mockResolvedValue(body('pg', 'Ready'));
    const ok = await actuator.probeServable(entry('pg'));
    expect(ok).toMatchObject({ servable: true, probed: true });
    expect(ok.detail).toContain('control-plane evidence');
    armGet.mockResolvedValue(body('pg', 'Stopped'));
    expect((await actuator.probeServable(entry('pg'))).servable).toBe(false);
    armGet.mockRejectedValue(new Error('ARM GET failed 500: boom'));
    const bad = await actuator.probeServable(entry('pg'));
    expect(bad.servable).toBe(false);
    expect(bad.probed).toBe(true);
  });
});

describe('read-back verification: pollPause promotes to PAUSED only on a fresh ARM read', () => {
  const snap = () => {
    const s = newPauseSnapshot({ id: 'p1', tenantId: 't', estateId: 'e' });
    s.resources.push(entry('pg'), entry('pbi'));
    return s;
  };
  // Breaks if: an accepted stop is counted as stopped without the read-back (pg still Ready after the POST).
  it('a server that still reads Ready after the stop was accepted is NOT confirmed; the estate stays PAUSING', async () => {
    armGet.mockImplementation(async (p: unknown) => (String(p).includes('DBforPostgreSQL') ? body('pg', 'Ready') : body('pbi', 'Paused')));
    const poll = await pollPause(snap(), actuator);
    expect(poll.state).toBe('PAUSING');
    expect(poll.confirmed).toBe(1); // only the capacity
  });
  // Breaks if: an unreadable server counts as stopped.
  it('a server whose read FAILS is not confirmed stopped', async () => {
    armGet.mockImplementation(async (p: unknown) => {
      if (String(p).includes('DBforPostgreSQL')) throw new Error('ARM GET failed 500: boom');
      return body('pbi', 'Paused');
    });
    const poll = await pollPause(snap(), actuator);
    expect(poll.state).toBe('PAUSING');
    expect(poll.progress.find((r) => r.name === 'pg-b')?.phase).toBe('unknown');
  });
  // Breaks if: the positive path is broken (both stopped must promote).
  it('both reading stopped -> PAUSED', async () => {
    armGet.mockImplementation(async (p: unknown) => (String(p).includes('DBforPostgreSQL') ? body('pg', 'Stopped') : body('pbi', 'Suspended')));
    const poll = await pollPause(snap(), actuator);
    expect(poll.state).toBe('PAUSED');
    expect(poll.confirmed).toBe(2);
  });
});
