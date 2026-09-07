/**
 * The CRITIC — the agent whose failure would be least visible, so the suite that
 * matters most.
 *
 * Two families of test here, and they check different things:
 *
 *   THE SIX MEASURED CHECKS — each fires on a finding shaped to trip it, and
 *   does NOT fire on a healthy one. A check that fires on everything is not a
 *   check; a check that fires on nothing is worse, because it is green.
 *
 *   THE ASYMMETRY — the model may lower a verdict and may do nothing else. These
 *   are the tests that would still pass if the model half were deleted entirely,
 *   and that fail the moment a model reply is given authority it should not have.
 */

import { describe, expect, it } from 'vitest';
import { criticize, confidenceFor, measuredRefutations, parseChallenges, verdictFor } from '@/lib/brain/agents';
import {
  azureNodeId,
  billedWithoutExportFinding,
  blindFinding,
  costedFinding,
  guidShapedCostedFinding,
  guidShapedFinding,
  guidShapedGraph,
  guidShapedSubject,
  makeFinding,
  makeGraph,
  noEvidenceFinding,
  population,
  stubClient,
  throwingClient,
  vacuousFinding,
} from './fixtures';
import { nodeIdFromPersisted } from '@/lib/brain/graph';

const codes = (rs: readonly { code: string }[]) => rs.map((r) => r.code);
const bySeverity = (rs: readonly { code: string; severity: string }[], s: string) =>
  rs.filter((r) => r.severity === s).map((r) => r.code);

describe('critic — the six measured checks', () => {
  it('a healthy finding trips no refuting check', () => {
    const refutations = measuredRefutations(makeFinding(), makeGraph([{ name: 'app-alpha', minReplicas: 2 }]));
    expect(bySeverity(refutations, 'refutes')).toEqual([]);
  });

  it('blind-population REFUTES a verdict taken over an empty subject set', () => {
    const rs = measuredRefutations(blindFinding());
    expect(bySeverity(rs, 'refutes')).toContain('blind-population');
    const stmt = rs.find((r) => r.code === 'blind-population')!.statement;
    // The statement must carry the measurement, not just the label.
    expect(stmt).toMatch(/examined=0/);
  });

  it('vacuous-provenance REFUTES "no configured edge" over a graph with zero configured edges', () => {
    const f = vacuousFinding();
    // The trap: the NODE set was not empty, so `blind` is false and nothing looks wrong.
    expect(f.population.blind).toBe(false);
    const rs = measuredRefutations(f);
    expect(bySeverity(rs, 'refutes')).toContain('vacuous-provenance');
    expect(rs.find((r) => r.code === 'vacuous-provenance')!.statement).toMatch(/configured=0/);
  });

  it('vacuous-provenance does NOT fire when the queried provenance has edges', () => {
    expect(codes(measuredRefutations(makeFinding()))).not.toContain('vacuous-provenance');
  });

  it('a query naming no provenance is INDETERMINATE, never a pass', () => {
    const f = makeFinding({
      evidence: {
        nodes: [azureNodeId('rg-brain-test', 'app-alpha')],
        edges: [],
        query: 'someBespokeRule(graph)',
        notes: [],
      },
    });
    const rs = measuredRefutations(f);
    expect(bySeverity(rs, 'indeterminate')).toContain('vacuous-provenance');
    // Indeterminate must NOT refute — it is "I could not check", not "it failed".
    expect(bySeverity(rs, 'refutes')).not.toContain('vacuous-provenance');
  });

  it('no-evidence REFUTES a finding with an empty evidence chain', () => {
    expect(bySeverity(measuredRefutations(noEvidenceFinding()), 'refutes')).toContain('no-evidence');
  });

  it('unmeasured-scale downgrades a cost quoted for a resource with no scale facts', () => {
    // The app exists in the graph but carries NO `properties.template.scale`,
    // which the extractor reads as NOT MEASURED — never as minReplicas 0.
    const graph = makeGraph([{ name: 'app-alpha' }]);
    const rs = measuredRefutations(costedFinding(), graph);
    expect(bySeverity(rs, 'downgrades')).toContain('unmeasured-scale');
  });

  it('unmeasured-scale does NOT fire when the scale WAS measured', () => {
    const graph = makeGraph([{ name: 'app-alpha', minReplicas: 2 }]);
    expect(codes(measuredRefutations(costedFinding(), graph))).not.toContain('unmeasured-scale');
  });

  it('unmeasured-scale is INDETERMINATE with no graph — it does not silently pass', () => {
    const rs = measuredRefutations(costedFinding());
    expect(bySeverity(rs, 'indeterminate')).toContain('unmeasured-scale');
  });

  it('ownership-unestablished downgrades, and reports the guard OWN population', () => {
    // Measured on the real estate 2026-08-23: ZERO of 105 container-tier
    // resources carry `loom-estate-id`, and the graph holds 0 `owns` edges. So
    // this check is BLIND, and it has to say so rather than read as satisfied.
    const graph = makeGraph([{ name: 'app-alpha', minReplicas: 2, tags: {} }]);
    const rs = measuredRefutations(makeFinding(), graph);
    const own = rs.find((r) => r.code === 'ownership-unestablished');
    expect(own?.severity).toBe('downgrades');
    expect(own?.statement).toMatch(/0 'owns' edge\(s\) IN TOTAL/);
    expect(own?.statement).toMatch(/blind, not satisfied/);
  });

  it('ownership-unestablished clears when the subject carries the estate tag', () => {
    const graph = makeGraph([
      { name: 'app-alpha', minReplicas: 2, tags: { 'loom-estate-id': 'estate-1' } },
    ]);
    expect(codes(measuredRefutations(makeFinding(), graph))).not.toContain('ownership-unestablished');
  });

  it('ownership is INDETERMINATE with no graph', () => {
    expect(bySeverity(measuredRefutations(makeFinding()), 'indeterminate')).toContain(
      'ownership-unestablished',
    );
  });

  it('ownership does not apply to a finding with no Azure subject', () => {
    const f = makeFinding({ subjects: [] });
    expect(codes(measuredRefutations(f, makeGraph([])))).not.toContain('ownership-unestablished');
  });

  it("cost-presented-as-billed downgrades a 'billed' figure with no export in its basis", () => {
    const rs = measuredRefutations(billedWithoutExportFinding());
    expect(bySeverity(rs, 'downgrades')).toContain('cost-presented-as-billed');
  });

  it("a 'billed' figure that names a Cost Management export is accepted", () => {
    const f = makeFinding({
      cost: {
        amountUsd: 41.5,
        source: 'billed',
        basis: 'Cost Management export loom-costs, period 2026-08-01..2026-08-22',
        asOf: '2026-08-23T00:00:00.000Z',
      },
    });
    expect(codes(measuredRefutations(f))).not.toContain('cost-presented-as-billed');
  });

  it('a derived figure is never flagged as billed', () => {
    expect(codes(measuredRefutations(costedFinding()))).not.toContain('cost-presented-as-billed');
  });
});

