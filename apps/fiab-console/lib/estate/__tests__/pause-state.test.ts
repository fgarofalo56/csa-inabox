/**
 * ESTATE PAUSE/RESUME — state-machine and snapshot tests.
 *
 * The load-bearing assertions here:
 *
 *   • RESUME_FAILED does not collapse into RUNNING (R-CAP-4). There is no
 *     transition RESUME_FAILED -> RUNNING, and `deriveResumeState` returns
 *     RESUME_FAILED for `unknown` — not just for a confirmed failure.
 *   • The snapshot round-trips: serialize -> deserialize -> deep-equal.
 *   • A snapshot whose power state did NOT come from ARM is REFUSED on read.
 *
 * All ids are obviously-fake placeholders.
 */
import { describe, it, expect } from 'vitest';
import {
  ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION,
  ESTATE_PAUSE_STATES,
  ESTATE_POWER_STATES,
  RESUME_SUCCESS_CONFIRMATIONS,
  allowedTransitions,
  armPowerReading,
  assertTransition,
  canTransition,
  capturePrePauseState,
  confirmResume,
  deriveResumeState,
  deserializePauseSnapshot,
  isPausedState,
  isResumeSuccess,
  isRunningState,
  newPauseSnapshot,
  serializePauseSnapshot,
  type ArmPowerReading,
  type EstatePauseSnapshot,
  type EstatePauseState,
  type EstatePowerState,
  type LoomOwnershipEvidence,
  type PausedResourceSnapshot,
  type ResumeOutcome,
} from '../pause-state';

const SUB = '11111111-1111-1111-1111-111111111111';
const ESTATE = 'loom-commercial-centralus';
const POOL_ID = `/subscriptions/${SUB}/resourceGroups/rg-csa-loom-dlz-default-centralus/providers/Microsoft.Synapse/workspaces/syn-loom-default/sqlPools/loompool`;
const ADX_ID = `/subscriptions/${SUB}/resourceGroups/rg-csa-loom-dlz-default-centralus/providers/Microsoft.Kusto/clusters/adx-loom-default`;

const OWNED: LoomOwnershipEvidence = {
  verdict: 'loom-owned',
  source: 'ownership-tag',
  tagKey: 'loom-estate-id',
  tagValue: ESTATE,
  reason: `loompool carries loom-estate-id='${ESTATE}'.`,
};

function poolSnapshot(): PausedResourceSnapshot {
  return capturePrePauseState({
    resourceId: POOL_ID,
    resourceType: 'Microsoft.Synapse/workspaces/sqlPools',
    name: 'loompool',
    resourceGroup: 'rg-csa-loom-dlz-default-centralus',
    subscriptionId: SUB,
    location: 'centralus',
    reading: armPowerReading({
      resourceId: POOL_ID,
      powerState: 'Online',
      armApiVersion: '2021-06-01',
      readAt: '2026-08-22T20:22:00.000Z',
    }),
    sku: { name: 'DW200c', tier: 'DataWarehouse', capacity: 200 },
    fallbackSku: { name: 'DW100c', tier: 'DataWarehouse', capacity: 100, reason: 'Region capacity unavailable on resume.' },
    ownership: OWNED,
  });
}

function adxSnapshot(): PausedResourceSnapshot {
  return capturePrePauseState({
    resourceId: ADX_ID,
    resourceType: 'Microsoft.Kusto/clusters',
    name: 'adx-loom-default',
    resourceGroup: 'rg-csa-loom-dlz-default-centralus',
    subscriptionId: SUB,
    reading: armPowerReading({ resourceId: ADX_ID, powerState: 'Online', armApiVersion: '2023-08-15' }),
    sku: { name: 'Standard_E8ads_v5', tier: 'Standard', capacity: 2 },
    replicaCount: 2,
    ownership: { ...OWNED, reason: 'adx-loom-default carries loom-estate-id.' },
  });
}

