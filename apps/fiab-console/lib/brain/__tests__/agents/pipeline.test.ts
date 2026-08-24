/**
 * The PIPELINE — and the one property that has to hold above all others:
 * **a finding the Critic refutes does not reach the output.**
 *
 * The gate is applied in `pipeline.ts`, in code, before the other three agents
 * run. So the test is not "the refuted finding is marked" — it is "the refuted
 * finding is ABSENT from `report.findings`, present in `report.refuted` with the
 * measurement that refuted it, and recorded in `skipped` so its disappearance is
 * not itself silent."
 *
 * The other theme here is that a fully degraded run — no model at all — still
 * produces a complete and correct report, and SAYS SO in numbers rather than
 * looking identical to a healthy one.
 */

import { describe, expect, it } from 'vitest';
import { runBrainAgents } from '@/lib/brain/agents';
import {
  blindDetectorResult,
  blindFinding,
  detectorResult,
  makeFinding,
  makeGraph,
  nineBicepFindings,
  noEvidenceFinding,
  reportingClient,
  stubClient,
  throwingClient,
  vacuousFinding,
} from './fixtures';

const NOW = '2026-08-23T12:00:00.000Z';

describe('pipeline — the Critic is a GATE, not an annotation', () => {
  it('a refuted finding is ABSENT from report.findings', async () => {
    const good = makeFinding({ id: 'good' });
    const bad = blindFinding({ id: 'bad-blind' });
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [good, bad])],
      now: NOW,
    });
    expect(report.findings.map((r) => r.finding.id)).toEqual(['good']);
    expect(report.findings.map((r) => r.finding.id)).not.toContain('bad-blind');
  });

  it('the refuted finding IS in report.refuted, with the measurement that refuted it', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [blindFinding({ id: 'bad-blind' })])],
      now: NOW,
    });
    expect(report.refuted).toHaveLength(1);
    expect(report.refuted[0]!.findingId).toBe('bad-blind');
    expect(report.refuted[0]!.deterministic.some((r) => r.code === 'blind-population')).toBe(true);
  });

  it('its removal is recorded in skipped — the disappearance is not silent', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [blindFinding({ id: 'bad-blind' })])],
      now: NOW,
    });
    const entry = report.skipped.find((s) => s.subject === 'bad-blind');
    expect(entry).toBeDefined();
    expect(entry!.reason).toMatch(/REFUTED by the Critic and withheld/);
    expect(entry!.reason).toMatch(/blind-population/);
  });

  it('all three refuting shapes are gated out together', async () => {
    const report = await runBrainAgents({
      detectorResults: [
        detectorResult('d1', [
          makeFinding({ id: 'survivor' }),
          blindFinding({ id: 'r-blind' }),
          vacuousFinding({ id: 'r-vacuous' }),
          noEvidenceFinding({ id: 'r-noevidence' }),
        ]),
      ],
      now: NOW,
    });
    expect(report.findings.map((r) => r.finding.id)).toEqual(['survivor']);
    expect(report.refuted.map((c) => c.findingId).sort()).toEqual([
      'r-blind',
      'r-noevidence',
      'r-vacuous',
    ]);
  });

  it('a model that calls every finding fine cannot rescue a refuted one', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [blindFinding({ id: 'bad-blind' })])],
      client: stubClient({
        critic: { challenges: [{ claim: 'looks correct to me', wouldRefute: false }] },
        explainer: { headline: 'h', prose: 'p' },
        remediator: { summary: 's', change: 'c' },
        correlator: { groups: [] },
      }),
      now: NOW,
    });
    expect(report.findings).toEqual([]);
    expect(report.refuted).toHaveLength(1);
  });

  it('a downgraded finding still SHIPS — downgrade is not refusal', async () => {
    // No graph → ownership is indeterminate, not a downgrade. Supply a graph
    // with no ownership signal so the check genuinely downgrades.
    const graph = makeGraph([{ name: 'app-alpha', minReplicas: 2, tags: {} }]);
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding({ id: 'downgradable', confidence: 'high' })])],
      graph,
      now: NOW,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.critique.verdict).toBe('downgraded');
    expect(report.findings[0]!.critique.resultingConfidence).toBe('medium');
  });
  it('a model insisting a clean finding is wrong cannot gate it out of the report', async () => {
    // The third guard point on the asymmetry (the other two are in critic.test.ts).
    // A model with maximum hostility must not be able to suppress a finding —
    // that would let a model outage or a bad reply silently shrink the report.
    const graph = makeGraph([
      { name: 'app-alpha', minReplicas: 2, tags: { 'loom-estate-id': 'estate-1' } },
    ]);
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding({ id: 'hostile-target' })])],
      graph,
      client: stubClient({
        critic: { challenges: [{ claim: 'wrong', wouldRefute: true, checkable: '' }] },
        explainer: { headline: 'h', prose: 'p' },
        remediator: { summary: 's', change: 'c' },
        correlator: { groups: [] },
      }),
      now: NOW,
    });
    expect(report.findings.map((r) => r.finding.id)).toEqual(['hostile-target']);
    expect(report.refuted).toEqual([]);
    expect(report.findings[0]!.critique.verdict).toBe('downgraded');
  });
});

