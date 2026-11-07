/**
 * #5099 phase B - the database DEPENDENCY guard, and the pause/resume ORDER it
 * relies on. Every assertion names, in a comment, the input that would break it
 * (assertion-design.md).
 *
 * The fixture is the measured estate shape: most Postgres servers back always-on
 * apps (loom-unity, loom-airflow, loom-duckdb, the console), so a server is
 * pausable ONLY when every consumer is in the same pause set.
 */
import { describe, it, expect } from 'vitest';
import {
  planPause,
  startPause,
  startResume,
  type EstateActuator,
} from '../pause-orchestrator';
import { armPowerReading, type EstatePowerState } from '../pause-state';
import type { DiscoveredResource, PauseScope } from '../pause-inventory';
import { orderForPause, orderForResume } from '../pause-tier';
import {
  CONSUMERS_TAG_KEY,
  dbActGuard,
  dbPauseGuard,
  parseConsumersTag,
} from '../pause-guards';

const ESTATE = 'loom:estate-dep';
const SCOPE: PauseScope = { kind: 'explicit-inventory', estateId: ESTATE };
const SUB = 'sub-dep';
const SELF = 'loom-console';
const ours = { 'loom-estate-id': ESTATE };

function res(type: string, name: string, tags: Record<string, string> | null): DiscoveredResource {
  return {
    resourceId: `/subscriptions/${SUB}/resourceGroups/rg-dep/providers/${type}/${name}`,
    resourceType: type.toLowerCase(),
    name,
    resourceGroup: 'rg-dep',
    subscriptionId: SUB,
    tags,
    discoverySource: 'deploy-manifest',
  };
}
const aca = (name: string, extra: Record<string, string> = {}) =>
  res('Microsoft.App/containerApps', name, { ...ours, ...extra });
const pg = (name: string, consumers?: string, extra: Record<string, string> = {}) =>
  res('Microsoft.DBforPostgreSQL/flexibleServers', name, {
    ...ours,
    ...(consumers === undefined ? {} : { [CONSUMERS_TAG_KEY]: consumers }),
    ...extra,
  });
const mysql = (name: string, consumers?: string) =>
  res('Microsoft.DBforMySQL/flexibleServers', name, {
    ...ours,
    ...(consumers === undefined ? {} : { [CONSUMERS_TAG_KEY]: consumers }),
  });

const planOf = (set: DiscoveredResource[]) => planPause(set, { scope: SCOPE, selfAppName: SELF });
const pausedNames = (set: DiscoveredResource[]) => planOf(set).dryRun.wouldPause.map((r) => r.name);
const heldOut = (set: DiscoveredResource[], name: string) => planOf(set).outOfTier.find((o) => o.name === name);

describe('parseConsumersTag', () => {
  // Breaks if: an absent/empty tag is read as "no consumers" (fail OPEN) instead of unknown.
  it('absent, empty and whitespace-only values are UNKNOWN, never "none"', () => {
    expect(parseConsumersTag({}).state).toBe('unknown');
    expect(parseConsumersTag({ [CONSUMERS_TAG_KEY]: '   ' }).state).toBe('unknown');
    expect(parseConsumersTag({ [CONSUMERS_TAG_KEY]: ' , ,' }).state).toBe('unknown');
    expect(parseConsumersTag(null).state).toBe('unknown');
  });
  // Breaks if: names are not lower-cased/trimmed/de-duplicated, so 'Loom-Unity' would miss the never-pause list.
  it('lists are lower-cased, trimmed and de-duplicated; the key is case-insensitive', () => {
    const t = parseConsumersTag({ 'Loom-Estate-Pause-Consumers': ' Loom-Unity, loom-duckdb ,loom-unity' });
    expect(t).toEqual({ state: 'listed', names: ['loom-unity', 'loom-duckdb'] });
  });
  // Breaks if: only the exact literal 'none' stops meaning "no consumers" (an operator decision).
  it("the literal 'none' is the one explicit no-consumers value", () => {
    expect(parseConsumersTag({ [CONSUMERS_TAG_KEY]: 'NONE' }).state).toBe('none');
    expect(parseConsumersTag({ [CONSUMERS_TAG_KEY]: 'none,loom-x' })).toEqual({ state: 'listed', names: ['none', 'loom-x'] });
  });
});