function fullSnapshot(): EstatePauseSnapshot {
  const snap = newPauseSnapshot({
    id: 'snap-placeholder-0001',
    tenantId: 'oid-placeholder-0001',
    estateId: ESTATE,
    createdBy: 'operator@example.invalid',
    now: '2026-08-22T20:20:00.000Z',
  });
  snap.resources = [poolSnapshot(), adxSnapshot()];
  snap.state = 'PAUSED';
  snap.pausedAt = '2026-08-22T20:25:00.000Z';
  snap.updatedAt = '2026-08-22T20:25:00.000Z';
  return snap;
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('the estate state machine', () => {
  it('has exactly the five states', () => {
    expect([...ESTATE_PAUSE_STATES].sort()).toEqual(
      ['PAUSED', 'PAUSING', 'RESUMING', 'RESUME_FAILED', 'RUNNING'].sort(),
    );
  });

  it('walks the happy path RUNNING -> PAUSING -> PAUSED -> RESUMING -> RUNNING', () => {
    expect(canTransition('RUNNING', 'PAUSING')).toBe(true);
    expect(canTransition('PAUSING', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'RESUMING')).toBe(true);
    expect(canTransition('RESUMING', 'RUNNING')).toBe(true);
  });

  it('R-CAP-4: RESUME_FAILED does NOT collapse into RUNNING', () => {
    // This is the whole point of the state. An unconfirmed resume cannot be
    // cleared by declaring the estate healthy.
    expect(canTransition('RESUME_FAILED', 'RUNNING')).toBe(false);
    expect(() => assertTransition('RESUME_FAILED', 'RUNNING')).toThrow(
      /Illegal estate transition RESUME_FAILED -> RUNNING/,
    );
  });

  it('R-CAP-4: the ONLY way out of RESUME_FAILED is another RESUMING attempt', () => {
    expect([...allowedTransitions('RESUME_FAILED')]).toEqual(['RESUMING']);
    for (const to of ESTATE_PAUSE_STATES) {
      if (to === 'RESUMING') continue;
      expect(canTransition('RESUME_FAILED', to)).toBe(false);
    }
  });

  it('RESUMING can only land in RUNNING or RESUME_FAILED', () => {
    expect([...allowedTransitions('RESUMING')].sort()).toEqual(['RESUME_FAILED', 'RUNNING']);
  });

  it('RUNNING cannot jump straight to PAUSED, RESUMING, or RESUME_FAILED', () => {
    for (const to of ['PAUSED', 'RESUMING', 'RESUME_FAILED'] as EstatePauseState[]) {
      expect(canTransition('RUNNING', to)).toBe(false);
    }
  });

  it('PAUSED cannot go straight back to RUNNING without a resume', () => {
    expect(canTransition('PAUSED', 'RUNNING')).toBe(false);
  });

  it('a partial pause stays PAUSING, and resume is always available as the safe direction', () => {
    expect(canTransition('PAUSING', 'PAUSING')).toBe(true);
    expect(canTransition('PAUSING', 'RESUMING')).toBe(true);
  });

  it('assertTransition passes a legal move', () => {
    expect(() => assertTransition('PAUSED', 'RESUMING')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Resume confirmation — unknown is NOT success
// ---------------------------------------------------------------------------

describe('confirmResume', () => {
  const pool = poolSnapshot();

  it('confirms a resource ARM reports Online', () => {
    const o = confirmResume(pool, armPowerReading({ resourceId: POOL_ID, powerState: 'Online', armApiVersion: '2021-06-01' }));
    expect(o.confirmation).toBe('confirmed-running');
  });

  it('a NULL reading is UNKNOWN, never a success', () => {
    const o = confirmResume(pool, null, 'ARM GET timed out after 30s');
    expect(o.confirmation).toBe('unknown');
    expect(isResumeSuccess(o.confirmation)).toBe(false);
    expect(o.reason).toMatch(/ARM GET timed out/);
    expect(o.reason).toMatch(/NOT established/);
  });

  it('an explicit Unknown power state is UNKNOWN, never a success', () => {
    const o = confirmResume(pool, armPowerReading({ resourceId: POOL_ID, powerState: 'Unknown', armApiVersion: '2021-06-01' }));
    expect(o.confirmation).toBe('unknown');
  });

  it('a mid-flight Resuming state is NOT a success', () => {
    const o = confirmResume(pool, armPowerReading({ resourceId: POOL_ID, powerState: 'Resuming', armApiVersion: '2021-06-01' }));
    expect(o.confirmation).toBe('confirmed-mismatch');
    expect(o.observedState).toBe('Resuming');
  });

  it('a reading for a DIFFERENT resource says nothing about this one', () => {
    const o = confirmResume(pool, armPowerReading({ resourceId: ADX_ID, powerState: 'Online', armApiVersion: '2023-08-15' }));
    expect(o.confirmation).toBe('unknown');
    expect(o.reason).toMatch(/says nothing about this resource/);
  });

  it('a resource that was ALREADY paused is restored to paused — and is NOT reported running', () => {
    const alreadyPaused: PausedResourceSnapshot = { ...pool, prePausePowerState: 'Paused' };
    const ok = confirmResume(
      alreadyPaused,
      armPowerReading({ resourceId: POOL_ID, powerState: 'Paused', armApiVersion: '2021-06-01' }),
    );
    // A correct outcome, but a DISTINCT member: a consumer branching on
    // 'confirmed-running' must not render this stopped resource as running.
    expect(ok.confirmation).toBe('confirmed-restored-paused');
    expect(ok.confirmation).not.toBe('confirmed-running');
    expect(isResumeSuccess(ok.confirmation)).toBe(true);
    expect(ok.observedState).toBe('Paused');
    expect(ok.reason).toMatch(/It is NOT running/);

    // ...and starting it would be WRONG, so Online is a mismatch, not a success.
    const wrong = confirmResume(
      alreadyPaused,
      armPowerReading({ resourceId: POOL_ID, powerState: 'Online', armApiVersion: '2021-06-01' }),
    );
    expect(wrong.confirmation).toBe('confirmed-mismatch');
    expect(isResumeSuccess(wrong.confirmation)).toBe(false);
  });

  it('every non-unknown confirmation that is a success carries a non-Online observedState only for restored-paused', () => {
    // Guards the rename's whole purpose: 'confirmed-running' must NEVER be
    // returned alongside an observedState that is not Online.
    const cases: Array<[EstatePowerState, EstatePowerState]> = [
      ['Online', 'Online'],
      ['Online', 'Paused'],
      ['Online', 'Stopped'],
      ['Paused', 'Paused'],
      ['Paused', 'Online'],
      ['Stopped', 'Deallocated'],
    ];
    for (const [pre, observed] of cases) {
      const snap: PausedResourceSnapshot = { ...pool, prePausePowerState: pre };
      const o = confirmResume(snap, armPowerReading({ resourceId: POOL_ID, powerState: observed, armApiVersion: '2021-06-01' }));
      if (o.confirmation === 'confirmed-running') expect(o.observedState).toBe('Online');
    }
  });
});

// ---------------------------------------------------------------------------
// The GCC-High ADX incident this PRP was written around (PR #3897 review BLOCKER)
// ---------------------------------------------------------------------------

describe('BLOCKER regression: an Unknown pre-pause state can never score as success', () => {
  const unknownPre: PausedResourceSnapshot = { ...poolSnapshot(), prePausePowerState: 'Unknown' };

  it('prePausePowerState=Unknown + ARM observes Stopped is NOT confirmed-running', () => {
    // The exact probe from review. Previously: confirmation=confirmed-running,
    // observedState=Stopped, ESTATE STATE=RUNNING — R-CAP-4's forbidden outcome
    // on the very scenario R-CAP exists for (resume fails with
    // InsufficientResourcesForSubscription, ARM reports Stopped).
    const o = confirmResume(
      unknownPre,
      armPowerReading({ resourceId: POOL_ID, powerState: 'Stopped', armApiVersion: '2021-06-01' }),
    );
    expect(o.confirmation).not.toBe('confirmed-running');
    expect(o.confirmation).not.toBe('confirmed-restored-paused');
    expect(isResumeSuccess(o.confirmation)).toBe(false);
    expect(o.confirmation).toBe('unknown');
    expect(o.reason).toMatch(/pre-pause power state .* was never established/);
  });

  it('and the ESTATE lands in RESUME_FAILED, not RUNNING', () => {
    const snap = { resources: [unknownPre] };
    const outcome = confirmResume(
      unknownPre,
      armPowerReading({ resourceId: POOL_ID, powerState: 'Stopped', armApiVersion: '2021-06-01' }),
    );
    const derived = deriveResumeState(snap, [outcome]);
    expect(derived.state).toBe('RESUME_FAILED');
  });

  it('no observed state whatsoever rescues an Unknown pre-pause state', () => {
    for (const observed of ESTATE_POWER_STATES) {
      const o = confirmResume(
        unknownPre,
        armPowerReading({ resourceId: POOL_ID, powerState: observed, armApiVersion: '2021-06-01' }),
      );
      expect(isResumeSuccess(o.confirmation)).toBe(false);
    }
  });

  it('the branch is unreachable via capture: an Unknown reading is REFUSED at snapshot time', () => {
    expect(() =>
      capturePrePauseState({
        resourceId: POOL_ID,
        resourceType: 'Microsoft.Synapse/workspaces/sqlPools',
        name: 'loompool',
        resourceGroup: 'rg-csa-loom-dlz-default-centralus',
        subscriptionId: SUB,
        reading: armPowerReading({ resourceId: POOL_ID, powerState: 'Unknown', armApiVersion: '2021-06-01' }),
        ownership: OWNED,
      }),
    ).toThrow(/did not report a recognised power state/);
  });

  it('and unreachable via deserialize: an Unknown pre-pause state is REFUSED on read', () => {
    const snap = fullSnapshot();
    const doc = JSON.parse(serializePauseSnapshot(snap));
    doc.resources[0].prePausePowerState = 'Unknown';
    expect(() => deserializePauseSnapshot(doc)).toThrow(/cannot be restored to/);
  });

  it('`!isRunningState` and `isPausedState` are NOT the same predicate — the root cause', () => {
    // The bug was using the former where the latter was meant. These four states
    // satisfy `!isRunningState` while NOT being paused; each would have taken
    // the "restore to paused" branch.
    for (const s of ['Unknown', 'Resuming', 'Starting', 'Scaling'] as const) {
      expect(isRunningState(s)).toBe(false);
      expect(isPausedState(s)).toBe(false);
    }
  });

  it('a TRANSITIONAL pre-pause state expects Online, not Paused', () => {
    // The same predicate bug, on the three states that are not Unknown. A
    // resource caught mid-start before the pause must come back Online; the old
    // `!isRunningState` branch would have scored it a success for being Stopped.
    for (const pre of ['Starting', 'Resuming', 'Scaling'] as const) {
      const snap: PausedResourceSnapshot = { ...poolSnapshot(), prePausePowerState: pre };
      const stopped = confirmResume(
        snap,
        armPowerReading({ resourceId: POOL_ID, powerState: 'Stopped', armApiVersion: '2021-06-01' }),
      );
      expect(stopped.confirmation).toBe('confirmed-mismatch');
      expect(isResumeSuccess(stopped.confirmation)).toBe(false);

      const online = confirmResume(
        snap,
        armPowerReading({ resourceId: POOL_ID, powerState: 'Online', armApiVersion: '2021-06-01' }),
      );
      expect(online.confirmation).toBe('confirmed-running');
    }
  });
});

describe('deriveResumeState (R-CAP-4)', () => {
  const snap = fullSnapshot();
  const ok = (id: string): ResumeOutcome => ({
    resourceId: id,
    confirmation: 'confirmed-running',
    observedState: 'Online',
    reason: 'ARM reports Online.',
  });

  it('RUNNING only when EVERY resource is confirmed running', () => {
    const r = deriveResumeState(snap, [ok(POOL_ID), ok(ADX_ID)]);
    expect(r.state).toBe('RUNNING');
    expect(r.unconfirmed).toHaveLength(0);
  });

  it('a single UNKNOWN makes the whole estate RESUME_FAILED', () => {
    const r = deriveResumeState(snap, [
      ok(POOL_ID),
      { resourceId: ADX_ID, confirmation: 'unknown', reason: 'ARM read failed.' },
    ]);
    expect(r.state).toBe('RESUME_FAILED');
    expect(r.unconfirmed.map((u) => u.resourceId)).toEqual([ADX_ID]);
    expect(r.reason).toMatch(/an unconfirmed resume is not a successful one/);
  });

  it('a single confirmed-mismatch makes the estate RESUME_FAILED', () => {
    const r = deriveResumeState(snap, [
      ok(POOL_ID),
      { resourceId: ADX_ID, confirmation: 'confirmed-mismatch', observedState: 'Stopped', reason: 'Still stopped.' },
    ]);
    expect(r.state).toBe('RESUME_FAILED');
  });

  it('confirmed-restored-paused counts as success — a legitimately paused resource does not fail the estate', () => {
    const r = deriveResumeState(snap, [
      ok(POOL_ID),
      { resourceId: ADX_ID, confirmation: 'confirmed-restored-paused', observedState: 'Paused', reason: 'Back to pre-pause.' },
    ]);
    expect(r.state).toBe('RUNNING');
    expect(r.unconfirmed).toHaveLength(0);
  });

  it('the success set is exactly the two confirmed-at-expected-state members', () => {
    expect([...RESUME_SUCCESS_CONFIRMATIONS].sort()).toEqual(
      ['confirmed-restored-paused', 'confirmed-running'].sort(),
    );
    expect(isResumeSuccess('confirmed-mismatch')).toBe(false);
    expect(isResumeSuccess('unknown')).toBe(false);
  });

  it('a resource with NO outcome at all is RESUME_FAILED, not silently ignored', () => {
    // A confirmation loop that skipped a resource must not be able to pass.
    const r = deriveResumeState(snap, [ok(POOL_ID)]);
    expect(r.state).toBe('RESUME_FAILED');
    expect(r.unconfirmed).toHaveLength(1);
    expect(r.unconfirmed[0].confirmation).toBe('unknown');
    expect(r.unconfirmed[0].reason).toMatch(/No confirmation was attempted/);
  });

  it('an EMPTY outcome list against a non-empty snapshot is RESUME_FAILED', () => {
    // `[].every(...)` is vacuously true — the zero-population trap. Checked
    // against the SNAPSHOT's resource count, not the outcome list's.
    const r = deriveResumeState(snap, []);
    expect(r.state).toBe('RESUME_FAILED');
    expect(r.unconfirmed).toHaveLength(2);
  });

  it('outcomes for resources NOT in the snapshot cannot mask a missing one', () => {
    const strayId = `/subscriptions/${SUB}/resourceGroups/rg-other/providers/Microsoft.App/containerApps/stray`;
    const r = deriveResumeState(snap, [ok(POOL_ID), ok(strayId), ok(strayId)]);
    expect(r.state).toBe('RESUME_FAILED');
    expect(r.unconfirmed.map((u) => u.resourceId)).toEqual([ADX_ID]);
  });

  it('an empty snapshot resumes to RUNNING — nothing was ever paused', () => {
    const r = deriveResumeState({ resources: [] }, []);
    expect(r.state).toBe('RUNNING');
    expect(r.reason).toMatch(/nothing to resume/);
  });

  it('the RESUME_FAILED verdict is a legal transition out of RESUMING', () => {
    const r = deriveResumeState(snap, []);
    expect(() => assertTransition('RESUMING', r.state)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Power-state helpers
// ---------------------------------------------------------------------------

describe('power-state predicates', () => {
  it('Unknown is neither running nor paused', () => {
    expect(isRunningState('Unknown')).toBe(false);
    expect(isPausedState('Unknown')).toBe(false);
  });

  it('only Online counts as running; transitional states do not', () => {
    expect(isRunningState('Online')).toBe(true);
    for (const s of ['Starting', 'Resuming', 'Scaling', 'Pausing'] as const) {
      expect(isRunningState(s)).toBe(false);
    }
  });

  it('Paused, Stopped and Deallocated all count as paused', () => {
    for (const s of ['Paused', 'Stopped', 'Deallocated'] as const) expect(isPausedState(s)).toBe(true);
  });
});

describe('armPowerReading — the ARM-only brand (PRP §3c)', () => {
  it('requires an ARM api-version, so a reading with no ARM call cannot be minted', () => {
    expect(() => armPowerReading({ resourceId: POOL_ID, powerState: 'Online', armApiVersion: '' })).toThrow(
      /requires the ARM api-version/,
    );
  });

  it('requires a resourceId', () => {
    expect(() => armPowerReading({ resourceId: '', powerState: 'Online', armApiVersion: '2021-06-01' })).toThrow(
      /requires a resourceId/,
    );
  });

  it('records the api-version so a snapshot shows the provenance of its state', () => {
    const s = poolSnapshot();
    expect(s.powerStateSource).toBe('arm');
    expect(s.powerStateApiVersion).toBe('2021-06-01');
    expect(s.powerStateReadAt).toBe('2026-08-22T20:22:00.000Z');
  });

  it('the brand is not serialized — a persisted reading cannot forge it', () => {
    const reading = armPowerReading({ resourceId: POOL_ID, powerState: 'Online', armApiVersion: '2021-06-01' });
    expect(Object.getOwnPropertySymbols(reading)).toHaveLength(0);
    expect(Object.keys(reading).sort()).toEqual(['armApiVersion', 'powerState', 'readAt', 'resourceId']);
  });

  it('a hand-written object is NOT assignable to ArmPowerReading (compile-time)', () => {
    // The @ts-expect-error IS the assertion. If the brand is ever weakened —
    // made optional, or dropped — this literal becomes assignable, the directive
    // has nothing to suppress, and `tsc` fails on THIS LINE. That is what stops
    // a caller from fabricating an "ARM" reading out of a Resource Graph row.
    // @ts-expect-error - ArmPowerReading is branded; armPowerReading() is the only constructor.
    const forged: ArmPowerReading = {
      resourceId: POOL_ID,
      powerState: 'Online',
      readAt: '2026-08-22T20:22:00.000Z',
      armApiVersion: '2021-06-01',
    };
    // Runtime behaviour is unchanged — confirmResume would accept it; the guard
    // is that no code can be WRITTEN this way and still compile.
    expect(confirmResume(poolSnapshot(), forged).confirmation).toBe('confirmed-running');
  });
});

// ---------------------------------------------------------------------------
// capturePrePauseState
// ---------------------------------------------------------------------------

describe('capturePrePauseState', () => {
  it('refuses a reading that belongs to a different resource', () => {
    expect(() =>
      capturePrePauseState({
        resourceId: POOL_ID,
        resourceType: 'Microsoft.Synapse/workspaces/sqlPools',
        name: 'loompool',
        resourceGroup: 'rg-csa-loom-dlz-default-centralus',
        subscriptionId: SUB,
        reading: armPowerReading({ resourceId: ADX_ID, powerState: 'Online', armApiVersion: '2023-08-15' }),
        ownership: OWNED,
      }),
    ).toThrow(/would record another resource's power state/);
  });

  it('refuses to snapshot a resource that is not positively Loom-owned', () => {
    for (const verdict of ['not-loom-owned', 'indeterminate'] as const) {
      expect(() =>
        capturePrePauseState({
          resourceId: POOL_ID,
          resourceType: 'Microsoft.Synapse/workspaces/sqlPools',
          name: 'loompool',
          resourceGroup: 'rg-csa-loom-dlz-default-centralus',
          subscriptionId: SUB,
          reading: armPowerReading({ resourceId: POOL_ID, powerState: 'Online', armApiVersion: '2021-06-01' }),
          ownership: { verdict, source: 'none', reason: 'no evidence' },
        }),
      ).toThrow(/refusing to snapshot/);
    }
  });

  it('captures SKU, replicas and the declared R-CAP-1 fallback', () => {
    const pool = poolSnapshot();
    expect(pool.sku).toEqual({ name: 'DW200c', tier: 'DataWarehouse', capacity: 200 });
    expect(pool.fallbackSku?.name).toBe('DW100c');
    expect(adxSnapshot().replicaCount).toBe(2);
  });

  it('normalises the ARM type to lower case', () => {
    expect(poolSnapshot().resourceType).toBe('microsoft.synapse/workspaces/sqlpools');
  });
});

// ---------------------------------------------------------------------------
// The snapshot document — round-trip
// ---------------------------------------------------------------------------

describe('snapshot serialization', () => {
  it('round-trips: serialize -> deserialize -> deep-equal', () => {
    const snap = fullSnapshot();
    const back = deserializePauseSnapshot(serializePauseSnapshot(snap));
    expect(back).toEqual(snap);
  });

  it('round-trips a snapshot carrying resume outcomes', () => {
    const snap = fullSnapshot();
    snap.state = 'RESUME_FAILED';
    snap.resumeStartedAt = '2026-08-22T21:00:00.000Z';
    snap.resumeOutcomes = [
      { resourceId: POOL_ID, confirmation: 'confirmed-running', observedState: 'Online', reason: 'ARM reports Online.' },
      { resourceId: ADX_ID, confirmation: 'unknown', reason: 'ARM read failed.' },
    ];
    const back = deserializePauseSnapshot(serializePauseSnapshot(snap));
    expect(back).toEqual(snap);
    expect(back.state).toBe('RESUME_FAILED');
  });

  it('serialize is a fixed point — a Cosmos round-trip does not mutate the document', () => {
    const once = serializePauseSnapshot(fullSnapshot());
    const twice = serializePauseSnapshot(deserializePauseSnapshot(once));
    expect(twice).toBe(once);
  });

  it('stamps the current schema version on a new snapshot', () => {
    const snap = newPauseSnapshot({ id: 'snap-placeholder-0002', tenantId: 'oid-placeholder-0001', estateId: ESTATE });
    expect(snap.schemaVersion).toBe(ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION);
    expect(snap.state).toBe('PAUSING');
    expect(snap.resources).toEqual([]);
  });

  it('follows the AppInstallJob convention: uuid id + tenantId partition key + ISO timestamps', () => {
    const snap = newPauseSnapshot({
      id: 'snap-placeholder-0003',
      tenantId: 'oid-placeholder-0001',
      estateId: ESTATE,
      now: '2026-08-22T20:20:00.000Z',
    });
    expect(snap.tenantId).toBe('oid-placeholder-0001');
    expect(snap.createdAt).toBe('2026-08-22T20:20:00.000Z');
    expect(snap.updatedAt).toBe('2026-08-22T20:20:00.000Z');
  });
});

describe('deserializePauseSnapshot refuses what it cannot establish', () => {
  it('rejects a document with no schemaVersion', () => {
    const { schemaVersion: _drop, ...rest } = fullSnapshot();
    expect(() => deserializePauseSnapshot(rest)).toThrow(/no numeric schemaVersion/);
  });

  it('rejects a NEWER schema version rather than mis-reading it', () => {
    const snap = { ...fullSnapshot(), schemaVersion: ESTATE_PAUSE_SNAPSHOT_SCHEMA_VERSION + 1 };
    expect(() => deserializePauseSnapshot(snap)).toThrow(/newer than this build understands/);
  });

  it('bounds the schema version at BOTH ends — 0, -1 and 0.5 are refused', () => {
    // Previously only the top was bounded, so all three were ACCEPTED (#3897
    // review). None names a shape this build has ever written.
    for (const version of [0, -1, 0.5, Number.NaN]) {
      const snap = { ...fullSnapshot(), schemaVersion: version };
      expect(() => deserializePauseSnapshot(snap)).toThrow(/not a positive integer/);
    }
  });

  it('accepts the current version (the control for the bound above)', () => {
    expect(() => deserializePauseSnapshot(serializePauseSnapshot(fullSnapshot()))).not.toThrow();
  });

  it('rejects a missing estateId — the scope would be unknown', () => {
    const snap = { ...fullSnapshot(), estateId: '' };
    expect(() => deserializePauseSnapshot(snap)).toThrow(/no estateId/);
  });

  it('rejects a missing tenantId partition key', () => {
    const snap = { ...fullSnapshot(), tenantId: '' };
    expect(() => deserializePauseSnapshot(snap)).toThrow(/no tenantId/);
  });

  it('rejects an unknown state string', () => {
    const snap = { ...fullSnapshot(), state: 'RESUMED_PROBABLY' };
    expect(() => deserializePauseSnapshot(snap)).toThrow(/unknown state/);
  });

  it('PRP §3c: rejects a resource whose power state did NOT come from ARM', () => {
    const snap = fullSnapshot();
    const doc = JSON.parse(serializePauseSnapshot(snap));
    doc.resources[0].powerStateSource = 'resource-graph';
    expect(() => deserializePauseSnapshot(doc)).toThrow(/Only 'arm' is accepted/);
    expect(() => deserializePauseSnapshot(doc)).toThrow(/measured reporting a Synapse pool Online/);
  });

  it('rejects a prePausePowerState that is not a recognised power state', () => {
    // The docstring claims this function "rejects — never guesses at — a
    // document it cannot establish the meaning of". Before the #3897 review it
    // validated resourceId + powerStateSource and then CAST, so a bogus power
    // state was accepted and flowed straight into confirmResume's branching.
    const doc = JSON.parse(serializePauseSnapshot(fullSnapshot()));
    doc.resources[0].prePausePowerState = 'TOTALLY_BOGUS';
    expect(() => deserializePauseSnapshot(doc)).toThrow(/not a recognised power state/);
  });

  it('accepts every legitimate power state except Unknown (the control)', () => {
    for (const s of ESTATE_POWER_STATES) {
      const doc = JSON.parse(serializePauseSnapshot(fullSnapshot()));
      doc.resources[0].prePausePowerState = s;
      if (s === 'Unknown') {
        expect(() => deserializePauseSnapshot(doc)).toThrow(/cannot be restored to/);
      } else {
        expect(() => deserializePauseSnapshot(doc)).not.toThrow();
      }
    }
  });

  it('rejects a non-object and malformed JSON', () => {
    expect(() => deserializePauseSnapshot('null')).toThrow(/not an object/);
    expect(() => deserializePauseSnapshot('[not json')).toThrow();
  });
});
