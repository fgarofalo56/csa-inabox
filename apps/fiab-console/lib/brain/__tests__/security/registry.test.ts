/**
 * RECOMMEND-ONLY and the detector REGISTRY.
 *
 * Two properties that are easy to lose silently and cheap to assert.
 */

import { describe, expect, it } from 'vitest';
import {
  assertAllInert,
  assertInertRemediation,
  runSecuritySweep,
  SECURITY_DETECTORS,
} from '@/lib/brain/security';
import type { Finding } from '@/lib/brain/security/substrate';
import {
  c1PositiveItemScoped,
  c2Positive,
  c3PositiveDiscarded,
  cleanBaseline,
  DISCLOSURE_COUNT,
  graphOf,
} from './fixtures/corpus';

function inertFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'f1',
    detectorId: 'd1',
    findingClass: 'C1-unauthorized-inbound-edge',
    severity: 'high',
    confidence: 'high',
    title: 't',
    evidence: { nodeIds: [], edgeIds: [], query: 'q', facts: [] },
    remediation: {
      summary: 's',
      proposedCommands: [],
      proposedPatchDescription: null,
      requiresHumanApproval: true,
    },
    ...over,
  };
}

describe('recommend-only', () => {
  it('accepts a drafted remediation that is pure data', () => {
    expect(() => assertInertRemediation(inertFinding())).not.toThrow();
  });

  it('REJECTS a function-valued property, whatever it is called', () => {
    // The general case. A key-name list only catches the spellings someone
    // thought of — the same lesson C1 teaches about guard shapes.
    const f = inertFinding({
      remediation: {
        summary: 's',
        proposedCommands: [],
        proposedPatchDescription: null,
        requiresHumanApproval: true,
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        somethingHarmlessSounding: () => {},
      } as unknown as Finding['remediation'],
    });
    expect(() => assertInertRemediation(f)).toThrow(/is a function/);
  });

  it('REJECTS a well-known actuator key even when its value is data', () => {
    const f = inertFinding({
      remediation: {
        summary: 's',
        proposedCommands: [],
        proposedPatchDescription: null,
        requiresHumanApproval: true,
        apply: 'az deployment sub create ...',
      } as unknown as Finding['remediation'],
    });
    expect(() => assertInertRemediation(f)).toThrow(/names an actuator/);
  });

  it('REJECTS a remediation that does not require human approval', () => {
    const f = inertFinding({
      remediation: {
        summary: 's',
        proposedCommands: [],
        proposedPatchDescription: null,
        requiresHumanApproval: false,
      } as unknown as Finding['remediation'],
    });
    expect(() => assertInertRemediation(f)).toThrow(/must be literally true/);
  });

  // -------------------------------------------------------------------------
  // DEPTH. The four specs above all sit at the TOP level of `remediation`, and
  // the previous implementation was a single `Object.entries` pass — so it
  // passed all of them while accepting every shape below. Measured during
  // review 2026-08-23 with the top-level arm as the positive control:
  //
  //   remediation.apply = fn                         -> REJECTED (control)
  //   remediation.plan = { apply: fn }                -> ACCEPTED (escaped)
  //   remediation.proposedCommands = [{ apply: fn }]  -> ACCEPTED (escaped)
  //
  // Neither escape was a live exploit — a function does not survive the
  // Cosmos/queue/JSON.parse crossing this module backstops — but the docstring
  // claimed "any function-valued property whatsoever", which was false.
  // -------------------------------------------------------------------------

  function withRemediation(remediation: unknown): Finding {
    return inertFinding({ remediation: remediation as Finding['remediation'] });
  }

  const BASE = {
    summary: 's',
    proposedCommands: [] as unknown[],
    proposedPatchDescription: null,
    requiresHumanApproval: true,
  };

  it('REJECTS a function nested one level down', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      assertInertRemediation(withRemediation({ ...BASE, plan: { apply: () => {} } })),
    ).toThrow(/remediation\.plan\.apply/);
  });

  it('REJECTS a function nested inside an array element', () => {
    expect(() =>
      assertInertRemediation(
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        withRemediation({ ...BASE, proposedCommands: [{ apply: () => {} }] }),
      ),
    ).toThrow(/remediation\.proposedCommands\[0\]\.apply/);
  });

  it('REJECTS a deeply buried function under a non-actuator key name', () => {
    // Proves the depth walk is keyed to the SHAPE, not to the key spelling —
    // no name on this path is in ACTUATOR_KEYS.
    expect(() =>
      assertInertRemediation(
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        withRemediation({ ...BASE, notes: { detail: [{ helper: () => {} }] } }),
      ),
    ).toThrow(/is a function/);
  });

  it('REJECTS an accessor property, where the callable hides in the descriptor', () => {
    const remediation = { ...BASE };
    Object.defineProperty(remediation, 'summary', {
      get: () => 'computed',
      enumerable: true,
      configurable: true,
    });
    expect(() => assertInertRemediation(withRemediation(remediation))).toThrow(
      /is an accessor property/,
    );
  });

  it('REJECTS a class instance, whose callables live on the prototype', () => {
    // `Reflect.ownKeys` does not walk the prototype chain, so an own-key scan
    // of this object finds nothing executable while `.apply()` is callable.
    class Remediation {
      summary = 's';
      proposedCommands: unknown[] = [];
      proposedPatchDescription = null;
      requiresHumanApproval = true as const;
      apply() {
        /* would execute */
      }
    }
    expect(() => assertInertRemediation(withRemediation(new Remediation()))).toThrow(
      /not a plain object or array/,
    );
  });

  it('REJECTS a reference cycle, which cannot survive serialisation', () => {
    const remediation: Record<string, unknown> = { ...BASE };
    remediation.self = remediation;
    expect(() => assertInertRemediation(withRemediation(remediation))).toThrow(
      /closes a reference cycle/,
    );
  });

  it('still ACCEPTS the real drafted shape, nested strings and all', () => {
    // The over-rejection control. Depth checking is worthless if it also
    // refuses the documents detectors actually emit.
    expect(() =>
      assertInertRemediation(
        withRemediation({
          ...BASE,
          proposedCommands: ['az deployment sub create ...', 'gh run list --limit 3'],
          proposedPatchDescription: 'add the tenant comparison to the shared resolver',
        }),
      ),
    ).not.toThrow();
  });

  it('every finding a real detector produces is inert', () => {
    const graph = graphOf([
      c1PositiveItemScoped(),
      c2Positive('fx:ro:c2', [DISCLOSURE_COUNT]),
      c3PositiveDiscarded(),
    ]);
    const sweep = runSecuritySweep(graph);
    expect(sweep.findings.length).toBeGreaterThan(0);
    expect(() => assertAllInert(sweep.findings)).not.toThrow();
    // And every one of them carries a drafted remediation rather than an empty
    // one — a finding with no proposed fix is not recommend-only, it is silent.
    expect(sweep.findings.every((f) => f.remediation.summary.length > 0)).toBe(true);
  });

  it('every drafted remediation says DRAFT ONLY where it proposes a change', () => {
    const sweep = runSecuritySweep(
      graphOf([c1PositiveItemScoped(), c3PositiveDiscarded()]),
    );
    const withPatch = sweep.findings.filter((f) => f.remediation.proposedPatchDescription !== null);
    expect(withPatch.length).toBeGreaterThan(0);
    expect(withPatch.every((f) => f.remediation.summary.includes('DRAFT ONLY'))).toBe(true);
  });
});

