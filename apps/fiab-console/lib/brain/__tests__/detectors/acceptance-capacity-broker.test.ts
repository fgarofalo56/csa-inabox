/**
 * LOOM BRAIN — THE DETECTOR ACCEPTANCE TEST.
 *
 * PRP §5: "`loom-capacity-broker` appears as an unreachable always-on node with
 * its evidence chain — that is the acceptance test, because it is the founding
 * measured example."
 *
 * The graph substrate proved the QUERY finds it. This proves the DETECTOR does:
 * that the finding is emitted, carries the evidence chain, carries a cost figure
 * labelled `derived`, carries a population, and carries a remediation that is a
 * proposal rather than an action.
 *
 * ── WHAT MAKES THIS TEST ABLE TO FAIL ──────────────────────────────────────
 * Three controls, and the assertions about them are the point:
 *
 *   `loom-direct-lake`  always-on and WIRED     -> must be absent.
 *   `loom-scratch`      unreachable, minReplicas 0 -> must be absent. This one
 *                       proves the ALWAYS-ON half of the predicate is doing work;
 *                       delete `minReplicas > 0` and only this assertion fails.
 *   `loom-console`      always-on, unwired, EXTERNAL -> must be absent from
 *                       findings and PRESENT in `skipped`. A finding here would
 *                       be the detector claiming something the graph cannot see.
 */

import { describe, it, expect } from 'vitest';
import { formatCostFigure } from '../../graph';
import { UNREACHABLE_SERVICE, unreachableService } from '../../detectors';
import {
  BICEP_PATH,
  BROKER_ID,
  CONSOLE_ARM,
  CONSOLE_ID,
  DIRECTLAKE_ID,
  SCRATCH_ID,
  UNMEASURED_ID,
  buildFixtureGraph,
} from './fixtures';

describe('ACCEPTANCE — unreachable-service finds loom-capacity-broker', () => {
  const graph = buildFixtureGraph();
  const result = unreachableService(graph);
  const ids = result.findings.map((f) => f.subjects[0]);

  it('THE FINDING: the broker is reported', () => {
    expect(result.detector).toBe(UNREACHABLE_SERVICE);
    expect(ids).toContain(BROKER_ID);
  });

  it('THE CONTROL: the wired always-on service is NOT reported', () => {
    // Without this, a detector that returned every container app would pass the
    // assertion above.
    expect(ids).not.toContain(DIRECTLAKE_ID);
  });

  it('THE CONTROL: a scale-to-zero unreachable app is NOT reported', () => {
    // `loom-scratch` has zero inbound configured edges too. It is excluded ONLY
    // by `minReplicas > 0`, so this assertion is the one that dies if the
    // always-on half of the predicate is removed.
    expect(graph.inboundEdges(SCRATCH_ID, 'configured').result).toHaveLength(0);
    expect(ids).not.toContain(SCRATCH_ID);
  });

  it('THE CONTROL: an externally-ingressed app is SKIPPED, not reported', () => {
    // loom-console is always-on and has no inbound configured edge. It is out of
    // scope because its callers are outside the graph — and "out of scope" must
    // be visible as a skip, never as a silent pass.
    expect(ids).not.toContain(CONSOLE_ID);
    const skip = result.skipped.find((s) => s.subject === CONSOLE_ID);
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/ingress\.external is true/);
  });

  it('NOT MEASURED is not zero: the app with no scale facts is skipped', () => {
    expect(ids).not.toContain(UNMEASURED_ID);
    const skip = result.skipped.find((s) => s.subject === UNMEASURED_ID);
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/Absent scale is NOT minReplicas 0/);
  });

  it('THE EVIDENCE CHAIN: the main.bicep line, the symbol and the empty value survive', () => {
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f).toBeDefined();
    const chain = f.evidence.notes.join('\n');
    expect(chain).toContain(BICEP_PATH);
    expect(chain).toContain('LOOM_BROKER_URL');
    // The receipt: not "no value found" — the wire is there and it is ''.
    expect(chain).toContain('empty-value');
    // The live side agrees: the running console carries the same empty wire.
    expect(chain).toContain(CONSOLE_ARM);
    // Edge ids, so the finding can be re-resolved against the graph.
    expect(f.evidence.edges.length).toBeGreaterThan(0);
    for (const id of f.evidence.edges) {
      expect(graph.edges.some((e) => e.id === id)).toBe(true);
    }
    // The query, re-runnable by hand.
    expect(f.evidence.query).toContain('nodesWithNoInboundEdge');
  });

  it('the finding states minReplicas, cpu, memory and that it is HEALTHY', () => {
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    const notes = f.evidence.notes.join('\n');
    expect(notes).toContain('minReplicas=2');
    expect(notes).toContain('cpu=0.5');
    expect(notes).toContain('memory=1Gi');
    // The reason a liveness check finds nothing here.
    expect(notes).toContain('provisioningState=Succeeded');
    expect(notes).toMatch(/only reachability does/);
  });

  it('the cost figure is DERIVED, never billed, and its basis is reproducible', () => {
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f.cost).toBeDefined();
    expect(f.cost!.source).toBe('derived');
    // 2 replicas x 0.5 vCPU x 2,628,000 s x $0.000003 = $7.884
    //   + 2 x 1 GiB x 2,628,000 s x $0.000003        = $15.768  => $23.65/mo idle
    expect(f.cost!.amountUsd).toBeCloseTo(23.65, 2);
    expect(f.cost!.basis).toContain('centralus');
    expect(f.cost!.basis).toContain('IDLE');
    expect(f.cost!.basis).toContain('prices.azure.com');
    // The free grant is NOT netted off, and the basis says so rather than
    // flattering the number by an amount the code cannot establish.
    expect(f.cost!.basis).toContain('free grant');
    // Rendered, it can never look like a bill.
    expect(formatCostFigure(f.cost!)).toContain('DERIVED estimate — not a bill');
  });

  it('confidence is HIGH, because a documented intent removes the alternative explanation', () => {
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    // A dangling wire names the broker as its intended target, so "nothing points
    // at it because nothing was meant to" is ruled out.
    expect(f.confidence).toBe('high');
    expect(f.severity).toBe('high');
  });

  it('the REMEDIATION is a proposal, needs approval, and mutates nothing', () => {
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f.remediation.kind).toBe('proposal');
    expect(f.remediation.requiresHumanApproval).toBe(true);
    expect(f.remediation.mutatesAzure).toBe(false);
    expect(f.remediation.proposedChange).toContain('RECOMMEND-ONLY');
    // It names the file and line to change, not a vague instruction.
    expect(f.remediation.proposedChange).toContain(BICEP_PATH);
  });

  it('the POPULATION is reported and is not blind or vacuous', () => {
    // A detector over an empty set is green and blind. This one ranged over the
    // scale-measured, non-external apps and says so.
    expect(result.population.blind).toBe(false);
    expect(result.population.examined).toBeGreaterThan(0);
    expect(result.population.scope).toMatch(/MEASURED scale/);
    // The vacuous-truth check: with zero resolved `configured` edges, "no inbound
    // configured edge" would be true of everything.
    expect(result.population.byProvenance.configured).toBeGreaterThan(0);
    expect(result.population.scope).toMatch(/Resolved 'configured' edges in graph: [1-9]/);
  });
});
