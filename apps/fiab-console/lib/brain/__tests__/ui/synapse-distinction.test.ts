/**
 * THE SYNAPSE LAYERS ARE VISUALLY DISTINCT, AND THEIR POPULATIONS ARE HONEST.
 *
 * #3934's acceptance criteria are two claims about a PICTURE — "an unreachable
 * node is visually distinguishable from a healthy one, and `loom-capacity-broker`
 * is the worked example" and "a risk edge is distinguishable from a benign one" —
 * plus, from every rule this repo runs on, a third: a layer that could not be
 * evaluated must not render as a layer that came back clean.
 *
 * ── WHY DISTINCTNESS IS ASSERTED PAIRWISE, NOT AGAINST CONSTANTS ───────────
 * Pinning `accent === 'var(--loom-accent-red)'` passes a refactor that makes two
 * layers identical, because each assertion only ever looks at one layer. Pinning
 * "no two layers share a rendering" cannot. Every distinctness test below
 * compares the layers to EACH OTHER, and the edge tests additionally require the
 * difference to survive on at least two channels, because a colour-only
 * distinction is invisible to a colour-blind operator and dies to one CSS
 * regression.
 *
 * ── AND WHY EVERY LANE TEST CARRIES A CONTROL ──────────────────────────────
 * "History is unavailable, so nothing is marked new" is satisfied identically by
 * a correct implementation and by one that can never mark anything new. So each
 * such test has a positive twin: history IS supplied, and the edge IS marked.
 * Without the twin the assertion is a tautology.
 */

import { describe, expect, it } from 'vitest';
import { snapshotFromCollection } from '@/app/api/admin/brain/_lib/snapshot';
import type { BrainSnapshot, WireEdge } from '@/app/api/admin/brain/_lib/wire';
import type { RiskLayer, WireRiskFinding } from '@/app/api/admin/brain/_lib/synapse-wire';
import {
  buildSynapseOverlay,
  pruneWidth,
  synapseEdgeMark,
  SYNAPSE_NODE_MAX_WIDTH,
  SYNAPSE_NODE_MIN_WIDTH,
  type SynapseEdgeLayer,
  type SynapseNodeMark,
} from '@/app/admin/brain/synapse-model';
import {
  BROKER_ID,
  CONSOLE_ID,
  DIRECTLAKE_ID,
  MIGRATE_ID,
  collection,
} from './estate-fixture';

const snapshot = snapshotFromCollection(collection());

function overlayOf(args?: {
  readonly risk?: RiskLayer | null;
  readonly history?: Parameters<typeof buildSynapseOverlay>[0]['history'];
  readonly snap?: BrainSnapshot;
}) {
  const snap = args?.snap ?? snapshot;
  return buildSynapseOverlay({
    snapshot: snap,
    nodes: snap.nodes,
    edges: snap.edges,
    risk: args?.risk ?? null,
    history: args?.history ?? null,
  });
}

function markOf(id: string, o = overlayOf()): SynapseNodeMark {
  const m = o.nodeMarks.get(id);
  if (!m) throw new Error(`no synapse mark for ${id} — the fixture or the join changed`);
  return m;
}

// ---------------------------------------------------------------------------
// The population precondition. Everything below is vacuous without it.
// ---------------------------------------------------------------------------

