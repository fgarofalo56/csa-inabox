/**
 * LOOM BRAIN — detector: UNREACHABLE SERVICE.
 *
 * An always-on resource (`scale.minReplicas > 0`) with ZERO inbound `configured`
 * edges. It is billing continuously and the running deployment wires nothing to
 * it.
 *
 * ── THIS DETECTOR IS THE ACCEPTANCE TEST (PRP §5) ──────────────────────────
 * `loom-capacity-broker` runs `minReplicas: 2` at 0.5 vCPU + 1 GiB per replica,
 * is `Succeeded`, answers its liveness and readiness probes, and has an internal
 * ingress FQDN. And the only name any bicep emits for its URL is
 * `admin-plane/main.bicep:4730 { name: 'LOOM_BROKER_URL', value: '' }`.
 *
 * A LIVENESS CHECK FINDS NOTHING HERE. The app is healthy. A provisioning-state
 * sweep finds nothing either — measured 2026-08-23, 0 of 63 container apps across
 * all six subscriptions are in a non-Succeeded state. The waste on this estate is
 * healthy services nobody calls, and only reachability sees it.
 *
 * ── WHY `configured` AND NOT `declared` ────────────────────────────────────
 * `declared` is what the template says; `configured` is what the DEPLOYMENT has.
 * A service can be perfectly wired in bicep and unreachable in the running
 * estate — which is the broker exactly, since the template's wire evaluates to
 * `''`. Asking the `declared` question would have exonerated it.
 *
 * ── THE THREE THINGS THAT KEEP THIS FROM BEING GREEN AND BLIND ─────────────
 *   1. VACUITY. If the graph holds no RESOLVED `configured` edges, "no inbound
 *      configured edge" is true of every node for an uninteresting reason. The
 *      detector then emits ZERO findings and records the reason, rather than
 *      reporting the whole estate as unreachable. See {@link vacuityReason} —
 *      note it counts RESOLVED edges, which is stricter than the population's
 *      `byProvenance` (that one counts dangling edges, which can never confer
 *      reachability).
 *   2. NOT-MEASURED IS NOT ZERO. A node with no `ScaleFacts` is SKIPPED with a
 *      reason, never treated as `minReplicas: 0`. Treating absence as zero would
 *      silently exonerate every resource whose scale could not be read.
 *   3. OWNERSHIP. Of the 13 container environments in these subscriptions, ONE is
 *      Loom's. Every proposal carries the ownership state, and today that state
 *      is `not-established` for everything because nothing carries
 *      `loom-estate-id`.
 *
 * ── ALWAYS-ON BY DESIGN IS NOT WASTE (#4257) ───────────────────────────────
 * Some always-on floors are DECLARED by the deploy on purpose: a runtime that
 * holds state in a single process cannot scale to zero without losing it.
 * `loom-risingwave` is the measured case — its own bicep says a scaled-to-zero
 * replica "loses every MV definition and its progress" — and this detector used
 * to report it as a HIGH-severity costed saving, which is what put an
 * unrecoverable destructive action at the top of the operator's list.
 *
 * So `nonScalableSubject` may be injected. A subject it names still gets a
 * finding (hiding it would be its own dishonesty, and the always-on cost is
 * real) but an `info`, COST-FREE, report-only one whose remediation says the
 * floor is by design and names the module that declares it. The predicate is
 * injected rather than read here because everything in this directory is PURE —
 * the derivation lives in `lib/brain-actions/scalability.ts`, which explains why
 * its source cannot drift from the bicep.
 *
 * ── WHICH PATH ACTUALLY SUPPLIES IT, STATED PLAINLY (review of #4261) ──────
 * The console's operator-facing detector is NOT this one. `snapshot.ts` runs
 * `app/api/admin/brain/_lib/detect.ts`'s `unreachableAlwaysOn`, and THAT is
 * where the same by-design branch is wired with a production default
 * (`declaredAlwaysOnReason`) — it is the finding the perform registry keys on
 * and the one that was ranking `loom-risingwave` as a costed saving.
 *
 * THIS detector runs in exactly one place: the `loom-brain-scan` CLI, via
 * `lib/brain/run/scan.ts`. MEASURED — no console route imports `lib/brain/run`.
 * That CLI is compiled by `lib/brain/run/tsconfig.cli.json`, which deliberately
 * declares NO `paths` mapping and is executed as plain `node …/cli.js`, so an
 * `@/`-aliased import anywhere in its emit closure is a COMPILE ERROR by
 * design. `lib/brain-actions/scalability.ts` reaches the template through
 * `@/lib/setup/user-arm-deploy`, so wiring the derivation into that closure
 * would break the nightly scan. Until the reader is split into an alias-free
 * module, the CLI report still prices these subjects: tracked, not claimed
 * fixed. `nonScalableSubject` is the seam that fix will use.
 */

