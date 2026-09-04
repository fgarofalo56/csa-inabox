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
  nodesNotReachableFrom,
  proposal,
  scaleUnknownCount,
  type AzureResourceNode,
  type BrainGraphView,
  type BrainNode,
  type DetectorResult,
  type EdgeProvenance,
  type Finding,
  type NodeId,
  type SkippedSubject,
} from '@/lib/brain/graph';
import { idleAlwaysOnCost } from './cost-model';
import {
  refuseScaleToZero,
  scaleToZeroRefusalReason,
} from '@/lib/brain-actions/scalability';
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
  /**
   * #4257 — why this subject's always-on floor is DECLARED, or null.
   *
   * Injected so the detector stays testable, and DEFAULTED to the real
   * derivation ({@link declaredAlwaysOnReason}) so the production path gets it
   * without any caller having to remember. An earlier revision of #4261 added
   * the by-design branch with no default and no production caller, which shipped
   * the whole thing dark — the review measured `loom-risingwave` still carrying
   * `severity: high` and a live cost figure on the operator's savings list.
   */
  readonly nonScalableSubject?: (displayName: string) => AlwaysOnVerdict | null;
}

/**
 * WHY a subject's always-on floor is declared, and WHICH claim that is.
 *
 * The kind travels with the prose because the finding's wording depends on it —
 * see {@link declaredAlwaysOnReason} and the round-2 review of #4261, B2.
 */
export interface AlwaysOnVerdict {
  readonly kind: 'pinned-singleton' | 'declared-consumer' | 'self';
  readonly reason: string;
}

/**
 * The real by-design predicate: the deploy's own declaration for this app.
 *
 * ── WHY `declaration-unavailable` IS DELIBERATELY NOT A DOWNGRADE ──────────
 * `refuseScaleToZero` fails CLOSED when the compiled template cannot be read,
 * so it refuses EVERY subject in that state. That is right for the WRITE path
 * (`guardScalableToZero`, the executor) — refusing to act on an unestablished
 * fact is the whole point of #4261 finding 1.
 *
 * It is wrong HERE. This is the READ path. An unreadable template establishes
 * nothing about this resource, so claiming "always-on BY DESIGN" over it would
 * assert exactly what was not established — the R7 error, pointed the other way.
 * The finding stays costed and truthful; the perform path refuses it separately,
 * which is where fail-closed belongs.
 *
 * ── THE KIND TRAVELS WITH THE PROSE (round-2 review of #4261, B2) ───────────
 * This returns non-null for THREE different claims, and the finding that quotes
 * it used to be worded as if only `pinned-singleton` could reach it — so
 * `loom-duckdb` got a finding TITLED "is always-on BY DESIGN and nothing wires
 * to it" carrying a BODY that said the deploy wires a consumer to it. MEASURED:
 * 13 of the 19 keyed apps refuse via `declared-consumer` and 1 via `self`, so
 * the self-contradiction was the majority of what the detector emitted, not an
 * edge case. It is the same R7 error this module invokes to justify NOT
 * downgrading `declaration-unavailable`, applied to one arm and not the others.
 */
