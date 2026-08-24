/**
 * LOOM BRAIN — the detectors behind the recommendations surface.
 *
 * PRP §0: "Every detector is a GRAPH QUERY, not a bespoke rule." Every function
 * below is a call into `lib/brain/graph` plus the assembly of a `Finding`. None
 * of them walks the node list by hand, and none of them re-implements
 * reachability — that lives once, in the substrate, where P2 (a dangling edge
 * has `to: null`) makes "a dangling wire cannot count as reachability" a
 * property of the type system rather than of everyone's care.
 *
 * ── THE THREE RULES THIS FILE ENFORCES ─────────────────────────────────────
 *
 * R-A  A DETECTOR ALWAYS REPORTS ITS POPULATION. `DetectorResult` makes that
 *      structural; this file additionally reports it for the ZERO-finding case,
 *      which is the case where it matters. PRP §3.2 calls this non-negotiable
 *      because "a detector over an empty set is green and blind" has been found
 *      repeatedly in this repo.
 *
 * R-B  A DETECTOR WHOSE PROVENANCE WAS NEVER COLLECTED EMITS NOTHING, AND SAYS
 *      SO. This is the rule that does the most work, and it guards a failure
 *      `Population.blind` cannot see. `nodesWithNoInboundEdge(g, 'declared')`
 *      over a graph with zero `declared` edges returns EVERY NODE: the node set
 *      was not empty, so `blind` is false, and the output is a screenful of
 *      confident findings that are vacuously true. `declaredButNotConfigured`
 *      below is the demonstration — at runtime it always takes the vacuous
 *      branch, on purpose, and `__tests__/ui/detect.test.ts` asserts that
 *      feeding it a graph WITH declared edges makes it emit.
 *
 * R-C  NO CLEANUP PROPOSAL WITHOUT ESTABLISHED OWNERSHIP. PRP §1 decision 4:
 *      reports cover ALL subscriptions, cleanup recommendations are scoped by
 *      ownership. Findings are therefore still REPORTED for unowned resources —
 *      hiding them would be its own dishonesty — but `ownershipConfirmed:
 *      false` withholds the proposal from approval. With `owns: 0` measured
 *      estate-wide on 2026-08-23, that is currently EVERY resource, and the UI
 *      says so rather than quietly offering nothing.
 *
 * ── NOTHING HERE MUTATES AZURE ─────────────────────────────────────────────
 * Pure: graph in, findings out. Every remediation is built with `proposal()`,
 * whose `requiresHumanApproval: true` / `mutatesAzure: false` are LITERAL types
 * — there is no assignment that produces an auto-executing recommendation.
 */

import {
  alwaysOnNodes,
  danglingEdges,
  formatCostFigure,
  hasInboundOnly,
  makePopulation,
  nodesWithNoInboundEdge,
  proposal,
  scaleUnknownCount,
  type AzureResourceNode,
  type BrainGraphView,
  type DetectorResult,
  type EdgeProvenance,
  type Finding,
  type NodeId,
  type SkippedSubject,
} from '@/lib/brain/graph';
import { idleAlwaysOnCost } from './cost-model';
import type { ProvenanceCoverage, WireDetectorRun, WireFinding } from './wire';

const CONTAINER_APPS = 'Microsoft.App/containerApps';

/** A detector run plus the vacuity verdict the wire format carries. */
export interface DetectorRun {
  readonly result: DetectorResult;
  readonly vacuous: boolean;
  readonly vacuousReason?: string;
  /** Node ids whose ownership could not be established. Drives R-C. */
  readonly ownedSubjects: ReadonlySet<string>;
}

export interface DetectContext {
  readonly graph: BrainGraphView;
  readonly coverage: Readonly<Record<EdgeProvenance, ProvenanceCoverage>>;
  /** Node ids carrying a resolved `owns` edge. Empty means ownership is blind. */
  readonly owned: ReadonlySet<string>;
}

