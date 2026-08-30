/**
 * C7 — the synthesized principal. The narrow arms are `-z` (absence, not
 * validity) and the cached path that never calls the guarded minter.
 */

import { describe, expect, it } from 'vitest';
import { detectSynthesizedPrincipal, securityFindingsOf } from '@/lib/brain/security';
import { c7Node, c8Node, graphOf } from './fixtures/corpus';

describe('C7 — the synthesized principal', () => {
  it('POSITIVE: fires when a literal can reach a partition key', () => {
    const node = c7Node('fx:c7:literal', {
      sink: 'mintSessionCookie',
      reachesPartitionKeyOrTenantScope: true,
      sources: [{ origin: 'literal', validation: 'none', bypassesMinter: false }],
      checkCopies: 1,
      checkCopiesUnderTest: 1,
    });
    const findings = securityFindingsOf(detectSynthesizedPrincipal(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].evidence.facts.join('\n')).toContain('SHADOW TENANT');
  });

  it('POSITIVE (NARROW): fires on a PRESENCE-only guard — `-z` catches absence, not validity', () => {
    const node = c7Node('fx:c7:presence', {
      sink: 'mintSessionCookie',
      reachesPartitionKeyOrTenantScope: true,
      sources: [{ origin: 'env', validation: 'presence', bypassesMinter: false }],
      checkCopies: 1,
      checkCopiesUnderTest: 1,
    });
    const findings = securityFindingsOf(detectSynthesizedPrincipal(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('checks ABSENCE, not validity');
  });

  it('POSITIVE (NARROW): fires on a cached path that never calls the guarded minter', () => {
    // Hardening the minter does not close this path — a principal minted under a
    // placeholder BEFORE the fix is still loaded AFTER it.
    const node = c7Node('fx:c7:cached', {
      sink: 'signIn',
      reachesPartitionKeyOrTenantScope: true,
      sources: [{ origin: 'cached-artifact', validation: 'value', bypassesMinter: true }],
      checkCopies: 1,
      checkCopiesUnderTest: 1,
    });
    const findings = securityFindingsOf(detectSynthesizedPrincipal(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('WITHOUT calling the guarded minter');
  });

  it('NEGATIVE CONTROL: does NOT fire on a principal from a live token', () => {
    const node = c7Node('fx:c7:live', {
      sink: 'mintSessionCookie',
      reachesPartitionKeyOrTenantScope: true,
      sources: [{ origin: 'live-token', validation: 'value', bypassesMinter: false }],
      checkCopies: 1,
      checkCopiesUnderTest: 1,
    });
    expect(securityFindingsOf(detectSynthesizedPrincipal(graphOf([node])))).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire when the value never reaches a tenancy boundary', () => {
    // The measured negative worth not re-investigating: a bare all-zeros-ish
    // constant in this repo is the Cosmos Data Contributor ROLE ID, not an
    // identity. A detector that pattern-matched placeholder GUIDs would flag it.
    const node = c7Node('fx:c7:role-id', {
      sink: 'roleAssignmentBuilder',
      reachesPartitionKeyOrTenantScope: false,
      sources: [{ origin: 'literal', validation: 'none', bypassesMinter: false }],
      checkCopies: 1,
      checkCopiesUnderTest: 1,
    });
    expect(securityFindingsOf(detectSynthesizedPrincipal(graphOf([node])))).toEqual([]);
  });

  it('POPULATION: reports untested copies of the check as its own finding', () => {
    // "Eight independent copies and exactly one under test" — the class stays
    // open even when every instance is closed, and the cheapest narrow bypass
    // available is "fix the copy under test".
    const node = c7Node('fx:c7:copies', {
      sink: 'placeholderOidCheck',
      reachesPartitionKeyOrTenantScope: true,
      sources: [{ origin: 'live-token', validation: 'value', bypassesMinter: false }],
      checkCopies: 8,
      checkCopiesUnderTest: 1,
    });
    const result = detectSynthesizedPrincipal(graphOf([node]));
    expect(securityFindingsOf(result)).toEqual([]);
    const pop = result.findings.filter((f) => f.findingClass === 'POP-population-integrity');
    expect(pop).toHaveLength(1);
    expect(pop[0].title).toContain('8 copies and 1 is/are under test');
  });

  // ── POPULATION (#3970) ─────────────────────────────────────────────────────
  //
  // The spec above reports on the CHECK COPIES — a finding C7 emits about the
  // world. It says nothing about C7's own `population` object, which had ZERO
  // assertions. The registry-wide census closes candidate-level narrowing for
  // all nine detectors; what it cannot see is a skip inside THIS predicate,
  // where the node stays counted as judged and only the finding disappears.
  //
  // The class-specific property: membership is (kind === 'principal'), i.e.
  // "a value that becomes a principal at this sink" — never "and it came from an
  // untrusted origin". Narrowing membership to the unsafe ORIGIN would make a
  // sink that switched to a live token vanish from the population entirely, and
  // a later regression on that same sink would then be invisible rather than red.
  describe('POPULATION MEMBERSHIP IS INDEPENDENT OF THE ORIGIN', () => {
    it('a sink fed by a LIVE TOKEN is still a candidate and still judged', () => {
      const fixed = c7Node('fx:c7:pop-live', {
        sink: 'mintSessionCookie',
        reachesPartitionKeyOrTenantScope: true,
        sources: [{ origin: 'live-token', validation: 'value', bypassesMinter: false }],
        checkCopies: 1,
        checkCopiesUnderTest: 1,
      });
      const result = detectSynthesizedPrincipal(graphOf([fixed]));
      expect(result.population.candidates).toContain(fixed.id);
      expect(result.population.judged).toContain(fixed.id);
      expect(result.population.unjudged).toEqual([]);
      expect(securityFindingsOf(result)).toEqual([]);
    });

    it('every exoneration route keeps the node judged — no predicate skip removes it', () => {
      // The two NEGATIVE CONTROLS above, side by side: a trusted origin, and a
      // value that never reaches a tenancy boundary. Each is a distinct exit
      // inside the predicate, and each must still count its node.
      const live = c7Node('fx:c7:pop-trusted', {
        sink: 'mintSessionCookie',
        reachesPartitionKeyOrTenantScope: true,
        sources: [{ origin: 'live-token', validation: 'value', bypassesMinter: false }],
        checkCopies: 1,
        checkCopiesUnderTest: 1,
      });
      const noBoundary = c7Node('fx:c7:pop-no-boundary', {
        sink: 'roleAssignmentBuilder',
        reachesPartitionKeyOrTenantScope: false,
        sources: [{ origin: 'literal', validation: 'none', bypassesMinter: false }],
        checkCopies: 1,
        checkCopiesUnderTest: 1,
      });
      const dirty = c7Node('fx:c7:pop-dirty', {
        sink: 'mintSessionCookie',
        reachesPartitionKeyOrTenantScope: true,
        sources: [{ origin: 'literal', validation: 'none', bypassesMinter: false }],
        checkCopies: 1,
        checkCopiesUnderTest: 1,
      });
      const ids = [live.id, noBoundary.id, dirty.id];
      const result = detectSynthesizedPrincipal(graphOf([live, noBoundary, dirty]));
      expect(result.population.candidates).toEqual(ids);
      expect(result.population.judged).toEqual(ids);
      // …and exactly one of the three is a finding, so the equality above is a
      // statement about counting, not about a detector that fires on nothing.
      expect(securityFindingsOf(result)).toHaveLength(1);
    });

    it('the population is SCOPED to this class, not to the whole graph', () => {
      const mine = c7Node('fx:c7:pop-mine', {
        sink: 'mintSessionCookie',
        reachesPartitionKeyOrTenantScope: true,
        sources: [{ origin: 'literal', validation: 'none', bypassesMinter: false }],
        checkCopies: 1,
        checkCopiesUnderTest: 1,
      });
      const foreign = c8Node('fx:c7:pop-foreign', {
        route: 'setup/identity',
        field: 'bootstrapScript',
        contentShape: 'shell-command',
        interpolations: [
          { name: 'x', source: 'caller-supplied', escaped: false, allowlisted: false, validatedAs: null },
        ],
        siblingEmitters: 1,
        siblingEmittersCovered: 1,
      });
      const result = detectSynthesizedPrincipal(graphOf([mine, foreign]));
      expect(result.population.candidates).toEqual([mine.id]);
      expect(result.population.candidates).not.toContain(foreign.id);
      expect(result.population.declaredKinds).toEqual(['principal']);
    });
  });
});
