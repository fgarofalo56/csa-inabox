/**
 * C3 — the discarded verdict. The narrow arm is the branch-scoped consumption,
 * which a "is the value tested?" checker passes.
 */

import { describe, expect, it } from 'vitest';
import { detectDiscardedVerdict, securityFindingsOf } from '@/lib/brain/security';
import {
  c3NegativeStaticCatalogue,
  c3PositiveAttribution,
  c3PositiveDiscarded,
  c3PositiveMethodScoped,
  graphOf,
} from './fixtures/corpus';
import type { SecurityNode } from '@/lib/brain/security/substrate';

describe('C3 — the discarded verdict', () => {
  it('POSITIVE: fires when the gate is called and its answer never consumed', () => {
    const findings = securityFindingsOf(detectDiscardedVerdict(graphOf([c3PositiveDiscarded()])));
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C3-discarded-verdict');
    // A subscription-scoped ARM deploy is the measured 2026-08-07 instance.
    expect(findings[0].severity).toBe('critical');
  });

  it('POSITIVE (NARROW): fires when the verdict IS tested but only on some paths', () => {
    // `if (gate && req.method !== 'GET') return gate;` — consumption is real, a
    // decision IS taken, and GET reaches the sink unrefused.
    const findings = securityFindingsOf(
      detectDiscardedVerdict(graphOf([c3PositiveMethodScoped()])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('NARROW');
    expect(findings[0].evidence.facts.join('\n')).toContain('path(s) reach the sink unrefused');
  });

  it('POSITIVE (attribution): fires when the only claims read is a savedBy field', () => {
    const findings = securityFindingsOf(detectDiscardedVerdict(graphOf([c3PositiveAttribution()])));
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('ATTRIBUTION');
  });

  it('NEGATIVE CONTROL: does NOT fire on a route whose sink is not privileged', () => {
    // A static capability-catalogue read that calls no guard. Distinguishing it
    // from C3 requires the DECLARED sinkPrivileged: false — it cannot be inferred.
    expect(
      securityFindingsOf(detectDiscardedVerdict(graphOf([c3NegativeStaticCatalogue()]))),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire when every path consumes the verdict as a refusal', () => {
    const node: SecurityNode = {
      id: 'fx:c3:clean',
      kind: 'verdict-call',
      provenance: 'declared',
      label: 'route returning the gate on every path',
      facet: {
        kind: 'verdict-call',
        callSite: 'clean:POST',
        symbol: 'enforceCapability',
        returnsVerdictUnion: true,
        pathsToPrivilegedSink: 3,
        pathsConsumingAsRefusal: 3,
        consumption: 'returned',
        allowlisted: false,
        allowlistPremiseTested: true,
        sinkPrivileged: true,
        sinkKind: 'cosmos-write',
      },
    };
    expect(securityFindingsOf(detectDiscardedVerdict(graphOf([node])))).toEqual([]);
  });

  describe('the allowlist is never a population filter', () => {
    const allowlistedButDiscarding: SecurityNode = {
      id: 'fx:c3:allowlisted-discarding',
      kind: 'verdict-call',
      provenance: 'declared',
      label: 'an allowlisted route that calls a gate and throws the answer away',
      facet: {
        kind: 'verdict-call',
        callSite: 'setup/identity:POST',
        symbol: 'enforceCapability',
        returnsVerdictUnion: true,
        pathsToPrivilegedSink: 1,
        pathsConsumingAsRefusal: 0,
        consumption: 'ignored',
        allowlisted: true,
        allowlistPremiseTested: false,
        sinkPrivileged: true,
        sinkKind: 'role-assignment',
      },
    };

    it('still fires the enforcement finding on an ALLOWLISTED route', () => {
      // Quoting check-route-guards.mjs:29-31: "this route needs no per-resource
      // authorization" never licenses "call a gate and throw its answer away".
      const findings = securityFindingsOf(
        detectDiscardedVerdict(graphOf([allowlistedButDiscarding])),
      );
      const enforcement = findings.filter((f) => !f.id.endsWith(':allowlist-premise'));
      expect(enforcement).toHaveLength(1);
      expect(enforcement[0].severity).toBe('high');
    });

    it('reports an UNTESTED allowlist premise separately, at a lower grade (#3607)', () => {
      const findings = securityFindingsOf(
        detectDiscardedVerdict(graphOf([allowlistedButDiscarding])),
      );
      const premise = findings.filter((f) => f.id.endsWith(':allowlist-premise'));
      expect(premise).toHaveLength(1);
      expect(premise[0].severity).toBe('medium');
    });

    it('keeps allowlisted routes in the JUDGED population', () => {
      const result = detectDiscardedVerdict(
        graphOf([allowlistedButDiscarding, c3NegativeStaticCatalogue()]),
      );
      expect(result.population.judged).toContain(allowlistedButDiscarding.id);
      expect(result.population.judged).toContain(c3NegativeStaticCatalogue().id);
      expect(result.population.unjudged).toEqual([]);
    });
  });
});
