/**
 * C7 — the synthesized principal. The narrow arms are `-z` (absence, not
 * validity) and the cached path that never calls the guarded minter.
 */

import { describe, expect, it } from 'vitest';
import { detectSynthesizedPrincipal, securityFindingsOf } from '@/lib/brain/security';
import { c7Node, graphOf } from './fixtures/corpus';

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
});
