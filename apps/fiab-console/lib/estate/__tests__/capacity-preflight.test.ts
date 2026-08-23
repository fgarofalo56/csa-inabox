/**
 * ESTATE PAUSE — capacity preconditions, failure classification, and the
 * false-green guard (PRP §3, work item W3).
 *
 * The centre of this file is `assertNoFalseGreen`. Everything else here is
 * supporting evidence for one claim: an estate is reported RUNNING only when
 * every resource in it was CONFIRMED running, and every other outcome —
 * including "we did not check" — is RESUME_FAILED.
 *
 * The classification cases are pinned to Azure's own ERROR CODES rather than to
 * its prose, and the ADX string is the verbatim one measured live on 2026-08-22
 * when the GCC-High cluster auto-stopped and could not be restarted.
 */
import { describe, it, expect } from 'vitest';
import {
  assertNoFalseGreen,
  capacityPreflight,
  classifyActuationFailure,
  FalseGreenError,
  highRiskCount,
  isRetryable,
  remediationFor,
  summarizeResume,
} from '../capacity-preflight';
import { PAUSABLE_RESOURCE_TYPES, type PauseCandidate } from '../pause-inventory';
import {
  isResumeSuccess,
  RESUME_SUCCESS_CONFIRMATIONS,
  type PausedResourceSnapshot,
  type ResumeOutcome,
} from '../pause-state';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ADX_SPEC = PAUSABLE_RESOURCE_TYPES['microsoft.kusto/clusters'];
const ACA_SPEC = PAUSABLE_RESOURCE_TYPES['microsoft.app/containerapps'];

function candidate(spec = ADX_SPEC, name = 'adx-loom-shared'): PauseCandidate {
  return {
    resource: {
      resourceId: `/subscriptions/s/resourceGroups/rg/providers/${spec.resourceType}/${name}`,
      resourceType: spec.resourceType,
      name,
      resourceGroup: 'rg-csa-loom-admin-centralus',
      subscriptionId: 's',
      tags: { 'loom-estate-id': 'loom:estate-a' },
      discoverySource: 'deploy-manifest',
    },
    spec,
    ownership: {
      verdict: 'loom-owned',
      source: 'ownership-tag',
      tagKey: 'loom-estate-id',
      tagValue: 'loom:estate-a',
      reason: `${name} carries loom-estate-id.`,
    },
    ...(spec.fallbackSku ? { fallbackSku: spec.fallbackSku } : {}),
  };
}

function snapshotEntry(over?: Partial<PausedResourceSnapshot>): PausedResourceSnapshot {
  return {
    resourceId: '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Kusto/clusters/adx-loom-shared',
    resourceType: 'microsoft.kusto/clusters',
    name: 'adx-loom-shared',
    resourceGroup: 'rg-csa-loom-admin-centralus',
    subscriptionId: 's',
    prePausePowerState: 'Online',
    powerStateSource: 'arm',
    powerStateReadAt: '2026-08-23T00:00:00.000Z',
    powerStateApiVersion: '2023-08-15',
    sku: { name: 'Standard_E8ads_v5', capacity: 2 },
    fallbackSku: ADX_SPEC.fallbackSku,
    ownership: { verdict: 'loom-owned', source: 'ownership-tag', reason: 'tagged' },
    ...over,
  };
}

const confirmed = (id: string): ResumeOutcome => ({
  resourceId: id,
  confirmation: 'confirmed-running',
  observedState: 'Online',
  reason: 'ARM reports it Online and it answered a probe.',
});

// ===========================================================================
// R-CAP-4 — the guard that cannot be satisfied by silence
// ===========================================================================

