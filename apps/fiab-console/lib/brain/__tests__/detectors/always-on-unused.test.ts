/**
 * LOOM BRAIN — `always-on-unused`: the detector that must refuse to answer today.
 *
 * There is no telemetry extractor. The graph holds zero `observed` edges — a true
 * measurement, not a broken extractor. So "no inbound observed edge" is vacuously
 * true of every always-on node, and a detector that emitted findings on that
 * basis would produce 19 confident recommendations to delete healthy services
 * (measured: 19 of Loom's 29 container apps are always-on).
 *
 * ── BOTH ARMS ARE RUN HERE, AND THAT IS THE ENTIRE VALUE OF THIS SUITE ─────
 * With only the no-telemetry arm, "0 findings" would be indistinguishable from a
 * detector whose predicate is `return []`. The telemetry arm uses a stand-in
 * extraction shaped exactly as a real telemetry extractor would shape it — the
 * DETECTOR is untouched — and proves the same code produces findings the moment
 * observed edges exist.
 */

import { describe, it, expect } from 'vitest';
import { ALWAYS_ON_UNUSED, alwaysOnUnused } from '../../detectors';
import {
  BROKER_ID,
  CONSOLE_ID,
  DIRECTLAKE_FQDN,
  DIRECTLAKE_ID,
  SCRATCH_ID,
  UNMEASURED_ID,
  buildFixtureGraph,
} from './fixtures';

describe('always-on-unused — ARM A: NO telemetry (the estate as it exists today)', () => {
  const graph = buildFixtureGraph();
  const result = alwaysOnUnused(graph);

  it('the graph really does hold zero observed edges', () => {
    expect(graph.report.edgesByProvenance.observed).toBe(0);
  });

  it('emits ZERO findings rather than accusing every always-on service', () => {
    expect(result.detector).toBe(ALWAYS_ON_UNUSED);
    expect(result.findings).toEqual([]);
  });

  it('does NOT report a clean estate: every always-on candidate is skipped with the reason', () => {
    const brokerSkip = result.skipped.find((s) => s.subject === BROKER_ID);
    expect(brokerSkip).toBeDefined();
    expect(brokerSkip!.reason).toMatch(/ALWAYS-ON \(minReplicas 2\)/);
    expect(brokerSkip!.reason).toMatch(/NOT EVALUATED/);
    expect(brokerSkip!.reason).toMatch(/ZERO RESOLVED 'observed' edges/);
    expect(brokerSkip!.reason).toMatch(/No telemetry extractor has run/);
    // The wired control is skipped too — the blindness is total and uniform,
    // which is what makes it honest rather than selective.
    expect(result.skipped.some((s) => s.subject === DIRECTLAKE_ID)).toBe(true);
  });

  it('the population is NOT blind: there were always-on nodes to examine', () => {
    // `blind` means the subject set was empty. It was not. The missing thing is
    // the telemetry, and that is reported separately so the two cannot be
    // confused.
    expect(result.population.blind).toBe(false);
    expect(result.population.examined).toBeGreaterThan(0);
    expect(result.population.scope).toMatch(/Resolved 'observed' edges in graph: 0/);
  });
});

describe('always-on-unused — ARM B: WITH telemetry, the same code produces findings', () => {
  const graph = buildFixtureGraph({
    // The console calls direct-lake. Nothing calls the broker.
    observedCalls: [{ from: CONSOLE_ID, to: DIRECTLAKE_FQDN }],
  });
  const result = alwaysOnUnused(graph);
  const ids = result.findings.map((f) => f.subjects[0]);

  it('the stand-in produced a RESOLVED observed edge, so the query is not vacuous', () => {
    const observed = graph.edges.filter((e) => e.provenance === 'observed');
    expect(observed).toHaveLength(1);
    expect(observed[0]!.resolution).toBe('resolved');
    expect(result.population.scope).toMatch(/Resolved 'observed' edges in graph: 1/);
  });

  it('POSITIVE: the always-on service with no traffic is reported', () => {
    expect(ids).toContain(BROKER_ID);
  });

  it('NEGATIVE: the always-on service WITH traffic is not', () => {
    // The discrimination. A detector returning every always-on node would pass
    // the assertion above and fail this one.
    expect(graph.inboundEdges(DIRECTLAKE_ID, 'observed').result).toHaveLength(1);
    expect(ids).not.toContain(DIRECTLAKE_ID);
  });

  it('NEGATIVE: a scale-to-zero service is not in the always-on set at all', () => {
    expect(ids).not.toContain(SCRATCH_ID);
  });

  it('NOT MEASURED is not zero: the app with no scale facts is skipped', () => {
    expect(ids).not.toContain(UNMEASURED_ID);
    expect(result.skipped.some((s) => s.subject === UNMEASURED_ID)).toBe(true);
  });

  it('the finding carries a DERIVED cost and a scale-to-zero proposal', () => {
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f.cost!.source).toBe('derived');
    expect(f.cost!.amountUsd).toBeCloseTo(23.65, 2);
    expect(f.remediation.proposedChange).toMatch(/minReplicas 0/);
    expect(f.remediation.mutatesAzure).toBe(false);
    expect(f.remediation.requiresHumanApproval).toBe(true);
  });

  it('confidence is MEDIUM and the finding states the window caveat', () => {
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    // A service called once a quarter looks identical to one never called.
    expect(f.confidence).toBe('medium');
    expect(f.evidence.notes.join('\n')).toMatch(/statement about the telemetry window/);
    expect(f.remediation.proposedChange).toMatch(/Confirm the telemetry window/);
  });

  it('this finding is DIFFERENT from unreachable: it names the wires that DO point at the node', () => {
    // "reachable and unused" vs "unreachable" — different findings, different
    // fixes. Here the broker has zero configured wires so the count is 0, but the
    // summary is a scaling decision, not a wiring defect.
    const f = result.findings.find((x) => x.subjects[0] === BROKER_ID)!;
    expect(f.summary).toMatch(/scaling decision, not a wiring defect/);
  });
});

describe('always-on-unused — the two arms genuinely differ', () => {
  it('same fixture, telemetry the only variable, opposite outcomes', () => {
    // If this ever collapses to "both empty" or "both non-empty", the detector
    // has stopped depending on `observed` and the vacuity gate is decoration.
    const without = alwaysOnUnused(buildFixtureGraph());
    const with_ = alwaysOnUnused(
      buildFixtureGraph({ observedCalls: [{ from: CONSOLE_ID, to: DIRECTLAKE_FQDN }] }),
    );
    expect(without.findings).toHaveLength(0);
    expect(with_.findings.length).toBeGreaterThan(0);
    expect(without.skipped.length).toBeGreaterThan(with_.skipped.length);
  });
});