describe('pipeline — a complete report with no model at all', () => {
  it('every survivor carries a critique, a narrative and a proposal', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding({ id: 'a' }), makeFinding({ id: 'b' })])],
      now: NOW,
    });
    expect(report.findings).toHaveLength(2);
    for (const r of report.findings) {
      expect(r.critique.findingId).toBe(r.finding.id);
      expect(r.narrative.evidenceBlock.length).toBeGreaterThan(0);
      expect(r.remediation.proposal.requiresHumanApproval).toBe(true);
      expect(r.remediation.proposal.mutatesAzure).toBe(false);
    }
  });

  it('all four stage populations are reported', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      now: NOW,
    });
    expect(Object.keys(report.stages).sort()).toEqual([
      'correlator',
      'critic',
      'explainer',
      'remediator',
    ]);
    expect(report.stages.critic.modelUnavailable).toBe(1);
    expect(report.stages.explainer.modelUnavailable).toBe(1);
    expect(report.stages.remediator.modelUnavailable).toBe(1);
  });

  it('the scope says the run was deterministic-only', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      now: NOW,
    });
    expect(report.population.scope).toMatch(/NO model client — deterministic-only run/);
  });

  it('a model outage produces the same findings as no client at all', async () => {
    const results = [detectorResult('d1', [makeFinding({ id: 'x' }), blindFinding({ id: 'y' })])];
    const a = await runBrainAgents({ detectorResults: results, now: NOW });
    const b = await runBrainAgents({ detectorResults: results, client: throwingClient(), now: NOW });
    expect(a.findings.map((r) => r.finding.id)).toEqual(b.findings.map((r) => r.finding.id));
    expect(a.refuted.map((c) => c.findingId)).toEqual(b.refuted.map((c) => c.findingId));
  });
});

describe('pipeline — a blind detector is visible, not absorbed', () => {
  it('a detector that examined NOTHING is reported as such', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()]), blindDetectorResult('d2')],
      now: NOW,
    });
    const d2 = report.detectors.find((d) => d.detector === 'd2')!;
    expect(d2.blind).toBe(true);
    expect(d2.findings).toBe(0);
    expect(d2.examined).toBe(0);
    expect(report.population.scope).toMatch(/1 detector\(s\) reported a BLIND population/);
  });

  it('a clean detector and a blind one are DIFFERENT states', async () => {
    const clean = await runBrainAgents({ detectorResults: [detectorResult('d1', [])], now: NOW });
    const blind = await runBrainAgents({ detectorResults: [blindDetectorResult('d1')], now: NOW });
    expect(clean.detectors[0]!.blind).toBe(false);
    expect(blind.detectors[0]!.blind).toBe(true);
    // Both produced zero findings — which is exactly why the flag has to exist.
    expect(clean.findings).toEqual([]);
    expect(blind.findings).toEqual([]);
  });

  it('no detectors at all is BLIND, not a clean bill of health', async () => {
    const report = await runBrainAgents({ detectorResults: [], now: NOW });
    expect(report.population.blind).toBe(true);
    expect(report.detectors).toEqual([]);
  });
});

