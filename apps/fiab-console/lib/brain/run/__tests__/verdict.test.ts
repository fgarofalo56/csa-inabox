/**
 * LOOM BRAIN W10 — the THREE-VERDICT classifier (#3936).
 *
 * #3936 acceptance, two of the five:
 *   • "A run that cannot reach Azure FAILS RED, and its error says 'could not
 *      reach' — never 'nothing found'."
 *   • "A run against a paused estate returns the PAUSED verdict with observed
 *      resource states."
 *
 * ── THE CONTROL THAT MAKES THE R7 ASSERTION MEAN SOMETHING ─────────────────
 * Asserting only that a reach failure SAYS "could not reach" is satisfied by a
 * classifier that puts the phrase on every red verdict. That version would be
 * WRONG in exactly the 2026-08-05 way: it would print "could not reach" for a
 * run that reached Azure and got zero rows back, and send an investigation at
 * connectivity when the answer is an estate id or a missing Reader assignment.
 * So both directions are asserted, and `assertMessageMatchesReason` re-checks
 * the correspondence at runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  COULD_NOT_REACH,
  classifyEstate,
  countByState,
  reasonForFailures,
} from '../verdict';
import { InconsistentProbeError } from '../model';
import {
  ARM_API,
  AUTH_FAILURE,
  BROKER_ARM,
  CLOUD,
  ESTATE,
  NETWORK_FAILURE,
  pausedReadings,
  probeOf,
  reading,
  runningReadings,
} from './fixtures';

const CTX = { at: '2026-08-24T04:11:00.000Z', cloud: CLOUD, estateId: ESTATE };

describe('classifyEstate — OK', () => {
  it('is OK when at least one in-scope resource is Online, and reports the split', () => {
    const v = classifyEstate(probeOf(runningReadings()), CTX);
    expect(v.kind).toBe('ok');
    if (v.kind !== 'ok') throw new Error('unreachable');
    expect(v.running).toBe(3);
    expect(v.notRunning).toBe(0);
    expect(v.indeterminate).toBe(0);
    expect(v.byState.Online).toBe(3);
    expect(v.message).not.toContain(COULD_NOT_REACH);
  });

  it('stays OK on a PARTIALLY running estate, and says how partial', () => {
    const v = classifyEstate(
      probeOf([reading('/a', 'Online'), reading('/b', 'Stopped'), reading('/c', 'Unknown')]),
      CTX,
    );
    expect(v.kind).toBe('ok');
    if (v.kind !== 'ok') throw new Error('unreachable');
    expect(v.running).toBe(1);
    expect(v.notRunning).toBe(1);
    expect(v.indeterminate).toBe(1);
    expect(v.message).toContain('1 of 3');
    expect(v.message).toContain('establishes neither');
  });
});

describe('classifyEstate — PAUSED', () => {
  it('is PAUSED when EVERY reading is definitively stopped, and carries the states', () => {
    const v = classifyEstate(probeOf(pausedReadings()), CTX);
    expect(v.kind).toBe('paused');
    if (v.kind !== 'paused') throw new Error('unreachable');
    expect(v.observed).toHaveLength(3);
    expect(v.observed.map((o) => o.powerState).sort()).toEqual([
      'Deallocated',
      'Stopped',
      'Stopped',
    ]);
    // The receipt: every observation names the ARM api-version it came from.
    expect(v.observed.every((o) => o.armApiVersion === ARM_API)).toBe(true);
    expect(v.message).toContain('the estate is paused');
    expect(v.message).toContain('NOT green');
    expect(v.message).toContain('NOT');
    // R7 — it REACHED Azure, so it must not claim otherwise.
    expect(v.message).not.toContain(COULD_NOT_REACH);
  });

  it('REFUSES to call an estate paused when a state was not established', () => {
    // Nothing Online, but one resource is mid-transition. The tempting predicate
    // `!isRunningState(s)` would call this PAUSED and render a half-stopped
    // estate as a clean neutral outcome.
    const v = classifyEstate(
      probeOf([reading('/a', 'Stopped'), reading('/b', 'Pausing')]),
      CTX,
    );
    expect(v.kind).toBe('unreachable');
    if (v.kind !== 'unreachable') throw new Error('unreachable');
    expect(v.reason).toBe('state-indeterminate');
    expect(v.message).toContain('REFUSES to report the estate as paused');
    expect(v.message).toContain('/b -> Pausing');
    expect(v.message).not.toContain(COULD_NOT_REACH);
  });

  it('REFUSES to call an all-Unknown estate paused', () => {
    const v = classifyEstate(probeOf([reading('/a', 'Unknown'), reading('/b', 'Unknown')]), CTX);
    expect(v.kind).toBe('unreachable');
    if (v.kind !== 'unreachable') throw new Error('unreachable');
    expect(v.reason).toBe('state-indeterminate');
  });
});

describe('classifyEstate — UNREACHABLE, and R7', () => {
  it('a reach failure is RED and its message says "could not reach"', () => {
    const v = classifyEstate(probeOf([], [NETWORK_FAILURE]), CTX);
    expect(v.kind).toBe('unreachable');
    if (v.kind !== 'unreachable') throw new Error('unreachable');
    expect(v.reason).toBe('network-failed');
    expect(v.message).toContain(COULD_NOT_REACH);
    // The failure detail is carried VERBATIM, not summarized.
    expect(v.message).toContain('getaddrinfo ENOTFOUND');
    expect(v.message).toContain('NOTHING was scanned');
  });

  it('an auth failure is classified as auth even mixed with network noise', () => {
    expect(reasonForFailures([NETWORK_FAILURE, AUTH_FAILURE])).toBe('auth-failed');
    const v = classifyEstate(probeOf([], [NETWORK_FAILURE, AUTH_FAILURE]), CTX);
    if (v.kind !== 'unreachable') throw new Error('unreachable');
    expect(v.reason).toBe('auth-failed');
    expect(v.message).toContain(COULD_NOT_REACH);
    expect(v.message).toContain('AuthorizationFailed');
  });

  it('THE CONTROL: a run that REACHED Azure and found nothing does NOT say "could not reach"', () => {
    const v = classifyEstate(
      { readings: [], failures: [], discovered: 0, scope: 'zero rows (synthetic)' },
      CTX,
    );
    expect(v.kind).toBe('unreachable');
    if (v.kind !== 'unreachable') throw new Error('unreachable');
    expect(v.reason).toBe('no-resources-observed');
    // This is the assertion that catches "unify every red message under one
    // phrase". A permission denial printed as a connectivity failure is the
    // 2026-08-05 defect that sent two investigations down the wrong path.
    expect(v.message).not.toContain(COULD_NOT_REACH);
    expect(v.message).toContain('reached Azure');
    expect(v.message).toContain('ZERO');
    // R7 — it says what it CANNOT tell apart rather than picking one.
    expect(v.message).toContain('indistinguishable');
  });

  it('zero rows is RED, not clean — a verdict over an empty population establishes nothing', () => {
    const v = classifyEstate(
      { readings: [], failures: [], discovered: 0, scope: 'zero rows (synthetic)' },
      CTX,
    );
    expect(v.kind).toBe('unreachable');
  });
});

describe('classifyEstate — the probe contract', () => {
  it('THROWS when the probe lost a resource without recording a failure', () => {
    // 3 discovered, 1 read, no failure: two resources left the examined
    // population with nothing to see it.
    expect(() =>
      classifyEstate(
        { readings: [reading(BROKER_ARM, 'Online')], failures: [], discovered: 3, scope: 's' },
        CTX,
      ),
    ).toThrow(InconsistentProbeError);
  });

  it('does NOT throw when the shortfall is explained by a failure', () => {
    const v = classifyEstate(
      {
        readings: [reading(BROKER_ARM, 'Online')],
        failures: [{ ...AUTH_FAILURE, stage: 'power-read', target: '/b' }],
        discovered: 3,
        scope: 's',
      },
      CTX,
    );
    expect(v.kind).toBe('unreachable');
  });
});

describe('countByState', () => {
  it('reports every state, including the zeroes', () => {
    const c = countByState([reading('/a', 'Online'), reading('/b', 'Paused')]);
    expect(c.Online).toBe(1);
    expect(c.Paused).toBe(1);
    expect(c.Unknown).toBe(0);
    expect(Object.keys(c)).toHaveLength(9);
  });
});