export function declaredAlwaysOnReason(displayName: string): AlwaysOnVerdict | null {
  const refusal = refuseScaleToZero(displayName);
  if (refusal === null || refusal.kind === 'declaration-unavailable') return null;
  return { kind: refusal.kind, reason: scaleToZeroRefusalReason(refusal) };
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

  // ── REACHABILITY, NOT INBOUND-EDGE COUNT (#4258) ─────────────────────────
  //
  // This used to be `nodesWithNoInboundEdge(graph, 'configured', filter)`, which
  // answers a LOCAL question: does anything point at this node? The finding this
  // detector exists to make is the GLOBAL one — can anything OUTSIDE reach it —
  // and the two come apart on a mutually-referencing island. Two internal
  // always-on apps whose env vars name each other each have an inbound
  // `configured` edge, so the local query CLEARS both, while nothing outside
  // them can call either. That is waste billing every second and the old shape
  // could not see it.
  //
  // The roots are the entry points this graph cannot see through, so a walk
  // from them is the honest boundary of what `configured` edges can establish:
  //   - EXTERNAL INGRESS. Addressable from the internet — a browser, Front Door,
  //     a partner, a webhook. None of those is an edge here.
  //   - ANY NON-CONTAINER-APP NODE. The estate holds Function Apps, Logic Apps,
  //     Data Factories, deploy artifacts and code modules whose outbound calls
  //     no extractor models. Treating them as roots is the conservative
  //     direction: it can only CLEAR a node, never flag one, and this
  //     detector's output is a deletion proposal.
  const roots = {
    where: (n: BrainNode) =>
      n.kind !== 'azure-resource' ||
      n.ingress?.external === true ||
      n.resourceType.toLowerCase() !== CONTAINER_APPS.toLowerCase(),
    describe:
      'nodes with EXTERNAL ingress, plus every non-Container-App node — the callers this graph ' +
      'cannot see through',
  } as const;
  const unreachable = nodesNotReachableFrom(ctx.graph, roots, 'configured', filter);
  const alwaysOn = alwaysOnNodes(ctx.graph, filter);
  const unknownScale = scaleUnknownCount(ctx.graph, filter);

  const alwaysOnIds = new Set(alwaysOn.result.map((n) => n.id as string));
  const subjects = unreachable.result.filter(
    (n): n is AzureResourceNode => n.kind === 'azure-resource' && alwaysOnIds.has(n.id as string),
  );

  const skipped: SkippedSubject[] = [];

  // ── EXTERNAL INGRESS IS A REACHABILITY PATH THIS GRAPH CANNOT SEE ────────
  // An app with `external: true` is addressable from the public internet — by a
  // browser, Front Door, a partner, a webhook. NONE of those are edges in this
  // graph, which only observes intra-estate `configured` wires. So no query over
  // those wires says anything about whether an externally-ingressed app is used,
  // and reporting one as unreachable is a FALSE POSITIVE by construction.
  //
  // Found by the acceptance suite rather than by review: `loom-console` came
  // out flagged, and it is the surface the operator was reading the finding on.
  // A rule that indicts the console is a rule nobody will trust about anything
  // else.
  //
  // They are now ROOTS of the walk rather than a post-filter on its output
  // (#4258), which is strictly stronger: an app they reach is cleared too. The
  // disclosure is therefore computed from the ALWAYS-ON set rather than from the
  // walk's leftovers — the walk no longer returns them, and a skip list derived
  // from it would silently empty. "Not evaluated" must never look like
  // "evaluated and clean".
  const externallyReachable = alwaysOn.result.filter((n) => n.ingress?.external === true);
  if (externallyReachable.length > 0) {
    skipped.push({
      subject: externallyReachable.map((n) => n.displayName).join(', '),
      reason:
        `${externallyReachable.length} always-on app(s) have EXTERNAL ingress, so they are ` +
        'addressable from outside this graph (browser, Front Door, partner, webhook). None of ' +
        'those callers is an edge here, so no configured-edge query establishes ANYTHING ' +
        'about whether they are used. They are entry points for the reachability walk, so a ' +
        'node they reach is CLEARED — but they themselves are not evaluated, neither cleared ' +
        'nor flagged.',
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
  const byDesignOf = ctx.nonScalableSubject ?? declaredAlwaysOnReason;
  for (const node of subjects) {
    const why = ctx.graph.danglingEdgesIntendedFor(node.id);
    const inbound = ctx.graph.inboundEdgesByProvenance(node.id);
    const cost = idleAlwaysOnCost(node.scale, { displayName: node.displayName });

    // ── #4257 item 2 — ALWAYS-ON BY DESIGN. Reported, never priced. ────────
    //
    // The subject IS always-on and IS unwired, so the finding stands. What must
    // not stand is the COST recommendation: this floor is what the deploy
    // declared, and "scale it to zero" against a runtime that holds state in one
    // process is unrecoverable loss dressed up as a saving. `loom-risingwave`
    // was the highest-value row on the live list for exactly this reason.
    //
    // `severity: 'info'` and NO `cost` key — a finding with no cost figure
    // cannot rank as a saving, which is the observable outcome #4257 asks for.
    const byDesign = byDesignOf(node.displayName);
    if (byDesign !== null) {
      // ── THE WORDING FOLLOWS THE CLAIM (round-2 review of #4261, B2) ──────
      // Only `pinned-singleton` establishes "always-on BY DESIGN". The other two
      // arms establish something else entirely, and a title that asserts the
      // deploy declares a floor — or that nothing wires to the service — over a
      // `declared-consumer` verdict contradicts the body it carries.
      const consumerCount = byDesign.reason.match(/wires (\d+) consumer\(s\)/)?.[1];
      const wording = {
        'pinned-singleton': {
          title: `${node.displayName} is always-on BY DESIGN and nothing wires to it`,
          claim:
            'its always-on floor is DECLARED by the deploy, so this is an OBSERVATION, not a ' +
            'cost recommendation.',
          note:
            'ALWAYS-ON BY DESIGN — the deploy declares this replica floor, so removing it is a ' +
            'template change, not an estate cleanup.',
          action: `NO ACTION — '${node.displayName}' is always-on by design.`,
          headline: `'${node.displayName}' is declared non-scalable by the deploy.`,
        },
        'declared-consumer': {
          title:
            `${node.displayName} looks unwired in the graph, but the DEPLOY wires ` +
            `${consumerCount ?? 'at least one'} consumer(s) to it`,
          claim:
            "the deployment template itself names a consumer of this service, so the finding's " +
            'central claim — that nothing points at it — is contradicted at its source. The ' +
            'missing edge is a graph gap, not an idle service.',
          note:
            'NOT "by design": this is an AVAILABILITY refusal. The deploy declares a consumer, ' +
            'so the zero-inbound-edge measurement is contradicted by the template.',
          action: `NO ACTION — the deploy wires ${consumerCount ?? 'a'} consumer(s) to '${node.displayName}'.`,
          headline: `'${node.displayName}' has a consumer the deploy declares.`,
        },
        self: {
          title: `${node.displayName} is THIS CONSOLE — it cannot be scaled to zero from here`,
          claim:
            'this is the console serving the page the recommendation is read from, and it is ' +
            'reached by EXTERNAL ingress, which is not an edge in this graph — so zero inbound ' +
            'edges establishes nothing about whether it is used.',
          note:
            'NOT "by design": this is the console itself. Its replica floor was not read from ' +
            'the deploy template at all.',
          action: `NO ACTION — '${node.displayName}' is this console.`,
          headline: `'${node.displayName}' is the console this page is served from.`,
        },
      }[byDesign.kind];

      skipped.push({
        subject: `${node.displayName} (cost)`,
        reason:
          'finding emitted WITHOUT a cost figure ON PURPOSE: scaling this resource to zero is ' +
          `refused by the deploy-declared guard, so it is not a saving to propose. ${byDesign.reason}`,
      });
      findings.push({
        id: `${detector}:${node.id}`,
        detector,
        severity: 'info',
        title: wording.title,
        summary:
          `'${node.displayName}' runs ${node.scale?.minReplicas ?? '?'} always-on replica(s) and the ` +
          "graph resolves ZERO inbound 'configured' edges for it — but " +
          `${wording.claim} ` +
          byDesign.reason,
        subjects: [node.id],
        evidence: {
          nodes: [node.id],
          edges: [],
          query: `refuseScaleToZero('${node.displayName}') over the compiled deploy template`,
          notes: [
            `minReplicas=${node.scale?.minReplicas ?? 'NOT MEASURED'}, maxReplicas=${node.scale?.maxReplicas ?? 'NOT MEASURED'}`,
            wording.note,
            byDesign.reason,
            'NO cost figure is attached, deliberately: pricing a refused, destructive change ' +
              "would rank it at the top of the operator's savings list. That is exactly what " +
              '#4257 reports having happened.',
          ],
        },
        population: unreachable.population,
        confidence: 'high',
        remediation: proposal(
          wording.action,
          `# ${wording.headline}\n` +
            `# ${byDesign.reason}\n` +
            '#\n' +
            '# Do NOT scale it to zero. If the floor is genuinely wrong, the change belongs in\n' +
            '# the bicep module that declares it — an out-of-band ARM write would be reverted by\n' +
            '# the next deploy anyway (deploy-integrity.md R2 — drift, not a fix).\n',
        ),
      });
      continue;
    }

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
        query: `nodesNotReachableFrom(graph, roots={external ingress OR non-'${CONTAINER_APPS}'}, 'configured', { resourceType: '${CONTAINER_APPS}' }) INTERSECT alwaysOnNodes(graph, same filter)`,
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