describe('assertNoFalseGreen — RUNNING requires POSITIVE confirmation of every resource', () => {
  const A = '/subscriptions/s/rg/a';
  const B = '/subscriptions/s/rg/b';

  it('permits RUNNING when every resource is confirmed-running', () => {
    expect(() => assertNoFalseGreen('RUNNING', [confirmed(A), confirmed(B)], 2)).not.toThrow();
  });

  it('REFUSES RUNNING when one resource is unknown', () => {
    const outcomes: ResumeOutcome[] = [
      confirmed(A),
      { resourceId: B, confirmation: 'unknown', reason: 'the ARM read failed' },
    ];
    expect(() => assertNoFalseGreen('RUNNING', outcomes, 2)).toThrow(FalseGreenError);
    try {
      assertNoFalseGreen('RUNNING', outcomes, 2);
    } catch (e) {
      expect((e as FalseGreenError).unconfirmed).toHaveLength(1);
      expect((e as Error).message).toContain('RESUME_FAILED, not a success');
    }
  });

  it('REFUSES RUNNING when one resource is confirmed MISMATCHED against its pre-pause state', () => {
    const outcomes: ResumeOutcome[] = [
      confirmed(A),
      { resourceId: B, confirmation: 'confirmed-mismatch', observedState: 'Stopped', reason: 'still stopped' },
    ];
    expect(() => assertNoFalseGreen('RUNNING', outcomes, 2)).toThrow(FalseGreenError);
  });

  it('PERMITS RUNNING for a correctly-restored-PAUSED resource — the inverse defect', () => {
    // W1 split the old single `confirmed-running` into `confirmed-running` +
    // `confirmed-restored-paused` precisely because a hand-rolled comparison is
    // wrong in BOTH directions. Comparing against `confirmed-running` alone
    // would now mark a legitimately-restored-paused resource as FAILED, which
    // is the inverse of the bug the rename fixed. `assertNoFalseGreen` must use
    // `isResumeSuccess`, whose success set has TWO members.
    const outcomes: ResumeOutcome[] = [
      confirmed(A),
      {
        resourceId: B,
        confirmation: 'confirmed-restored-paused',
        observedState: 'Paused',
        reason: 'it was Paused before the pause and is Paused again',
      },
    ];
    expect(RESUME_SUCCESS_CONFIRMATIONS).toContain('confirmed-restored-paused');
    expect(isResumeSuccess('confirmed-restored-paused')).toBe(true);
    expect(() => assertNoFalseGreen('RUNNING', outcomes, 2)).not.toThrow();
  });

  it('THE ZERO-POPULATION CASE: RUNNING with ZERO outcomes against paused resources is REFUSED', () => {
    // `[].every(...)` is vacuously true, so a confirmation loop that ran zero
    // times would otherwise launder "nothing was checked" into "all good". This
    // is the exact shape of several guards in this repo that measured nothing.
    expect(() => assertNoFalseGreen('RUNNING', [], 3)).toThrow(FalseGreenError);
    try {
      assertNoFalseGreen('RUNNING', [], 3);
    } catch (e) {
      expect((e as Error).message).toMatch(/ZERO confirmation outcomes/);
      expect((e as Error).message).toMatch(/Nothing was checked/);
    }
  });

  it('permits RUNNING with zero outcomes ONLY when nothing was ever paused', () => {
    expect(() => assertNoFalseGreen('RUNNING', [], 0)).not.toThrow();
  });

  it('is silent for every NON-RUNNING state — it guards the claim, not the machinery', () => {
    const bad: ResumeOutcome[] = [{ resourceId: A, confirmation: 'unknown', reason: 'x' }];
    for (const state of ['RESUMING', 'RESUME_FAILED', 'PAUSED', 'PAUSING']) {
      expect(() => assertNoFalseGreen(state, bad, 1)).not.toThrow();
    }
  });
});

// ===========================================================================
// Failure classification — deploy-integrity R6
// ===========================================================================

