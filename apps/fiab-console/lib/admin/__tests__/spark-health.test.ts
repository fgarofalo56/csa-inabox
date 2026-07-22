/**
 * A10 — Spark pool health mapping (lib/admin/spark-health.ts).
 *
 * Pure-function coverage of the classification the Spark pools tab renders:
 * FAULTED / suspect detection, leak-candidate + busy-zombie classification
 * (mirrors the reaper's rules), the vCore ladder, and the pool summary join.
 */
import { describe, it, expect } from 'vitest';
import {
  poolHealthState,
  breakerArmed,
  poolMaxNodes,
  poolMaxVCores,
  isCapacityHoldingState,
  isPoolOwnedSessionName,
  classifyLiveSessions,
  summarizePool,
} from '@/lib/admin/spark-health';
import type { GroupStatus } from '@/lib/azure/spark-session-pool';
import type { SparkPool } from '@/lib/azure/synapse-dev-client';
import type { LivySession } from '@/lib/azure/synapse-livy-client';

function group(over: Partial<GroupStatus> = {}): GroupStatus {
  return {
    key: 'synapse|loompool2|pyspark|s',
    backend: 'synapse',
    poolName: 'loompool2',
    kind: 'pyspark',
    sizingKey: 's',
    warm: 1,
    leased: 0,
    shared: 0,
    warming: 0,
    target: 1,
    sessions: [],
    ...over,
  };
}

function armPool(over: Partial<SparkPool['properties']> = {}, name = 'loompool2'): SparkPool {
  return {
    name,
    id: `/subscriptions/x/resourceGroups/rg/providers/Microsoft.Synapse/workspaces/ws/bigDataPools/${name}`,
    properties: {
      nodeSize: 'Small',
      sparkVersion: '3.4',
      provisioningState: 'Succeeded',
      autoScale: { enabled: true, minNodeCount: 3, maxNodeCount: 10 },
      autoPause: { enabled: true, delayInMinutes: 15 },
      ...over,
    },
  };
}

describe('poolHealthState (FAULTED detection)', () => {
  it('hard ARM faults → faulted', () => {
    expect(poolHealthState('Failed')).toBe('faulted');
    expect(poolHealthState('Canceled')).toBe('faulted');
    expect(poolHealthState('Faulted')).toBe('faulted');
  });

  it('Succeeded + healthy groups → ready', () => {
    expect(poolHealthState('Succeeded', [group()])).toBe('ready');
    expect(poolHealthState('Succeeded')).toBe('ready');
  });

  it('the "Succeeded but can\'t launch" flavor → suspect when the breaker is armed', () => {
    // 2026-07-12 FAULTED + 2026-07-14 name-wedge: ARM stays green while
    // launches fail — the armed circuit breaker is the only visible signal.
    expect(poolHealthState('Succeeded', [group({ consecFails: 3 })])).toBe('suspect');
    expect(poolHealthState('Succeeded', [group({ backoffUntil: Date.now() + 60_000 })])).toBe('suspect');
    expect(poolHealthState('Succeeded', [group({ lastFailure: 'MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED' })])).toBe('suspect');
  });

  it('transitional + unknown states', () => {
    expect(poolHealthState('Provisioning')).toBe('provisioning');
    expect(poolHealthState('Updating')).toBe('provisioning');
    expect(poolHealthState('Deleting')).toBe('deleting');
    expect(poolHealthState(undefined)).toBe('unknown');
  });
});

describe('breakerArmed', () => {
  it('is false for a healthy group and true for any armed signal', () => {
    expect(breakerArmed(group())).toBe(false);
    expect(breakerArmed(group({ consecFails: 1 }))).toBe(true);
    expect(breakerArmed(group({ lastFailure: 'boom' }))).toBe(true);
  });
});

describe('capacity (vCore ladder)', () => {
  it('autoscale pools use max node count', () => {
    const p = armPool();
    expect(poolMaxNodes(p.properties)).toBe(10);
    expect(poolMaxVCores(p.properties)).toBe(40); // Small = 4 vCores/node
  });

  it('fixed pools use nodeCount; unknown sizes are honest 0', () => {
    expect(poolMaxVCores({ nodeSize: 'Medium', nodeCount: 5, autoScale: undefined })).toBe(40);
    expect(poolMaxVCores({ nodeSize: 'Weird' as never, nodeCount: 5 })).toBe(0);
  });
});

