/**
 * LOOM BRAIN — detector: DANGLING WIRE.
 *
 * An edge that EXISTS in an artifact and points nowhere: its value is `''`
 * (`empty-value`) or it names an ARM resource that is not in the graph
 * (`missing-resource`). PRP §0: "edge whose target resolves to `''` or a missing
 * resource".
 *
 * ── THIS IS THE RECEIPT HALF OF THE FOUNDING FINDING ───────────────────────
 * `unreachable-service` says the broker has no inbound edge. THIS says
 * `admin-plane/main.bicep:4730` tried to wire it and emitted `''`. Delete this
 * detector and the verdict survives while the remediation evaporates — an
 * operator would be told a service is unreachable with no file, no line, and no
 * idea what to change.
 *
 * ── SCOPE: `unresolved-target` IS DELIBERATELY EXCLUDED ────────────────────
 * The third {@link DanglingReason} is `unresolved-target` — a non-empty value
 * nothing in the graph matches. Measured on the real graph 2026-08-23: 1,504 of
 * the 1,741 dangling edges are that, and they are dominated by bare-specifier
 * imports (`react`, `node:fs`) that the source-imports extractor honestly
 * recorded as unresolvable rather than guessing. Reporting them as defects would
 * bury the 237 that are real under a 6:1 noise ratio.
 *
 * So they are EXCLUDED — and the exclusion is reported as a skip carrying the
 * count, because an omission the operator cannot see is indistinguishable from a
 * detector that never looked.
 *
 * ── GROUPING: ONE FINDING PER (SOURCE NODE, REASON) ────────────────────────
 * Per-edge findings would produce 222 entries for `empty-value` alone. The
 * remediation, though, is per-app: "these N env vars on this app are empty".
 * So edges are grouped by their `from` node and reason, and EVERY edge id lands
 * in the evidence chain with its artifact, line, symbol and raw value — the
 * grouping compresses the presentation, never the receipt.
 */

import {
  type BrainGraphView,
  type DanglingEdge,
  type DanglingReason,
  type Detector,
  type DetectorResult,
  type Finding,
  type FindingSeverity,
  type NodeId,
  type SkippedSubject,
} from '../graph';
import {
  bySeverity,
  edgeDetectorPopulation,
  evidence,
  findingId,
  ownership,
  scopedProposal,
  skip,
} from './detector-kit';

export const DANGLING_WIRE = 'dangling-wire';

/**
 * The reasons this detector reports. `unresolved-target` is absent on purpose —
 * see the module header.
 */
export const REPORTED_REASONS: readonly DanglingReason[] = ['empty-value', 'missing-resource'];

const QUERY = "danglingEdges(graph, 'empty-value') UNION danglingEdges(graph, 'missing-resource')";

/**
 * `empty-value` is worse than `missing-resource`: an empty wire is a template or
 * deployment that silently produced nothing, whereas a missing resource at least
 * names what it wanted and may simply be out of the graph's scope.
 */
function severityFor(reason: DanglingReason): FindingSeverity {
  return reason === 'empty-value' ? 'high' : 'medium';
}