describe('classifyActuationFailure', () => {
  it('classifies the VERBATIM ADX capacity error measured on 2026-08-22', () => {
    const measured =
      'ERROR: (InsufficientResourcesForSubscription) [BadRequest] Currently there are no available '
      + 'resources to start the cluster with current SKU. Please choose different SKU';
    const { kind, matched } = classifyActuationFailure(measured);
    // Note the string ALSO contains "BadRequest". Capacity must win — otherwise
    // a real capacity outage is remediated as "your request was malformed".
    expect(kind).toBe('capacity');
    expect(matched).toBe('InsufficientResourcesForSubscription');
  });

  it('classifies each Azure error class from its CODE, not its prose', () => {
    const cases: Array<[string, string]> = [
      ['SkuNotAvailable: the requested size is not available', 'capacity'],
      ['AllocationFailed: allocation failed in this zone', 'capacity'],
      ['QuotaExceeded: Operation could not be completed as it results in exceeding approved cores quota', 'quota'],
      ["AuthorizationFailed: the client does not have authorization to perform action 'Microsoft.Kusto/clusters/start/action'", 'permission'],
      ['ResourceNotFound: the resource was not found', 'not-found'],
      ['ARM POST failed 429: TooManyRequests', 'transient'],
      ['ARM POST failed 503: service unavailable', 'transient'],
      ['ETIMEDOUT connecting to management.azure.com', 'transient'],
      ['Conflict: the pool is not in a valid state for this operation', 'configuration'],
    ];
    for (const [text, expected] of cases) {
      expect(classifyActuationFailure(text).kind, text).toBe(expected);
    }
  });

  it('reports an UNRECOGNISED failure as unknown — never guessed into a familiar bucket', () => {
    expect(classifyActuationFailure('the flux capacitor is misaligned').kind).toBe('unknown');
    expect(classifyActuationFailure('').kind).toBe('unknown');
    expect(classifyActuationFailure(undefined).kind).toBe('unknown');
    expect(classifyActuationFailure(null).kind).toBe('unknown');
  });

  it('only TRANSIENT is retryable — an unknown failure is NOT retried into a loop', () => {
    expect(isRetryable('transient')).toBe(true);
    for (const k of ['capacity', 'quota', 'permission', 'not-found', 'configuration', 'unknown'] as const) {
      expect(isRetryable(k), k).toBe(false);
    }
  });
});

describe('remediationFor — a concrete next step, never "check the logs"', () => {
  it('names the DECLARED fallback SKU on a capacity failure, and says it is not applied automatically', () => {
    const text = remediationFor('capacity', snapshotEntry());
    expect(text).toContain('Dev(No SLA)_Standard_E2a_v4');
    expect(text).toMatch(/manual step in this release/);
    // …and it states the underlying fact rather than blaming Loom.
    expect(text).toMatch(/Azure does not reserve capacity while a resource is stopped/);
  });

  it('says so plainly when NO fallback is declared, instead of implying one', () => {
    const text = remediationFor('capacity', snapshotEntry({ fallbackSku: undefined }));
    expect(text).toMatch(/No fallback SKU is declared/);
  });

  it('names the identity and the scope on a permission failure', () => {
    const text = remediationFor('permission', snapshotEntry());
    expect(text).toContain('LOOM_UAMI_CLIENT_ID');
    expect(text).toContain('rg-csa-loom-admin-centralus');
  });

  it('refuses to recreate a vanished resource silently', () => {
    const text = remediationFor('not-found', snapshotEntry());
    expect(text).toMatch(/will NOT recreate it silently/);
  });

  it('preserves the raw ARM text on an unknown failure and warns against assuming transience', () => {
    const text = remediationFor('unknown', snapshotEntry(), 'HTTP 418 I am a teapot');
    expect(text).toContain('HTTP 418 I am a teapot');
    expect(text).toMatch(/Do not treat this as transient without evidence/);
  });

  it('every classification produces a non-empty, specific remediation', () => {
    for (const kind of ['capacity', 'quota', 'permission', 'not-found', 'transient', 'configuration', 'unknown'] as const) {
      const text = remediationFor(kind, snapshotEntry());
      expect(text.length, kind).toBeGreaterThan(80);
      expect(text, kind).not.toMatch(/check the logs|see above|contact support/i);
    }
  });
});

