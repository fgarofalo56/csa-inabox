/**
 * THE RISK LANE RUNS THE REAL DETECTORS, AND CANNOT REPORT A BLINDNESS AS CLEAN.
 *
 * #3934 says the synapse view RENDERS and does not re-derive: findings come from
 * `lib/brain/security/**`. This file is the proof of that seam. It builds a
 * modelled `SecurityGraph`, runs `buildRiskLayer` — which calls the SHIPPED
 * `runSecuritySweep`, not a stub of it — and asserts the flattened output.
 *
 * ── WHY IT DOES NOT MOCK THE SWEEP ─────────────────────────────────────────
 * A test that mocked `runSecuritySweep` would assert this file's own object
 * literal. It would stay green if the detectors were deleted, if their population
 * contract were removed, or if a remediation gained a callable member. Running
 * the real nine costs milliseconds and asserts the actual composition.
 *
 * ── THE TWO STATES THAT MUST NEVER LOOK ALIKE ──────────────────────────────
 *   NOT EVALUATED   no security graph exists ⇒ `evaluated: false`, plus the
 *                   registry of what WOULD have run, so a reader can count it.
 *   EVALUATED-BLIND a graph exists but a detector ranged over nothing ⇒ the
 *                   detector itself synthesises a `POP-population-integrity`
 *                   finding, which this layer must carry through rather than
 *                   filter out as noise.
 * Both are asserted below, and each carries a control that would fail if the
 * implementation collapsed them into an empty findings array.
 */

import { describe, expect, it } from 'vitest';
import {
  SECURITY_DETECTORS,
  type SecurityGraph,
  type SecurityNode,
} from '@/lib/brain/security';
import { buildRiskLayer, riskDetectorRegistry } from '@/app/api/admin/brain/_lib/risk-layer';
import {
  NO_SECURITY_GRAPH_REASON,
  loadSecurityGraph,
} from '@/app/api/admin/brain/_lib/security-source';
import { NO_EDGE_HISTORY_REASON, loadEdgeHistory } from '@/app/api/admin/brain/_lib/edge-history';
import { InMemoryGraphHistoryStore } from '@/lib/brain/history';
import {
  BASELINE,
  ESTATE,
  fqdnOf,
  versionFrom,
  type EstateSpec,
} from '@/lib/brain/history/__tests__/fixtures';

/**
 * The baseline estate plus one app and the wire that reaches it.
 *
 * Exists so the "previous version" assertion has a CONTROL: the head's edge set
 * differs from the baseline's, so a `loadEdgeHistory` that returned the head — or
 * the union, or an empty set — would be visible rather than coincidentally right.
 */
const GREW: EstateSpec = {
  apps: [...BASELINE.apps, { name: 'loom-new-thing', minReplicas: 1 }],
  wires: [
    ...BASELINE.wires,
    {
      onApp: 'loom-console',
      envVar: 'LOOM_NEW_THING_URL',
      value: `https://${fqdnOf('loom-new-thing')}`,
      boundTo: 'loom-new-thing',
    },
  ],
};

/**
 * An authorizer carrying the admin-bypass shape C1 exists to find.
 *
 * Modelled from the class the taxonomy describes, not copied from a detector
 * fixture: it grants on an admin claim alone (`isTenantAdmin`), it governs a
 * specific caller-named resource (`resourceScoped`), it reaches a write-side
 * privileged sink, and its ALLOW is NOT implied by a verdict from the canonical
 * owns resolver. Remove any one of those and C1 correctly says nothing — which
 * is what makes this a positive subject rather than a shape that always trips.
 */
function bypassAuthorizer(): SecurityNode {
  return {
    id: 'lib/auth/item-gate.ts#allowItemAction',
    kind: 'authorizer',
    provenance: 'declared',
    label: 'allowItemAction — item-scoped authorization',
    facet: {
      kind: 'authorizer',
      fnName: 'allowItemAction',
      params: ['session', 'itemId'],
      resourceScoped: true,
      callerNamedResourceInputs: ['itemId'],
      allowPaths: [
        {
          id: 'allow-1',
          conditionPredicates: ['isTenantAdmin'],
          scopeLiterals: [],
          mentionsVerdict: false,
          impliedByOwnsVerdict: false,
          ownsResolver: null,
        },
      ],
      reachesPrivilegedSink: true,
      privilegedSinkKinds: ['adls-posix-acl'],
    },
  };
}

function graphWith(nodes: readonly SecurityNode[]): SecurityGraph {
  return {
    nodes,
    edges: [],
    annotations: { expectedPredicateClusterSize: {} },
    // Honest: hand-authored. A consumer that reads this as an estate measurement
    // is making the R7 error the field exists to prevent.
    source: 'modelled',
  };
}

// ---------------------------------------------------------------------------
// NOT EVALUATED
// ---------------------------------------------------------------------------

