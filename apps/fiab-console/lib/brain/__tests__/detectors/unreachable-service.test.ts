/**
 * LOOM BRAIN — `unreachable-service`: the arms the acceptance test does not cover.
 *
 * The acceptance test proves the founding finding. This proves the detector's
 * behaviour at its edges — vacuity, ownership, cost absence, and the scoping
 * decisions — because those are where a detector quietly stops being able to say
 * anything and keeps reporting green.
 */

import { describe, it, expect } from 'vitest';
import { unreachableService } from '../../detectors';
import {
  unreachableAlwaysOn,
  type DetectContext,
} from '@/app/api/admin/brain/_lib/detect';
import {
  BROKER_ARM,
  BROKER_ID,
  DIRECTLAKE_ID,
  ENV_DOMAIN,
  PEER_A_ID,
  PEER_B_ID,
  RG,
  SUB,
  appRow,
  buildEdgelessGraph,
  buildFixtureGraph,
  buildMutualIslandGraph,
} from './fixtures';

describe('unreachable-service — POSITIVE and NEGATIVE', () => {
  const graph = buildFixtureGraph();
  const result = unreachableService(graph);

  it('POSITIVE: the always-on unwired service is found', () => {
    expect(result.findings.map((f) => f.subjects[0])).toContain(BROKER_ID);
  });

  it('NEGATIVE: the always-on WIRED service is not', () => {
    expect(result.findings.map((f) => f.subjects[0])).not.toContain(DIRECTLAKE_ID);
    // …and it really does have the inbound edge that excludes it, so the
    // negative is about the predicate rather than about the fixture being thin.
    expect(graph.inboundEdges(DIRECTLAKE_ID, 'configured').result).toHaveLength(1);
  });

  it('every finding carries the population, and it is the SAME object across findings', () => {
    // A per-finding population computed while iterating would freeze each finding
    // at a running count. They must all describe the completed pass.
    const pops = new Set(result.findings.map((f) => f.population.scope));
    expect(pops.size).toBe(1);
    expect(result.findings[0]!.population.scope).toBe(result.population.scope);
  });
});