export const danglingWire: Detector = (graph: BrainGraphView): DetectorResult => {
  const skipped: SkippedSubject[] = [];

  const all = graph.edges.filter((e): e is DanglingEdge => e.resolution === 'dangling');
  // THE PREDICATE. Only the two reasons that name a real defect.
  const reported = all.filter((e) => REPORTED_REASONS.includes(e.danglingReason));

  const excluded = all.length - reported.length;
  if (excluded > 0) {
    skipped.push(
      skip(
        `${excluded} dangling edge(s) with reason 'unresolved-target'`,
        "EXCLUDED BY SCOPE, not unexamined: an 'unresolved-target' edge has a non-empty value that " +
          'nothing in the graph matches, which is overwhelmingly a bare module specifier the ' +
          'source-imports extractor declined to guess at. They are visible via ' +
          "danglingEdges(graph, 'unresolved-target').",
      ),
    );
  }

  // The subject here is EDGES: this detector ranges over wires, not nodes. A
  // graph with zero dangling edges makes `blind` true, which is the honest
  // signal that there was nothing to examine.
  const population = edgeDetectorPopulation(
    graph,
    reported,
    `${all.length} dangling edge(s) of ${graph.edges.length} total in graph; ` +
      `${reported.length} in scope (reasons: ${REPORTED_REASONS.join(', ')}); ` +
      `${excluded} excluded as 'unresolved-target'. ` +
      `Breakdown in scope: ` +
      REPORTED_REASONS.map((r) => `${r}=${reported.filter((e) => e.danglingReason === r).length}`).join(', '),
  );

  // Group by (source node, reason). The remediation is per-app; the receipt stays per-edge.
  const groups = new Map<string, DanglingEdge[]>();
  for (const e of reported) {
    const key = `${e.from}|${e.danglingReason}`;
    const g = groups.get(key);
    if (g) g.push(e);
    else groups.set(key, [e]);
  }

  const findings: Finding[] = [];
  for (const [key, edges] of groups) {
    const first = edges[0]!;
    const reason = first.danglingReason;
    const from = first.from;
    const fromNode = graph.node(from);

    // An edge whose SOURCE node is not in the graph is a graph-integrity defect,
    // already recorded in report.danglingNodeRefs. Say so rather than rendering
    // an undefined display name.
    const fromLabel = fromNode?.displayName ?? `${from} (SOURCE NODE NOT IN GRAPH)`;
    if (!fromNode) {
      skipped.push(
        skip(
          from,
          'this edge\'s source node is not present in the graph (see report.danglingNodeRefs). The ' +
            'finding is still emitted, but its subject cannot be resolved to a node.',
        ),
      );
    }

    const intended = edges
      .map((e) => e.intendedTo)
      .filter((n): n is NodeId => n !== null);
    const uniqueIntended = [...new Set(intended)];

    const notes: string[] = [
      `${edges.length} wire(s) from '${fromLabel}' with reason '${reason}':`,
      ...edges.map(
        (e) =>
          `  [${e.provenance}] ${e.evidence.artifact}` +
          (e.evidence.line !== undefined ? `:${e.evidence.line}` : '') +
          ` ${e.evidence.symbol ?? '(no symbol)'} = ${JSON.stringify(e.evidence.rawValue ?? '')}` +
          ` (extractor: ${e.evidence.extractor})` +
          (e.intendedTo ? ` -> intended for ${e.intendedTo}` : ' -> intended target NOT ESTABLISHED'),
      ),
    ];

    if (uniqueIntended.length === 0) {
      notes.push(
        'No wire in this group names its intended target. An empty value destroys the evidence of its ' +
          'own intent, and the extractor was not given an envVarBindings entry for it — so the graph ' +
          'records the wire without being able to say what it was for. That is a gap in the extraction ' +
          'input, not proof the wire is pointless.',
      );
    } else {
      for (const t of uniqueIntended) {
        const target = graph.node(t);
        notes.push(`  intended target: ${target?.displayName ?? t} (${t})`);
      }
    }

    const own = ownership(graph, from);
    const proposedChange =
      reason === 'empty-value'
        ? `Give each wire below a real value, or delete the entry so the graph stops recording an ` +
          `intent that the deployment does not honour:\n` +
          edges
            .map(
              (e) =>
                `  - ${e.evidence.artifact}` +
                (e.evidence.line !== undefined ? `:${e.evidence.line}` : '') +
                `  ${e.evidence.symbol ?? '(no symbol)'}` +
                (e.intendedTo
                  ? `  -> should resolve to ${graph.node(e.intendedTo)?.displayName ?? e.intendedTo}`
                  : '  -> intended target unknown; establish it before changing the value'),
            )
            .join('\n')
        : `Each wire below names an ARM resource id that is NOT in the graph. Either the resource was ` +
          `deleted, or discovery did not cover its subscription. Confirm which before changing anything ` +
          `— a wire pointing at a resource this scan did not see is not the same as a wire pointing at ` +
          `a resource that does not exist:\n` +
          edges
            .map(
              (e) =>
                `  - ${e.evidence.artifact}` +
                (e.evidence.line !== undefined ? `:${e.evidence.line}` : '') +
                `  ${e.evidence.symbol ?? '(no symbol)'} = ${JSON.stringify(e.evidence.rawValue ?? '')}`,
            )
            .join('\n');

    findings.push({
      id: findingId(DANGLING_WIRE, key),
      detector: DANGLING_WIRE,
      severity: severityFor(reason),
      title:
        reason === 'empty-value'
          ? `${edges.length} wire(s) on '${fromLabel}' exist and carry an empty value`
          : `${edges.length} wire(s) on '${fromLabel}' name a resource that is not in the graph`,
      summary:
        `'${fromLabel}' has ${edges.length} edge(s) that exist in their source artifact and resolve to ` +
        `nothing (${reason}). A dangling edge does NOT make its target reachable — its \`to\` is null by ` +
        `construction — so anything relying on these wires is unwired` +
        (uniqueIntended.length ? `, including ${uniqueIntended.length} named target(s).` : '.'),
      subjects: [from, ...uniqueIntended],
      evidence: evidence({
        nodes: [from, ...uniqueIntended],
        edges,
        query: `${QUERY} — grouped by (from='${from}', reason='${reason}')`,
        notes,
      }),
      population,
      // The wire's existence and its value are both read directly off the
      // artifact. There is nothing inferred in the verdict itself.
      confidence: 'high',
      remediation: scopedProposal(
        `Resolve ${edges.length} dangling wire(s) on '${fromLabel}'`,
        proposedChange,
        own,
      ),
    });
  }

  return {
    detector: DANGLING_WIRE,
    findings: [...findings].sort(bySeverity),
    population,
    skipped,
  };
};
