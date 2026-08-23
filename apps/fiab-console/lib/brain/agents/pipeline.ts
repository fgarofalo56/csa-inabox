/**
 * LOOM BRAIN — the agent pipeline.
 *
 * ── THE ORDER IS THE DESIGN ────────────────────────────────────────────────
 *
 *     detectors ─▶ CRITIC ─▶ (refuted dropped) ─▶ CORRELATOR ─▶ EXPLAINER ─▶ REMEDIATOR
 *
 * The Critic runs FIRST and its refusals are applied by THIS module, in code —
 * it is a gate, not a decoration. A refuted finding is never narrated, never
 * grouped, never drafted, and never appears in `report.findings`. It appears in
 * `report.refuted` with the measurement that refuted it, because deleting it
 * silently would hide that a detector produced something unsound.
 *
 * Putting the Critic last would have been cheaper — narrate everything, then
 * annotate. It would also have meant that every downstream agent spent tokens on
 * findings that were already known to be unsound, and that a bug in the filter
 * would surface as "a refuted finding got rendered anyway". Gating first makes
 * that class of bug impossible rather than unlikely.
 *
 * ── DEGRADATION IS A REPORTED NUMBER, NOT A FAILURE ────────────────────────
 * With no `client`, the whole pipeline runs: every measured check, every
 * component grouping, every evidence block, every proposal. What is lost is
 * prose, root-cause names and richer drafts. The report says so — each stage's
 * population carries `modelConsulted` / `modelUnavailable`, so "the Brain
 * reviewed 41 findings" and "…and the model answered for 0 of them" are
 * different, visible claims.
 *
 * ── NOTHING HERE MUTATES AZURE ─────────────────────────────────────────────
 * This module composes four pure-except-for-one-chat-call agents. It has no
 * Azure client and no code path that could delete or scale a resource.
 */

import type { DetectorResult, Finding, SkippedSubject } from '../types';
import {
  makeAgentPopulation,
  mergeUsage,
  zeroUsage,
  type AgentName,
  type AgentPopulation,
  type BrainAgentReport,
  type CorrelationGroup,
  type Critique,
  type DetectorInputSummary,
  type Narrative,
  type RemediationDraft,
  type ReportedFinding,
} from './contracts';
import { correlate } from './correlator';
import { criticize } from './critic';
import { explain } from './explainer';
import { draftRemediations } from './remediator';
import { agentRunCost } from './tokens';
import type { BrainModelClient } from './model-client';
import type { BrainGraphView } from '../types';

export interface BrainAgentInput {
  /**
   * Detector output, NOT a bare finding array.
   *
   * Taking `DetectorResult[]` is what lets the report state that a detector
   * examined an empty set. A detector that returns zero findings over zero nodes
   * is green and blind, and if the pipeline only received `Finding[]` it would
   * see nothing at all — the blind detector and the clean one would be the same
   * empty list.
   */
  readonly detectorResults: readonly DetectorResult[];
  readonly graph?: BrainGraphView;
  /** Omit for a fully deterministic run. Nothing fails; degradation is reported. */
  readonly client?: BrainModelClient;
  /** ISO-8601 timestamp for the cost figure's `asOf`. Injected for determinism. */
  readonly now?: string;
}

/** Summarize the detectors that fed this run, including the ones that saw nothing. */
function summarizeDetectors(results: readonly DetectorResult[]): DetectorInputSummary[] {
  return results.map((r) => ({
    detector: r.detector,
    findings: r.findings.length,
    examined: r.population.examined,
    edgesExamined: r.population.edgesExamined,
    blind: r.population.blind,
    scope: r.population.scope,
    skipped: r.skipped.length,
  }));
}

/**
 * Run the agent layer.
 *
 * Returns a complete report in every case, including: no detectors, detectors
 * that found nothing, a blind graph, and no model client. Each of those is a
 * different, visible state in the returned populations rather than the same
 * empty success.
 */
