/**
 * LOOM BRAIN — the cross-detector CONTRACT.
 *
 * Every assertion in this file ranges over EVERY detector, because the bug that
 * prompted it was per-detector and invisible per-detector.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 * `Finding.cost` is optional. `always-on-unused` and `declared-but-dead` both
 * computed a cost figure correctly, recorded no skip for it, and then never put
 * it on the finding — and both TYPECHECKED, because an omitted optional field is
 * legal. One suite caught one of them by accident.
 *
 * The cure for a bug found once is a guard that catches its family, so the
 * invariant below is stated once and applied to all six:
 *
 *     if a detector did not record a "(cost)" skip for a subject, and that
 *     subject is priceable, the finding MUST carry the figure.
 *
 * That is exactly the assertion that fails on a computed-and-dropped cost, and it
 * fails for every detector that ever does it.
 *
 * ── THE POPULATION CHECK IS THE OTHER HALF ─────────────────────────────────
 * `population` is REQUIRED on `Finding` and `DetectorResult`, so it cannot be
 * omitted — but it CAN be wrong. A per-finding population built inside the loop
 * freezes each finding at the running count, which understates what the detector
 * went on to examine. Every finding must carry the SAME population object its
 * result does.
 */

import { describe, it, expect } from 'vitest';
import { ALL_DETECTORS, runDetectors } from '../../detectors';
import { estimateAlwaysOnMonthlyCost } from '../../detectors/cost-model';
import { subjectCount } from '../../detectors/detector-kit';
import type { AzureResourceNode, BrainGraphView, DanglingEdge, Finding } from '../../graph';
import {
  CONSOLE_ID,
  DIRECTLAKE_FQDN,
  ENV_DOMAIN,
  RG,
  SUB,
  appRow,
  buildEdgelessGraph,
  buildEstateScaleGraph,
  buildEstateScaleTelemetryGraph,
  buildFixtureGraph,
  inertPaddingExtraction,
} from './fixtures';