describe('no security graph ⇒ NOT EVALUATED, never an empty findings array', () => {
  const layer = buildRiskLayer({ available: false, reason: NO_SECURITY_GRAPH_REASON });

  it('reports `evaluated: false` and there is no findings field to misread', () => {
    expect(layer.evaluated).toBe(false);
    // The union has no `findings` member on this branch — asserted structurally
    // so a future widening that added one fails here rather than in a browser.
    expect((layer as unknown as { findings?: unknown }).findings).toBeUndefined();
  });

  it('carries the registry, so "0 findings" cannot read as "0 risk"', () => {
    if (layer.evaluated) throw new Error('unreachable');
    expect(layer.registry.length).toBe(SECURITY_DETECTORS.length);
    expect(layer.registry.length).toBeGreaterThanOrEqual(9);
    // Each row names the taxonomy class, so the operator can see WHICH classes
    // went unexamined rather than only how many.
    expect(layer.registry.map((r) => r.taxonomyClass).sort()).toEqual(
      SECURITY_DETECTORS.map((s) => s.taxonomyClass).sort(),
    );
  });

  it('states what was established, not a guess', () => {
    if (layer.evaluated) throw new Error('unreachable');
    expect(layer.reason).toBe(NO_SECURITY_GRAPH_REASON);
    expect(layer.reason).toMatch(/this is not a clean result/i);
  });

  it('the SHIPPED source is now the extracted artifact, and it is usable', () => {
    // A LIVE measurement of the seam, not a restatement of it (#3934). Until
    // this landed, `loadSecurityGraph()` returned a hard-coded refusal and this
    // assertion read `available === false`. It now proves the committed
    // build-time artifact resolves: an absent, malformed, stale, zero-node or
    // wrong-version artifact is refused by `resolveSecurityGraph`, so a green
    // here is evidence the risk lane actually has a population to range over.
    const src = loadSecurityGraph();
    if (!src.available) {
      throw new Error(
        `the shipped security graph did not resolve, so the risk lane ships NOT EVALUATED: ${src.reason}`,
      );
    }
    expect(src.graph.source).toBe('extracted');
    expect(src.graph.nodes.length).toBeGreaterThan(0);
  });

  it('the risk layer built from the SHIPPED source is evaluated, not blind', () => {
    // The end-to-end claim #3934 asks for: the committed artifact, through the
    // real seam, through the real nine detectors. `evaluated: false` here would
    // mean the surface renders NOT EVALUATED in production.
    const shipped = buildRiskLayer(loadSecurityGraph());
    expect(shipped.evaluated).toBe(true);
    if (!shipped.evaluated) throw new Error('unreachable');
    expect(shipped.graphSource).toBe('extracted');
  });

  it('the edge history is honestly unavailable when the store holds ONE version', async () => {
    // The store is INJECTED, so this asserts the refusal branch rather than
    // whatever the ambient environment happens to have. A single retained
    // version has no version before the head, so there is no baseline at all.
    const store = new InMemoryGraphHistoryStore();
    await store.append(versionFrom(BASELINE, '2026-09-01T00:00:00.000Z', { estateId: ESTATE }));
    const h = await loadEdgeHistory({ store, estateId: ESTATE });
    expect(h.available).toBe(false);
    if (h.available) throw new Error('unreachable');
    expect(h.reason).toBe(NO_EDGE_HISTORY_REASON);
    expect(h.reason).toMatch(/fewer than two graph versions/i);
  });

  it('the edge history RETURNS the previous version once two are retained', async () => {
    const store = new InMemoryGraphHistoryStore();
    const older = versionFrom(BASELINE, '2026-09-01T00:00:00.000Z', { estateId: ESTATE });
    const newer = versionFrom(GREW, '2026-09-02T00:00:00.000Z', { estateId: ESTATE });
    await store.append(older);
    await store.append(newer);
    const h = await loadEdgeHistory({ store, estateId: ESTATE });
    expect(h.available).toBe(true);
    if (!h.available) throw new Error('unreachable');
    // The version BEFORE the head — `edgesAddedSincePrevious`'s baseline — so
    // the canvas and /api/admin/brain/history answer the same question.
    expect(h.previousGeneratedAt).toBe(older.capturedAt);
    expect(h.previousEdgeIds.length).toBeGreaterThan(0);
    expect([...h.previousEdgeIds].sort()).toEqual(
      older.content.edges.map((e) => e.id as string).sort(),
    );
    // The CONTROL that makes the assertion above mean something: the head's
    // edge set differs, so returning the wrong version would be visible.
    expect(newer.content.edges.length).not.toBe(older.content.edges.length);
  });

  it('a store FAILURE is reported as a failure, never as "no changes"', async () => {
    const store = new InMemoryGraphHistoryStore();
    const h = await loadEdgeHistory({
      store: {
        policy: store.policy,
        listSummaries: async () => [],
        loadRecent: async () => {
          throw new Error('cosmos unreachable');
        },
        load: async () => null,
        append: async () => {},
        remove: async () => {},
        observe: async () => {},
      },
      estateId: ESTATE,
    });
    expect(h.available).toBe(false);
    if (h.available) throw new Error('unreachable');
    expect(h.reason).toMatch(/cosmos unreachable/);
    expect(h.reason).toMatch(/NOT "no changes"/);
  });

  it('the registry helper agrees with the shipped registry', () => {
    expect(riskDetectorRegistry().map((r) => r.detectorId)).toEqual(
      SECURITY_DETECTORS.map((s) => s.id),
    );
  });
});

