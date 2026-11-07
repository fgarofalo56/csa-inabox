/**
 * Record-first persistence (review N1): a death after app 2 of 4 leaves apps 1 and 2
 * recoverable. Real planPause/startPause; only the actuator and the store are fakes.
 * Each `it` names the input that breaks it.
 */
import { describe, it, expect, vi } from 'vitest';
import { planPause, startPause, startResume, type EstateActuator, type PowerRead } from '../pause-orchestrator';
import { armPowerReading, type EstatePauseSnapshot } from '../pause-state';
import { discardPauseProgress, withIncrementalSnapshot } from '../pause-incremental';
import type { DiscoveredResource, PauseScope } from '../pause-inventory';

const ESTATE = 'loom:e1:rg';
const SCOPE: PauseScope = { kind: 'explicit-inventory', estateId: ESTATE };
const NAMES = ['app-1', 'app-2', 'app-3', 'app-4'];
const RANGE: Record<string, { minReplicas: number; maxReplicas: number }> = {
  'app-1': { minReplicas: 1, maxReplicas: 3 }, 'app-2': { minReplicas: 2, maxReplicas: 2 },
  'app-3': { minReplicas: 1, maxReplicas: 5 }, 'app-4': { minReplicas: 3, maxReplicas: 4 },
};
const res = (name: string): DiscoveredResource => ({
  resourceId: `/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/${name}`,
  resourceType: 'microsoft.app/containerapps', name, resourceGroup: 'rg', subscriptionId: 's',
  tags: { 'loom-estate-id': ESTATE }, discoverySource: 'arm-rg-list',
});
const plan = () => planPause(NAMES.map(res), { scope: SCOPE, selfAppName: 'loom-console' });
const base = { id: 'snap-1', tenantId: 't1', estateId: ESTATE, createdBy: 'sp:abc' };

function fakeActuator(onPause: (name: string) => void | Promise<void>): EstateActuator {
  return {
    readTags: async () => ({ 'loom-estate-id': ESTATE }),
    readPower: async (r): Promise<PowerRead> => ({
      reading: armPowerReading({ resourceId: r.resourceId, powerState: 'Online', armApiVersion: 'x' }),
      scale: RANGE[r.name],
    }),
    pause: async (c) => { await onPause(c.resource.name); return { ok: true, detail: `paused ${c.resource.name}` }; },
    resume: async (e) => ({ ok: true, detail: `resumed ${e.name}` }),
    probeServable: async () => ({ servable: true, probed: true, detail: 'ok' }),
  };
}
const startCtx = () => ({ snapshotId: 'snap-1', tenantId: 't1', estateId: ESTATE, selfAppName: 'loom-console', readManifest: async () => null });