// ===========================================================================
// R-CAP-1 / R-CAP-3 — the risk shown BEFORE the confirm
// ===========================================================================

describe('capacityPreflight', () => {
  it('flags a capacity-constrained resource as high risk and names its declared fallback', () => {
    const [risk] = capacityPreflight([candidate()]);
    expect(risk.risk).toBe('high');
    expect(risk.capacityConstrained).toBe(true);
    expect(risk.fallbackSku?.name).toBe('Dev(No SLA)_Standard_E2a_v4');
    expect(risk.statement).toMatch(/Azure does not reserve it/);
  });

  it('does NOT flag a serverless resource, so the warning stays meaningful', () => {
    const [risk] = capacityPreflight([candidate(ACA_SPEC, 'loom-console')]);
    expect(risk.risk).toBe('low');
    expect(risk.statement).toMatch(/does not contend for regional capacity/);
  });

  it('counts high-risk rows for the confirm dialog', () => {
    const risks = capacityPreflight([candidate(), candidate(ACA_SPEC, 'loom-console')]);
    expect(highRiskCount(risks)).toBe(1);
  });

  it('EVERY capacity-constrained type in the registry declares a fallback', () => {
    // A future addition that forgets one fails HERE rather than failing a resume
    // at 3am with nothing to fall back to.
    for (const [type, spec] of Object.entries(PAUSABLE_RESOURCE_TYPES)) {
      if (spec.capacityConstrained) {
        expect(spec.fallbackSku?.name, `${type} is capacityConstrained with no fallbackSku`).toBeTruthy();
        expect(spec.fallbackSku?.reason, `${type} fallback has no reason`).toBeTruthy();
      }
    }
  });
});

// ===========================================================================
// The operator-facing summary
// ===========================================================================

describe('summarizeResume', () => {
  const entry = snapshotEntry();

  it('a RUNNING summary says BOTH checks passed, not just the status field', () => {
    const s = summarizeResume('RUNNING', [confirmed(entry.resourceId)], [entry]);
    expect(s.headline).toMatch(/authoritative ARM read AND a real request/);
    expect(s.details).toEqual([]);
  });

  it('a RESUME_FAILED summary NAMES the resource, its class, and its remediation', () => {
    const outcomes: ResumeOutcome[] = [{
      resourceId: entry.resourceId,
      confirmation: 'confirmed-mismatch',
      observedState: 'Stopped',
      reason: 'ARM POST failed 400: (InsufficientResourcesForSubscription) no available resources to start the cluster',
    }];
    const s = summarizeResume('RESUME_FAILED', outcomes, [entry]);
    expect(s.headline).toMatch(/NOT confirmed running/);
    expect(s.headline).toMatch(/not a display state/);
    expect(s.details).toHaveLength(1);
    expect(s.details[0].kind).toBe('capacity');
    expect(s.details[0].remediation).toContain('Dev(No SLA)_Standard_E2a_v4');
  });

  it('a RESUMING summary does NOT claim failure — it says the window has not elapsed', () => {
    const outcomes: ResumeOutcome[] = [{ resourceId: entry.resourceId, confirmation: 'unknown', reason: 'still starting' }];
    const s = summarizeResume('RESUMING', outcomes, [entry]);
    expect(s.headline).toMatch(/Nothing has failed yet/);
  });

  it('an outcome for a resource NOT in the snapshot is reported, not dropped', () => {
    const outcomes: ResumeOutcome[] = [{ resourceId: '/ghost', confirmation: 'unknown', reason: 'no idea' }];
    const s = summarizeResume('RESUME_FAILED', outcomes, [entry]);
    expect(s.details).toHaveLength(1);
    expect(s.details[0].remediation).toMatch(/not in the snapshot/);
  });
});
