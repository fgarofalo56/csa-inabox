/**
 * LOOM BRAIN — detector: DECLARED BUT DEAD.
 *
 * A node with an inbound `declared` edge and NO inbound `configured` edge: the
 * template wires it, the running deployment does not. `types.ts` states the
 * distinction that makes this a detector rather than a footnote:
 *
 *     declared without configured  = wired in the template, DEAD in the deployment.
 *     configured without observed  = reachable and UNUSED.
 *
 * Those are different findings with different fixes, and conflating them is how
 * "it's deployed so it must be used" happens.
 *
 * ── WHY THIS IS NOT A DUPLICATE OF `unreachable-service` ───────────────────
 * `unreachable-service` asks about ALWAYS-ON resources — it is a cost question,
 * and it fires on a node with no inbound wire of any kind. This one fires only on
 * nodes that ARE declared, at any replica count, and it is a DEPLOY-INTEGRITY
 * question: something merged into the template never reached the estate.
 *
 * The overlap is real and deliberate. `loom-capacity-broker` is not in this
 * detector's output, because its declared wire is EMPTY and therefore dangling —
 * it has no resolved `declared` edge either. That is the correct answer: the
 * broker is not "declared but not configured", it is "declared as nothing". The
 * two detectors partition the space rather than double-reporting it, and the test
 * suite asserts the broker is absent here.
 *
 * ── TWO VACUITY CHECKS, NOT ONE ────────────────────────────────────────────
 * This predicate reads two provenances, so it has two ways to be vacuous:
 *
 *   zero resolved `declared`    -> nothing can match the positive half; result is
 *                                  empty for an uninteresting reason.
 *   zero resolved `configured`  -> the negative half is true of everything, so
 *                                  EVERY declared node is reported. Loud and wrong.
 *
 * Both are checked. A single-provenance check would catch only the first, and the
 * second is the dangerous one because it produces findings rather than silence.
 */

import {
  hasInboundOnly,
  type BrainGraphView,
  type CostFigure,
  type Detector,
  type DetectorResult,
  type Finding,
  type SkippedSubject,
} from '../graph';
import { estimateAlwaysOnMonthlyCost } from './cost-model';
import {
  bySeverity,
  detectorPopulation,
  evidence,
  findingId,
  inbound,
  ownership,
  resolvedEdgeCount,
  scopedProposal,
  severityForMonthlyUsd,
  skip,
  vacuityReason,
} from './detector-kit';

export const DECLARED_BUT_DEAD = 'declared-but-dead';

const QUERY = "hasInboundOnly(graph, 'declared', 'configured')";

export const declaredButDead: Detector = (graph: BrainGraphView): DetectorResult => {
  const skipped: SkippedSubject[] = [];
  const candidates = graph.nodes;

  const population = detectorPopulation(
    graph,
    candidates,
    `${candidates.length} node(s) tested for inbound RESOLVED 'declared' AND zero inbound RESOLVED ` +
      `'configured'. Resolved edges in graph: declared=${resolvedEdgeCount(graph, 'declared')}, ` +
      `configured=${resolvedEdgeCount(graph, 'configured')}.`,
  );

  // Two ways to be vacuous. The `configured` one is the dangerous half: it
  // produces a full page of confident findings rather than an empty result.
  const declaredVacuous = vacuityReason(graph, 'declared');
  const configuredVacuous = vacuityReason(graph, 'configured');
  if (declaredVacuous !== null || configuredVacuous !== null) {
    skipped.push(
      skip(
        'ALL NODES',
        'detector not run — ' +
          [declaredVacuous, configuredVacuous].filter((r): r is string => r !== null).join(' ALSO: '),
      ),
    );
    return { detector: DECLARED_BUT_DEAD, findings: [], population, skipped };
  }

  // THE PREDICATE, as the substrate's own query: inbound 'declared', no inbound 'configured'.
  const dead = hasInboundOnly(graph, 'declared', 'configured');

  const findings: Finding[] = [];
  for (const node of dead.result) {
    const declaredEdges = inbound(graph, node.id, 'declared');
    const own = ownership(graph, node.id);

    let costLine = 'no cost figure: this detector prices only always-on Azure resources.';
    let monthlyUsd: number | null = null;
    let cost: CostFigure | undefined;
    if (node.kind === 'azure-resource') {
      const est = estimateAlwaysOnMonthlyCost(node);
      if (est.kind === 'priced') {
        cost = est.figure;
        monthlyUsd = est.figure.amountUsd;
        costLine = `derived cost while dead: $${est.figure.amountUsd.toFixed(2)}/mo (idle rate)`;
      } else {
        costLine = `no cost figure: ${est.reason}`;
        skipped.push(skip(`${node.id} (cost)`, `finding emitted WITHOUT a cost figure: ${est.reason}`));
      }
    }

    findings.push({
      id: findingId(DECLARED_BUT_DEAD, node.id),
      detector: DECLARED_BUT_DEAD,
      severity: severityForMonthlyUsd(monthlyUsd),
      title: `${node.displayName} is wired in the template and unwired in the deployment`,
      summary:
        `${declaredEdges.length} 'declared' edge(s) from the bicep templates resolve to ` +
        `'${node.displayName}', and ZERO 'configured' edges from the live deployment do. The template ` +
        'says these are connected; the running estate says they are not. Per deploy-integrity R2 that ' +
        'gap is what "merged, not deployed" looks like in the graph.',
      subjects: [node.id],
      evidence: evidence({
        nodes: [node.id, ...declaredEdges.map((e) => e.from)],
        edges: declaredEdges,
        query: QUERY,
        notes: [
          `inbound resolved: declared=${declaredEdges.length}, configured=0`,
          ...declaredEdges.map(
            (e) =>
              `  declared by ${e.evidence.artifact}` +
              (e.evidence.line !== undefined ? `:${e.evidence.line}` : '') +
              ` ${e.evidence.symbol ?? '(no symbol)'} = ${JSON.stringify(e.evidence.rawValue ?? '')}`,
          ),
          costLine,
          'R7 — this establishes that no EXTRACTED live env var points here. If the consuming app\'s ' +
            'env was never read (or its value came from a secretRef, which is unreadable), the ' +
            'configured side is INDETERMINATE rather than absent. Check the graph report\'s skipped list.',
        ],
      }),
      population,
      // The declared side is read from the template; the configured side is an
      // absence, and an absence can be an extraction gap. Not `high`.
      confidence: 'medium',
      cost,
      remediation: scopedProposal(
        `Deploy or remove the declared wiring for '${node.displayName}'`,
        `The template declares ${declaredEdges.length} wire(s) to '${node.displayName}' that the running ` +
          `deployment does not carry. Either:\n` +
          `  1. roll the consuming app so the declared value reaches it (deploy-integrity R2: merged is ` +
          `not deployed), or\n` +
          `  2. if the wiring was intentionally dropped, remove it from the template so the graph stops ` +
          `recording an intent nothing honours.\nDeclared at:\n` +
          declaredEdges
            .map(
              (e) =>
                `  - ${e.evidence.artifact}` +
                (e.evidence.line !== undefined ? `:${e.evidence.line}` : '') +
                `  ${e.evidence.symbol ?? '(no symbol)'}`,
            )
            .join('\n'),
        own,
      ),
    });
  }

  return {
    detector: DECLARED_BUT_DEAD,
    findings: [...findings].sort(bySeverity),
    population,
    skipped,
  };
};