describe('the fixture actually produces the subjects these tests reason about', () => {
  it('has a non-empty estate and a collected `configured` provenance', () => {
    expect(snapshot.nodes.length).toBeGreaterThan(3);
    expect(snapshot.coverage.configured.collected).toBe(true);
  });

  it('marks every node in view — no node is silently unclassified', () => {
    const o = overlayOf();
    expect(o.nodeMarks.size).toBe(snapshot.nodes.length);
    expect(o.edgeMarks.size).toBe(snapshot.edges.length);
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE — loom-capacity-broker vs a healthy node
// ---------------------------------------------------------------------------

describe('ACCEPTANCE: an unreachable node is distinguishable from a healthy one', () => {
  it('loom-capacity-broker is a costly prune candidate; loom-directlake is not', () => {
    const broker = markOf(BROKER_ID);
    const healthy = markOf(DIRECTLAKE_ID);

    expect(broker.layer).toBe('prune-costly');
    // THE CONTROL. Without it, "every node is a prune candidate" would satisfy
    // the line above exactly, and the layer would be indistinguishable from
    // `() => allNodes`.
    expect(healthy.layer).not.toBe('prune-costly');
    expect(healthy.layer).not.toBe('prune-idle');
  });

  it('and they differ on FOUR independent channels, not just colour', () => {
    const broker = markOf(BROKER_ID);
    const healthy = markOf(DIRECTLAKE_ID);

    expect(broker.layer).not.toBe(healthy.layer);
    expect(broker.accent).not.toBe(healthy.accent);
    expect(broker.badge).not.toBe(healthy.badge);
    expect(broker.ring).not.toBe(healthy.ring);
  });

  it('the broker states WHY, in a reason that survives to the tooltip', () => {
    // A badge with no reason is a colour with no finding behind it.
    expect(markOf(BROKER_ID).reason).toMatch(/inbound configured/i);
  });

  it('an unreachable-but-idle node is NOT rendered as loudly as the billing one', () => {
    // Rendering both at maximum alarm trains the operator to ignore both.
    const idle = markOf(MIGRATE_ID);
    const costly = markOf(BROKER_ID);
    expect(idle.layer).toBe('prune-idle');
    expect(idle.ring).toBe(false);
    expect(costly.ring).toBe(true);
    expect(idle.accent).not.toBe(costly.accent);
  });

  it('an EXTERNAL-ingress node is neither cleared nor pruned', () => {
    // loom-console is reachable by callers that are not edges in this graph.
    // Calling it waste would be a false claim; calling it wired would be another.
    expect(markOf(CONSOLE_ID).layer).toBe('unevaluated');
  });
});

// ---------------------------------------------------------------------------
// Node-layer distinctness, pairwise
// ---------------------------------------------------------------------------

describe('node layers are pairwise distinct', () => {
  it('no two layers present in the view share an accent or a badge', () => {
    const o = overlayOf();
    const byLayer = new Map<string, SynapseNodeMark>();
    for (const m of o.nodeMarks.values()) if (!byLayer.has(m.layer)) byLayer.set(m.layer, m);

    // POPULATION: with fewer than two layers on screen this test proves nothing.
    expect(byLayer.size).toBeGreaterThanOrEqual(3);

    const marks = [...byLayer.values()];
    for (let i = 0; i < marks.length; i += 1) {
      for (let j = i + 1; j < marks.length; j += 1) {
        const a = marks[i]!;
        const b = marks[j]!;
        expect(a.accent, `${a.layer} and ${b.layer} share an accent`).not.toBe(b.accent);
        expect(a.badge, `${a.layer} and ${b.layer} share a badge`).not.toBe(b.badge);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PRUNE candidates are sized by derived cost — inside the compactness band
// ---------------------------------------------------------------------------

describe('prune candidates are sized by derived cost, within the ux-baseline band', () => {
  it('the most expensive prune candidate is the widest node on the canvas', () => {
    const o = overlayOf();
    const prune = [...o.nodeMarks.values()].filter(
      (m) => m.layer === 'prune-costly' || m.layer === 'prune-idle',
    );
    expect(prune.length).toBeGreaterThan(1);

    const priced = prune.filter((m) => (m.derivedCostUsd ?? 0) > 0);
    expect(priced.length, 'no prune candidate carries a derived cost').toBeGreaterThan(0);

    const dearest = priced.reduce((a, b) =>
      (a.derivedCostUsd ?? 0) >= (b.derivedCostUsd ?? 0) ? a : b,
    );
    for (const m of priced) {
      if (m === dearest) continue;
      if ((m.derivedCostUsd ?? 0) === (dearest.derivedCostUsd ?? 0)) continue;
      expect(m.widthPx).toBeLessThan(dearest.widthPx);
    }
  });

  it('every node width stays inside 160-190px (ux-baseline node compactness)', () => {
    for (const m of overlayOf().nodeMarks.values()) {
      expect(m.widthPx).toBeGreaterThanOrEqual(SYNAPSE_NODE_MIN_WIDTH);
      expect(m.widthPx).toBeLessThanOrEqual(SYNAPSE_NODE_MAX_WIDTH);
    }
  });

  it('an UNPRICED prune candidate renders at the minimum, never as an expensive one', () => {
    expect(pruneWidth(null, 100)).toBe(SYNAPSE_NODE_MIN_WIDTH);
    expect(pruneWidth(0, 100)).toBe(SYNAPSE_NODE_MIN_WIDTH);
    // And nothing priced at all does not divide by zero into the maximum.
    expect(pruneWidth(50, 0)).toBe(SYNAPSE_NODE_MIN_WIDTH);
  });

  it('the scale is monotonic and bounded', () => {
    expect(pruneWidth(1, 100)).toBeLessThan(pruneWidth(50, 100));
    expect(pruneWidth(50, 100)).toBeLessThan(pruneWidth(100, 100));
    expect(pruneWidth(100, 100)).toBe(SYNAPSE_NODE_MAX_WIDTH);
    // A cost above the observed maximum cannot escape the band.
    expect(pruneWidth(1_000_000, 100)).toBe(SYNAPSE_NODE_MAX_WIDTH);
  });

  it('at most ONE on-node badge per node', () => {
    for (const m of overlayOf().nodeMarks.values()) {
      if (m.badge === null) continue;
      expect(typeof m.badge).toBe('string');
      expect(m.badge.includes('\n')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE — a risk edge is distinguishable from a benign one
// ---------------------------------------------------------------------------

function edge(over: Partial<WireEdge> & Pick<WireEdge, 'id' | 'provenance'>): WireEdge {
  return {
    to: 'azure:/b',
    from: 'azure:/a',
    resolution: 'resolved',
    evidence: { artifact: 'fixture', extractor: 'container-app-env' },
    ...over,
  } as WireEdge;
}

const EDGE_CASES: ReadonlyArray<{
  readonly layer: SynapseEdgeLayer;
  readonly mark: ReturnType<typeof synapseEdgeMark>;
}> = [
  {
    layer: 'risk',
    mark: synapseEdgeMark(edge({ id: 'e-risk', provenance: 'configured' }), {
      riskEdgeIds: new Set(['e-risk']),
      newEdgeIds: new Set(),
    }),
  },
  {
    layer: 'new',
    mark: synapseEdgeMark(edge({ id: 'e-new', provenance: 'configured' }), {
      riskEdgeIds: new Set(),
      newEdgeIds: new Set(['e-new']),
    }),
  },
  {
    layer: 'hot',
    mark: synapseEdgeMark(edge({ id: 'e-hot', provenance: 'observed' }), {
      riskEdgeIds: new Set(),
      newEdgeIds: new Set(),
    }),
  },
  {
    layer: 'wired',
    mark: synapseEdgeMark(edge({ id: 'e-wired', provenance: 'configured' }), {
      riskEdgeIds: new Set(),
      newEdgeIds: new Set(),
    }),
  },
  {
    layer: 'declared-only',
    mark: synapseEdgeMark(edge({ id: 'e-decl', provenance: 'declared' }), {
      riskEdgeIds: new Set(),
      newEdgeIds: new Set(),
    }),
  },
  {
    layer: 'broken',
    mark: synapseEdgeMark(
      edge({
        id: 'e-broken',
        provenance: 'configured',
        resolution: 'dangling',
        to: null,
        danglingReason: 'empty-value',
        evidence: { artifact: 'main.bicep', extractor: 'bicep', symbol: 'LOOM_BROKER_URL' },
      }),
      { riskEdgeIds: new Set(), newEdgeIds: new Set() },
    ),
  },
  {
    layer: 'structural',
    mark: synapseEdgeMark(edge({ id: 'e-owns', provenance: 'owns' }), {
      riskEdgeIds: new Set(),
      newEdgeIds: new Set(),
    }),
  },
];

describe('ACCEPTANCE: a risk edge is distinguishable from a benign one', () => {
  it('every case produced the layer it was built for (the matcher is not stuck)', () => {
    for (const c of EDGE_CASES) expect(c.mark.layer).toBe(c.layer);
  });

  it('risk differs from EVERY benign layer on at least two channels', () => {
    const risk = EDGE_CASES.find((c) => c.layer === 'risk')!.mark;
    for (const c of EDGE_CASES) {
      if (c.layer === 'risk') continue;
      const differences = [
        risk.stroke !== c.mark.stroke,
        risk.width !== c.mark.width,
        risk.dash !== c.mark.dash,
        risk.animated !== c.mark.animated,
        risk.label !== c.mark.label,
      ].filter(Boolean).length;
      expect(
        differences,
        `risk vs ${c.layer} differs on only ${differences} channel(s) — one CSS regression from invisible`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('and it is the heaviest stroke on the canvas, so it reads first', () => {
    const risk = EDGE_CASES.find((c) => c.layer === 'risk')!.mark;
    for (const c of EDGE_CASES) {
      if (c.layer === 'risk') continue;
      expect(risk.width).toBeGreaterThan(c.mark.width);
    }
  });

  it('hot paths are distinguishable from declared-only ones', () => {
    // Stated as its own case because it is the second half of #3934's scope:
    // "edges with observed traffic, visually distinct from declared-only ones".
    const hot = EDGE_CASES.find((c) => c.layer === 'hot')!.mark;
    const declared = EDGE_CASES.find((c) => c.layer === 'declared-only')!.mark;
    expect(hot.stroke).not.toBe(declared.stroke);
    expect(hot.width).toBeGreaterThan(declared.width);
    expect(hot.dash).not.toBe(declared.dash);
    expect(hot.animated).not.toBe(declared.animated);
  });

  it('all seven edge layers are pairwise distinct on their rendering tuple', () => {
    const seen = new Map<string, SynapseEdgeLayer>();
    for (const c of EDGE_CASES) {
      const key = `${c.mark.stroke}|${c.mark.width}|${c.mark.dash}|${c.mark.animated}`;
      const clash = seen.get(key);
      expect(clash, `${c.layer} renders identically to ${clash}`).toBeUndefined();
      seen.set(key, c.layer);
    }
    expect(seen.size).toBe(EDGE_CASES.length);
  });

  it('risk outranks new and hot — the fact that should interrupt wins', () => {
    const both = synapseEdgeMark(edge({ id: 'e1', provenance: 'observed' }), {
      riskEdgeIds: new Set(['e1']),
      newEdgeIds: new Set(['e1']),
    });
    expect(both.layer).toBe('risk');
  });
});

// ---------------------------------------------------------------------------
// The lanes report populations, and NOT-EVALUATED is never a zero
// ---------------------------------------------------------------------------

describe('the prune lane refuses to paint when reachability is not evaluable', () => {
  it('with `configured` collected it evaluates and counts', () => {
    const o = overlayOf();
    expect(o.prune.evaluated).toBe(true);
    expect(o.prune.costly).toBeGreaterThan(0);
    expect(o.prune.nodesExamined).toBe(snapshot.nodes.length);
  });

  it('with `configured` NOT collected it reports NOT EVALUATED and paints nothing', () => {
    // THE CONTROL for the test above. Over a graph with zero `configured` edges,
    // "nothing reaches this node" is vacuously true of every node, so a lane
    // that still counted would report the whole estate as waste.
    const blind: BrainSnapshot = {
      ...snapshot,
      coverage: {
        ...snapshot.coverage,
        configured: { collected: false, edgeCount: 0, note: 'no env was read' },
      },
    };
    const o = overlayOf({ snap: blind });
    expect(o.prune.evaluated).toBe(false);
    expect(o.prune.costly).toBe(0);
    expect(o.prune.idle).toBe(0);
    expect(o.prune.reason).toMatch(/vacuously true/i);
  });
});

describe('the hot lane distinguishes "no traffic" from "no telemetry"', () => {
  it('reports observed as NOT COLLECTED rather than as zero traffic', () => {
    const o = overlayOf();
    expect(snapshot.coverage.observed.collected).toBe(false);
    expect(o.hot.collected).toBe(false);
    expect(o.hot.observed).toBe(0);
    expect(o.hot.note).toMatch(/indistinguishable from "no traffic"/i);
    // …and it still counts what it CAN: wired edges are real and present.
    expect(o.hot.wired + o.hot.broken).toBeGreaterThan(0);
    expect(o.hot.edgesExamined).toBe(snapshot.edges.length);
  });
});

describe('the growth lane invents neither "all new" nor "nothing changed"', () => {
  it('with no history, no edge is marked new', () => {
    const o = overlayOf({ history: { available: false, reason: 'no history' } });
    expect(o.fresh.available).toBe(false);
    expect(o.fresh.newEdges).toBe(0);
    for (const m of o.edgeMarks.values()) expect(m.layer).not.toBe('new');
  });

  it('THE CONTROL: with a history that omits an edge, that edge IS marked new', () => {
    // Without this, "0 new edges" would be satisfied by an implementation that
    // can never mark anything new, and the lane would be permanently dead.
    expect(snapshot.edges.length).toBeGreaterThan(0);
    const [first, ...rest] = snapshot.edges;
    const o = overlayOf({
      history: {
        available: true,
        previousGeneratedAt: '2026-08-01T00:00:00Z',
        previousEdgeIds: rest.map((e) => e.id),
      },
    });
    expect(o.fresh.available).toBe(true);
    expect(o.fresh.newEdges).toBe(1);
    expect(o.edgeMarks.get(first!.id)!.layer).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// The risk join — reported, never dropped
// ---------------------------------------------------------------------------

function riskFinding(over: Partial<WireRiskFinding> = {}): WireRiskFinding {
  return {
    id: 'f1',
    detectorId: 'security.c1.unauthorized-inbound-edge',
    findingClass: 'C1-unauthorized-inbound-edge',
    severity: 'critical',
    confidence: 'high',
    title: 'an ALLOW that is not implied by an owns-verdict',
    evidence: { nodeIds: [], edgeIds: [], query: 'q', facts: ['f'] },
    remediation: {
      summary: 's',
      proposedCommands: [],
      proposedPatchDescription: null,
      requiresHumanApproval: true,
    },
    ...over,
  };
}

function evaluatedRisk(findings: readonly WireRiskFinding[]): RiskLayer {
  return {
    evaluated: true,
    graphSource: 'modelled',
    findings,
    detectors: [],
    coverage: { judged: 9, candidates: 9, ratio: 1, incompleteDetectors: [] },
  };
}

describe('the risk lane paints what it can join and REPORTS what it cannot', () => {
  it('a finding naming an estate node paints that node as risk', () => {
    const o = overlayOf({
      risk: evaluatedRisk([riskFinding({ evidence: { nodeIds: [BROKER_ID], edgeIds: [], query: 'q', facts: [] } })]),
    });
    expect(o.risk.painted).toBe(1);
    expect(o.risk.unjoined).toHaveLength(0);
    // Risk outranks prune: the broker is unreachable AND named, and renders as risk.
    expect(markOf(BROKER_ID, o).layer).toBe('risk');
  });

  it('a finding naming a SOURCE location is reported in its own lane, not dropped', () => {
    // The id spaces are disjoint. Dropping the finding is the obvious
    // implementation — the join loop simply never fires — and it would discard
    // every risk finding the Brain ever produces.
    const src = riskFinding({
      id: 'f-src',
      evidence: {
        nodeIds: ['lib/api/route-toolkit.ts#withTenantAdmin'],
        edgeIds: [],
        query: 'q',
        facts: [],
      },
    });
    const o = overlayOf({ risk: evaluatedRisk([src]) });
    expect(o.risk.painted).toBe(0);
    expect(o.risk.unjoined.map((u) => u.finding.id)).toEqual(['f-src']);
    expect(o.risk.findings).toHaveLength(1);
    expect(o.risk.unjoined[0]!.reason).toMatch(/disjoint/i);
  });

  it('an edge named by a finding is painted as a risk edge', () => {
    const target = snapshot.edges[0]!;
    const o = overlayOf({
      risk: evaluatedRisk([
        riskFinding({ evidence: { nodeIds: [], edgeIds: [target.id], query: 'q', facts: [] } }),
      ]),
    });
    expect(o.edgeMarks.get(target.id)!.layer).toBe('risk');
    expect(o.risk.painted).toBe(1);
  });

  it('with NO risk layer loaded, nothing is painted as risk and the lane says so', () => {
    const o = overlayOf({ risk: null });
    expect(o.risk.evaluated).toBe(false);
    expect(o.risk.findings).toHaveLength(0);
    for (const m of o.nodeMarks.values()) expect(m.layer).not.toBe('risk');
    for (const m of o.edgeMarks.values()) expect(m.layer).not.toBe('risk');
  });

  it('an UNEVALUATED risk layer carries its reason and its registry size', () => {
    const o = overlayOf({
      risk: {
        evaluated: false,
        reason: 'no security graph is available',
        registry: [
          { detectorId: 'a', taxonomyClass: 'C1', title: 't' },
          { detectorId: 'b', taxonomyClass: 'C2', title: 't' },
        ],
      },
    });
    expect(o.risk.evaluated).toBe(false);
    expect(o.risk.reason).toMatch(/no security graph/i);
    // The count of what would have run — so "0 findings" cannot read as "0 risk".
    expect(o.risk.detectorsRegistered).toBe(2);
  });
});