describe('pipeline — correlation is wired into the findings', () => {
  it('the nine-of-#3893 all carry the same groupId', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('inert-bicep-module', nineBicepFindings())],
      now: NOW,
    });
    expect(report.findings).toHaveLength(9);
    const groupIds = new Set(report.findings.map((r) => r.groupId));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).not.toBeNull();
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.members).toHaveLength(9);
  });

  it('an ungrouped finding carries groupId null rather than a fabricated group', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding({ id: 'lonely' })])],
      now: NOW,
    });
    expect(report.findings[0]!.groupId).toBeNull();
    expect(report.groups).toEqual([]);
  });

  it('a refuted finding is never correlated — the gate runs first', async () => {
    const nine = nineBicepFindings();
    const blinded = nine.map((f, i) =>
      i < 4 ? blindFinding({ ...f, id: f.id }) : f,
    );
    const report = await runBrainAgents({
      detectorResults: [detectorResult('inert-bicep-module', blinded)],
      now: NOW,
    });
    expect(report.refuted).toHaveLength(4);
    expect(report.groups[0]!.members).toHaveLength(5);
    for (const c of report.refuted) {
      expect(report.groups.some((g) => g.members.includes(c.findingId))).toBe(false);
    }
  });
});

describe('pipeline — cost and usage are labelled', () => {
  it('the cost figure is ALWAYS derived, never billed', async () => {
    const withModel = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      client: stubClient({ explainer: { headline: 'h', prose: 'p' } }),
      now: NOW,
    });
    const reported = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      client: reportingClient({}, { promptTokens: 900, completionTokens: 120 }),
      now: NOW,
    });
    expect(withModel.cost.source).toBe('derived');
    // Even with REAL token counts the dollar figure is still derived — the rate
    // is a published list price, not a bill.
    expect(reported.cost.source).toBe('derived');
    expect(reported.cost.asOf).toBe(NOW);
  });

  it("usage source is 'estimated' when the client reports no counts", async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      client: stubClient({ explainer: { headline: 'h', prose: 'p' } }),
      now: NOW,
    });
    expect(report.usage.source).toBe('estimated');
    expect(report.cost.basis).toMatch(/token counts ESTIMATED \(chars\/4 — NOT a measurement\)/);
  });

  it("usage source is 'reported' when the client DOES report counts", async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      client: reportingClient({}, { promptTokens: 900, completionTokens: 120 }),
      now: NOW,
    });
    expect(report.usage.source).toBe('reported');
    expect(report.cost.basis).toMatch(/token counts REPORTED/);
  });

  it('a deterministic-only run spends nothing and says so', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      now: NOW,
    });
    expect(report.usage.calls).toBe(0);
    expect(report.cost.amountUsd).toBe(0);
    expect(report.cost.source).toBe('derived');
  });

  it('spend is attributed per tier, so the strong-tier Critic is visible', async () => {
    const report = await runBrainAgents({
      detectorResults: [detectorResult('d1', [makeFinding()])],
      client: stubClient({
        critic: { challenges: [] },
        explainer: { headline: 'h', prose: 'p' },
        remediator: { summary: 's', change: 'c' },
        correlator: { groups: [] },
      }),
      now: NOW,
    });
    // explainer=mini, remediator=standard, critic=strong. The correlator makes no
    // call here because a single finding yields a one-member component that never
    // becomes a group — but the component still exists, so it does call. Assert
    // the three tiers that must be present.
    expect(Object.keys(report.usage.byTier).sort()).toEqual(['mini', 'standard', 'strong']);
    expect(report.cost.basis).toMatch(/strong: \d+p\+\d+c/);
  });
});