export async function runBrainAgents(input: BrainAgentInput): Promise<BrainAgentReport> {
  const now = input.now ?? new Date().toISOString();
  const detectors = summarizeDetectors(input.detectorResults);
  const allFindings: Finding[] = input.detectorResults.flatMap((r) => [...r.findings]);
  const skipped: SkippedSubject[] = input.detectorResults.flatMap((r) => [...r.skipped]);

  // ── 1. CRITIC — the gate ────────────────────────────────────────────────
  const criticRun = await criticize({
    findings: allFindings,
    graph: input.graph,
    client: input.client,
  });
  const critiqueById = new Map<string, Critique>(criticRun.result.map((c) => [c.findingId, c]));
  const refuted = criticRun.result.filter((c) => c.verdict === 'refuted');
  const refutedIds = new Set(refuted.map((c) => c.findingId));

  // The filter is HERE, in code, and it is the only place a finding can pass.
  const survivors = allFindings.filter((f) => !refutedIds.has(f.id));
  for (const c of refuted) {
    const why = c.deterministic.find((r) => r.severity === 'refutes');
    skipped.push({
      subject: c.findingId,
      reason: `REFUTED by the Critic and withheld from the report — ${why?.code ?? 'measured refutation'}: ${why?.statement ?? ''}`,
    });
  }

  // ── 2–4. The remaining agents see survivors only ────────────────────────
  const correlatorRun = await correlate({
    findings: survivors,
    graph: input.graph,
    client: input.client,
  });
  const explainerRun = await explain({
    findings: survivors,
    critiques: critiqueById,
    client: input.client,
  });
  const remediatorRun = await draftRemediations({
    findings: survivors,
    critiques: critiqueById,
    client: input.client,
  });

  const narrativeById = new Map<string, Narrative>(explainerRun.result.map((n) => [n.findingId, n]));
  const draftById = new Map<string, RemediationDraft>(remediatorRun.result.map((d) => [d.findingId, d]));
  const groupIdByFinding = new Map<string, string>();
  for (const g of correlatorRun.result) {
    for (const m of g.members) groupIdByFinding.set(m, g.id);
  }

  const reported: ReportedFinding[] = [];
  for (const f of survivors) {
    const critique = critiqueById.get(f.id);
    const narrative = narrativeById.get(f.id);
    const remediation = draftById.get(f.id);
    if (!critique || !narrative || !remediation) {
      // Structurally unreachable — every agent iterates the same array — but a
      // silent `undefined!` here would be exactly the kind of assumption this
      // codebase punishes. Record it and drop the finding rather than emit a
      // half-built one.
      skipped.push({
        subject: f.id,
        reason:
          `assembly incomplete (critique=${!!critique} narrative=${!!narrative} ` +
          `remediation=${!!remediation}); withheld rather than emitted partially`,
      });
      continue;
    }
    reported.push({
      finding: f,
      critique,
      narrative,
      remediation,
      groupId: groupIdByFinding.get(f.id) ?? null,
    });
  }

  const usage = [criticRun, correlatorRun, explainerRun, remediatorRun].reduce(
    (acc, r) => mergeUsage(acc, r.usage),
    zeroUsage(),
  );

  const stages: Record<AgentName, AgentPopulation> = {
    critic: criticRun.population,
    correlator: correlatorRun.population,
    explainer: explainerRun.population,
    remediator: remediatorRun.population,
  };

  const blindDetectors = detectors.filter((d) => d.blind).length;
  const population = makeAgentPopulation({
    subject: 'findings',
    findings: allFindings,
    scope:
      `${input.detectorResults.length} detector(s) → ${allFindings.length} finding(s) in; ` +
      `${refuted.length} refuted by the Critic and withheld; ${reported.length} reported; ` +
      `${correlatorRun.result.length} correlation group(s)` +
      (blindDetectors > 0
        ? `; ${blindDetectors} detector(s) reported a BLIND population — those examined nothing`
        : '') +
      (input.graph
        ? `; graph: ${input.graph.nodes.length} nodes, ${input.graph.edges.length} edges`
        : '; NO graph supplied — ownership and scale checks are INDETERMINATE, not passed') +
      (input.client ? '' : '; NO model client — deterministic-only run'),
    modelConsulted: criticRun.population.modelConsulted,
    modelUnavailable: criticRun.population.modelUnavailable,
  });

  return {
    findings: reported,
    refuted,
    groups: correlatorRun.result,
    population,
    stages,
    detectors,
    usage,
    cost: agentRunCost(usage, now),
    skipped: [
      ...skipped,
      ...criticRun.skipped,
      ...correlatorRun.skipped,
      ...explainerRun.skipped,
      ...remediatorRun.skipped,
    ],
  };
}
