/**
 * CONTRACTS THE ARTIFACT MUST HOLD — publication safety, cloud neutrality, and
 * the coupling between what this extractor NAMES and what C1 RECOGNISES.
 *
 * All three are asserted rather than stated, because each is a claim made in a
 * docblock elsewhere in this package and a docblock does not fail a build.
 */

import { describe, expect, it } from 'vitest';
import { runSecuritySweep } from '../../index';
import type { SecurityGraph, SecurityNode } from '../../substrate';
import { extractedArtifact } from '../runtime';

const artifact = extractedArtifact()!;
const serialized = JSON.stringify(artifact);

describe('the committed artifact publishes NOTHING about an estate', () => {
  // This repo is PUBLIC and the artifact is COMMITTED. Anything that reaches it
  // is published, permanently, to everyone.

  it('contains no GUID — no subscription, tenant, object or client id', () => {
    const guid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
    const hit = guid.exec(serialized);
    expect(hit?.[0] ?? null).toBeNull();
  });

  it('contains no ARM resource path', () => {
    expect(/\/subscriptions\//i.test(serialized)).toBe(false);
    expect(/\/resourceGroups\//i.test(serialized)).toBe(false);
  });

  it('contains no Azure endpoint host', () => {
    for (const host of [
      'core.windows.net',
      'azure.com',
      'usgovcloudapi.net',
      'core.usgovcloudapi.net',
      'azure.us',
      'onelake.dfs.fabric.microsoft.com',
      'limitlessdata.ai',
    ]) {
      expect(serialized.includes(host)).toBe(false);
    }
  });
});

describe('the artifact is CLOUD-NEUTRAL by construction', () => {
  // cloud-parity.md is die-hard. A build-time artifact SHOULD be cloud-neutral
  // because it names no cloud — but "should" is how parity claims go wrong, so
  // the property is measured on the real bytes.

  it('names no cloud, boundary or sovereign environment', () => {
    for (const token of [
      'AzureUSGovernment',
      'AzureCloud',
      'usgov',
      'gcc-high',
      'gcchigh',
      'il5',
      'commercial-full',
    ]) {
      expect(serialized.toLowerCase().includes(token.toLowerCase())).toBe(false);
    }
  });

  it('joins through LOGICAL app names only, never an ARM id', () => {
    const units = new Set(artifact.join.painted.map((p) => p.deployedAs));
    expect(units.size).toBeGreaterThan(0);
    for (const unit of units) {
      expect(unit).toMatch(/^[a-z0-9-]+$/);
      expect(unit.startsWith('azure:')).toBe(false);
    }
  });
});

/**
 * The coupling that would otherwise fail SILENTLY.
 *
 * `route-nodes.ts#ADMIN_CLAIM_SPELLINGS` maps a source spelling
 * (`withTenantAdmin`) to the predicate NAME C1 keys on (`isTenantAdmin`). C1's
 * `ADMIN_CLAIM_PREDICATES` is module-private, so this asserts the coupling
 * BEHAVIOURALLY: a node carrying each emitted predicate name, with every other
 * C1 condition satisfied, must actually produce a finding.
 *
 * A rename on either side empties the C1 finding set without erroring. This
 * turns that into a red test.
 */
function authorizerNode(predicate: string): SecurityNode {
  return {
    id: `sec:authorizer:apps/fiab-console/app/api/probe/[id]/route.ts#GET`,
    kind: 'authorizer',
    provenance: 'declared',
    label: 'GET /api/probe/[id]',
    facet: {
      kind: 'authorizer',
      fnName: 'GET /api/probe/[id]',
      params: ['id'],
      resourceScoped: true,
      callerNamedResourceInputs: ['id'],
      allowPaths: [
        {
          id: 'get:admin-claim',
          conditionPredicates: [predicate],
          scopeLiterals: [],
          mentionsVerdict: false,
          impliedByOwnsVerdict: false,
          ownsResolver: null,
        },
      ],
      reachesPrivilegedSink: true,
      privilegedSinkKinds: ['cosmos-cross-partition-read'],
    },
  };
}

function sweepOne(node: SecurityNode) {
  const graph: SecurityGraph = {
    nodes: [node],
    edges: [],
    annotations: { expectedPredicateClusterSize: {} },
    source: 'extracted',
  };
  return runSecuritySweep(graph);
}

describe('every predicate name this extractor emits is one C1 recognises', () => {
  for (const predicate of ['isTenantAdmin', 'hasTenantAdminRole']) {
    it(`C1 fires on '${predicate}'`, () => {
      const sweep = sweepOne(authorizerNode(predicate));
      const c1 = sweep.findings.filter((f) => f.findingClass === 'C1-unauthorized-inbound-edge');
      expect(c1.length).toBeGreaterThan(0);
    });
  }

  it('C1 does NOT fire on a predicate name it does not recognise (control)', () => {
    // Proves the assertions above are watching the PREDICATE and not merely the
    // node's presence — without this, a detector that fired on everything would
    // pass them both.
    const sweep = sweepOne(authorizerNode('someUnrelatedCheck'));
    const c1 = sweep.findings.filter((f) => f.findingClass === 'C1-unauthorized-inbound-edge');
    expect(c1).toHaveLength(0);
  });
});

describe('the artifact records what it did NOT measure', () => {
  it('carries scan scopes with real file counts', () => {
    expect(artifact.meta.scanScopes.length).toBeGreaterThan(0);
    for (const scope of artifact.meta.scanScopes) {
      expect(scope.filesMatched).toBeGreaterThan(0);
      expect(scope.scope.length).toBeGreaterThan(0);
    }
  });

  it('carries skipped subjects with reasons, so the gaps are countable', () => {
    expect(artifact.meta.skipped.length).toBeGreaterThan(0);
    for (const s of artifact.meta.skipped.slice(0, 50)) {
      expect(s.reason.length).toBeGreaterThan(30);
    }
  });
});