describe('critic — the asymmetry: a model can only ever subtract', () => {
  it('a model challenge CANNOT refute — the best it can do is downgrade', () => {
    expect(verdictFor([], [{ claim: 'x', wouldRefute: true, checkable: '' }])).toBe('downgraded');
  });

  it('end-to-end: a model insisting a clean finding is wrong only DOWNGRADES it', async () => {
    // The same property through the real agent rather than the pure helper, so
    // the asymmetry is guarded at two points rather than one. A graph with an
    // ownership signal keeps the measured half silent, isolating the model's effect.
    const graph = makeGraph([
      { name: 'app-alpha', minReplicas: 2, tags: { 'loom-estate-id': 'estate-1' } },
    ]);
    const run = await criticize({
      findings: [makeFinding({ id: 'clean', confidence: 'high' })],
      graph,
      client: stubClient({
        critic: {
          challenges: [
            { claim: 'this is definitely wrong', wouldRefute: true, checkable: 'trust me' },
          ],
        },
      }),
    });
    expect(run.result[0]!.verdict).toBe('downgraded');
    expect(run.result[0]!.verdict).not.toBe('refuted');
    expect(run.result[0]!.resultingConfidence).toBe('medium');
  });

  it('a model CANNOT clear a measured refutation', async () => {
    // The model returns no challenges at all — the most favourable reply it could
    // give. The blind population still refutes.
    const run = await criticize({
      findings: [blindFinding({ id: 'blind-1' })],
      client: stubClient({ critic: { challenges: [] } }),
    });
    expect(run.result[0]!.verdict).toBe('refuted');
    expect(run.result[0]!.modelConsulted).toBe(true);
  });

  it('a model CANNOT raise confidence above what the finding declared', () => {
    expect(confidenceFor('low', 'survives')).toBe('low');
    expect(confidenceFor('medium', 'survives')).toBe('medium');
    // And a downgrade never lands above the declared value either.
    expect(confidenceFor('low', 'downgraded')).toBe('low');
    expect(confidenceFor('high', 'downgraded')).toBe('medium');
    expect(confidenceFor('high', 'refuted')).toBe('low');
  });

  it('wouldRefute is accepted only as a real boolean — a truthy string is false', () => {
    // A coerced truthy read is the shape that turned an admin check into a
    // bypass (#3891). `"yes"` must not become authority.
    const parsed = parseChallenges({
      challenges: [
        { claim: 'a', wouldRefute: 'yes' },
        { claim: 'b', wouldRefute: 1 },
        { claim: 'c', wouldRefute: true },
      ],
    });
    expect(parsed.map((c) => c.wouldRefute)).toEqual([false, false, true]);
  });

  it('malformed challenge entries are dropped, not coerced', () => {
    expect(parseChallenges({ challenges: [null, 3, { claim: '   ' }, { nope: 1 }] })).toEqual([]);
    expect(parseChallenges({})).toEqual([]);
    expect(parseChallenges(null)).toEqual([]);
    expect(parseChallenges({ challenges: 'lots' })).toEqual([]);
  });
});

