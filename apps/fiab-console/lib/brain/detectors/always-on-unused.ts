/**
 * LOOM BRAIN — detector: ALWAYS-ON, UNUSED.
 *
 * `scale.minReplicas > 0` and ZERO inbound `observed` edges — reachable, wired,
 * and receiving no traffic. `types.ts`: "configured without observed = reachable
 * and UNUSED."
 *
 * ── THE POPULATION THIS EXISTS FOR ─────────────────────────────────────────
 * Measured 2026-08-23 across all six subscriptions: Loom runs 29 container apps,
 * and 19 of them never scale to zero (minReplicas 1 -> 17 apps, 2 -> 2 apps).
 * That is where the container spend is. This detector's job is to make each of
 * those 19 justify itself with traffic rather than with a healthy probe.
 *
 * ── AND TODAY IT CANNOT, WHICH IS THE ENTIRE POINT OF HOW IT BEHAVES ───────
 * There is no telemetry extractor yet. The graph holds ZERO `observed` edges —
 * measured, not assumed. So "has no inbound observed edge" is VACUOUSLY TRUE of
 * every node in the estate, and a detector that emitted findings on that basis
 * would produce 19 confident, evidence-backed, completely worthless
 * recommendations to delete healthy services.
 *
 * So: when the graph holds no resolved `observed` edges, this detector emits ZERO
 * findings and records EVERY always-on candidate in `skipped` with the reason. It
 * does not report a clean estate — a clean estate and a missing extractor produce
 * identical output otherwise, and this repo has shipped that failure repeatedly.
 *
 * The moment a telemetry extractor lands, the same code starts producing
 * findings with no edit. That is the test: `always-on-unused.test.ts` runs both
 * arms — a graph with observed edges (findings) and one without (all skipped) —
 * and the difference between them is the whole guarantee.
 *
 * ── WHY THIS IS NOT `unreachable-service` WITH A DIFFERENT ARGUMENT ────────
 * It is nearly that, and the near-miss is the point. `unreachable-service` asks
 * whether anything is WIRED to the node; this asks whether anything USES it. A
 * service can be perfectly wired, referenced by five apps, and called by none.
 * Only the second question finds that, and only telemetry can answer it.
 */

import {
  alwaysOnNodes,
  formatCostFigure,
  scaleUnknownCount,
  type BrainGraphView,
  type CostFigure,
  type Detector,
  type DetectorResult,
  type Finding,
  type SkippedSubject,
} from '../graph';
import { estimateAlwaysOnMonthlyCost } from './cost-model';
import {
  azureResources,
  detectorPopulation,
  evidence,
  finalizeResult,
  findingId,
  inbound,
  makeLedger,
  ownership,
  resolvedEdgeCount,
  scopedProposal,
  severityForMonthlyUsd,
  skip,
  vacuityReason,
} from './detector-kit';

export const ALWAYS_ON_UNUSED = 'always-on-unused';

const QUERY = "alwaysOnNodes(graph) MINUS nodes with inbound RESOLVED 'observed' edges";

