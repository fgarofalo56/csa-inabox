/**
 * C1 — THE UNAUTHORIZED INBOUND EDGE (the admin-bypass family).
 *
 * Taxonomy §2. The paradigm case for the reachability thesis and the class with
 * the most live instances: `security-roles/route.ts:85` (#3855, OPEN, grants real
 * ADLS Gen2 POSIX ACLs) and `workspaces/[id]/folders/route.ts:36` (#3891, OPEN,
 * gating GET/POST/PATCH/DELETE on a coerced truthy read).
 *
 * ── THE PREDICATE ─────────────────────────────────────────────────────────
 *
 * An ALLOW that (a) is reached on a condition mentioning an admin-claim
 * predicate, (b) governs a resource NAMED BY CALLER INPUT, and (c) reaches a
 * privileged sink, must be BOOLEAN-IMPLIED BY a verdict obtained from the
 * canonical `owns` resolver. If it is not, it is a finding.
 *
 * `isTenantAdmin(session)` is an edge from the caller to NOTHING — it reads a
 * claim and never touches the `owns` relation. The path reaches the privileged
 * sink with no edge that mentions the resource.
 *
 * ── THE THREE THINGS THIS DETECTOR REFUSES TO DO ──────────────────────────
 *
 * Each corresponds to a measured evasion, and each has a regression spec.
 *
 * 1. IT NEVER FILTERS THE POPULATION BY PARAMETER NAME.
 *
 *    `scripts/ci/check-tid-boundary-chokepoint.mjs:2662` narrows its judged set
 *    with `const ADMIN_GRANT_SCOPE = /\bworkspace(Id|_id)?\b/i;` applied to
 *    `fn.params`. Measured live on 2026-08-23 by running the guard:
 *
 *        [tid-boundary-chokepoint] repo-wide admin-shape scan: 15 function(s)
 *          whose OWN body grants on an isTenantAdmin-bearing condition, of which
 *          1 are workspace-scoped by signature (#3825)
 *        [tid-boundary-chokepoint] OK — the tenant boundary is required at every
 *          call site.
 *        RC=0
 *
 *    15 candidates, 1 judged, RC=0 — with a live shape-1 defect in the tree. A
 *    route-level authorizer whose parameters are named `itemId` / `itemType` —
 *    exactly `security-roles/route.ts:85`'s signature — is outside the judged
 *    population. To that guard's credit the limit is DISCLOSED in its own comment
 *    at `:2655-2661`. Disclosure is not enforcement.
 *
 *    So `AuthorizerFacet.params` exists here for EVIDENCE ONLY and no predicate
 *    below reads it. `__tests__/security/c1-population.test.ts` asserts a
 *    `(session, itemId, itemType)` authorizer is JUDGED, and the hollow-control
 *    arm of the mutation harness re-introduces the param filter to prove that
 *    assertion actually watches.
 *
 * 2. A LITERAL SCOPING NEVER EXEMPTS AND NEVER REDUCES SEVERITY.
 *
 *    On 2026-08-21 an independent review inserted ONE line at the top of
 *    `authorizeItemWorkspace` (`lib/auth/workspace-guard.ts:216-227`):
 *
 *        if (opts.itemType === 'lakehouse' && isTenantAdmin(session)) return null;
 *
 *    It passed the ENTIRE verification stack — guard exit 0, the 27-test #3825
 *    spec green, the 259-test wide suite green — while granting a real
 *    cross-tenant ALLOW for that one item type. `authorizeItemWorkspace` is the
 *    85-importer entry point; a bypass scoped to one `itemType` is invisible to a
 *    spec suite that exercises a different one.
 *
 *    `scopeLiterals` is therefore recorded and reported, never subtracted.
 *
 * 3. MENTIONING A VERDICT IS NOT READING ONE.
 *
 *    The round-2 fix for (2) was defeated by
 *
 *        if (!denied || opts.itemType === 'lakehouse') return null;
 *
 *    which mentions the delegated verdict and discards it. The predicate below
 *    turns on `impliedByOwnsVerdict` — a boolean-implication fact over the path
 *    condition — and treats `mentionsVerdict && !impliedByOwnsVerdict` as HIGH
 *    confidence rather than as mitigation, because that combination is not an
 *    accident: it is what a defeated fix looks like.
 *
 * ── THE NEGATIVE CONTROL THAT SEPARATES THIS FROM A GREP ──────────────────
 *
 * `lib/auth/feature-gate.ts:157` (`requireTenantAdmin`) is byte-identical in
 * shape to the defect — `if (isTenantAdmin(session)) return null;` — and is
 * CORRECT, because its contract is "is this caller a tenant admin at all": an
 * org-wide gate over no resource. Any detector that flags it is keyed to a
 * spelling rather than to the presence of an unauthorized RESOURCE edge. That is
 * why `resourceScoped` is a required facet field and not an inference.
 *
 * Second negative control: `lib/azure/powerbi-workspace-mapping.ts:68` — an
 * unfiltered `loadWorkspaceAdmin` whose result never becomes an authorization
 * decision. Shape-matching flags it; edge semantics does not. It is modelled here
 * as an authorizer with `reachesPrivilegedSink: false`.
 *
 * ── WHAT THIS DETECTOR DOES NOT COVER ─────────────────────────────────────
 *
 * A route with a privileged sink and NO verdict obtained at all is not C1's
 * shape — there is no ALLOW path to test the implication of. That is C3's
 * "the verdict was never consumed" with `pathsConsumingAsRefusal: 0`, and it is
 * stated here so the boundary is a decision rather than a gap.
 */