// ---------------------------------------------------------------------------
// EVALUATED — over a graph with a real subject
// ---------------------------------------------------------------------------

describe('a graph with a real subject ⇒ the shipped detectors produce the findings', () => {
  const layer = buildRiskLayer({ available: true, graph: graphWith([bypassAuthorizer()]) });

  it('is evaluated and carries the graph provenance verbatim', () => {
    expect(layer.evaluated).toBe(true);
    if (!layer.evaluated) throw new Error('unreachable');
    expect(layer.graphSource).toBe('modelled');
  });

  it('C1 found the bypass — the positive control for the whole seam', () => {
    if (!layer.evaluated) throw new Error('unreachable');
    const c1 = layer.findings.filter((f) => f.findingClass === 'C1-unauthorized-inbound-edge');
    expect(c1.length).toBe(1);
    expect(c1[0]!.severity).toBe('critical');
    expect(c1[0]!.evidence.nodeIds).toContain('lib/auth/item-gate.ts#allowItemAction');
    // The evidence must be re-runnable, not an assertion.
    expect(c1[0]!.evidence.query.length).toBeGreaterThan(20);
    expect(c1[0]!.evidence.facts.length).toBeGreaterThan(0);
  });

  it('THE NEGATIVE CONTROL: remove the privileged sink and C1 correctly says nothing', () => {
    // Without this, a detector that flagged every authorizer would satisfy the
    // test above identically, and the lane would be a colour with no finding.
    const benign = bypassAuthorizer();
    const clean = buildRiskLayer({
      available: true,
      graph: graphWith([
        {
          ...benign,
          facet: { ...benign.facet, reachesPrivilegedSink: false, privilegedSinkKinds: ['none'] },
        } as SecurityNode,
      ]),
    });
    if (!clean.evaluated) throw new Error('unreachable');
    expect(
      clean.findings.filter((f) => f.findingClass === 'C1-unauthorized-inbound-edge'),
    ).toHaveLength(0);
  });

  it('every detector reports judged/candidates, per detector and not only in aggregate', () => {
    if (!layer.evaluated) throw new Error('unreachable');
    expect(layer.detectors.length).toBe(SECURITY_DETECTORS.length);
    for (const d of layer.detectors) {
      expect(d.judged).toBeLessThanOrEqual(d.candidates);
      expect(typeof d.ratio).toBe('number');
      // The taxonomy class must be joined by ID, not by array position: a row
      // labelled C1 that is really C5 is worse than no row.
      const spec = SECURITY_DETECTORS.find((s) => s.id === d.detectorId);
      expect(spec, `detector ${d.detectorId} is not in the registry`).toBeDefined();
      expect(d.taxonomyClass).toBe(spec!.taxonomyClass);
    }
    const c1 = layer.detectors.find((d) => d.taxonomyClass === 'C1')!;
    expect(c1.candidates).toBe(1);
    expect(c1.judged).toBe(1);
    expect(c1.ratio).toBe(1);
  });

  it('EVALUATED-BLIND is carried through, not filtered out as noise', () => {
    if (!layer.evaluated) throw new Error('unreachable');
    // Eight of the nine ranged over ZERO nodes on this graph, and each one says
    // so as a high-severity finding of its own. A flattener that dropped the
    // population class would turn eight blind detectors into a quiet green.
    const pop = layer.findings.filter((f) => f.findingClass === 'POP-population-integrity');
    expect(pop.length).toBe(SECURITY_DETECTORS.length - 1);
    for (const f of pop) {
      expect(f.severity).toBe('high');
      expect(f.title).toMatch(/EMPTY population — green and blind/);
    }
  });

  it('every remediation that reaches the wire is INERT', () => {
    if (!layer.evaluated) throw new Error('unreachable');
    expect(layer.findings.length).toBeGreaterThan(0);
    for (const f of layer.findings) {
      expect(f.remediation.requiresHumanApproval).toBe(true);
      // No callable member survives the flatten. `assertAllInert` inside the
      // sweep is the first line of this; the flattened shape is the second,
      // because the type is erased the moment this crosses HTTP.
      for (const v of Object.values(f.remediation)) {
        expect(typeof v).not.toBe('function');
      }
      for (const cmd of f.remediation.proposedCommands) expect(typeof cmd).toBe('string');
    }
  });

  it('the aggregate coverage is present and consistent with the per-detector rows', () => {
    if (!layer.evaluated) throw new Error('unreachable');
    const judged = layer.detectors.reduce((a, d) => a + d.judged, 0);
    const candidates = layer.detectors.reduce((a, d) => a + d.candidates, 0);
    expect(layer.coverage.judged).toBe(judged);
    expect(layer.coverage.candidates).toBe(candidates);
    expect(layer.coverage.incompleteDetectors).toEqual([]);
  });
});