function emptyResult(
  detector: string,
  graph: BrainGraphView,
  scope: string,
  skipped: readonly SkippedSubject[] = [],
): DetectorResult {
  return {
    detector,
    findings: [],
    population: makePopulation({
      subject: 'nodes',
      nodes: graph.nodes,
      edges: graph.edges,
      scope,
    }),
    skipped,
  };
}

/**
 * R-B in one function. Returns a vacuous run when `provenance` was not
 * collected, or `null` when the detector may proceed.
 *
 * The distinction it draws is between two things that look identical in a
 * result array and mean opposite things:
 *   "I looked and found nothing"        -> a real, reportable clean result
 *   "the data I query was never loaded" -> establishes NOTHING
 */
function refuseIfUncollected(
  detector: string,
  ctx: DetectContext,
  provenance: EdgeProvenance,
): DetectorRun | null {
  const cov = ctx.coverage[provenance];
  if (cov.collected) return null;
  const reason =
    `provenance '${provenance}' was NOT COLLECTED in this snapshot, so this detector ` +
    `emits nothing. ${cov.note} A query for "no inbound '${provenance}' edge" over a graph ` +
    `containing ${cov.edgeCount} such edge(s) would be vacuously true of every node, and ` +
    'Population.blind does NOT fire on that — the node set is not empty. Reporting zero ' +
    'findings here is the honest answer; reporting every node would be a screenful of ' +
    'confident nonsense.';
  return {
    result: emptyResult(detector, ctx.graph, `SKIPPED — ${reason}`),
    vacuous: true,
    vacuousReason: reason,
    ownedSubjects: new Set(),
  };
}

// ---------------------------------------------------------------------------
// D1 — THE FOUNDING DETECTOR
// ---------------------------------------------------------------------------

/**
 * Always-on Container Apps with ZERO inbound resolved `configured` edges.
 *
 * This is the `loom-capacity-broker` shape and, more importantly, its CLASS:
 * minReplicas > 0 (so it bills every second) and nothing in the running
 * deployment points at it (so nothing can call it). PRP §2 explains why a
 * liveness check finds none of these — 0 of 63 apps are in a non-Succeeded
 * state. The waste is healthy services nobody uses, and reachability is the
 * only query that sees it.
 *
 * TWO POPULATIONS ARE REPORTED, not one:
 *   - how many apps were examined (the reachability scope), and
 *   - how many had NO scale facts at all. An unmeasured scale is NOT
 *     `minReplicas: 0`; treating it as zero would silently exonerate every app
 *     whose scale could not be read.
 */