describe('planPause: a server is pausable ONLY when every consumer is in the pause set', () => {
  // Breaks if: the unknown-consumers branch is dropped, then this server lands in wouldPause.
  it('NO consumers tag -> held out with the reason "consumers unknown"', () => {
    const set = [pg('psql-a'), aca('app-a')];
    expect(pausedNames(set)).toEqual(['app-a']);
    const h = heldOut(set, 'psql-a');
    expect(h?.reason).toContain('consumers unknown');
    expect(h?.reason).toContain(CONSUMERS_TAG_KEY);
    expect(h?.pinnedBy).toBeUndefined(); // nothing pins it: nothing is KNOWN
  });

  // Breaks if: the never-pause consumer is ignored (server paused under loom-unity), or the reason names another consumer.
  it('a consumer on the never-pause list pins the server, and the reason names THAT consumer', () => {
    const set = [pg('psql-unity', 'app-a,loom-unity'), aca('app-a'), aca('loom-unity')];
    expect(pausedNames(set)).toEqual(['app-a']);
    const h = heldOut(set, 'psql-unity');
    expect(h?.pinnedBy).toBe('loom-unity');
    expect(h?.reason).toContain('pinned by loom-unity');
    expect(h?.reason).toContain('never-pause list');
    expect(h?.reason).not.toContain('pinned by app-a'); // app-a is fine; only unity pins
  });

  // Breaks if: the guard only trusts the never-pause list for apps IN the set (an undiscovered unity would pass).
  it('a never-pause consumer that is not even discovered still pins the server', () => {
    const set = [pg('psql-air', 'loom-airflow')];
    expect(pausedNames(set)).toEqual([]);
    expect(heldOut(set, 'psql-air')?.pinnedBy).toBe('loom-airflow');
    // The never-pause arm is outcome-equivalent to the not-in-set arm here (both hold the server out);
    // what only it provides is the TRUE reason. This pins the message, not the count (R7).
    expect(heldOut(set, 'psql-air')?.reason).toContain('never-pause list because');
    expect(heldOut(set, 'psql-air')?.reason).not.toContain('not discovered');
  });

  // Breaks if: the console as a consumer (e.g. the ducklake catalog) is treated like any app.
  it('the console as a consumer pins the server', () => {
    const set = [pg('psql-duck', 'loom-console,loom-duckdb'), aca('loom-duckdb')];
    expect(pausedNames(set)).toEqual([]);
    expect(heldOut(set, 'psql-duck')?.pinnedBy).toBe('loom-console');
  });

  // Breaks if: a consumer opted out (exempt) of the pause is still counted as "in the set".
  it('a consumer held out by its own exempt tag pins the server and the reason says why', () => {
    const set = [pg('psql-b', 'app-a,app-b'), aca('app-a'), aca('app-b', { 'loom-estate-pause': 'exempt' })];
    expect(pausedNames(set)).toEqual(['app-a']);
    const h = heldOut(set, 'psql-b');
    expect(h?.pinnedBy).toBe('app-b');
    expect(h?.reason).toContain('exempt');
  });

  // Breaks if: a consumer name that matches nothing in the set is read as satisfied.
  it('a consumer that is not in the set at all pins the server', () => {
    const set = [pg('psql-c', 'app-ghost'), aca('app-a')];
    expect(pausedNames(set)).toEqual(['app-a']);
    expect(heldOut(set, 'psql-c')?.pinnedBy).toBe('app-ghost');
  });

  // Breaks if: the positive path is broken (a guard that holds out EVERYTHING also passes every hold-out test above).
  it('every consumer in the set -> the server (PostgreSQL and MySQL) IS paused, with the set unchanged otherwise', () => {
    const set = [pg('psql-ok', 'app-a,app-b'), mysql('mysql-ok', 'app-b'), aca('app-a'), aca('app-b')];
    expect(pausedNames(set).sort()).toEqual(['app-a', 'app-b', 'mysql-ok', 'psql-ok']);
    expect(planOf(set).outOfTier).toEqual([]);
  });

  // Breaks if: 'none' is not honoured (operator override), or is honoured while a consumer list is present.
  it("'none' pauses the server with no consumers in the set", () => {
    expect(pausedNames([pg('psql-none', 'none')])).toEqual(['psql-none']);
  });

  // Breaks if: unreadable tags (null) are read as "no exempt marker" and the server proceeds.
  it('unreadable tags fail safe', () => {
    const g = dbPauseGuard({ name: 'psql-x', tags: null }, { pausing: new Set(), heldOut: new Map() });
    expect(g.eligible).toBe(false);
    expect(g.reason).toContain('could not be read');
  });

  // Breaks if: the exempt tag stops applying to databases.
  it('loom-estate-pause=exempt holds a database out even with satisfied consumers', () => {
    const set = [pg('psql-e', 'app-a', { 'loom-estate-pause': 'exempt' }), aca('app-a')];
    expect(pausedNames(set)).toEqual(['app-a']);
  });
});