describe('critic — degradation is reported, never silent', () => {
  it('every finding is still reviewed when the model is unavailable', async () => {
    const findings = [makeFinding(), blindFinding(), noEvidenceFinding()];
    const run = await criticize({ findings, client: throwingClient() });
    expect(run.result).toHaveLength(3);
    // The measured half is untouched by the outage.
    expect(run.result[1]!.verdict).toBe('refuted');
    expect(run.result[2]!.verdict).toBe('refuted');
    expect(run.result.every((c) => c.modelConsulted === false)).toBe(true);
  });

  it('the population separates "reviewed 3" from "the model saw 3"', async () => {
    const findings = [makeFinding(), makeFinding(), makeFinding()];
    const out = await criticize({ findings, client: throwingClient() });
    expect(out.population.examined).toBe(3);
    expect(out.population.modelConsulted).toBe(0);
    expect(out.population.modelUnavailable).toBe(3);
    expect(out.skipped).toHaveLength(3);
  });

  it('a reply with no JSON object counts as UNAVAILABLE, not as an empty answer', async () => {
    const out = await criticize({
      findings: [makeFinding()],
      client: async () => ({ json: 'not an object', usage: null }),
    });
    expect(out.population.modelConsulted).toBe(0);
    expect(out.population.modelUnavailable).toBe(1);
  });

  it('with NO client the run is deterministic-only and says so in the scope', async () => {
    const out = await criticize({ findings: [makeFinding()] });
    expect(out.population.modelUnavailable).toBe(1);
    expect(out.usage.calls).toBe(0);
  });

  it('an empty finding list is BLIND, and does not read as a clean bill of health', async () => {
    const out = await criticize({ findings: [] });
    expect(out.population.blind).toBe(true);
    expect(out.population.examined).toBe(0);
  });

  it('the scope names the graph as absent when it is absent', async () => {
    const out = await criticize({ findings: [makeFinding()] });
    expect(out.population.scope).toMatch(/NO graph supplied/);
    expect(out.population.scope).toMatch(/INDETERMINATE, not passed/);
  });

  it('blindInputs carries a blind finding forward into the population', async () => {
    const out = await criticize({ findings: [makeFinding(), blindFinding()] });
    expect(out.population.blindInputs).toBe(1);
    expect(out.population.byDetector['unreachable-always-on']).toBe(2);
  });
});