export function unreachableAlwaysOn(ctx: DetectContext): DetectorRun {
  const detector = 'unreachable-always-on';
  const refusal = refuseIfUncollected(detector, ctx, 'configured');
  if (refusal) return refusal;

  const filter = {
    resourceType: CONTAINER_APPS,
    describe: 'Container Apps',
  } as const;

  const unreachable = nodesWithNoInboundEdge(ctx.graph, 'configured', filter);
  const alwaysOn = alwaysOnNodes(ctx.graph, filter);
  const unknownScale = scaleUnknownCount(ctx.graph, filter);

  const alwaysOnIds = new Set(alwaysOn.result.map((n) => n.id as string));
  const candidates = unreachable.result.filter(
    (n): n is AzureResourceNode => n.kind === 'azure-resource' && alwaysOnIds.has(n.id as string),
  );

  const skipped: SkippedSubject[] = [];

  // ── EXTERNAL INGRESS IS A REACHABILITY PATH THIS GRAPH CANNOT SEE ────────
  // An app with `external: true` is addressable from the public internet — by a
  // browser, Front Door, a partner, a webhook. NONE of those are edges in this
  // graph, which only observes intra-estate `configured` wires. So "zero inbound
  // configured edges" says nothing about whether an externally-ingressed app is
  // used, and reporting one as unreachable is a FALSE POSITIVE by construction.
  //
  // Found by the acceptance suite rather than by review: `loom-console` came
  // out flagged, and it is the surface the operator was reading the finding on.
  // A rule that indicts the console is a rule nobody will trust about anything
  // else.
  //
  // These are SKIPPED, not silently dropped — the population says how many and
  // why, because "not evaluated" must never look like "evaluated and clean".
  const subjects = candidates.filter((n) => n.ingress?.external !== true);
  const externallyReachable = candidates.filter((n) => n.ingress?.external === true);
  if (externallyReachable.length > 0) {
    skipped.push({
      subject: externallyReachable.map((n) => n.displayName).join(', '),
      reason:
        `${externallyReachable.length} always-on app(s) have EXTERNAL ingress, so they are ` +
        'addressable from outside this graph (browser, Front Door, partner, webhook). None of ' +
        'those callers is an edge here, so zero inbound configured edges establishes NOTHING ' +
        'about whether they are used. Not evaluated — neither cleared nor flagged.',
    });
  }
  if (unknownScale > 0) {
    skipped.push({
      subject: `${unknownScale} Container App(s)`,
      reason:
        'no scale facts were readable, so always-on could not be evaluated. NOT MEASURED — ' +
        'these are neither cleared nor flagged.',
    });
  }

  const findings: Finding[] = [];
  for (const node of subjects) {
    const why = ctx.graph.danglingEdgesIntendedFor(node.id);
    const inbound = ctx.graph.inboundEdgesByProvenance(node.id);
    const cost = idleAlwaysOnCost(node.scale, { displayName: node.displayName });

    const notes: string[] = [
      `zero inbound RESOLVED edges of provenance 'configured' (dangling edges are excluded ` +
        `by construction — their target is null, which is what keeps a broken wire from ` +
        `counting as reachability)`,
      `minReplicas=${node.scale?.minReplicas ?? 'NOT MEASURED'}` +
        (node.scale?.cpu !== undefined ? `, cpu=${node.scale.cpu}` : '') +
        (node.scale?.memory !== undefined ? `, memory=${node.scale.memory}` : '') +
        `, scale source='${node.scale?.source ?? 'none'}'`,
      node.ingress
        ? `ingress: external=${node.ingress.external}, fqdn=${node.ingress.fqdn ?? 'none'}` +
          (node.ingress.external === false && node.ingress.fqdn
            ? ' — an INTERNAL endpoint: addressable from inside the environment, and wired to nothing'
            : '')
        : 'ingress: NOT MEASURED',
      `provisioningState=${node.provisioningState ?? 'NOT MEASURED'}` +
        (node.provisioningState === 'Succeeded'
          ? ' — healthy. A liveness check clears this service; only reachability does not.'
          : ''),
      `inbound by provenance: ` +
        (Object.entries(inbound.result) as [EdgeProvenance, readonly unknown[]][])
          .map(([p, es]) => `${p}=${es.length}`)
          .join(', '),
    ];
    if (why.result.length > 0) {
      for (const d of why.result) {
        notes.push(
          `dangling ${d.provenance} wire intended for this node: ` +
            `${d.evidence.artifact}${d.evidence.line ? `:${d.evidence.line}` : ''} ` +
            `${d.evidence.symbol ?? '<no symbol>'} = ${JSON.stringify(d.evidence.rawValue ?? '')} ` +
            `(${d.danglingReason})`,
        );
      }
    } else {
      notes.push(
        'no dangling wire names this node: nothing in the collected artifacts even ATTEMPTED ' +
          'to wire it. That is a weaker evidence chain than an empty wire, not a stronger one.',
      );
    }
    if (cost.kind === 'unknown') notes.push(`cost NOT DERIVED: ${cost.reason}`);

    const ownershipConfirmed = ctx.owned.has(node.id as string);

    findings.push({
      id: `${detector}:${node.id}`,
      detector,
      severity: 'high',
      title: `${node.displayName} is always-on and unreachable`,
      summary:
        `'${node.displayName}' runs ${node.scale?.minReplicas ?? '?'} always-on replica(s) and is ` +
        `${node.provisioningState === 'Succeeded' ? 'healthy' : `in state '${node.provisioningState ?? 'unknown'}'`}, ` +
        `but NOTHING in the live deployment points at it: zero inbound resolved 'configured' ` +
        `edges across ${unreachable.population.examined} Container App(s) examined. ` +
        (why.result.length > 0
          ? `${why.result.length} wire(s) were MEANT to reach it and resolve to nothing.`
          : 'No wire in the collected artifacts names it at all.') +
        (ownershipConfirmed
          ? ''
          : ' Ownership is NOT established for this resource, so no remediation is offered for approval.'),
      subjects: [node.id],
      evidence: {
        nodes: [node.id],
        edges: why.result.map((d) => d.id),
        query: `nodesWithNoInboundEdge(graph, 'configured', { resourceType: '${CONTAINER_APPS}' }) INTERSECT alwaysOnNodes(graph, same filter)`,
        notes,
      },
      population: unreachable.population,
      // 'medium', never 'high': `observed` is not collected, so this establishes
      // "nothing in the live CONFIG points at it", not "nothing calls it". A
      // caller reaching it by a hardcoded FQDN would be invisible here.
      confidence: 'medium',
      ...(cost.kind === 'derived' ? { cost: cost.figure } : {}),
      remediation: proposal(
        ownershipConfirmed
          ? `Scale '${node.displayName}' to minReplicas 0, or wire its consumer.`
          : `REPORT ONLY — ownership of '${node.displayName}' is not established.`,
        buildRemediationText(node, why.result.length > 0, ownershipConfirmed),
      ),
    });
  }

  return {
    result: {
      detector,
      findings,
      population: {
        ...unreachable.population,
        scope:
          `${unreachable.population.scope}; intersected with alwaysOnNodes over the same filter ` +
          `(${alwaysOn.result.length} always-on, ${unknownScale} with NO scale facts — NOT MEASURED, ` +
          'not counted as minReplicas 0)',
      },
      skipped,
    },
    vacuous: false,
    ownedSubjects: ctx.owned,
  };
}