describe('unreachable-service — VACUITY: a graph with no resolved configured edges', () => {
  // The dangerous shape. Every node trivially has "no inbound configured edge",
  // so a detector without this gate reports the whole estate as unreachable —
  // loudly, with cost figures attached, and completely wrongly.
  const graph = buildEdgelessGraph();
  const result = unreachableService(graph);

  it('emits ZERO findings rather than reporting every node', () => {
    expect(graph.report.edgesByProvenance.configured).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('does NOT report a clean estate: every candidate is skipped with the reason', () => {
    // This is the whole difference between honest and green-and-blind. The nodes
    // exist, they are always-on, and the detector says it could not evaluate them.
    expect(result.skipped.length).toBeGreaterThan(0);
    const brokerSkip = result.skipped.find((s) => s.subject === BROKER_ID);
    expect(brokerSkip).toBeDefined();
    expect(brokerSkip!.reason).toMatch(/ZERO RESOLVED 'configured' edges/);
    expect(brokerSkip!.reason).toMatch(/vacuously true/);
  });

  it('the population is NOT blind — there were nodes, just no usable edges', () => {
    // `blind` means the subject set was empty. It was not. Conflating "nothing to
    // look at" with "nothing to look WITH" would hide which of the two happened.
    expect(result.population.blind).toBe(false);
    expect(result.population.examined).toBeGreaterThan(0);
  });
});

describe('unreachable-service — the vacuity check counts RESOLVED edges, not all edges', () => {
  it('a graph whose configured edges are ALL dangling is still vacuous', () => {
    // The sharp case. `population.byProvenance.configured` is non-zero here, so
    // the substrate's documented vacuity check (`byProvenance[p] === 0`) would
    // pass — while every dangling edge has `to: null` and confers no
    // reachability. Only counting RESOLVED edges catches it.
    const graph = buildFixtureGraph({
      consoleEnvOverride: [{ name: 'LOOM_BROKER_URL', value: '' }],
    });
    const configured = graph.edges.filter((e) => e.provenance === 'configured');
    expect(configured.length).toBeGreaterThan(0);
    expect(configured.every((e) => e.resolution === 'dangling')).toBe(true);

    const result = unreachableService(graph);
    expect(result.findings).toEqual([]);
    expect(result.skipped.some((s) => /ZERO RESOLVED 'configured' edges/.test(s.reason))).toBe(true);
  });
});

describe('unreachable-service — cost and ownership are stated, never assumed', () => {
  it('a resource in an unpriced region is reported WITHOUT a cost figure, and the reason is recorded', () => {
    const graph = buildFixtureGraph({
      extraRows: [
        appRow({
          armId: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-remote`,
          name: 'loom-remote',
          minReplicas: 1,
          cpu: 0.25,
          memory: '512Mi',
          fqdn: `loom-remote.internal.example.invalid`,
          location: 'antarcticawest',
        }),
      ],
    });
    const result = unreachableService(graph);
    const f = result.findings.find((x) => x.title.includes('loom-remote'));
    expect(f).toBeDefined();
    // The finding still stands — only the price is unknown.
    expect(f!.cost).toBeUndefined();
    const costSkip = result.skipped.find((s) => s.subject.includes('loom-remote') && s.subject.includes('cost'));
    expect(costSkip).toBeDefined();
    expect(costSkip!.reason).toMatch(/no retail rate was read for region 'antarcticawest'/);
    // Explicitly refuses to substitute another region's rate.
    expect(costSkip!.reason).toMatch(/Gov rates are 25-33% above Commercial/);
  });

  it('with no ownership tag anywhere, every proposal says ownership is NOT ESTABLISHED', () => {
    // The measured state of the real estate: zero resources carry
    // `loom-estate-id`, so the graph holds zero `owns` edges.
    const graph = buildFixtureGraph({ withoutOwnershipTag: true });
    expect(graph.report.edgesByProvenance.owns).toBe(0);
    const result = unreachableService(graph);
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f.remediation.proposedChange).toMatch(/OWNERSHIP NOT ESTABLISHED/);
    expect(f.remediation.proposedChange).toMatch(/12 non-Loom container/);
  });

  it('with an ownership tag present, the proposal says so', () => {
    const graph = buildFixtureGraph();
    expect(graph.report.edgesByProvenance.owns).toBeGreaterThan(0);
    const result = unreachableService(graph);
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f.remediation.proposedChange).toMatch(/carries the `loom-estate-id` tag/);
  });
});

// ---------------------------------------------------------------------------
// #4257 — ALWAYS-ON BY DESIGN is reported, never proposed as a saving
// ---------------------------------------------------------------------------

describe('unreachable-service — a service the DEPLOY declares non-scalable', () => {
  const DECLARED =
    "the deploy PINS 'loom-capacity-broker' to exactly 2 replica(s) (minReplicas 2 = " +
    'maxReplicas 2, no scale rules). CANNOT scale to zero: a stopped replica loses every ' +
    'materialized view and its progress.';

  /** Names ONLY the broker, so the second finding below is the control. */
  const nonScalableSubject = (n: { id: string }) => (n.id === BROKER_ID ? DECLARED : null);

  /**
   * The base fixture produces exactly ONE finding, and a one-finding population
   * cannot tell "the option changed the named subject" from "the option changed
   * everything". A second always-on, unwired app is added so both readings are
   * distinguishable.
   */
  const OTHER_ARM = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/loom-elastic`;
  const buildTwoFindingGraph = () =>
    buildFixtureGraph({
      extraRows: [
        appRow({
          armId: OTHER_ARM,
          name: 'loom-elastic',
          minReplicas: 1,
          cpu: 0.5,
          memory: '1Gi',
          fqdn: `loom-elastic.internal.${ENV_DOMAIN}`,
        }),
      ],
    });

  const baseline = unreachableService(buildTwoFindingGraph());
  const guarded = unreachableService(buildTwoFindingGraph(), { nonScalableSubject });

  it('POPULATION: the same subject IS a finding in both runs — nothing is hidden', () => {
    // The always-on floor and the missing wire are both real. Suppressing the
    // finding would be its own dishonesty; what changes is what is PROPOSED.
    expect(baseline.findings.map((f) => f.subjects[0])).toContain(BROKER_ID);
    expect(guarded.findings.map((f) => f.subjects[0])).toContain(BROKER_ID);
    expect(guarded.findings.length).toBe(baseline.findings.length);
  });

  it('THE FIX: the costed HIGH-severity waste finding becomes an INFO observation', () => {
    const before = baseline.findings.find((f) => f.subjects[0] === BROKER_ID)!;
    const after = guarded.findings.find((f) => f.subjects[0] === BROKER_ID)!;

    // Baseline: a priced saving, ranked by dollars, at the top of the list.
    expect(before.cost).toBeDefined();
    expect(before.severity).not.toBe('info');
    expect(before.remediation.summary).toMatch(/Wire or retire/);

    // Guarded: no cost figure at all, so it cannot be ranked as a saving, and
    // the remediation says NO ACTION rather than "scale it to zero".
    expect(after.cost).toBeUndefined();
    expect(after.severity).toBe('info');
    expect(after.title).toMatch(/BY DESIGN/);
    expect(after.remediation.summary).toMatch(/NO ACTION/);
    expect(after.remediation.proposedChange).toMatch(/Do NOT scale it to zero/);
    // The deploy's own reason travels with it.
    expect(after.summary).toContain('materialized view');
  });

  it('the dropped cost is RECORDED as a skip, not silently omitted', () => {
    // The cross-detector contract requires a `(cost)` skip for any priceable
    // subject with no figure. An omission with no record is indistinguishable
    // from the computed-and-dropped bug that contract exists to catch.
    const costSkip = guarded.skipped.find(
      (s) => s.subject.includes(BROKER_ID) && s.subject.includes('(cost)'),
    );
    expect(costSkip).toBeDefined();
    expect(costSkip!.reason).toMatch(/ON PURPOSE/);
    expect(costSkip!.reason).toContain(DECLARED);
  });

  it('THE CONTROL: an undeclared subject is untouched by the option', () => {
    // A predicate that named everything would satisfy the specs above while
    // having disabled the detector, so the fixture must carry a SECOND finding
    // the predicate does not name — and it does.
    const otherBaseline = baseline.findings.find((f) => f.subjects[0] !== BROKER_ID);
    expect(otherBaseline, 'the fixture must produce a second, undeclared finding').toBeDefined();
    const other = guarded.findings.find((f) => f.subjects[0] === otherBaseline!.subjects[0]);
    expect(other).toBeDefined();
    expect(other!.severity).toBe(otherBaseline!.severity);
    expect(other!.cost).toEqual(otherBaseline!.cost);
    expect(other!.title).not.toMatch(/BY DESIGN/);
    expect(other!.remediation.summary).toBe(otherBaseline!.remediation.summary);
  });

  it('the default detector (no option) behaves exactly as before', () => {
    // `ALL_DETECTORS` passes no options, so the library pass is unchanged.
    expect(baseline.findings.map((f) => f.id)).toEqual(
      unreachableService(buildTwoFindingGraph()).findings.map((f) => f.id),
    );
  });
});

describe('unreachable-service — the finding id is deterministic', () => {
  it('two runs over two identically-built graphs produce identical finding ids', () => {
    // A finding whose id changes between runs cannot be acknowledged in a UI or
    // correlated across time by the agent layer.
    const a = unreachableService(buildFixtureGraph()).findings.map((f) => f.id);
    const b = unreachableService(buildFixtureGraph()).findings.map((f) => f.id);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]).toContain(BROKER_ARM.toLowerCase());
  });
});

describe('#4258 — REACHABILITY, not inbound-edge count: the mutual island', () => {
  // THE DEFECT, as a test. Two always-on internal apps whose env vars name each
  // other each carry ONE inbound resolved `configured` edge, so the predicate
  // this detector used to run — `inbound(graph, id, 'configured').length === 0`
  // — is FALSE for both and cleared them. Nothing outside the pair can reach
  // either: the console is the only externally-ingressed app in the fixture and
  // it wires only `loom-direct-lake`.
  //
  // Measured before the fix: 0 findings over this graph. That is the whole
  // finding — an always-on island billing continuously, invisible to the query
  // whose entire purpose is to see it.

  it('EMBEDDED CONTROL: each peer really does have an inbound configured edge', () => {
    // Without this, "the old predicate missed them" is an assertion about the
    // fixture rather than about the detector.
    const graph = buildMutualIslandGraph();
    expect(graph.inboundEdges(PEER_A_ID, 'configured').result).toHaveLength(1);
    expect(graph.inboundEdges(PEER_B_ID, 'configured').result).toHaveLength(1);
  });

  it('BOTH peers are flagged — the inbound-edge count cleared them', () => {
    const result = unreachableService(buildMutualIslandGraph());
    const subjects = result.findings.map((f) => f.subjects[0]);
    expect(subjects).toContain(PEER_A_ID);
    expect(subjects).toContain(PEER_B_ID);
  });

  it('CONTROL: the wired app reached from the external console is CLEARED', () => {
    // The walk has to actually reach things. A walk that reached nothing would
    // flag every node and pass the assertion above for the wrong reason.
    const result = unreachableService(buildMutualIslandGraph());
    expect(result.findings.map((f) => f.subjects[0])).not.toContain(DIRECTLAKE_ID);
  });

  it('CONTROL: give peer A external ingress and peer B is CLEARED', () => {
    // A becomes a ROOT, so B is genuinely reachable from outside the graph and
    // must not be flagged. A itself is skipped as externally ingressed.
    const result = unreachableService(buildMutualIslandGraph({ peerAExternal: true }));
    const subjects = result.findings.map((f) => f.subjects[0]);
    expect(subjects).not.toContain(PEER_B_ID);
    expect(subjects).not.toContain(PEER_A_ID);
  });

  it('the population NAMES the root set, so the verdict can be checked', () => {
    const result = unreachableService(buildMutualIslandGraph());
    expect(result.population.scope).toMatch(/NOT REACHABLE/);
    expect(result.population.scope).toMatch(/EXTERNAL ingress/);
  });
});

describe('#4258 — THE RUNTIME PATH: unreachableAlwaysOn over the same island', () => {
  // The library detector above is not what the console executes. The BFF runs
  // `unreachableAlwaysOn` from `app/api/admin/brain/_lib/detect.ts`, which
  // carried the same inbound-edge-count shape at its own line. Covering only the
  // library twin would leave the surface the operator actually reads uncovered —
  // the exact split that lets a fix look complete and change nothing live.

  function ctxOver(graph: ReturnType<typeof buildMutualIslandGraph>): DetectContext {
    const owned = new Set<string>();
    for (const e of graph.edges) {
      if (e.provenance === 'owns' && e.resolution === 'resolved') owned.add(e.to as string);
    }
    // `configured` MUST be marked collected or `refuseIfUncollected` short-
    // circuits and the test would pass over a detector that never ran.
    const coverage = {
      configured: { collected: true, edgeCount: graph.edges.filter((e) => e.provenance === 'configured').length, note: 'container app env (fixture)' },
      declared: { collected: false, edgeCount: 0, note: 'bicep is not in this fixture' },
      observed: { collected: false, edgeCount: 0, note: 'no telemetry extractor' },
      imports: { collected: false, edgeCount: 0, note: 'no source extractor' },
      owns: { collected: true, edgeCount: graph.edges.filter((e) => e.provenance === 'owns').length, note: 'estate tag (fixture)' },
    } as unknown as DetectContext['coverage'];
    return { graph, coverage, owned };
  }

  it('EMBEDDED CONTROL: the detector actually ran — it is not the vacuity skip', () => {
    const run = unreachableAlwaysOn(ctxOver(buildMutualIslandGraph()));
    expect(run.vacuous).toBe(false);
  });

  it('BOTH peers are flagged on the runtime path too', () => {
    const run = unreachableAlwaysOn(ctxOver(buildMutualIslandGraph()));
    const subjects = run.result.findings.map((f) => f.subjects[0]);
    expect(subjects).toContain(PEER_A_ID);
    expect(subjects).toContain(PEER_B_ID);
  });

  it('CONTROL: the app wired from the external console is CLEARED', () => {
    const run = unreachableAlwaysOn(ctxOver(buildMutualIslandGraph()));
    expect(run.result.findings.map((f) => f.subjects[0])).not.toContain(DIRECTLAKE_ID);
  });

  it('CONTROL: peer A external ⇒ peer B cleared', () => {
    const run = unreachableAlwaysOn(ctxOver(buildMutualIslandGraph({ peerAExternal: true })));
    const subjects = run.result.findings.map((f) => f.subjects[0]);
    expect(subjects).not.toContain(PEER_B_ID);
    expect(subjects).not.toContain(PEER_A_ID);
  });

  it('the externally-ingressed apps are DISCLOSED as skipped, not silently dropped', () => {
    const run = unreachableAlwaysOn(ctxOver(buildMutualIslandGraph()));
    const reasons = run.result.skipped.map((s) => s.reason).join(' ');
    expect(reasons).toMatch(/EXTERNAL ingress/);
  });
});