import {
  formatCostFigure,
  type AzureResourceNode,
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
  danglingFor,
  detectorPopulation,
  evidence,
  finalizeResult,
  findingId,
  inbound,
  makeLedger,
  ownership,
  reachabilityConfidence,
  resolvedEdgeCount,
  scopedProposal,
  severityForMonthlyUsd,
  skip,
  vacuityReason,
} from './detector-kit';

export const UNREACHABLE_SERVICE = 'unreachable-service';

/** The query, as text, for the evidence chain. Must be re-runnable by hand. */
const QUERY =
  "alwaysOnNodes(graph) INTERSECT nodesWithNoInboundEdge(graph, 'configured') " +
  '— over azure-resource nodes carrying measured ScaleFacts';

/** Options this detector accepts. Every one is DATA — nothing is read from I/O. */
export interface UnreachableServiceOptions {
  /**
   * Names the subjects the DEPLOY declares as pinned singletons, returning the
   * reason verbatim (or null when the resource is not declared non-scalable, or
   * when the declaration could not be established at all).
   *
   * Injected so this module stays pure. `lib/brain-actions/scalability.ts`
   * derives it from the compiled deploy template.
   */
  readonly nonScalableSubject?: (node: AzureResourceNode) => string | null;
}

export function unreachableService(
  graph: BrainGraphView,
  options: UnreachableServiceOptions = {},
): DetectorResult {
  const skipped: SkippedSubject[] = [];
  const azure = azureResources(graph.nodes);

  // EVERY azure resource must be accounted for — flagged, cleared, or skipped
  // with a reason. See `detector-kit`'s disposition section: a candidate that
  // falls out of the loop is what a bypass keyed to production cardinality looks
  // like, and a population count alone cannot see it.
  const ledger = makeLedger(UNREACHABLE_SERVICE, azure.map((n) => n.id));

  // NOT MEASURED is not zero. A node with no scale facts is recorded, never
  // silently treated as scaling to zero.
  const scaleUnknown = azure.filter((n) => n.scale === undefined);
  for (const n of scaleUnknown) {
    ledger.skipped(n.id);
    skipped.push(
      skip(
        n.id,
        'no ScaleFacts were measured for this resource, so it cannot be established as always-on. ' +
          'Absent scale is NOT minReplicas 0 — this node is neither cleared nor flagged.',
      ),
    );
  }

  const scaleMeasured = azure.filter((n) => n.scale !== undefined);

  // EXTERNAL INGRESS IS OUT OF SCOPE, and this is the difference between a
  // detector and a noise generator.
  //
  // An app with `external: true` is reachable from the internet. Its callers are
  // OUTSIDE the graph by construction — no extractor models browser traffic — so
  // "zero inbound configured edges" says nothing about whether it is used. Left
  // in, `loom-console` (minReplicas 2, public FQDN, the busiest thing on the
  // estate) is reported as unreachable with a real cost figure attached, and one
  // finding like that is enough for an operator to stop trusting the surface.
  //
  // The inverse is exactly why the broker IS in scope: `external: false` with an
  // FQDN means every caller must be inside the Container Apps environment, and
  // inside-the-environment wiring is precisely what `configured` edges model. So
  // the scope is not a convenience — it is the boundary of what the graph can
  // establish (R7).
  const externallyIngressed = scaleMeasured.filter((n) => n.ingress?.external === true);
  for (const n of externallyIngressed) {
    ledger.skipped(n.id);
    skipped.push(
      skip(
        n.id,
        `ingress.external is true (fqdn ${n.ingress?.fqdn ?? 'unknown'}), so this app's callers are ` +
          'outside the graph. Inbound-edge count establishes NOTHING about its use. Not evaluated — ' +
          'neither cleared nor flagged. Use `always-on-unused` once telemetry exists; telemetry sees ' +
          'external requests, this query cannot.',
      ),
    );
  }

  // The population is every node whose scale IS measured and whose callers could
  // be visible: the set over which the question can actually be asked.
  const candidates = scaleMeasured.filter((n) => n.ingress?.external !== true);
  const population = detectorPopulation(
    graph,
    candidates,
    `${candidates.length} azure-resource node(s) with MEASURED scale and non-external ingress ` +
      `(of ${azure.length} azure resources, ${graph.nodes.length} nodes total); ` +
      `${scaleUnknown.length} skipped as scale-not-measured, ${externallyIngressed.length} skipped as ` +
      `externally ingressed; tested for minReplicas > 0 AND zero inbound RESOLVED 'configured' edges. ` +
      `Resolved 'configured' edges in graph: ${resolvedEdgeCount(graph, 'configured')}.`,
  );

  // VACUITY. Without resolved `configured` edges every node is trivially
  // "unreachable" and the answer means nothing. Report the reason; emit nothing.
  const vacuous = vacuityReason(graph, 'configured');
  if (vacuous !== null) {
    for (const n of candidates) {
      ledger.skipped(n.id);
      skipped.push(skip(n.id, `not evaluated — ${vacuous}`));
    }
    return finalizeResult({
      detector: UNREACHABLE_SERVICE,
      graph,
      findings: [],
      population,
      skipped,
      ledger,
      requiresResolved: ['configured'],
    });
  }

  const findings: Finding[] = [];

  for (const node of candidates) {
    // THE PREDICATE. Always-on, and nothing in the live deployment points at it.
    const isUnreachableAlwaysOn =
      node.scale!.minReplicas > 0 && inbound(graph, node.id, 'configured').length === 0;
    if (!isUnreachableAlwaysOn) {
      ledger.cleared(
        node.id,
        'scales to zero, or a resolved `configured` edge in the live deployment points at it',
      );
      continue;
    }
    ledger.finding(node.id);

    // ── #4257 — ALWAYS-ON BY DESIGN. Reported, never proposed as a saving. ──
    //
    // The subject is genuinely always-on and genuinely has no inbound wire, so
    // the finding stands. What must NOT stand is the COST recommendation: this
    // floor is what the deploy declared, and "scale it to zero" against a
    // runtime that holds its state in one process is unrecoverable loss dressed
    // up as a saving. `severity: 'info'`, no `cost` figure, and a remediation
    // that points at the module rather than at an ARM write.
    const byDesign = options.nonScalableSubject?.(node) ?? null;
    if (byDesign !== null) {
      // The contract suite requires either a cost figure or a recorded `(cost)`
      // skip for every priceable subject. This is the second: the omission is
      // deliberate and its reason is on the record, not silent.
      skipped.push(
        skip(
          `${node.id} (cost)`,
          'finding emitted WITHOUT a cost figure ON PURPOSE: the always-on floor is DECLARED by ' +
            `the deploy for this resource, so it is not a saving to propose. ${byDesign}`,
        ),
      );
      findings.push({
        id: findingId(UNREACHABLE_SERVICE, node.id),
        detector: UNREACHABLE_SERVICE,
        severity: 'info',
        title: `${node.displayName} is always-on BY DESIGN (declared non-scalable) and nothing wires to it`,
        summary:
          `'${node.displayName}' runs ${node.scale!.minReplicas} replica(s) that never scale to zero and ` +
          "the graph resolves ZERO inbound 'configured' edges for it — but its always-on floor is " +
          'DECLARED by the deploy, so this is an observation, NOT a cost recommendation. ' +
          byDesign,
        subjects: [node.id],
        evidence: evidence({
          nodes: [node.id],
          edges: [],
          query: QUERY,
          notes: [
            `minReplicas=${node.scale!.minReplicas}, maxReplicas=${node.scale!.maxReplicas ?? 'unset'}` +
              ` (scale read by extractor '${node.scale!.source}')`,
            'ALWAYS-ON BY DESIGN — the deploy declares this replica floor, so removing it is a ' +
              'template change, not an estate cleanup.',
            byDesign,
            'NO cost figure is attached, deliberately: an always-on floor the deploy asked for is ' +
              'not waste, and pricing it here would rank a destructive change to a stateful ' +
              "runtime at the top of the operator's savings list. That is exactly what #4257 " +
              'reports having happened.',
          ],
        }),
        population,
        confidence: 'high',
        remediation: scopedProposal(
          `NO ACTION — '${node.displayName}' is always-on by design.`,
          `# '${node.displayName}' is declared non-scalable by the deploy.\n` +
            `# ${byDesign}\n` +
            '#\n' +
            '# Do NOT scale it to zero. If the floor is genuinely wrong, the change belongs in the\n' +
            '# bicep module that declares it, and the next deploy would revert an out-of-band ARM\n' +
            '# write anyway (deploy-integrity.md R2 — drift, not a fix).\n' +
            '#\n' +
            '# If nothing is supposed to reach this service, the question is whether it should be\n' +
            '# DEPLOYED at all — a disable toggle in the module, not a replica count.',
          ownership(graph, node.id),
        ),
      });
      continue;
    }

    const dangling = danglingFor(graph, node.id);
    const declared = inbound(graph, node.id, 'declared');
    const imports = inbound(graph, node.id, 'imports');
    const observed = inbound(graph, node.id, 'observed');
    const hasOtherInbound = declared.length + imports.length + observed.length > 0;

    const estimate = estimateAlwaysOnMonthlyCost(node);
    let cost: CostFigure | undefined;
    let monthlyUsd: number | null = null;
    if (estimate.kind === 'priced') {
      cost = estimate.figure;
      monthlyUsd = estimate.figure.amountUsd;
    } else {
      skipped.push(skip(`${node.id} (cost)`, `finding emitted WITHOUT a cost figure: ${estimate.reason}`));
    }

    const own = ownership(graph, node.id);

    const notes: string[] = [
      `minReplicas=${node.scale!.minReplicas}` +
        (node.scale!.cpu !== undefined ? `, cpu=${node.scale!.cpu}` : '') +
        (node.scale!.memory !== undefined ? `, memory=${node.scale!.memory}` : '') +
        ` (scale read by extractor '${node.scale!.source}')`,
      `provisioningState=${node.provisioningState ?? 'NOT MEASURED'} — a liveness or provisioning check ` +
        'does NOT find this; only reachability does.',
      node.ingress
        ? `ingress: external=${node.ingress.external}, fqdn=${node.ingress.fqdn ?? 'none'}` +
          (node.ingress.external === false && node.ingress.fqdn
            ? ' — addressable from inside the environment, and wired to nothing.'
            : '')
        : 'ingress NOT MEASURED',
      `inbound resolved edges: configured=0, declared=${declared.length}, imports=${imports.length}, observed=${observed.length}`,
    ];

    if (dangling.length > 0) {
      notes.push(
        `${dangling.length} DANGLING wire(s) were intended for this node — the intent is documented and ` +
          'the value is empty or unresolvable:',
      );
      for (const d of dangling) {
        notes.push(
          `  [${d.provenance}] ${d.evidence.artifact}` +
            (d.evidence.line !== undefined ? `:${d.evidence.line}` : '') +
            ` ${d.evidence.symbol ?? '(no symbol)'} = ${JSON.stringify(d.evidence.rawValue ?? '')}` +
            ` (${d.danglingReason})`,
        );
      }
    } else {
      notes.push(
        'no dangling wire names this node as its intended target, so no INTENT to reach it is ' +
          'documented in the graph. The absence of an inbound edge is therefore weaker evidence here ' +
          'than it is for a node with an empty wire pointing at it.',
      );
    }

    if (cost) notes.push(`derived cost: ${formatCostFigure(cost)}`);

    const remediationBody = dangling.length
      ? `Either give the empty wire(s) a real value, or scale '${node.displayName}' to zero and delete it.\n` +
        dangling
          .map(
            (d) =>
              `  - ${d.evidence.artifact}` +
              (d.evidence.line !== undefined ? `:${d.evidence.line}` : '') +
              `  ${d.evidence.symbol ?? '(no symbol)'} currently ${JSON.stringify(d.evidence.rawValue ?? '')}` +
              (node.ingress?.fqdn ? ` -> should resolve to https://${node.ingress.fqdn}` : ''),
          )
          .join('\n')
      : `Nothing in the running deployment references '${node.displayName}'. Establish whether it has a ` +
        'consumer that this graph does not extract (a private DNS name, a queue, a scheduled job). If it ' +
        'does not, propose scaling it to minReplicas 0.';

    findings.push({
      id: findingId(UNREACHABLE_SERVICE, node.id),
      detector: UNREACHABLE_SERVICE,
      severity: severityForMonthlyUsd(monthlyUsd),
      title: `${node.displayName} is always-on (minReplicas ${node.scale!.minReplicas}) and nothing in the deployment wires to it`,
      summary:
        `'${node.displayName}' runs ${node.scale!.minReplicas} replica(s) that never scale to zero, and the ` +
        `graph resolves ZERO inbound 'configured' edges for it` +
        (dangling.length ? `, while ${dangling.length} wire(s) that were meant to reach it are empty or unresolvable` : '') +
        `. It is ${node.provisioningState ?? 'of unmeasured provisioning state'} and healthy, which is why a ` +
        'liveness check does not find it.',
      subjects: [node.id],
      evidence: evidence({
        nodes: [node.id, ...dangling.map((d) => d.from)],
        edges: [...dangling],
        query: QUERY,
        notes,
      }),
      population,
      confidence: reachabilityConfidence({
        hasDanglingIntent: dangling.length > 0,
        hasOtherInbound,
      }),
      cost,
      remediation: scopedProposal(
        `Wire or retire '${node.displayName}'`,
        remediationBody,
        own,
      ),
    });
  }

  return finalizeResult({
    detector: UNREACHABLE_SERVICE,
    graph,
    findings,
    population,
    skipped,
    ledger,
    requiresResolved: ['configured'],
  });
}

/**
 * Build-checked: the options parameter is OPTIONAL, so this function is still a
 * plain {@link Detector} and `ALL_DETECTORS` keeps working unchanged. Written in
 * the source (not a test) because `tsconfig.build.json` excludes `__tests__` —
 * the pattern `lib/brain/types.ts` established for its own literal assertions.
 */
const _unreachableServiceIsADetector: Detector = unreachableService;
void _unreachableServiceIsADetector;