function buildRemediationText(
  node: AzureResourceNode,
  hasDanglingWire: boolean,
  ownershipConfirmed: boolean,
): string {
  const lines: string[] = [];
  if (!ownershipConfirmed) {
    lines.push(
      '# WITHHELD — ownership not established.',
      '#',
      "# This resource carries no 'loom-estate-id' tag, so the Brain cannot prove it belongs",
      '# to this Loom estate. Of the Container App environments visible across these',
      '# subscriptions, most are NOT Loom\'s, so a cleanup scoped by a guessed owner can',
      '# reach someone else\'s production. The finding is reported; the change is not',
      '# offered. Stamp the ownership tag in the deploy and this becomes actionable.',
      '',
      '# For reference, the change that WOULD be proposed:',
    );
  }
  lines.push(
    '# Two options. Pick based on whether this service is meant to be used.',
    '',
    '# (A) The service IS wanted — the wire is what is broken. Fix the wire, not the',
    '#     replica count. Set the consumer env var to the service FQDN in bicep so the',
    "#     value is PRODUCED BY THE DEPLOY (auto-bind-by-default.md §5), e.g.:",
    "#       { name: '<CONSUMER_ENV_VAR>', value: 'https://${<module>!.outputs.fqdn}' }",
    hasDanglingWire
      ? '#     A wire already exists and resolves to nothing — see the evidence chain above'
      : '#     No wire names this service at all — one has to be added',
    '',
    '# (B) The service is NOT wanted — stop paying for idle replicas. This is a scale',
    '#     change, applied by a human, from the bicep module that owns the app:',
    '#       scale: { minReplicas: 0, maxReplicas: <unchanged> }',
    `#     Current: minReplicas=${node.scale?.minReplicas ?? '?'}, maxReplicas=${node.scale?.maxReplicas ?? '?'}`,
    '',
    '# NOTE: scale-to-zero adds cold-start latency on first call. If this service sits on',
    '#       a hot path, (A) is the correct fix and (B) trades a cost problem for a',
    '#       latency one.',
    '',
    '# The Brain does not apply either. Both are edits a human makes in the repo.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// D2 — the empty-wire inventory
// ---------------------------------------------------------------------------

/**
 * Wires that EXIST and carry `''` — the `LOOM_BROKER_URL: ''` class, estate-wide.
 *
 * Reported separately from D1 because they are a different fact with a
 * different fix. D1 says "this service is unreachable"; D2 says "this specific
 * line tried to connect something and shipped an empty string". A service can
 * be unreachable with no empty wire (nothing ever tried), and an empty wire can
 * exist pointing at a service that other things DO reach.
 */
export function danglingEmptyWires(ctx: DetectContext): DetectorRun {
  const detector = 'dangling-empty-wire';
  const refusal = refuseIfUncollected(detector, ctx, 'configured');
  if (refusal) return refusal;

  const empties = danglingEdges(ctx.graph, 'empty-value');
  const findings: Finding[] = [];

  for (const edge of empties.result) {
    const fromNode = ctx.graph.node(edge.from);
    const target = edge.intendedTo ? ctx.graph.node(edge.intendedTo) : undefined;
    const subjects: NodeId[] = edge.intendedTo ? [edge.intendedTo] : [edge.from];
    const ownershipConfirmed = subjects.every((s) => ctx.owned.has(s as string));

    findings.push({
      id: `${detector}:${edge.id}`,
      detector,
      severity: target ? 'medium' : 'low',
      title: `${edge.evidence.symbol ?? 'a wire'} is set to an empty string`,
      summary:
        `${fromNode?.displayName ?? edge.from} carries ` +
        `${edge.evidence.symbol ?? 'an env var'} = '' (${edge.provenance}). ` +
        (target
          ? `It was meant to reach '${target.displayName}', which therefore gains NO inbound ` +
            'edge from it.'
          : 'The intended target could NOT be established — an empty value names nothing, and ' +
            'no binding row covers this variable. The wire is known to be broken; who it was ' +
            'for is not.'),
      subjects,
      evidence: {
        nodes: subjects,
        edges: [edge.id],
        query: "danglingEdges(graph, 'empty-value')",
        notes: [
          `artifact: ${edge.evidence.artifact}${edge.evidence.line ? `:${edge.evidence.line}` : ''}`,
          `symbol: ${edge.evidence.symbol ?? '<none>'}`,
          `raw value: ${JSON.stringify(edge.evidence.rawValue ?? '')}`,
          `extractor: ${edge.evidence.extractor}`,
          'this edge has `to: null`, so it does NOT make its intended target reachable — that ' +
            'exclusion is the point, and the edge is retained only so the evidence survives',
        ],
      },
      population: empties.population,
      confidence: 'high',
      remediation: proposal(
        target
          ? `Wire ${edge.evidence.symbol ?? 'the variable'} to '${target.displayName}'.`
          : `Establish what ${edge.evidence.symbol ?? 'this variable'} was meant to reach, or remove it.`,
        [
          `# ${edge.evidence.artifact}${edge.evidence.line ? `:${edge.evidence.line}` : ''}`,
          `# currently: { name: '${edge.evidence.symbol ?? '?'}', value: '' }`,
          '',
          target
            ? `# The value must be PRODUCED BY THE DEPLOY, not asked of the operator` +
              ` (auto-bind-by-default.md §5):` +
              `\n#   { name: '${edge.evidence.symbol ?? '?'}', value: 'https://\${<module>!.outputs.fqdn}' }` +
              `\n# where <module> is the bicep module deploying '${target.displayName}'.`
            : '# Either wire it to its real target or DELETE the line. An env var permanently set' +
              "\n# to '' is a wire that will keep looking like an attempt nobody finished.",
          '',
          ownershipConfirmed
            ? '# This is a repository edit. Nothing in the Brain applies it.'
            : '# Ownership of the affected resource is not established; reported for visibility only.',
        ].join('\n'),
      ),
    });
  }

  return {
    result: { detector, findings, population: empties.population, skipped: [] },
    vacuous: false,
    ownedSubjects: ctx.owned,
  };
}

// ---------------------------------------------------------------------------
// D3 / D4 — the two detectors that MUST decline at runtime
// ---------------------------------------------------------------------------

/**
 * Wired in the template, DEAD in the deployment: inbound `declared`, no inbound
 * `configured`.
 *
 * AT RUNTIME THIS ALWAYS DECLINES, and that is the feature. The console image
 * has no bicep, so `declared` is never collected, so this query would return
 * every node in the graph. `refuseIfUncollected` stops it at the door and the
 * UI renders the gap. `__tests__/ui/detect.test.ts` feeds it a graph that DOES
 * carry declared edges and asserts it emits — otherwise "declines" and "broken"
 * would be indistinguishable.
 */
export function declaredButNotConfigured(ctx: DetectContext): DetectorRun {
  const detector = 'declared-not-configured';
  const refusal = refuseIfUncollected(detector, ctx, 'declared');
  if (refusal) return refusal;

  const hits = hasInboundOnly(ctx.graph, 'declared', 'configured', {
    resourceType: CONTAINER_APPS,
    describe: 'Container Apps',
  });

  const findings: Finding[] = hits.result.map((node) => ({
    id: `${detector}:${node.id}`,
    detector,
    severity: 'high' as const,
    title: `${node.displayName} is wired in the template but not in the deployment`,
    summary:
      `'${node.displayName}' has at least one inbound 'declared' edge (a bicep template wires ` +
      "it) and ZERO inbound 'configured' edges (the running deployment does not). The template " +
      'and the estate disagree about this service.',
    subjects: [node.id],
    evidence: {
      nodes: [node.id],
      edges: ctx.graph.inboundEdges(node.id, 'declared').result.map((e) => e.id),
      query: "hasInboundOnly(graph, 'declared', 'configured', { resourceType: 'Microsoft.App/containerApps' })",
      notes: [
        'declared without configured = wired in the template, dead in the deployment.',
        'This is a DIFFERENT finding from "unreachable" with a different fix: the template ' +
          'already says what should connect, so the question is why the deploy did not apply it.',
      ],
    },
    population: hits.population,
    confidence: 'high' as const,
    remediation: proposal(
      `Reconcile '${node.displayName}': the template wires it, the deployment does not.`,
      '# Compare the bicep module output against the running app\'s env, and re-run the\n' +
        '# deploy path that should have applied it. Per deploy-integrity.md R2, a merge that\n' +
        '# was never deployed is inert — this finding is one of the shapes that produces.',
    ),
  }));

  return {
    result: { detector, findings, population: hits.population, skipped: [] },
    vacuous: false,
    ownedSubjects: ctx.owned,
  };
}

/**
 * Reachable and UNUSED: inbound `configured`, no inbound `observed`.
 *
 * Also always declines at runtime — there is no telemetry extractor yet, so
 * `observed` is 0 and this query would indict every reachable service in the
 * estate. It is present rather than omitted so the surface names the capability
 * it does not yet have, instead of quietly not having it.
 */
export function reachableButUnobserved(ctx: DetectContext): DetectorRun {
  const detector = 'reachable-not-observed';
  const refusal = refuseIfUncollected(detector, ctx, 'observed');
  if (refusal) return refusal;

  const hits = hasInboundOnly(ctx.graph, 'configured', 'observed', {
    resourceType: CONTAINER_APPS,
    describe: 'Container Apps',
  });

  const findings: Finding[] = hits.result.map((node) => ({
    id: `${detector}:${node.id}`,
    detector,
    severity: 'medium' as const,
    title: `${node.displayName} is reachable but no traffic was observed`,
    summary:
      `'${node.displayName}' has inbound 'configured' edges but zero 'observed' traffic edges ` +
      'over the telemetry window.',
    subjects: [node.id],
    evidence: {
      nodes: [node.id],
      edges: ctx.graph.inboundEdges(node.id, 'configured').result.map((e) => e.id),
      query: "hasInboundOnly(graph, 'configured', 'observed', { resourceType: 'Microsoft.App/containerApps' })",
      notes: ['configured without observed = reachable and unused.'],
    },
    population: hits.population,
    confidence: 'medium' as const,
    remediation: proposal(
      `Confirm whether '${node.displayName}' is still needed.`,
      '# Reachable-and-unused is a weaker signal than unreachable: a low-frequency consumer\n' +
        '# looks identical to none over a short window. Widen the window before acting.',
    ),
  }));

  return {
    result: { detector, findings, population: hits.population, skipped: [] },
    vacuous: false,
    ownedSubjects: ctx.owned,
  };
}

// ---------------------------------------------------------------------------
// The registry + wire projection
// ---------------------------------------------------------------------------

export const DETECTORS: readonly ((ctx: DetectContext) => DetectorRun)[] = [
  unreachableAlwaysOn,
  danglingEmptyWires,
  declaredButNotConfigured,
  reachableButUnobserved,
];

export interface DetectionOutput {
  readonly findings: readonly WireFinding[];
  readonly runs: readonly WireDetectorRun[];
}

/**
 * Run every detector and project the results onto the wire.
 *
 * Findings are ordered by DERIVED SAVING, descending, with uncosted findings
 * after costed ones. Ranking by dollars is what the operator asked for; ranking
 * an UNKNOWN cost as zero would push "we could not price this" to the bottom as
 * if it were free, so uncosted findings keep their severity order instead.
 */
export function runDetectors(ctx: DetectContext): DetectionOutput {
  const findings: WireFinding[] = [];
  const runs: WireDetectorRun[] = [];

  for (const detector of DETECTORS) {
    const run = detector(ctx);
    runs.push({
      detector: run.result.detector,
      findingCount: run.result.findings.length,
      population: run.result.population,
      skipped: run.result.skipped,
      vacuous: run.vacuous,
      ...(run.vacuousReason ? { vacuousReason: run.vacuousReason } : {}),
    });

    for (const f of run.result.findings) {
      const ownershipConfirmed =
        f.subjects.length > 0 && f.subjects.every((s) => ctx.owned.has(s as string));
      findings.push({
        id: f.id,
        detector: f.detector,
        severity: f.severity,
        title: f.title,
        summary: f.summary,
        subjects: f.subjects as readonly string[],
        confidence: f.confidence,
        ...(f.cost ? { cost: f.cost, costLabel: formatCostFigure(f.cost) } : {}),
        remediation: f.remediation,
        population: f.population,
        evidence: {
          nodes: f.evidence.nodes as readonly string[],
          edges: f.evidence.edges as readonly string[],
          query: f.evidence.query,
          notes: f.evidence.notes,
        },
        ownershipConfirmed,
      });
    }
  }

  const severityRank: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  const sorted = [...findings].sort((a, b) => {
    const av = a.cost?.amountUsd;
    const bv = b.cost?.amountUsd;
    if (av !== undefined && bv !== undefined) return bv - av;
    // A finding with no cost is NOT $0 — it is unpriced. Keep it after priced
    // ones rather than sorting it to the bottom as though it were free.
    if (av !== undefined) return -1;
    if (bv !== undefined) return 1;
    return (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9);
  });

  return { findings: sorted, runs };
}