export const alwaysOnUnused: Detector = (graph: BrainGraphView): DetectorResult => {
  const skipped: SkippedSubject[] = [];

  const azure = azureResources(graph.nodes);
  const ledger = makeLedger(ALWAYS_ON_UNUSED, azure.map((n) => n.id));
  const unknownScale = scaleUnknownCount(graph);
  for (const n of azure.filter((x) => x.scale === undefined)) {
    ledger.skipped(n.id);
    skipped.push(
      skip(
        n.id,
        'no ScaleFacts measured — cannot be established as always-on. NOT MEASURED is not minReplicas 0.',
      ),
    );
  }

  // The always-on set, from the substrate's own query so the definition lives in
  // exactly one place.
  const alwaysOn = alwaysOnNodes(graph, {
    where: (n) => n.kind === 'azure-resource',
    describe: 'azure-resource nodes',
  });

  // Scale measured and minReplicas 0: evaluated, and it costs nothing when idle.
  const alwaysOnIds = new Set(alwaysOn.result.map((n) => n.id));
  for (const n of azure) {
    if (n.scale !== undefined && !alwaysOnIds.has(n.id)) {
      ledger.cleared(n.id, 'scales to zero (minReplicas 0) — no always-on floor to justify');
    }
  }

  const population = detectorPopulation(
    graph,
    alwaysOn.result,
    `${alwaysOn.result.length} ALWAYS-ON azure-resource node(s) (minReplicas > 0) of ${azure.length} azure ` +
      `resources; ${unknownScale} had NO scale facts and were skipped, not cleared. ` +
      `Tested for zero inbound RESOLVED 'observed' edges. ` +
      `Resolved 'observed' edges in graph: ${resolvedEdgeCount(graph, 'observed')}.`,
  );

  // THE VACUITY GATE. Without telemetry, every always-on node trivially has no
  // observed inbound edge, and reporting that would be 19 false accusations.
  const vacuous = vacuityReason(graph, 'observed');
  if (vacuous !== null) {
    for (const n of alwaysOn.result) {
      ledger.skipped(n.id);
      skipped.push(
        skip(
          n.id,
          `ALWAYS-ON (minReplicas ${n.scale?.minReplicas ?? '?'}) but NOT EVALUATED — ${vacuous} ` +
            'No telemetry extractor has run, so this node is neither cleared nor flagged.',
        ),
      );
    }
    return finalizeResult({
      detector: ALWAYS_ON_UNUSED,
      graph,
      findings: [],
      population,
      skipped,
      ledger,
      requiresResolved: ['observed'],
    });
  }

  const findings: Finding[] = [];
  for (const node of alwaysOn.result) {
    // THE PREDICATE. Always-on (already true of this set) and no observed traffic.
    const observed = inbound(graph, node.id, 'observed');
    if (observed.length !== 0) {
      ledger.cleared(node.id, 'telemetry records inbound calls to it');
      continue;
    }
    ledger.finding(node.id);

    const configured = inbound(graph, node.id, 'configured');
    const est = estimateAlwaysOnMonthlyCost(node);
    let cost: CostFigure | undefined;
    let monthlyUsd: number | null = null;
    if (est.kind === 'priced') {
      cost = est.figure;
      monthlyUsd = est.figure.amountUsd;
    } else {
      skipped.push(skip(`${node.id} (cost)`, `finding emitted WITHOUT a cost figure: ${est.reason}`));
    }

    const own = ownership(graph, node.id);

    findings.push({
      id: findingId(ALWAYS_ON_UNUSED, node.id),
      detector: ALWAYS_ON_UNUSED,
      severity: severityForMonthlyUsd(monthlyUsd),
      title: `${node.displayName} is always-on with no observed traffic`,
      summary:
        `'${node.displayName}' holds ${node.scale!.minReplicas} replica(s) at all times and telemetry ` +
        `records ZERO inbound calls to it, while ${configured.length} 'configured' wire(s) do point at it. ` +
        'Reachable and unused is a different finding from unreachable, and it has a different fix: this ' +
        'one is a scaling decision, not a wiring defect.',
      subjects: [node.id],
      evidence: evidence({
        nodes: [node.id, ...configured.map((e) => e.from)],
        edges: configured,
        query: QUERY,
        notes: [
          `minReplicas=${node.scale!.minReplicas}, maxReplicas=${node.scale!.maxReplicas ?? 'unset'}` +
            `, cpu=${node.scale!.cpu ?? 'NOT MEASURED'}, memory=${node.scale!.memory ?? 'NOT MEASURED'}`,
          `inbound resolved: observed=0, configured=${configured.length}`,
          `resolved 'observed' edges graph-wide: ${resolvedEdgeCount(graph, 'observed')} — non-zero, so ` +
            'this verdict is not vacuous.',
          ...configured.map(
            (e) =>
              `  wired from ${e.evidence.artifact} ${e.evidence.symbol ?? '(no symbol)'} ` +
              `(extractor: ${e.evidence.extractor})`,
          ),
          cost ? `derived cost: ${formatCostFigure(cost)}` : 'no cost figure could be derived',
          'R7 — zero observed traffic is a statement about the telemetry window that was extracted. A ' +
            'service called once a quarter looks identical to one never called. Confirm the window before ' +
            'acting.',
        ],
      }),
      population,
      // Telemetry coverage is rarely total, and the window matters. Not `high`.
      confidence: 'medium',
      cost,
      remediation: scopedProposal(
        `Justify or scale down '${node.displayName}'`,
        `'${node.displayName}' runs ${node.scale!.minReplicas} always-on replica(s) with no recorded ` +
          `traffic${cost ? ` at an estimated ${formatCostFigure(cost)}` : ''}.\n` +
          `  1. Confirm the telemetry window covers a full usage cycle for this service.\n` +
          `  2. If it does, propose minReplicas 0 so it scales to zero between calls — Container Apps ` +
          `cold-starts it on the next request, and ${configured.length} wire(s) already point at it so ` +
          `nothing needs rewiring.\n` +
          `  3. If it cannot tolerate a cold start, record that as the reason it stays always-on, so this ` +
          `finding does not resurface every run.`,
        own,
      ),
    });
  }

  return finalizeResult({
    detector: ALWAYS_ON_UNUSED,
    graph,
    findings,
    population,
    skipped,
    ledger,
    requiresResolved: ['observed'],
  });
};
