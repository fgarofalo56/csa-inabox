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
import type { BrainGraphView, Finding } from '../../graph';
import {
  CONSOLE_ID,
  DIRECTLAKE_FQDN,
  RG,
  SUB,
  appRow,
  buildEdgelessGraph,
  buildEstateScaleGraph,
  buildFixtureGraph,
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
