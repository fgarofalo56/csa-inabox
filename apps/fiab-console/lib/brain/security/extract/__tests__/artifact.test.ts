/**
 * EVERY REFUSAL BRANCH, REACHED.
 *
 * `artifact.ts` exists to make "not evaluated" a state the surface can actually
 * be in. A refusal branch no test can enter is not a guard, so this spec enters
 * all of them and asserts the reason names the CAUSE — never a generic failure.
 *
 * The pattern being guarded against is live one directory away:
 * `lib/brain/live-graph.ts:215` hard-codes `configured.collected: true`
 * regardless of whether the env read succeeded, which makes NOT-EVALUATED
 * unreachable on that lane and lets a clean zero be reported for something
 * nobody examined. Nothing here may be written that way.
 */

import { describe, expect, it } from 'vitest';
import type { SecurityGraph } from '../../substrate';
import type { SecurityGraphArtifact } from '../types';
import { GENERATOR_VERSION } from '../build';
import { ageInDays, MAX_ARTIFACT_AGE_DAYS, resolveSecurityGraph } from '../artifact';

const NOW = new Date('2026-08-24T12:00:00.000Z');

function graphWith(nodes: SecurityGraph['nodes']): SecurityGraph {
  return { nodes, edges: [], annotations: { expectedPredicateClusterSize: {} }, source: 'extracted' };
}

const ONE_NODE: SecurityGraph['nodes'] = [
  {
    id: 'sec:authorizer:apps/fiab-console/app/api/x/route.ts#GET',
    kind: 'authorizer',
    provenance: 'declared',
    label: 'GET /api/x',
    facet: {
      kind: 'authorizer',
      fnName: 'GET /api/x',
      params: [],
      resourceScoped: false,
      callerNamedResourceInputs: [],
      allowPaths: [],
      reachesPrivilegedSink: false,
      privilegedSinkKinds: [],
    },
  },
];

function artifactWith(overrides: Partial<SecurityGraphArtifact> = {}): SecurityGraphArtifact {
  const graph = overrides.graph ?? graphWith(ONE_NODE);
  return {
    graph,
    join: overrides.join ?? {
      painted: graph.nodes.map((n) => ({
        nodeId: n.id,
        codeModuleId: 'code:apps/fiab-console/app/api/x/route.ts',
        deployedAs: 'loom-console',
      })),
      unjoined: [],
    },
    meta: {
      generatorVersion: GENERATOR_VERSION,
      generatedAt: '2026-08-24T00:00:00.000Z',
      commit: null,
      inputsDigest: 'deadbeefdeadbeef',
      filesScanned: 1,
      scanScopes: [],
      skipped: [],
      ...overrides.meta,
    },
  };
}

describe('resolveSecurityGraph — a healthy artifact', () => {
  it('is AVAILABLE and hands back the graph unchanged', () => {
    const artifact = artifactWith();
    const result = resolveSecurityGraph(artifact, { now: NOW });
    expect(result.available).toBe(true);
    if (result.available) expect(result.graph).toBe(artifact.graph);
  });
});

describe('resolveSecurityGraph — every refusal is reachable and names its cause', () => {
  it('REFUSES a missing artifact', () => {
    const result = resolveSecurityGraph(null, { now: NOW });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('NOT EVALUATED');
    expect(result.reason).toContain('build time');
  });

  it('REFUSES a graph produced by a different extractor version', () => {
    const result = resolveSecurityGraph(
      artifactWith({ meta: { generatorVersion: GENERATOR_VERSION + 1 } as never }),
      { now: NOW },
    );
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain(`version ${GENERATOR_VERSION + 1}`);
  });

  it("REFUSES a 'modelled' graph — a fixture is not a measurement", () => {
    const graph: SecurityGraph = { ...graphWith(ONE_NODE), source: 'modelled' };
    const result = resolveSecurityGraph(artifactWith({ graph }), { now: NOW });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain("source 'modelled'");
  });

  it('REFUSES a ZERO-NODE graph rather than sweeping it', () => {
    // THE CENTRAL CASE. A sweep over an empty graph reports zero security
    // findings, and zero is indistinguishable from clean to any consumer that
    // counts risks. It must never reach a detector.
    const result = resolveSecurityGraph(
      artifactWith({ graph: graphWith([]), join: { painted: [], unjoined: [] } }),
      { now: NOW },
    );
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('ZERO nodes');
    expect(result.reason).toContain('indistinguishable from a clean estate');
  });

  it('REFUSES a STALE artifact and states its age', () => {
    const stale = artifactWith({ meta: { generatedAt: '2026-01-01T00:00:00.000Z' } as never });
    const result = resolveSecurityGraph(stale, { now: NOW });
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('STALE');
    expect(result.reason).toContain(`ceiling ${MAX_ARTIFACT_AGE_DAYS} days`);
  });

  it('ACCEPTS an artifact one day inside the ceiling and REFUSES one day outside', () => {
    const inside = new Date(NOW.getTime() - (MAX_ARTIFACT_AGE_DAYS - 1) * 86_400_000);
    const outside = new Date(NOW.getTime() - (MAX_ARTIFACT_AGE_DAYS + 1) * 86_400_000);

    expect(
      resolveSecurityGraph(artifactWith({ meta: { generatedAt: inside.toISOString() } as never }), {
        now: NOW,
      }).available,
    ).toBe(true);
    expect(
      resolveSecurityGraph(artifactWith({ meta: { generatedAt: outside.toISOString() } as never }), {
        now: NOW,
      }).available,
    ).toBe(false);
  });

  it('REFUSES an unparseable generatedAt rather than treating unknown age as fresh', () => {
    const result = resolveSecurityGraph(
      artifactWith({ meta: { generatedAt: 'not-a-date' } as never }),
      { now: NOW },
    );
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('unparseable');
  });

  it('REFUSES an artifact whose join does not account for every node', () => {
    const result = resolveSecurityGraph(
      artifactWith({ join: { painted: [], unjoined: [] } }),
      { now: NOW },
    );
    expect(result.available).toBe(false);
    if (result.available) throw new Error('unreachable');
    expect(result.reason).toContain('does not account for every node');
  });

  it('never throws on a malformed artifact — it degrades to an honest refusal', () => {
    const broken = { graph: null, join: null, meta: null } as unknown as SecurityGraphArtifact;
    expect(() => resolveSecurityGraph(broken, { now: NOW })).not.toThrow();
  });
});

describe('ageInDays', () => {
  it('returns null for an unparseable timestamp instead of 0', () => {
    // Returning 0 would read as "generated right now", turning an UNKNOWN into
    // the most favourable possible answer.
    expect(ageInDays('nonsense', NOW)).toBeNull();
  });

  it('measures whole days', () => {
    expect(ageInDays('2026-08-14T12:00:00.000Z', NOW)).toBe(10);
  });
});
