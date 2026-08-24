/**
 * C3 — THE DISCARDED VERDICT (authorization is the CALLER'S line).
 *
 * Taxonomy §4. The class that most sharply refines the reachability thesis, and
 * the one a call graph is blind to BY CONSTRUCTION.
 *
 * ── THE MECHANISM ────────────────────────────────────────────────────────
 *
 * Every returned-value guard in this console has the contract
 * `Promise<NextResponse | null>` — `null` means allowed
 * (`lib/auth/feature-gate.ts:185`). So THE AUTHORIZATION EDGE IS NOT THE CALL.
 * The call produces a value; the edge is `if (gate) return gate;` IN THE CALLER.
 *
 * Delete that one line and the graph still contains the import, the call, and
 * the guard's full correct implementation — and no authorization. In provenance
 * terms the `imports` edge and the `declared` call both survive; the `observed`
 * enforcement does not.
 *
 * ── THE MEASURED INSTANCE ────────────────────────────────────────────────
 *
 * `scripts/ci/check-route-guards.mjs:24-36` records it verbatim: on 2026-08-07
 * `if (gate) return gate;` was deleted from `app/api/setup/deploy/route.ts` — the
 * route that submits SUBSCRIPTION-SCOPED ARM deployments — leaving the
 * `enforceCapability` call in place. Measured: that checker printed
 * `violations: 0`; so did check-route-toolkit and check-credential-route-authz.
 * Authorization was fully defeated and EVERY MERGE-BLOCKING CONTROL IN THE REPO
 * WAS GREEN.
 *
 * Seven symbols share the contract: `enforceCapability`, `requireTenantAdmin`,
 * `denyIfNoDlzAccess`, `pdpCheck`, `authorizeItemWorkspace`, `authorizeWorkspace`,
 * `requireWorkspace`.
 *
 * ── THE THREE NARROW BYPASSES, ALL IN THE FIXTURE CORPUS ─────────────────
 *
 * (a) CONSUME THE VERDICT ON ONE BRANCH.
 *     `if (gate && req.method !== 'GET') return gate;` — consumption is real, the
 *     value IS tested, a decision IS taken, and GET is unauthorized. A checker
 *     that asks "is the value tested?" passes it. The requirement must be EVERY
 *     PATH TO THE SINK, not SOME path — hence the predicate compares
 *     `pathsConsumingAsRefusal` against `pathsToPrivilegedSink` rather than
 *     testing a boolean.
 *
 * (b) CONSUME IT INTO A DEAD STORE.
 *     `const gate = await enforceCapability(...); if (gate) log(gate);` — tested,
 *     consumed, never returned. `consumption: 'logged'`.
 *
 * (c) SATISFY THE PRESENCE SIGNAL WITH AN AUDIT FIELD.
 *     Measured, from `check-route-guards.mjs:96-108`: a bare `claims.oid` proves
 *     the token is PRESENT in the handler, not that it AUTHORIZES.
 *     `items/dashboard/[id]` PUT passed on the overlay's `savedBy` ATTRIBUTION
 *     while overwriting any tenant's overlay by id;
 *     `databricks-notebook/[id]/versions` POST passed on `savedBy:
 *     session.claims.oid` for the same reason. Removing bare `claims.*` from the
 *     signal set was measured on 2026-08-08: 0 violations -> 205. The same class
 *     at the reporting layer is commit `72fb01afd` — "the route inventory called
 *     a LOG FIELD an authorization check — 271 of 773 owner-scoped rows" (#3625).
 *
 *     A SIGNAL THAT A TOKEN IS PRESENT IS NOT A SIGNAL THAT A DECISION WAS MADE.
 *     This repo has paid for that confusion at least four times.
 *
 * ── THE ALLOWLIST IS NEVER A POPULATION FILTER ───────────────────────────
 *
 * Quoting `check-route-guards.mjs:29-31`, which is the non-obvious part of the
 * design: "this route needs no per-resource authorization" NEVER LICENSES "call a
 * gate and throw its answer away". So allowlisted routes stay in BOTH
 * `candidates` and `judged`, and `allowlisted` never suppresses a finding. It
 * only produces an ADDITIONAL finding when the premise was never tested — #3607
 * records that `ALLOWLIST_PREFIXES` premises are load-bearing for 12 routes and
 * untested, and CHECK 3 of that same guard exists because allowlist entries were
 * never premise-tested before.
 *
 * ── THE NEGATIVE CONTROL ─────────────────────────────────────────────────
 *
 * A route that legitimately needs no per-resource authorization — a static
 * capability-catalogue read — which calls no guard at all. It must NOT fire.
 * Distinguishing it from C3 requires knowing THE SINK IS NOT PRIVILEGED, which is
 * a `declared` property of the sink that must be maintained explicitly and never
 * inferred (taxonomy §4.5). `sinkPrivileged` is that property.
 */

import { buildFinding } from '../finding-builder';
import {
  candidatesOfKind,
  detectorResult,
  type DetectorResult,
  type Population,
  type SecurityDetectorSpec,
} from '../population';
import type { Finding, SecurityGraph, SecurityNode, VerdictCallFacet } from '../substrate';

export const C3_DETECTOR_ID = 'security.c3.discarded-verdict';

/** Consumption kinds that are NOT a refusal, however real the read looks. */
const NON_REFUSING_CONSUMPTION = new Set(['logged', 'ignored', 'attribution-only']);