import { buildFinding } from '../finding-builder';
import {
  candidatesOfKind,
  detectorResult,
  type DetectorResult,
  type Population,
  type SecurityDetectorSpec,
} from '../population';
import type {
  AllowPath,
  AuthorizerFacet,
  Finding,
  SecurityGraph,
  SecurityNode,
  Severity,
} from '../substrate';

export const C1_DETECTOR_ID = 'security.c1.unauthorized-inbound-edge';

/**
 * Predicates that read an admin claim and nothing else.
 *
 * Matched as a SET rather than a regex over source text, because the taxonomy's
 * shape-3 finding (#3891) is precisely a member the family's greps missed:
 * `!!(await readWorkspaceById(id))` is neither `return null` nor
 * `loadWorkspaceAdmin`. The facet extractor names the predicate; this detector
 * does not re-derive it from a spelling.
 */
const ADMIN_CLAIM_PREDICATES = new Set([
  'isTenantAdmin',
  'session.claims.roles.includes(admin)',
  'hasTenantAdminRole',
]);

/** Sinks whose compromise is a WRITE, not a read. These escalate severity. */
const WRITE_SIDE_SINKS = new Set([
  'adls-posix-acl',
  'cosmos-write',
  'arm-deploy',
  'delete-cascade',
  'role-assignment',
]);

function isAdminClaimOnly(path: AllowPath): boolean {
  return path.conditionPredicates.some((p) => ADMIN_CLAIM_PREDICATES.has(p));
}

function severityFor(facet: AuthorizerFacet): Severity {
  return facet.privilegedSinkKinds.some((k) => WRITE_SIDE_SINKS.has(k)) ? 'critical' : 'high';
}

/**
 * Judge ONE authorizer and return its findings.
 *
 * Every "not this class" exit is a `return`, never a `continue` in the caller's
 * loop. That is deliberate: it means the caller can append to `judged` only
 * AFTER this function has returned a verdict, so a skip injected at loop level
 * drops the node out of `judged` and `detectorResult()` refuses the result
 * outright. See `detectUnauthorizedInboundEdge` below.
 */