const WAREHOUSE_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-warehouse`;
const WAREHOUSE_FQDN = 'loom-warehouse.internal.examplegreenfield-00000000.centralus.azurecontainerapps.io';

/**
 * A graph rigged so that EVERY detector has something to say — telemetry, a dead
 * declaration, a drifted wire and a dangling one.
 *
 * Without it this contract suite would range over an output that only two
 * detectors contributed to, and an invariant is only as strong as the population
 * it is checked against.
 */
function buildRichGraph() {
  return buildFixtureGraph({
    observedCalls: [{ from: CONSOLE_ID, to: DIRECTLAKE_FQDN }],
    extraRows: [
      appRow({
        armId: WAREHOUSE_ARM,
        name: 'loom-warehouse',
        minReplicas: 1,
        cpu: 0.5,
        memory: '1Gi',
        fqdn: WAREHOUSE_FQDN,
      }),
    ],
    extraBicepLines: [
      "            { name: 'LOOM_WAREHOUSE_URL', value: 'https://${loomWarehouse!.outputs.fqdn}' }",
    ],
    extraModuleTargets: { loomWarehouse: WAREHOUSE_FQDN },
  });
}

const GRAPHS: readonly { readonly name: string; readonly graph: BrainGraphView }[] = [
  { name: 'rich (every detector fires)', graph: buildRichGraph() },
  { name: 'base estate', graph: buildFixtureGraph() },
  // 63 container apps, zero ownership tags — the MEASURED shape of the estate.
  // Every invariant below runs at the production cardinality, so a bypass keyed
  // to `graph.nodes.length > 20` cannot pass by hiding above the fixtures.
  { name: 'estate-scale (63 apps, no ownership tag)', graph: buildEstateScaleGraph() },
  { name: 'edgeless (vacuity)', graph: buildEdgelessGraph() },
];

/** The graphs where every detector has a real subject set to range over. */
const NON_VACUOUS: readonly { readonly name: string; readonly graph: BrainGraphView }[] =
  GRAPHS.filter((g) => !g.name.startsWith('edgeless'));

describe('CONTRACT — the run harness ranges over every detector', () => {
  it('POPULATION: there are six detectors and each produces a result', () => {
    // A contract suite over an empty detector list is green and blind. Assert the
    // count AND the names, so deleting a detector cannot silently shrink what is
    // checked below.
    expect(ALL_DETECTORS).toHaveLength(6);
    const run = runDetectors(buildRichGraph());
    expect(run.results).toHaveLength(6);
    expect(run.results.map((r) => r.detector).sort()).toEqual([
      'always-on-unused',
      'config-drift',
      'dangling-wire',
      'declared-but-dead',
      'orphan',
      'unreachable-service',
    ]);
  });

  it('POPULATION: the rich graph makes at least four detectors emit findings', () => {
    // The invariants below are only meaningful over findings that exist.
    const run = runDetectors(buildRichGraph());
    const emitting = run.results.filter((r) => r.findings.length > 0).map((r) => r.detector);
    expect(emitting.length).toBeGreaterThanOrEqual(4);
    expect(run.findings.length).toBeGreaterThanOrEqual(5);
  });

  it('a detector that throws is NOT swallowed', () => {
    // Catching here would make the harness a gate that cannot fail: the pass
    // would report a short, confident finding list with no sign a detector died.
    const boom = () => {
      throw new Error('detector exploded');
    };
    expect(() => runDetectors(buildRichGraph(), [boom as never])).toThrow('detector exploded');
  });
});

describe.each(GRAPHS)('CONTRACT over the $name graph', ({ graph }) => {
  const run = runDetectors(graph);

  it('every detector reports a population, even when it reports no findings', () => {
    for (const r of run.results) {
      expect(r.population).toBeDefined();
      expect(typeof r.population.examined).toBe('number');
      expect(typeof r.population.blind).toBe('boolean');
      expect(r.population.scope.length).toBeGreaterThan(20);
    }
  });

  it('NO detector emits a finding over an EMPTY population', () => {
    // ── THE ASSERTION THIS SUITE WAS MISSING ─────────────────────────────
    // The family guard above asserted `typeof examined === 'number'` and
    // `typeof blind === 'boolean'` — never that the population had anything in
    // it. Measured in review: setting `dangling-wire`'s population subject to
    // `[]` while leaving its verdict intact produced
    // `edgesExamined=0 blind=true` beside a confident HIGH-severity finding,
    // and 19 files / 261 tests stayed green. That is the green-and-blind
    // failure this whole program exists to prevent, present in its own code.
    //
    // Stated once here rather than in a seventh per-detector file, so it covers
    // all six and the next detector inherits it.
    for (const r of run.results) {
      if (r.findings.length === 0) continue;
      expect(
        r.population.blind,
        `${r.detector} emitted ${r.findings.length} finding(s) over a BLIND population`,
      ).toBe(false);
      expect(
        subjectCount(r.population),
        `${r.detector} emitted ${r.findings.length} finding(s) having examined 0 ${r.population.subject}`,
      ).toBeGreaterThan(0);
      for (const f of r.findings) {
        expect(f.population.blind).toBe(false);
        expect(subjectCount(f.population)).toBeGreaterThan(0);
      }
    }
  });

  it('every finding carries the SAME population object its detector reported', () => {
    // A per-finding population computed inside the loop would drift from this.
    for (const r of run.results) {
      for (const f of r.findings) {
        expect(f.population).toBe(r.population);
      }
    }
  });

  it('every remediation is a PROPOSAL that needs approval and mutates nothing', () => {
    for (const f of run.findings) {
      expect(f.remediation.kind).toBe('proposal');
      expect(f.remediation.requiresHumanApproval).toBe(true);
      expect(f.remediation.mutatesAzure).toBe(false);
      expect(f.remediation.proposedChange).toContain('RECOMMEND-ONLY');
      // Ownership is stated on every one, because a recommendation acted on
      // against a non-Loom resource is the failure mode with the largest blast
      // radius on this estate.
      expect(f.remediation.proposedChange).toMatch(/OWNERSHIP/);
    }
  });

  it('NO finding ever carries a `billed` cost figure', () => {
    // Cost Management returned 429 on 11 consecutive attempts; nothing in the
    // Brain has seen a bill. A `billed` figure here would be a false claim.
    for (const f of run.findings) {
      if (f.cost) expect(f.cost.source).toBe('derived');
    }
  });

  it('THE FAMILY GUARD: a priceable subject with no "(cost)" skip MUST carry its figure', () => {
    for (const r of run.results) {
      for (const f of r.findings) {
        const subject = graph.node(f.subjects[0]!);
        if (!subject || subject.kind !== 'azure-resource') continue;
        const est = estimateAlwaysOnMonthlyCost(subject);
        if (est.kind !== 'priced') continue;
        const hasCostSkip = r.skipped.some(
          (s) => s.subject.includes(f.subjects[0]!) && s.subject.includes('(cost)'),
        );
        if (hasCostSkip) continue;
        // `config-drift`, `orphan` and `dangling-wire` do not price their
        // subjects at all — they are not cost findings — so they are exempt by
        // name rather than by silence.
        if (['config-drift', 'orphan', 'dangling-wire'].includes(r.detector)) continue;
        expect(
          f.cost,
          `${r.detector} finding ${f.id} has a priceable subject, recorded no cost skip, and dropped the figure`,
        ).toBeDefined();
        expect(f.cost!.amountUsd).toBeCloseTo(est.figure.amountUsd, 2);
      }
    }
  });

  it('every evidence edge id resolves back to a real edge in the graph', () => {
    for (const f of run.findings) {
      for (const id of f.evidence.edges) {
        expect(graph.edges.some((e) => e.id === id)).toBe(true);
      }
    }
  });

  it('every finding names a re-runnable query and at least one note', () => {
    for (const f of run.findings) {
      expect(f.evidence.query.length).toBeGreaterThan(10);
      expect(f.evidence.notes.length).toBeGreaterThan(0);
      expect(f.subjects.length).toBeGreaterThan(0);
    }
  });

  it('finding ids are unique within the run', () => {
    const ids = run.findings.map((f: Finding) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the run is DETERMINISTIC: a second pass over the same graph is identical', () => {
    const again = runDetectors(graph);
    expect(again.findings.map((f) => f.id)).toEqual(run.findings.map((f) => f.id));
    expect(again.skipped.map((s) => s.subject)).toEqual(run.skipped.map((s) => s.subject));
  });

  it('findings are ordered most-severe first', () => {
    const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;
    const ranks = run.findings.map((f) => rank[f.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('every skip is attributed to the detector that made it', () => {
    for (const s of run.skipped) {
      expect(s.subject).toMatch(/^\[[a-z-]+\] /);
      expect(s.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('CONTRACT — zero findings is never reported as a clean estate', () => {
  it('the edgeless graph produces no findings AND a non-empty skip list with reasons', () => {
    const run = runDetectors(buildEdgelessGraph());
    expect(run.findings).toEqual([]);
    // The whole point. Without this the output is indistinguishable from a
    // healthy estate.
    expect(run.skipped.length).toBeGreaterThan(0);
    expect(run.population.scope).toContain('skipped subject(s)');
  });
});

describe.each(NON_VACUOUS)('CONTRACT — populations are non-empty over the $name graph', ({ graph }) => {
  it('EVERY detector ranged over a non-empty subject set', () => {
    // Stronger than the finding-conditional check above: on a graph that has
    // nodes AND edges of every provenance the detectors read, none of the six
    // has any business reporting `blind`. This is the assertion that fails the
    // instant a population subject is replaced by `[]`, whether or not that
    // detector happened to emit a finding on this graph.
    const run = runDetectors(graph);
    for (const r of run.results) {
      expect(r.population.blind, `${r.detector} reported a BLIND population`).toBe(false);
      expect(
        subjectCount(r.population),
        `${r.detector} examined 0 ${r.population.subject}`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('CONTRACT — the suite actually reaches production cardinality', () => {
  it('POPULATION: the estate-scale graph is the measured shape, not a fixture', () => {
    // A production-cardinality guard whose "production" graph is nine nodes is a
    // guard that watches nothing. Assert the numbers that make the bypasses
    // reachable: >20 nodes (the cardinality every measured bypass keyed on) and
    // ZERO `owns` edges (the branch an ownership bypass hides in).
    const graph = buildEstateScaleGraph();
    const apps = graph.nodes.filter(
      (n) => n.kind === 'azure-resource' && n.resourceType === 'Microsoft.App/containerApps',
    );
    expect(apps.length).toBe(63);
    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(graph.edges.filter((e) => e.provenance === 'owns')).toHaveLength(0);
  });

  it('the estate-scale graph makes unreachable-service produce findings at scale', () => {
    // Without findings here the invariants above are vacuous on this graph.
    const run = runDetectors(buildEstateScaleGraph());
    const unreachable = run.results.find((r) => r.detector === 'unreachable-service')!;
    expect(unreachable.findings.length).toBeGreaterThan(5);
    expect(unreachable.population.examined).toBeGreaterThan(20);
  });

  it('ownership is NOT ESTABLISHED for anything on the estate-scale graph', () => {
    // The measured state: nothing carries `loom-estate-id`, so no proposal may
    // read as authorized. A bypass that returns 'owned' at this cardinality is
    // the single worst output this system could produce.
    const run = runDetectors(buildEstateScaleGraph());
    expect(run.findings.length).toBeGreaterThan(0);
    for (const f of run.findings) {
      expect(f.remediation.proposedChange).toContain('OWNERSHIP NOT ESTABLISHED');
      expect(f.remediation.proposedChange).not.toContain('carries the `loom-estate-id` tag');
    }
  });
});

// ---------------------------------------------------------------------------
// #3964 — a bypass inside a CLEARED branch still balances the ledger
// ---------------------------------------------------------------------------

/**
 * THE DEFECT THIS SECTION EXISTS FOR.
 *
 * `assertLedgerBalances` proves every declared candidate got exactly one
 * disposition. It cannot prove the dispositions are the RIGHT ones, because a
 * bypass that moves every candidate from `finding` to `cleared` balances the
 * ledger perfectly. Two such bypasses were measured against the suite at head:
 *
 *   N3  `always-on-unused.ts` — `if (observed.length !== 0 || graph.nodes.length > 20)`
 *       i.e. clear every always-on app once the graph passes 20 nodes.
 *   N4  `dangling-wire.ts` — `REPORTED_REASONS.includes(r) && graph.edges.length < 50`
 *       i.e. report no dangling wire once the graph passes 50 edges.
 *
 * Both left the whole brain suite green. Two independent things close them, and
 * neither is a restatement of the detector:
 *
 *   1. A GRAPH-DERIVED UNIVERSE AND DISPOSITION. The counts are re-derived here
 *      from the graph, by a second implementation the detector cannot influence.
 *      N3 shows up as `finding: 0` against a derived count; so does N4.
 *   2. A DIFFERENTIAL RUN. The same estate, padded with INERT nodes and edges
 *      past every threshold either bypass keys on. A detector whose verdict
 *      depends on graph SIZE rather than graph CONTENT answers differently
 *      across the pair — which is the definition of the whole class, not just
 *      of the two mutations that were measured.
 *
 * SCOPE, STATED SO IT IS NOT OVERREAD. This section's population is
 * `ALL_DETECTORS` — the six detectors in `lib/brain/detectors`, which are what
 * `lib/brain/run/scan.ts` runs for `loom-brain-scan.yml`. There is a SECOND,
 * parallel detector implementation at `app/api/admin/brain/_lib/detect.ts`
 * (`DETECTORS`: `unreachableAlwaysOn`, `danglingEmptyWires`,
 * `declaredButNotConfigured`, `reachableButUnobserved`) behind the
 * `/admin/brain` route. It has no ledger at all — `grep -c
 * 'makeLedger|finalizeResult|ledger\.'` over that file returns 0 — so the
 * N3/N4 class is UNGUARDED there and nothing in this file would see it. Closing
 * that is follow-up work in that file, tracked as #4379, not something this
 * section claims.
 */

/** Azure resources, re-derived here rather than read from the detector kit. */
function azureNodesOf(graph: BrainGraphView): AzureResourceNode[] {
  return graph.nodes.filter((n): n is AzureResourceNode => n.kind === 'azure-resource');
}

function danglingOf(graph: BrainGraphView): DanglingEdge[] {
  return graph.edges.filter((e): e is DanglingEdge => e.resolution === 'dangling');
}

/**
 * The joinable (from, symbol) pairs `config-drift` ranges over, re-derived: a
 * declared edge whose (from, symbol) has a live `configured` counterpart.
 */
function configDriftPairCount(graph: BrainGraphView): number {
  const live = new Set<string>();
  for (const e of graph.edges) {
    if (e.provenance !== 'configured' || !e.evidence.symbol) continue;
    live.add(`${e.from}|${e.evidence.symbol}`);
  }
  let n = 0;
  for (const e of graph.edges) {
    if (e.provenance !== 'declared' || !e.evidence.symbol) continue;
    if (live.has(`${e.from}|${e.evidence.symbol}`)) n += 1;
  }
  return n;
}

/**
 * What each detector's candidate universe MUST be, stated as a function of the
 * graph. This is the oracle: it is computed from the graph, never read off the
 * result, so no filter written inside a detector can move it.
 */
const UNIVERSE_OF: Readonly<Record<string, (g: BrainGraphView) => number>> = {
  'always-on-unused': (g) => azureNodesOf(g).length,
  'unreachable-service': (g) => azureNodesOf(g).length,
  'dangling-wire': (g) => danglingOf(g).length,
  'config-drift': (g) => configDriftPairCount(g),
  'declared-but-dead': (g) => g.nodes.length,
  orphan: (g) => g.nodes.length,
};

describe('CONTRACT — every ALL_DETECTORS detector reports DISPOSITIONS over a graph-derived universe (#3964)', () => {
  const graphs = [
    { name: 'estate-scale', graph: buildEstateScaleGraph() },
    { name: 'estate-scale + telemetry', graph: buildEstateScaleTelemetryGraph() },
    {
      name: 'estate-scale + telemetry + inert padding',
      graph: buildEstateScaleTelemetryGraph({ extraExtractions: [inertPaddingExtraction(60)] }),
    },
  ];

  it('POPULATION: the oracle covers every detector that runs, by name', () => {
    // A universe table missing a detector would silently exempt it. Assert the
    // table and the detector list are the SAME set — not that the table is a
    // superset, which is how an exemption hides.
    const running = runDetectors(buildEstateScaleGraph())
      .results.map((r) => r.detector)
      .sort();
    expect(running.length).toBe(ALL_DETECTORS.length);
    expect(Object.keys(UNIVERSE_OF).sort()).toEqual(running);
  });

  describe.each(graphs)('over the $name graph', ({ graph }) => {
    it('every result CARRIES `dispositions` and `clearedReasons`', () => {
      // The fields are optional on DetectorResult, and the reason is measured:
      // making them required fails `tsc -p tsconfig.build.json` at five sites,
      // ALL in `app/api/admin/brain/_lib/detect.ts` — the parallel detector
      // implementation behind the /admin/brain route, which has no ledger. (NOT
      // the security detectors: `lib/brain/security/population.ts` declares its
      // own unrelated `DetectorResult`.) "Optional in the type" must not become
      // "absent in practice" for the estate detectors, so it is asserted here.
      // This suite's population is ALL_DETECTORS; the route's four detectors are
      // outside it and are NOT covered by this guard.
      for (const r of runDetectors(graph).results) {
        expect(r.dispositions, `${r.detector} carries no dispositions`).toBeDefined();
        expect(r.clearedReasons, `${r.detector} carries no clearedReasons`).toBeDefined();
      }
    });

    it('the ledger universe equals a count derived from the GRAPH, not from the detector', () => {
      for (const r of runDetectors(graph).results) {
        const derive = UNIVERSE_OF[r.detector]!;
        expect(
          r.dispositions!.universe,
          `${r.detector}: ledger universe disagrees with the graph-derived candidate count`,
        ).toBe(derive(graph));
      }
    });

    it('finding + cleared + skipped === universe, for every detector', () => {
      for (const r of runDetectors(graph).results) {
        const d = r.dispositions!;
        expect(d.finding + d.cleared + d.skipped, `${r.detector} ledger does not balance`).toBe(
          d.universe,
        );
      }
    });
  });
});

describe("CONTRACT — always-on-unused's DISPOSITIONS are derived from the graph (kills N3)", () => {
  const graph = buildEstateScaleTelemetryGraph();
  const azure = azureNodesOf(graph);
  const noScale = azure.filter((n) => n.scale === undefined);
  const alwaysOn = azure.filter((n) => n.scale !== undefined && n.scale.minReplicas > 0);
  const scalesToZero = azure.filter((n) => n.scale !== undefined && n.scale.minReplicas === 0);
  const withTraffic = alwaysOn.filter((n) => graph.inboundEdges(n.id, 'observed').result.length > 0);

  it('POPULATION: this graph reaches the predicate — telemetry exists, on BOTH arms', () => {
    // Without observed edges the detector stops at its vacuity gate and every
    // candidate is skipped, so the branch N3 sits on never executes. Without
    // BOTH arms populated, "cleared" and "finding" cannot be told apart.
    expect(graph.nodes.length).toBeGreaterThan(20);
    expect(
      graph.edges.filter((e) => e.provenance === 'observed' && e.resolution === 'resolved').length,
    ).toBeGreaterThan(0);
    expect(withTraffic.length).toBeGreaterThan(0);
    expect(alwaysOn.length - withTraffic.length).toBeGreaterThan(0);
    expect(noScale.length).toBeGreaterThan(0);
    expect(scalesToZero.length).toBeGreaterThan(0);
  });

  it('finding === always-on apps with ZERO inbound observed edges', () => {
    // N3 (`|| graph.nodes.length > 20` on the clearing branch) drives this to 0
    // while the ledger still balances and every other assertion in this suite
    // stays green.
    const r = runDetectors(graph).results.find((x) => x.detector === 'always-on-unused')!;
    expect(r.dispositions!.finding).toBe(alwaysOn.length - withTraffic.length);
    expect(r.findings.length).toBe(alwaysOn.length - withTraffic.length);
  });

  it('cleared === scale-to-zero apps PLUS always-on apps that DO have traffic', () => {
    const r = runDetectors(graph).results.find((x) => x.detector === 'always-on-unused')!;
    expect(r.dispositions!.cleared).toBe(scalesToZero.length + withTraffic.length);
  });

  it('skipped === apps whose scale was NEVER MEASURED — and nothing else', () => {
    // NOT MEASURED is not minReplicas 0. A bypass that quietly moves candidates
    // into `skipped` reads as "we looked and could not tell", which is a lie of
    // a different shape but the same size.
    const r = runDetectors(graph).results.find((x) => x.detector === 'always-on-unused')!;
    expect(r.dispositions!.skipped).toBe(noScale.length);
  });
});

describe("CONTRACT — dangling-wire's DISPOSITIONS are derived from the graph (kills N4)", () => {
  const REPORTED = ['empty-value', 'missing-resource'];
  const graph = buildEstateScaleGraph({ extraExtractions: [inertPaddingExtraction(60)] });
  const dangling = danglingOf(graph);
  const inScope = dangling.filter((e) => REPORTED.includes(e.danglingReason));

  it('POPULATION: this graph passes the 50-edge threshold AND has reportable dangling wires', () => {
    expect(graph.edges.length).toBeGreaterThan(50);
    expect(inScope.length).toBeGreaterThan(0);
  });

  it('finding === dangling edges whose reason names a real defect', () => {
    // N4 (`&& graph.edges.length < 50` inside the reason filter) drives this to
    // 0 and moves all of them into `skipped`, and the ledger still balances.
    const r = runDetectors(graph).results.find((x) => x.detector === 'dangling-wire')!;
    expect(r.dispositions!.finding).toBe(inScope.length);
    expect(r.dispositions!.skipped).toBe(dangling.length - inScope.length);
  });
});

describe('CONTRACT — the DIFFERENTIAL: verdicts follow graph CONTENT, never graph SIZE (#3964)', () => {
  /**
   * Detectors whose candidate universe is INVARIANT under inert padding, so
   * their whole disposition triple must be identical across the pair. The two
   * that are missing (`declared-but-dead`, `orphan`) range over every node by
   * design, so their universes legitimately grow — stated here rather than left
   * as an unexplained omission, and asserted below on the terms that DO hold.
   */
  const UNIVERSE_INVARIANT = [
    'always-on-unused',
    'unreachable-service',
    'dangling-wire',
    'config-drift',
  ];

  const base = buildEstateScaleTelemetryGraph();
  const padded = buildEstateScaleTelemetryGraph({ extraExtractions: [inertPaddingExtraction(60)] });
  const baseRun = runDetectors(base);
  const paddedRun = runDetectors(padded);
  const originalIds = new Set(base.nodes.map((n) => String(n.id)));
  const originalEdgeIds = new Set(base.edges.map((e) => e.id as string));

  it('POPULATION: the padding really does cross every threshold the measured bypasses key on', () => {
    // A "differential" whose two graphs are the same size proves nothing. The
    // 50-edge threshold must have the two graphs on OPPOSITE sides, and the
    // padding must be inert or a changed verdict would be legitimate.
    expect(base.edges.length).toBeLessThan(50);
    expect(padded.edges.length).toBeGreaterThan(50);
    expect(padded.nodes.length).toBeGreaterThan(base.nodes.length + 50);
    // INERT: no azure resource, no dangling edge, no joinable declared/configured
    // pair was added, so nothing a detector decides about the original estate
    // can legitimately change.
    expect(azureNodesOf(padded).length).toBe(azureNodesOf(base).length);
    expect(danglingOf(padded).length).toBe(danglingOf(base).length);
    expect(configDriftPairCount(padded)).toBe(configDriftPairCount(base));
    // …and the padded run is not vacuous, or "identical" would be trivially true.
    expect(paddedRun.findings.length).toBeGreaterThan(0);
  });

  it('the universe-invariant detectors report IDENTICAL dispositions on both graphs', () => {
    for (const name of UNIVERSE_INVARIANT) {
      const a = baseRun.results.find((r) => r.detector === name)!;
      const b = paddedRun.results.find((r) => r.detector === name)!;
      expect(b.dispositions, `${name} changed its verdict with graph SIZE`).toEqual(a.dispositions);
    }
  });

  it('EVERY detector clears for the same REASONS on both graphs', () => {
    // A size-conditioned branch that reuses an existing reason string is not
    // caught by this alone — the counts above are what catch that. This catches
    // the other half: a branch that only exists at scale and says something new.
    for (const a of baseRun.results) {
      const b = paddedRun.results.find((r) => r.detector === a.detector)!;
      expect([...b.clearedReasons!].sort(), `${a.detector} cleared for different reasons`).toEqual(
        [...a.clearedReasons!].sort(),
      );
    }
  });

  it('EVERY detector flags the SAME original subjects on both graphs', () => {
    // The per-candidate half. Restricted to subjects that exist in BOTH graphs,
    // because the padding legitimately adds new ones to the node-wide detectors.
    const subjectsOf = (fs: readonly Finding[]): string[] =>
      [...new Set(fs.flatMap((f) => f.subjects.map(String)))]
        .filter((s) => originalIds.has(s) || originalEdgeIds.has(s))
        .sort();
    for (const a of baseRun.results) {
      const b = paddedRun.results.find((r) => r.detector === a.detector)!;
      expect(subjectsOf(b.findings), `${a.detector} flagged a different set at scale`).toEqual(
        subjectsOf(a.findings),
      );
    }
  });

  it('EVERY detector SKIPS the same original subjects, for the same reasons', () => {
    // A bypass can also hide by moving candidates into `skipped` — "we looked
    // and could not tell" rather than "we looked and it is fine". Same class,
    // different door, so it is asserted on the same terms.
    const skipsOf = (r: { skipped: readonly { subject: string; reason: string }[] }): string[] =>
      r.skipped
        .filter((s) => originalIds.has(s.subject) || originalEdgeIds.has(s.subject))
        .map((s) => `${s.subject} :: ${s.reason}`)
        .sort();
    for (const a of baseRun.results) {
      const b = paddedRun.results.find((r) => r.detector === a.detector)!;
      expect(skipsOf(b), `${a.detector} skipped a different set at scale`).toEqual(skipsOf(a));
    }
  });

  it('CONTROL: the differential CAN fail — the SAME padded estate PLUS one real app differs', () => {
    // Without this, the four assertions above pass just as well against two
    // identical runs or a comparison that compares nothing.
    //
    // The counterfactual has to be MINIMAL to say anything. An earlier revision
    // compared the 63-app padded graph against a six-app `buildFixtureGraph` and
    // called that "adding a real always-on azure resource" — those two graphs
    // differ in every way, so the pass was trivially true and much weaker than
    // the comment claimed. `plusOneApp` here is `padded` itself — same fixture,
    // same telemetry, same 60 inert padding modules — with exactly ONE extra
    // always-on container app. So the ONLY difference between the two runs is
    // graph CONTENT, which is precisely what the identity assertions above
    // require to move the dispositions when it changes.
    const plusOneApp = buildEstateScaleTelemetryGraph({
      extraExtractions: [inertPaddingExtraction(60)],
      extraRows: [
        appRow({
          armId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-new-idle`,
          name: 'loom-new-idle',
          minReplicas: 3,
          maxReplicas: 5,
          cpu: 0.5,
          memory: '1Gi',
          fqdn: `loom-new-idle.internal.${ENV_DOMAIN}`,
          tags: {},
        }),
      ],
    });
    // POPULATION: "the same estate plus one app" is checked, not asserted in
    // prose. Exactly one node more, and it is an azure resource — otherwise the
    // control would be comparing two different estates again.
    expect(plusOneApp.nodes.length).toBe(padded.nodes.length + 1);
    expect(azureNodesOf(plusOneApp).length).toBe(azureNodesOf(padded).length + 1);

    const a = paddedRun.results.find((r) => r.detector === 'unreachable-service')!;
    const b = runDetectors(plusOneApp).results.find((r) => r.detector === 'unreachable-service')!;
    expect(b.dispositions).not.toEqual(a.dispositions);
  });
});