describe('record first, then patch', () => {
  // Breaks if: the snapshot is only written after the loop (the pre-fix behaviour): `saves` would be empty at the throw.
  it('a death DURING app 3 of 4 leaves apps 1 and 2 (and 3) recoverable with their ORIGINAL ranges', async () => {
    const saves: EstatePauseSnapshot[] = [];
    const mutated: string[] = [];
    const inc = withIncrementalSnapshot(
      fakeActuator(async (name) => { if (name === 'app-3') throw new Error('process died'); mutated.push(name); }),
      base,
      async (s) => { saves.push(structuredClone(s)); },
    );
    await expect(startPause(plan(), inc.actuator, startCtx())).rejects.toThrow('process died');

    const last = saves[saves.length - 1];
    expect(last.state).toBe('PAUSING');
    expect(mutated).toEqual(['app-1', 'app-2']);
    // Each mutated app's original range is in the record, and so is the app being mutated when it died.
    expect(last.resources.map((r) => r.name)).toEqual(['app-1', 'app-2', 'app-3']);
    for (const n of ['app-1', 'app-2']) {
      expect(last.resources.find((r) => r.name === n)?.scale).toEqual(RANGE[n]);
    }
    // app-4 was never reached: it must NOT be in the record (nothing to restore).
    expect(last.resources.map((r) => r.name)).not.toContain('app-4');
  });

  // Breaks if: the record is written AFTER the mutation (patch-then-record): the first save would already follow app-1's patch.
  it('the record for an app is written BEFORE that app is mutated (ordering, not just presence)', async () => {
    const events: string[] = [];
    const inc = withIncrementalSnapshot(
      fakeActuator(async (name) => { events.push(`patch:${name}`); }),
      base,
      async (s) => { events.push(`save:${s.resources.map((r) => r.name).join('+')}`); },
    );
    await startPause(plan(), inc.actuator, startCtx());
    expect(events).toEqual([
      'save:app-1', 'patch:app-1', 'save:app-1+app-2', 'patch:app-2',
      'save:app-1+app-2+app-3', 'patch:app-3', 'save:app-1+app-2+app-3+app-4', 'patch:app-4',
    ]);
  });

  // Breaks if: a failed record write is ignored and the app is scaled to zero anyway.
  it('a failed record write means the app is NOT mutated and is reported failed, not silently paused', async () => {
    const mutated: string[] = [];
    const inc = withIncrementalSnapshot(
      fakeActuator(async (name) => { mutated.push(name); }),
      base,
      async (s) => { if (s.resources[s.resources.length - 1].name === 'app-2') throw new Error('cosmos 503'); },
    );
    const run = await startPause(plan(), inc.actuator, startCtx());
    expect(mutated).toEqual(['app-1', 'app-3', 'app-4']);
    const a2 = run.actions.find((a) => a.name === 'app-2');
    expect(a2).toMatchObject({ status: 'failed', error: 'snapshot-persist-failed' });
    expect(a2?.detail).toMatch(/Left RUNNING/);
  });

  // Breaks if: the saved snapshot is the live object (later pushes would leak into earlier saves).
  it('each save is a point-in-time copy', async () => {
    const saves: EstatePauseSnapshot[] = [];
    const inc = withIncrementalSnapshot(fakeActuator(async () => {}), base, async (s) => { saves.push(s); });
    await startPause(plan(), inc.actuator, startCtx());
    expect(saves.map((s) => s.resources.length)).toEqual([1, 2, 3, 4]);
  });
});

describe('the interrupted snapshot is recoverable', () => {
  // Breaks if: resume of a PAUSING snapshot is refused or rewrites ranges it did not record.
  it('startResume over the crash snapshot restores exactly the recorded ranges and is idempotent for untouched apps', async () => {
    const saves: EstatePauseSnapshot[] = [];
    const inc = withIncrementalSnapshot(
      fakeActuator(async (name) => { if (name === 'app-3') throw new Error('process died'); }),
      base,
      async (s) => { saves.push(structuredClone(s)); },
    );
    await expect(startPause(plan(), inc.actuator, startCtx())).rejects.toThrow();
    const resumed: string[] = [];
    const act = fakeActuator(async () => {});
    act.resume = vi.fn(async (e) => { resumed.push(`${e.name}:${e.scale?.minReplicas}/${e.scale?.maxReplicas}`); return { ok: true, detail: 'ok' }; });
    const run = await startResume(saves[saves.length - 1], act);
    expect(run.snapshot.state).toBe('RESUMING');
    expect(resumed.sort()).toEqual(['app-1:1/3', 'app-2:2/2', 'app-3:1/5']);
  });
});

describe('a pause that moved nothing does not leave a PAUSING record', () => {
  // Breaks if: discard writes an empty RUNNING record over the previous one (losing lastResumedAt, the idle clock).
  it('discard restores the PREVIOUS snapshot verbatim, resume timestamp included', async () => {
    const saved: EstatePauseSnapshot[] = [];
    const prev = { id: 'old', tenantId: 't1', estateId: ESTATE, state: 'RUNNING', resources: [], resumeConfirmedAt: '2026-10-22T00:00:00.000Z' } as unknown as EstatePauseSnapshot;
    await discardPauseProgress(prev, base, async (s) => { saved.push(s); });
    expect(saved).toEqual([prev]);
  });

  it('with no previous snapshot it writes an EMPTY RUNNING record, never PAUSING', async () => {
    const saved: EstatePauseSnapshot[] = [];
    await discardPauseProgress(null, base, async (s) => { saved.push(s); });
    expect(saved[0]).toMatchObject({ state: 'RUNNING', resources: [] });
  });

  it('wasPersisted() is false until a record is written (so a run that never reached a mutation writes nothing)', async () => {
    const inc = withIncrementalSnapshot(fakeActuator(async () => {}), base, async () => {});
    expect(inc.wasPersisted()).toBe(false);
    await startPause(plan(), inc.actuator, startCtx());
    expect(inc.wasPersisted()).toBe(true);
  });
});