function judgeAuthorizer(node: SecurityNode): Finding[] {
  const facet = node.facet as AuthorizerFacet;
  const findings: Finding[] = [];

  for (const path of facet.allowPaths) {
    // Not this class: the ALLOW is not reached on an admin-claim condition.
    if (!isAdminClaimOnly(path)) continue;

    // NEGATIVE CONTROL — an org-wide gate over no resource (requireTenantAdmin).
    // The ALLOW is real and correct because there is no resource edge to check.
    if (!facet.resourceScoped) continue;

    // NEGATIVE CONTROL — the verdict never becomes an authorization decision
    // (powerbi-workspace-mapping). Shape matches; semantics do not.
    if (!facet.reachesPrivilegedSink) continue;

    // THE PREDICATE. Note what is absent: no read of `facet.params`, and no
    // branch on `path.scopeLiterals.length`.
    if (path.impliedByOwnsVerdict) continue;

    const narrow = path.scopeLiterals.length > 0;
    const facts: string[] = [
      `authorizer ${facet.fnName} allows on [${path.conditionPredicates.join(', ')}]`,
      `resource named by caller input: ${facet.callerNamedResourceInputs.join(', ') || '(none recorded)'}`,
      `privileged sinks reached: ${facet.privilegedSinkKinds.join(', ')}`,
      `ALLOW implied by an owns-verdict: NO (resolver=${path.ownsResolver ?? 'none'})`,
      // Evidence only. Stated explicitly so a reader can see the field was
      // recorded and deliberately not used as a filter.
      `parameters (EVIDENCE ONLY, never a population filter): ${facet.params.join(', ')}`,
    ];

    if (narrow) {
      facts.push(
        `NARROW: the ALLOW is scoped to ${path.scopeLiterals.join(' && ')}. This does not ` +
          'reduce severity. A bypass scoped to one item type passed guard exit 0, a 27-test ' +
          'spec and a 259-test suite on 2026-08-21 while granting a live cross-tenant ALLOW.',
      );
    }
    if (path.mentionsVerdict) {
      facts.push(
        'The path condition MENTIONS a delegated verdict but the ALLOW is not implied by it. ' +
          'That is the shape of a DEFEATED fix (`if (!denied || opts.itemType === ...)`), ' +
          'not of an oversight.',
      );
    }

    findings.push(
      buildFinding({
        id: `${C1_DETECTOR_ID}:${node.id}:${path.id}`,
        detectorId: C1_DETECTOR_ID,
        findingClass: 'C1-unauthorized-inbound-edge',
        severity: severityFor(facet),
        confidence: 'high',
        title:
          `${facet.fnName} grants on an admin claim alone` +
          (narrow ? ` (scoped to ${path.scopeLiterals.join(' && ')})` : '') +
          ' — the ALLOW is not implied by an owns-verdict',
        nodeIds: [node.id],
        query:
          'authorizer.allowPaths[] where condition names an admin-claim predicate AND the ' +
          'authorizer is resourceScoped AND reaches a privileged sink AND the ALLOW is NOT ' +
          'boolean-implied by a verdict from the canonical owns resolver',
        facts,
        remediationSummary:
          `Route ${facet.fnName}'s decision through the canonical owns resolver so the ALLOW ` +
          'is implied by a POSITIVE tenant match, not by the absence of a contradiction ' +
          '(bfd67ed1 / #3859). An edge that fails to fire on missing data is not an edge. ' +
          'DRAFT ONLY — a wrong autonomous change to an authorization path is worse than the gap.',
        proposedPatchDescription:
          `Replace the admin-claim short-circuit in ${facet.fnName} with a delegation whose ` +
          'ALLOW is implied by the resolver verdict on every path.',
      }),
    );
  }

  return findings;
}

export function detectUnauthorizedInboundEdge(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'authorizer');
  const findings: Finding[] = [];
  const judged: string[] = [];

  for (const node of nodes) {
    findings.push(...judgeAuthorizer(node));
    // `judged` is appended ONLY here, after a verdict was actually produced.
    // A `continue` injected anywhere above — the loop-level form of the
    // parameter-name filter at check-tid-boundary-chokepoint.mjs:2662 — drops
    // the node out of `judged`, and `detectorResult()` then THROWS rather than
    // reporting a narrowed sweep as clean.
    //
    // Stated honestly, because it is a real limit: this catches a LOOP-LEVEL
    // skip. A skip injected INSIDE `judgeAuthorizer` still counts the node as
    // judged, and only the positive specs catch that. The mutation harness runs
    // BOTH arms and reports the difference rather than claiming the contract is
    // total.
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C1_DETECTOR_ID,
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population);
}

export const c1Spec: SecurityDetectorSpec = {
  id: C1_DETECTOR_ID,
  taxonomyClass: 'C1',
  title: 'Unauthorized inbound edge (admin-bypass family)',
  run: detectUnauthorizedInboundEdge,
};
