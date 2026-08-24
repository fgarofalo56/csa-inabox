/**
 * C1 — unauthorized inbound edge. Positive, NARROW positive, two negative
 * controls, and the population assertion that matters most in this lane.
 */

import { describe, expect, it } from 'vitest';
import { detectUnauthorizedInboundEdge, securityFindingsOf } from '@/lib/brain/security';
import {
  AP_CLEAN_DELEGATION,
  AP_LAKEHOUSE_SCOPED_BYPASS,
  AP_MENTIONS_BUT_DISCARDS,
  c1NegativeMappingLookup,
  c1NegativeOrgWideGate,
  c1PositiveItemScoped,
  c1PositiveNarrow,
  graphOf,
} from './fixtures/corpus';
import type { SecurityNode } from '@/lib/brain/security/substrate';

describe('C1 — the unauthorized inbound edge', () => {
  it('POSITIVE: fires on an admin short-circuit that reaches a privileged sink', () => {
    const findings = securityFindingsOf(
      detectUnauthorizedInboundEdge(graphOf([c1PositiveItemScoped()])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C1-unauthorized-inbound-edge');
    // An ADLS POSIX ACL grant is a WRITE-side escalation, not a read.
    expect(findings[0].severity).toBe('critical');
  });

  it('POSITIVE (NARROW): fires identically when the bypass is scoped to ONE item type', () => {
    const findings = securityFindingsOf(
      detectUnauthorizedInboundEdge(graphOf([c1PositiveNarrow()])),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].findingClass).toBe('C1-unauthorized-inbound-edge');
    expect(findings[0].evidence.facts.join('\n')).toContain('NARROW');
    // The correct delegation on the same authorizer does NOT absolve the scoped
    // ALLOW. A spec suite exercising a different item type would never see it.
    expect(findings[0].title).toContain("itemType === 'lakehouse'");
  });

  it('NARROW severity is NOT reduced — the scoped form is graded the same as the broad', () => {
    // Identical in every respect EXCEPT the literal scoping, so the comparison
    // isolates the one variable. If a future change ever grades the narrow form
    // lower, this fails — which is the point: the narrow form is the one that
    // passed guard exit 0, a 27-test spec and a 259-test suite on 2026-08-21.
    const broadNode: SecurityNode = {
      id: 'fx:c1:broad-unscoped',
      kind: 'authorizer',
      provenance: 'declared',
      label: 'the same bypass with no literal scoping',
      facet: {
        kind: 'authorizer',
        fnName: 'authorizeItemWorkspace',
        params: ['session', 'opts'],
        resourceScoped: true,
        callerNamedResourceInputs: ['opts.itemId'],
        allowPaths: [
          AP_CLEAN_DELEGATION,
          { ...AP_LAKEHOUSE_SCOPED_BYPASS, id: 'ap-broad-unscoped', scopeLiterals: [] },
        ],
        reachesPrivilegedSink: true,
        privilegedSinkKinds: ['cosmos-write'],
      },
    };

    const broad = securityFindingsOf(detectUnauthorizedInboundEdge(graphOf([broadNode])));
    const narrow = securityFindingsOf(detectUnauthorizedInboundEdge(graphOf([c1PositiveNarrow()])));

    expect(broad).toHaveLength(1);
    expect(narrow).toHaveLength(1);
    expect(narrow[0].severity).toBe(broad[0].severity);
    expect(narrow[0].confidence).toBe(broad[0].confidence);
  });

  it('POSITIVE: fires on the DEFEATED FIX that mentions the verdict and discards it', () => {
    const node: SecurityNode = {
      id: 'fx:c1:defeated-fix',
      kind: 'authorizer',
      provenance: 'declared',
      label: 'round-2 fix defeated by `if (!denied || opts.itemType === ...)`',
      facet: {
        kind: 'authorizer',
        fnName: 'authorizeItemWorkspace',
        params: ['session', 'opts'],
        resourceScoped: true,
        callerNamedResourceInputs: ['opts.itemId'],
        allowPaths: [AP_MENTIONS_BUT_DISCARDS],
        reachesPrivilegedSink: true,
        privilegedSinkKinds: ['cosmos-write'],
      },
    };
    const findings = securityFindingsOf(detectUnauthorizedInboundEdge(graphOf([node])));
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.facts.join('\n')).toContain('DEFEATED fix');
    // Mentioning a verdict must not soften the grade.
    expect(findings[0].confidence).toBe('high');
  });

  it('NEGATIVE CONTROL: does NOT fire on requireTenantAdmin (org-wide gate, no resource)', () => {
    const findings = securityFindingsOf(
      detectUnauthorizedInboundEdge(graphOf([c1NegativeOrgWideGate()])),
    );
    expect(findings).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire on an admin lookup whose result decides nothing', () => {
    const findings = securityFindingsOf(
      detectUnauthorizedInboundEdge(graphOf([c1NegativeMappingLookup()])),
    );
    expect(findings).toEqual([]);
  });

  it('NEGATIVE CONTROL: does NOT fire when the ALLOW is implied by an owns-verdict', () => {
    const node: SecurityNode = {
      id: 'fx:c1:delegating',
      kind: 'authorizer',
      provenance: 'declared',
      label: 'authorizer delegating correctly',
      facet: {
        kind: 'authorizer',
        fnName: 'authorizeWorkspace',
        params: ['session', 'workspaceId'],
        resourceScoped: true,
        callerNamedResourceInputs: ['workspaceId'],
        allowPaths: [AP_CLEAN_DELEGATION],
        reachesPrivilegedSink: true,
        privilegedSinkKinds: ['cosmos-write'],
      },
    };
    expect(securityFindingsOf(detectUnauthorizedInboundEdge(graphOf([node])))).toEqual([]);
  });

  describe('POPULATION — the property this detector exists to preserve', () => {
    it('JUDGES an authorizer whose parameters carry no workspace-shaped name', () => {
      // This is taxonomy §2.4(c) measured live: check-tid-boundary-chokepoint.mjs
      // finds 15 functions carrying this shape and judges 1, RC=0, because
      // `ADMIN_GRANT_SCOPE = /\bworkspace(Id|_id)?\b/i` is applied to fn.params.
      // An authorizer taking (session, itemId, itemType) is outside its judged
      // population. It must NOT be outside this one.
      const node = c1PositiveItemScoped();
      const facetParams = (node.facet as { params: readonly string[] }).params;
      expect(facetParams.join(',')).not.toMatch(/workspace/i);

      const result = detectUnauthorizedInboundEdge(graphOf([node]));
      expect(result.population.candidates).toContain(node.id);
      expect(result.population.judged).toContain(node.id);
      expect(result.population.unjudged).toEqual([]);
    });

    it('judged === candidates for every authorizer, including the negative controls', () => {
      const nodes = [
        c1PositiveItemScoped(),
        c1PositiveNarrow(),
        c1NegativeOrgWideGate(),
        c1NegativeMappingLookup(),
      ];
      const result = detectUnauthorizedInboundEdge(graphOf(nodes));
      expect(result.population.candidates).toHaveLength(4);
      expect(result.population.judged).toHaveLength(4);
      // A node being CLEAN must never remove it from the judged set — otherwise
      // coverage and compliance are indistinguishable.
      expect(result.population.judged).toContain(c1NegativeOrgWideGate().id);
    });

    it('reports an EMPTY population loudly rather than reporting clean', () => {
      const result = detectUnauthorizedInboundEdge(graphOf([]));
      expect(securityFindingsOf(result)).toEqual([]);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].findingClass).toBe('POP-population-integrity');
      expect(result.findings[0].severity).toBe('high');
    });
  });
});