describe('the detector registry', () => {
  it('carries exactly nine detectors — one per taxonomy class', () => {
    // Asserted rather than assumed: a detector silently dropping out of the
    // registry is taxonomy §11.5's population failure applied to the registry.
    expect(SECURITY_DETECTORS).toHaveLength(9);
  });

  it('covers C1 through C9 with no duplicates and no gaps', () => {
    expect(SECURITY_DETECTORS.map((d) => d.taxonomyClass).sort()).toEqual([
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
      'C6',
      'C7',
      'C8',
      'C9',
    ]);
  });

  it('leads with the classes that have live OPEN instances', () => {
    // Real-instance severity order, not numeric order: C1 (two live OPEN
    // instances), C2 (cross-tenant leak), C4 (secret publication).
    expect(SECURITY_DETECTORS.slice(0, 3).map((d) => d.taxonomyClass)).toEqual(['C1', 'C2', 'C4']);
  });

  it('every detector id is unique', () => {
    expect(new Set(SECURITY_DETECTORS.map((d) => d.id)).size).toBe(SECURITY_DETECTORS.length);
  });

  it('every detector is PURE — the same graph twice gives an identical result', () => {
    const graph = cleanBaseline();
    expect(JSON.stringify(runSecuritySweep(graph))).toBe(JSON.stringify(runSecuritySweep(graph)));
  });
});