describe('critic — verdict composition', () => {
  it('measured refutations decide "refuted" before challenges are consulted', () => {
    const refuting = [{ code: 'blind-population' as const, severity: 'refutes' as const, statement: '', establishedBy: '' }];
    expect(verdictFor(refuting, [])).toBe('refuted');
    expect(verdictFor(refuting, [{ claim: 'looks fine', wouldRefute: false, checkable: '' }])).toBe('refuted');
  });

  it('a downgrading refutation yields "downgraded"', () => {
    const d = [{ code: 'ownership-unestablished' as const, severity: 'downgrades' as const, statement: '', establishedBy: '' }];
    expect(verdictFor(d, [])).toBe('downgraded');
  });

  it('an indeterminate refutation alone does NOT change the verdict', () => {
    const i = [{ code: 'ownership-unestablished' as const, severity: 'indeterminate' as const, statement: '', establishedBy: '' }];
    expect(verdictFor(i, [])).toBe('survives');
  });

  it('a fully clean finding with a graph survives at its declared confidence', async () => {
    const graph = makeGraph([
      { name: 'app-alpha', minReplicas: 2, tags: { 'loom-estate-id': 'estate-1' } },
    ]);
    const out = await criticize({
      findings: [makeFinding({ confidence: 'high', population: population() })],
      graph,
    });
    expect(out.result[0]!.verdict).toBe('survives');
    expect(out.result[0]!.resultingConfidence).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// #3967 — the `azure:` population, and the mutation that could zero it
// ---------------------------------------------------------------------------

describe("#3967 — azureSubjects' population is reachable at PRODUCTION shape", () => {
  // THE MEASURED GAP. `azureSubjects()` is the population for `checkOwnership`
  // and `checkUnmeasuredScale`, and an empty population makes both return null —
  // a PASS, not an indeterminate. Mutation N5 (keep the prefix test, drop any
  // subject whose subscription segment is 36 chars) left the whole brain suite
  // green at 231/231, because every fixture used the 5-char `sub-a` placeholder.
  // These arms use a GUID-SHAPED subject, so the mutation is now visible.

  it('EMBEDDED CONTROL: the subject really does carry a 36-char subscription segment', () => {
    // Without this the arms below would pass over a fixture that never had the
    // shape the mutation keys on — a test of nothing, indistinguishable from a
    // test that works.
    const id = String(guidShapedSubject());
    expect(id.startsWith('azure:')).toBe(true);
    expect(id.split('/')[2]).toHaveLength(36);
    // …and the ORIGINAL fixture does not, which is why it could not see N5.
    expect(String(azureNodeId('rg-brain-test', 'app-alpha')).split('/')[2]).not.toHaveLength(36);
  });

  it('checkOwnership DOWNGRADES over a GUID-shaped subject', () => {
    // No `owns` edge and no estate tag in this graph, so ownership is not
    // established and the guard between a wrong inference and someone else's
    // production must fire.
    const rs = measuredRefutations(
      guidShapedFinding(),
      guidShapedGraph([{ name: 'app-alpha', minReplicas: 2 }]),
    );
    expect(bySeverity(rs, 'downgrades')).toContain('ownership-unestablished');
  });

  it('checkUnmeasuredScale DOWNGRADES over a GUID-shaped subject with no scale facts', () => {
    const rs = measuredRefutations(
      guidShapedCostedFinding(),
      // `minReplicas` omitted ⇒ no ScaleFacts, which is NOT MEASURED.
      guidShapedGraph([{ name: 'app-alpha' }]),
    );
    expect(bySeverity(rs, 'downgrades')).toContain('unmeasured-scale');
  });

  it('CONTROL: a GUID-shaped subject that IS owned and IS measured trips neither', () => {
    // Proves the two arms above are about the PREDICATE rather than about the
    // GUID shape tripping something unconditionally.
    const rs = measuredRefutations(
      guidShapedCostedFinding(),
      guidShapedGraph([
        { name: 'app-alpha', minReplicas: 2, tags: { 'loom-estate-id': 'loom-test-estate' } },
      ]),
    );
    expect(bySeverity(rs, 'downgrades')).not.toContain('ownership-unestablished');
    expect(bySeverity(rs, 'downgrades')).not.toContain('unmeasured-scale');
  });
});

describe('#3967 item 3 — a DROPPED Azure subject is indeterminate, never a pass', () => {
  // The independent oracle. If a subject resolves in the GRAPH to an
  // azure-resource node and the prefix predicate did not return it, the
  // population this check ranged over is smaller than the finding's — and a
  // smaller population is not a clean result. No filter written inside
  // `azureSubjects` can hide from this, because the answer comes from the graph.

  it('a subject the graph calls azure-resource but the prefix missed ⇒ indeterminate', () => {
    const graph = guidShapedGraph([{ name: 'app-alpha', minReplicas: 2 }]);
    const real = graph.nodes.find((n) => n.kind === 'azure-resource')!;
    // A subject that IS that node, addressed without the minted prefix — the
    // observable shape of a prefix drift or a predicate-internal filter.
    const disguised = String(real.id).replace(/^azure:/, '') as unknown as typeof real.id;
    const patched = {
      ...graph,
      node: (id: typeof real.id) => (String(id) === String(disguised) ? real : graph.node(id)),
    } as typeof graph;

    const rs = measuredRefutations(makeFinding({ subjects: [disguised] }), patched);
    expect(bySeverity(rs, 'indeterminate')).toContain('ownership-unestablished');
    const stmt = rs.find((r) => r.code === 'ownership-unestablished')!.statement;
    expect(stmt).toMatch(/SMALLER population/);
    expect(stmt).toMatch(/NOT a clean result/);
  });

  it('CONTROL: a genuinely NON-Azure subject stays a silent pass, not noise', () => {
    // A code-module or deploy-artifact subject has no Azure ownership question.
    // Keying the indeterminate to `subjects.length > 0` would fire here and
    // train a reader to ignore the code.
    const rs = measuredRefutations(
      makeFinding({ subjects: [nodeIdFromPersisted('deploy:platform/fiab/bicep/main.bicep')] }),
      makeGraph([{ name: 'app-alpha', minReplicas: 2 }]),
    );
    expect(codes(rs)).not.toContain('ownership-unestablished');
  });
});