describe('pause order: consumers BEFORE the database; resume: database BEFORE consumers', () => {
  // The database is listed FIRST in discovery order on purpose: a sort that did
  // nothing (or ranked the database with the apps) would leave it first and fail here.
  const discovery = [pg('psql-o', 'app-a,app-b'), aca('app-a'), aca('app-b')];

  // Breaks if: the database's rank is changed to equal the consumers' (rank 2) or lower than platform.
  it('orderForPause puts both apps before the database; orderForResume puts the database first', () => {
    expect(orderForPause(discovery).map((r) => r.name)).toEqual(['app-a', 'app-b', 'psql-o']);
    expect(orderForResume(discovery).map((r) => r.name)).toEqual(['psql-o', 'app-a', 'app-b']);
  });

  function fakeActuator(opts: { failPause?: string[] } = {}) {
    const calls: string[] = [];
    const power = new Map<string, EstatePowerState>();
    const actuator: EstateActuator = {
      readTags: async (id) => discovery.find((d) => d.resourceId === id)?.tags ?? null,
      readPower: async (r) => {
        const state = power.get(r.resourceId) ?? 'Online';
        return { reading: armPowerReading({ resourceId: r.resourceId, powerState: state, armApiVersion: 'x' }) };
      },
      pause: async (c) => {
        calls.push(`pause:${c.resource.name}`);
        if (opts.failPause?.includes(c.resource.name)) return { ok: false, detail: 'rejected', error: 'boom' };
        power.set(c.resource.resourceId, 'Paused');
        return { ok: true, detail: 'accepted' };
      },
      resume: async (e) => {
        calls.push(`resume:${e.name}`);
        return { ok: true, detail: 'accepted' };
      },
      probeServable: async () => ({ servable: true, probed: true, detail: 'ok' }),
    };
    return { actuator, calls };
  }

  // Breaks if: startPause dispatches the database before an app it serves (calls[] order flips).
  it('startPause dispatches app-a, app-b, THEN psql-o; the snapshot records the consumers', async () => {
    const ordered = orderForPause(discovery);
    const plan = planOf(ordered);
    const { actuator, calls } = fakeActuator();
    const run = await startPause(plan, actuator, {
      snapshotId: 's1', tenantId: 't1', estateId: ESTATE, readManifest: async () => null, selfAppName: SELF,
    });
    expect(calls).toEqual(['pause:app-a', 'pause:app-b', 'pause:psql-o']);
    expect(run.actions.map((a) => a.status)).toEqual(['dispatched', 'dispatched', 'dispatched']);
    const entry = run.snapshot.resources.find((r) => r.name === 'psql-o');
    expect(entry?.consumers).toEqual(['app-a', 'app-b']); // lifted from the FRESH tags, lower-cased
  });

  // Breaks if: startResume starts an app before the database it needs.
  it('startResume dispatches psql-o and HOLDS the apps (phase C: they start once the database reads Online)', async () => {
    const ordered = orderForPause(discovery);
    const { actuator, calls } = fakeActuator();
    const run = await startPause(planOf(ordered), actuator, {
      snapshotId: 's2', tenantId: 't1', estateId: ESTATE, readManifest: async () => null, selfAppName: SELF,
    });
    calls.length = 0;
    const paused = { ...run.snapshot, state: 'PAUSED' as const };
    await startResume(paused, actuator);
    expect(calls).toEqual(['resume:psql-o']); // app-a/app-b wait for the database (see pause-phase-c-review-fixes.test.ts)
  });

  // Breaks if: the act-time check is removed - the plan PREDICTED app-b would pause, but its pause was
  // rejected, so stopping the database now would break a running app.
  it('ACT TIME: a consumer whose pause FAILED pins the database; the server is not stopped', async () => {
    const ordered = orderForPause(discovery);
    const { actuator, calls } = fakeActuator({ failPause: ['app-b'] });
    const run = await startPause(planOf(ordered), actuator, {
      snapshotId: 's3', tenantId: 't1', estateId: ESTATE, readManifest: async () => null, selfAppName: SELF,
    });
    expect(calls).toEqual(['pause:app-a', 'pause:app-b']); // pause:psql-o NEVER sent
    const a = run.actions.find((x) => x.name === 'psql-o');
    expect(a?.status).toBe('skipped');
    expect(a?.detail).toContain('pinned by app-b');
    expect(a?.detail).toContain("'failed'");
    expect(run.snapshot.resources.some((r) => r.name === 'psql-o')).toBe(false); // nothing to restore
  });

  // Breaks if: the database is processed before its consumers (e.g. an unordered caller): it must fail safe, not stop.
  it('ACT TIME: a database reached BEFORE its consumers is skipped, never stopped', async () => {
    const { actuator, calls } = fakeActuator();
    const run = await startPause(planOf(discovery), actuator, {
      snapshotId: 's4', tenantId: 't1', estateId: ESTATE, readManifest: async () => null, selfAppName: SELF,
    });
    // plan order = discovery order (database first)
    expect(run.actions.find((x) => x.name === 'psql-o')?.status).toBe('skipped');
    expect(calls).not.toContain('pause:psql-o');
  });
});

describe('dbActGuard evidence rules', () => {
  const db = { name: 'psql-g', tags: { [CONSUMERS_TAG_KEY]: 'app-a' } as Record<string, string> };
  // Breaks if: 'already-paused' stops counting as stopped (an app that was already stopped is fine).
  it("an already-paused consumer satisfies the guard; 'skipped' and 'no-op' do not", () => {
    const act = (status: string) => [{ name: 'app-a', resourceType: 'microsoft.app/containerapps', status }];
    expect(dbActGuard(db, act('already-paused')).eligible).toBe(true);
    expect(dbActGuard(db, act('dispatched')).eligible).toBe(true);
    expect(dbActGuard(db, act('skipped')).eligible).toBe(false);
    expect(dbActGuard(db, act('no-op')).eligible).toBe(false);
    expect(dbActGuard(db, []).reason).toContain('has not been paused in this run');
  });
  // Breaks if: an action for a same-named resource of a NON-consumer type (e.g. a VM named app-a) satisfies the guard.
  it('only consumer-type resources count as the consumer', () => {
    const vm = [{ name: 'app-a', resourceType: 'microsoft.compute/virtualmachines', status: 'dispatched' }];
    expect(dbActGuard(db, vm).eligible).toBe(false);
  });
});