describe('leak classification (reaper mirror)', () => {
  it('capacity-holding states match the reaper', () => {
    for (const s of ['idle', 'not_started', 'starting', 'recovering']) {
      expect(isCapacityHoldingState(s)).toBe(true);
    }
    expect(isCapacityHoldingState('busy')).toBe(false);
    expect(isCapacityHoldingState('error')).toBe(false);
  });

  it('pool-owned session names', () => {
    expect(isPoolOwnedSessionName('loom-warmpool-abc')).toBe(true);
    expect(isPoolOwnedSessionName('user-notebook')).toBe(false);
    expect(isPoolOwnedSessionName(null)).toBe(false);
  });

  it('classifies tracked / leak-candidate / busy-zombie / benign untracked', () => {
    const live: LivySession[] = [
      { id: 1, state: 'idle' }, // tracked warm slot
      { id: 2, state: 'idle', name: 'orphan' }, // untracked idle → leak (#1796)
      { id: 3, state: 'not_started', name: 'loom-warmpool-x' }, // queued zombie (2026-07-14)
      { id: 4, state: 'busy', name: 'loom-warmpool-y' }, // busy zombie (80-core class)
      { id: 5, state: 'busy', name: 'user-run' }, // real user work — NOT a leak
      { id: 6, state: 'error', name: 'dead', errorInfo: [{ errorCode: 'MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED' }] },
    ];
    const groups = [group({
      sessions: [{ leaseId: 'l1', state: 'warm', sessionId: 1, leaseCount: 0, ageSecs: 120, idleSecs: 30 }],
    })];
    const rows = classifyLiveSessions(live, groups);
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(1)).toMatchObject({ tracked: true, leakSuspect: false, ageSecs: 120, idleSecs: 30 });
    expect(byId.get(2)).toMatchObject({ tracked: false, leakSuspect: true, busyZombieSuspect: false });
    expect(byId.get(3)).toMatchObject({ leakSuspect: true, busyZombieSuspect: false });
    expect(byId.get(4)).toMatchObject({ leakSuspect: true, busyZombieSuspect: true });
    expect(byId.get(5)).toMatchObject({ tracked: false, leakSuspect: false, busyZombieSuspect: false });
    // Terminal error session: not capacity-holding, but its REAL errorInfo surfaces.
    expect(byId.get(6)).toMatchObject({ leakSuspect: false, error: 'MAX_QUEUED_JOBS_PER_COMPUTE_EXCEEDED' });
  });
});

describe('summarizePool (the dashboard row join)', () => {
  it('joins ARM + groups + live census', () => {
    const groups = [
      group({
        warm: 2, leased: 1, warming: 1, lastFailure: 'queue jam', consecFails: 2,
        sessions: [{ leaseId: 'l1', state: 'warm', sessionId: 1, leaseCount: 0, ageSecs: 60, idleSecs: 10 }],
      }),
      group({ key: 'other', poolName: 'otherpool', warm: 9 }), // different pool — excluded
    ];
    const live: LivySession[] = [
      { id: 1, state: 'idle' },
      { id: 2, state: 'idle', name: 'orphan' },
    ];
    const s = summarizePool(armPool(), groups, { sessions: live });
    expect(s.name).toBe('loompool2');
    expect(s.healthState).toBe('suspect'); // Succeeded + armed breaker
    expect(s.warm).toBe(2);
    expect(s.leased).toBe(1);
    expect(s.warming).toBe(1);
    expect(s.maxVCores).toBe(40);
    expect(s.autoScale).toEqual({ enabled: true, min: 3, max: 10 });
    expect(s.autoPauseMinutes).toBe(15);
    expect(s.lastFailure).toBe('queue jam');
    expect(s.liveTotal).toBe(2);
    expect(s.leakSuspects).toBe(1);
  });

  it('propagates a Livy census failure honestly (no fake empty table)', () => {
    const s = summarizePool(armPool(), [], { error: '403 from public runner' });
    expect(s.sessions).toBeUndefined();
    expect(s.leakSuspects).toBeUndefined();
    expect(s.sessionsError).toBe('403 from public runner');
  });

  it('a faulted ARM state wins over healthy groups', () => {
    const s = summarizePool(armPool({ provisioningState: 'Failed' }), [group()]);
    expect(s.healthState).toBe('faulted');
  });
});