/** Judge ONE call site. See `c1` for why every exit is a `return`. */
function judgeVerdictCall(node: SecurityNode): Finding[] {
  const facet = node.facet as VerdictCallFacet;
  const findings: Finding[] = [];

  // NEGATIVE CONTROL — the sink is not privileged, so no per-resource
  // authorization is required and no verdict is owed. This is a `declared`
  // property, never inferred.
  if (!facet.sinkPrivileged) return findings;

  const partial =
    facet.pathsToPrivilegedSink > 0 &&
    facet.pathsConsumingAsRefusal < facet.pathsToPrivilegedSink;
  const nonRefusing = NON_REFUSING_CONSUMPTION.has(facet.consumption);

  if (partial || nonRefusing) {
    const facts: string[] = [
      `${facet.callSite} calls ${facet.symbol} (returns a verdict union: ${facet.returnsVerdictUnion})`,
      `paths to the privileged sink (${facet.sinkKind}): ${facet.pathsToPrivilegedSink}; ` +
        `paths consuming the verdict as a refusal: ${facet.pathsConsumingAsRefusal}`,
      `consumption: ${facet.consumption}`,
      `allowlisted: ${facet.allowlisted} (NEVER a population filter — this node is judged either way)`,
    ];

    if (partial && facet.pathsConsumingAsRefusal > 0) {
      facts.push(
        'NARROW: the verdict IS tested and a decision IS taken — on some paths. ' +
          `${facet.pathsToPrivilegedSink - facet.pathsConsumingAsRefusal} path(s) reach the ` +
          'sink unrefused. A consumption checker that asks "is the value tested?" passes this.',
      );
    }
    if (facet.consumption === 'attribution-only') {
      facts.push(
        'The only guard-shaped signal is an ATTRIBUTION field (savedBy / claims.oid). That ' +
          'proves the token is PRESENT in the handler, not that it AUTHORIZES. Measured ' +
          '2026-08-08: removing bare claims.* from the signal set moved 0 violations -> 205.',
      );
    }
    if (facet.consumption === 'logged') {
      facts.push(
        'The verdict is consumed into a DEAD STORE — read, tested, and never returned.',
      );
    }

    findings.push(
      buildFinding({
        id: `${C3_DETECTOR_ID}:${node.id}`,
        detectorId: C3_DETECTOR_ID,
        findingClass: 'C3-discarded-verdict',
        severity: facet.sinkKind === 'arm-deploy' ? 'critical' : 'high',
        confidence: 'high',
        title:
          `${facet.callSite} obtains a verdict from ${facet.symbol} and does not consume it ` +
          'as a refusal on every path to the privileged sink',
        nodeIds: [node.id],
        query:
          'verdict-call where sinkPrivileged AND (pathsConsumingAsRefusal < ' +
          'pathsToPrivilegedSink OR consumption is logged/ignored/attribution-only) — run ' +
          'over EVERY route including allowlisted ones',
        facts,
        remediationSummary:
          `Return the verdict as a refusal on every path from ${facet.callSite} to the ` +
          'privileged sink. The authorization edge is the caller\'s `if (gate) return gate;`, ' +
          'not the call — deleting that line leaves the import, the call and the guard\'s ' +
          'whole correct implementation in place with no authorization. DRAFT ONLY.',
        proposedPatchDescription:
          `Consume ${facet.symbol}'s return value as an unconditional early return in ` +
          `${facet.callSite} before any privileged operation.`,
      }),
    );
  }

  // #3607 — an allowlist entry whose premise was never tested is load-bearing
  // and unverified. Reported separately, at lower severity, so it cannot be
  // mistaken for the enforcement finding above.
  if (facet.allowlisted && !facet.allowlistPremiseTested) {
    findings.push(
      buildFinding({
        id: `${C3_DETECTOR_ID}:${node.id}:allowlist-premise`,
        detectorId: C3_DETECTOR_ID,
        findingClass: 'C3-discarded-verdict',
        severity: 'medium',
        confidence: 'medium',
        title: `${facet.callSite} is allowlisted on an UNTESTED premise`,
        nodeIds: [node.id],
        query: 'verdict-call where allowlisted AND NOT allowlistPremiseTested',
        facts: [
          `${facet.callSite} sits behind an authorization allowlist whose premise ` +
            '("this route needs no per-resource authorization") is asserted and never verified.',
          '#3607 records the same gap open for ALLOWLIST_PREFIXES, load-bearing for 12 routes. ' +
            'CHECK 3 of check-route-guards.mjs exists because allowlist entries were never ' +
            'premise-tested.',
        ],
        remediationSummary:
          'Add a premise test that FAILS if the allowlisted route ever acquires a privileged ' +
          'sink, so the exemption expires with the condition that justified it. DRAFT ONLY.',
      }),
    );
  }

  return findings;
}

export function detectDiscardedVerdict(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'verdict-call');
  const findings: Finding[] = [];
  const judged: string[] = [];

  for (const node of nodes) {
    findings.push(...judgeVerdictCall(node));
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C3_DETECTOR_ID,
    declaredKinds: ['verdict-call'],
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population, graph);
}

export const c3Spec: SecurityDetectorSpec = {
  id: C3_DETECTOR_ID,
  taxonomyClass: 'C3',
  title: 'Discarded verdict (the edge is the caller\'s consumption, not the call)',
  run: detectDiscardedVerdict,
};
