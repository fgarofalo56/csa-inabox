/**
 * LOOM BRAIN — the shared contract's runtime-visible guarantees.
 *
 * The COMPILE-time guarantees (P1/P2/P4 and the cost-source requirement) are
 * asserted in `lib/brain/types.ts` itself, in a SOURCE file, deliberately:
 * `next build` typechecks with `tsconfig.build.json`, which EXCLUDES
 * `**\/__tests__\/**`, so a `@ts-expect-error` written here is NOT enforced by
 * the build gate. A guard the gate never runs is not a guard. This file asserts
 * only what is observable at RUNTIME.
 *
 * The pattern is lifted from `lib/estate/pause-state.ts`, which learned it the
 * same way.
 */
import { describe, it, expect } from 'vitest';
import * as brainGraph from '../../graph';
import {
  billedCost,
  derivedCost,
  EDGE_PROVENANCES,
  formatCostFigure,
  isDanglingEdge,
  isResolvedEdge,
  NODE_KINDS,
  proposal,
  type BrainEdge,
  type EdgeId,
  type NodeId,
} from '../../graph';

describe('the provenance set is closed and complete', () => {
  it('holds exactly the five provenances from PRP §3.1', () => {
    expect([...EDGE_PROVENANCES].sort()).toEqual(
      ['configured', 'declared', 'imports', 'observed', 'owns'].sort(),
    );
  });

  it('has NO "unknown" member — an extractor that cannot tell must not emit', () => {
    expect(EDGE_PROVENANCES).not.toContain('unknown');
  });

  it('holds exactly the four node kinds', () => {
    expect([...NODE_KINDS].sort()).toEqual(
      ['azure-resource', 'code-module', 'deploy-artifact', 'loom-item'].sort(),
    );
  });
});

describe('edge narrowing helpers', () => {
  const resolved: BrainEdge = {
    id: 'e1' as EdgeId,
    provenance: 'configured',
    from: 'azure:a' as NodeId,
    evidence: { artifact: 'x', extractor: 'container-app-env' },
    resolution: 'resolved',
    to: 'azure:b' as NodeId,
  };
  const dangling: BrainEdge = {
    id: 'e2' as EdgeId,
    provenance: 'declared',
    from: 'azure:a' as NodeId,
    evidence: { artifact: 'x', extractor: 'bicep' },
    resolution: 'dangling',
    to: null,
    intendedTo: 'azure:b' as NodeId,
    danglingReason: 'empty-value',
  };

  it('discriminate correctly and are mutually exclusive', () => {
    expect(isResolvedEdge(resolved)).toBe(true);
    expect(isDanglingEdge(resolved)).toBe(false);
    expect(isDanglingEdge(dangling)).toBe(true);
    expect(isResolvedEdge(dangling)).toBe(false);
  });

  it("a dangling edge's target is null even when its INTENT is known", () => {
    // This is the property that keeps it out of reachability while preserving
    // the evidence chain.
    expect(dangling.to).toBeNull();
    expect(isDanglingEdge(dangling) && dangling.intendedTo).toBe('azure:b');
  });
});

describe('cost figures are never presented as something they are not', () => {
  it('a DERIVED figure renders with an explicit not-a-bill label', () => {
    const c = derivedCost(43.8, '2 replicas x 0.5 vCPU, retail list 2026-08-23', '2026-08-23');
    const s = formatCostFigure(c);
    expect(s).toMatch(/DERIVED estimate/);
    expect(s).toMatch(/not a bill/);
    expect(s).toContain('$43.80');
    expect(s).toContain('retail list 2026-08-23');
  });

  it('a BILLED figure renders as billed, and the two are never the same string', () => {
    const d = derivedCost(10, 'basis', '2026-08-23');
    const b = billedCost(10, 'basis', '2026-08-23');
    expect(formatCostFigure(b)).toMatch(/billed/);
    expect(formatCostFigure(b)).not.toMatch(/DERIVED/);
    expect(formatCostFigure(d)).not.toBe(formatCostFigure(b));
  });

  it('the constructors stamp the source — it cannot be omitted at a call site', () => {
    expect(derivedCost(1, 'b', 'a').source).toBe('derived');
    expect(billedCost(1, 'b', 'a').source).toBe('billed');
  });

  it('MEASURED CONTEXT: every figure produced so far is derived', () => {
    // The Cost Management API returned HTTP 429 on 11 consecutive attempts over
    // ~35 minutes (PRP §1 decision 3). Until an export lands, `billedCost` has
    // no legitimate caller and this expectation documents why.
    const c = derivedCost(0, 'measured SKU x published retail rate', '2026-08-23');
    expect(c.source).toBe('derived');
    expect(c.basis.length).toBeGreaterThan(0);
  });
});

describe('remediations are proposals, never actions (P4)', () => {
  it('the only constructor stamps human approval and no mutation', () => {
    const p = proposal('Wire LOOM_BROKER_URL', "set value to 'https://<broker-fqdn>'");
    expect(p.kind).toBe('proposal');
    expect(p.requiresHumanApproval).toBe(true);
    expect(p.mutatesAzure).toBe(false);
  });

  it('the proposed change is TEXT — nothing in lib/brain executes it', () => {
    const p = proposal('s', 'az containerapp update --set-env-vars LOOM_BROKER_URL=https://x');
    expect(typeof p.proposedChange).toBe('string');
  });
});

describe('the public surface four downstream agents build against', () => {
  /**
   * PINNED ON PURPOSE. Detectors, the agent layer, the cost layer and the
   * visualizer are all written against these names concurrently with this
   * module. Renaming or dropping one is a breaking change to four consumers at
   * once, so it should fail here first rather than in four other branches.
   */
  const REQUIRED_EXPORTS = [
    // graph construction
    'buildGraph',
    'makePopulation',
    // identity
    'azureResourceNodeId',
    'loomItemNodeId',
    'deployArtifactNodeId',
    'codeModuleNodeId',
    'canonicalPath',
    'edgeId',
    'nodeIdFromPersisted',
    'edgeIdFromPersisted',
    // queries — a detector is one of these, not a bespoke rule
    'nodesWithNoInboundEdge',
    'hasInboundOnly',
    'danglingEdges',
    'alwaysOnNodes',
    'scaleUnknownCount',
    // extractors
    'extractFromResourceGraph',
    'extractFromBicep',
    'extractFromContainerAppEnv',
    'extractFromSourceImports',
    // contract values + constructors
    'EDGE_PROVENANCES',
    'NODE_KINDS',
    'LOOM_ESTATE_TAG_KEY',
    'isResolvedEdge',
    'isDanglingEdge',
    'derivedCost',
    'billedCost',
    'formatCostFigure',
    'proposal',
  ] as const;

  it('exports every name the downstream modules were told to use', () => {
    const surface = new Set(Object.keys(brainGraph));
    const missing = REQUIRED_EXPORTS.filter((n) => !surface.has(n));
    expect(missing).toEqual([]);
  });

  it('every required export is actually callable or a value, not an undefined re-export', () => {
    // A barrel can export a name that resolves to `undefined` when the source
    // module renames it — the import compiles and fails at runtime.
    for (const name of REQUIRED_EXPORTS) {
      expect((brainGraph as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});
