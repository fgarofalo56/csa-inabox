/**
 * C7 — THE SYNTHESIZED PRINCIPAL.
 *
 * Taxonomy §8 — a class the commissioned list did not contain. C1 is "the wrong
 * principal was authorized". THIS is "NO PRINCIPAL EXISTED AND ONE WAS INVENTED".
 * The identity node's provenance is neither `observed` nor `configured` — it is a
 * LITERAL, and it is well-formed, so every downstream check that validates SHAPE
 * passes.
 *
 * ── WHY THIS MATTERS MORE HERE THAN IN MOST CODEBASES ────────────────────
 *
 * #3818 (OPEN) states the mechanism, and one sentence carries it:
 *
 *   "In this codebase the caller's `oid` is a COSMOS PARTITION KEY — a
 *    tenant/resource boundary. A placeholder oid writes into a partition no real
 *    user occupies, which is how a green run can measure nothing (#3804)."
 *
 * That is the connective tissue to C1: `Workspace.tenantId` stores the creator's
 * oid and IS the partition key (`lib/auth/workspace-guard.ts:109-112`). So a
 * synthesized oid does not merely mis-attribute — IT CREATES A SHADOW TENANT.
 *
 * #3804 (OPEN) is the consequence: eight UAT harnesses mint a LIVE session as an
 * all-zeros principal when the identity env var is unset, and it had already
 * orphaned 24 workspaces.
 *
 * ── THE TWO MEASURED BYPASSES ────────────────────────────────────────────
 *
 * (a) GUARD EMPTINESS RATHER THAN VALIDITY. `.github/workflows/perf-gate.yml:135`
 *     guards with `[[ -z "${LOOM_AUTOMATION_OID:-}" ]]`, which catches ABSENCE
 *     ONLY. An explicitly-set all-zeros value passes it and mints at `:145`.
 *     -> `validation: 'presence'` is a BYPASS here, not a weaker grade of
 *     `'value'`, and the predicate treats it as one.
 *
 * (b) REACH THE SINK BY A CACHED PATH THAT NEVER CALLS THE GUARDED MINTER.
 *     `apps/fiab-console/tests/e2e/_shared.ts:80-85` — `signIn()` prefers a
 *     cached storage artifact and returns WITHOUT ever calling
 *     `mintSessionCookie()`, so a cookie minted under the zero GUID BEFORE the
 *     fix is still loaded AFTER it. -> `bypassesMinter`.
 *
 * A third is implied by "eight independent copies, one under test": FIX THE COPY
 * UNDER TEST. That is why `checkCopies` / `checkCopiesUnderTest` are facet fields
 * and produce their own finding — seven untested copies IS the defect, and it is
 * open even though the instances were closed.
 *
 * NOT RE-VERIFIED BY THIS LANE: the taxonomy read #3818 and #3804 but did not
 * re-open `perf-gate.yml` or `_shared.ts`. Those are the issues' measurements.
 * The fixtures here are synthetic and assert nothing about the live tree.
 *
 * ── ONE MEASURED NEGATIVE, RECORDED SO IT IS NOT RE-INVESTIGATED ─────────
 *
 * The nil-GUID fail-open scan came back CLEAN, and the bare `...000000000002`
 * constant that shows up in that grep is the Cosmos Data Contributor ROLE ID, not
 * an identity. A detector that pattern-matches zero-ish GUIDs would flag it. This
 * one keys on `reachesPartitionKeyOrTenantScope` — a role id does not — which is
 * why that constant is not in the fixture corpus as a positive.
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
  Finding,
  PrincipalFacet,
  PrincipalSource,
  SecurityGraph,
  SecurityNode,
} from '../substrate';

export const C7_DETECTOR_ID = 'security.c7.synthesized-principal';

/** A principal is trustworthy only when it came from a live token. */
function isSynthesizable(source: PrincipalSource): boolean {
  return source.origin !== 'live-token';
}

/**
 * Is this source adequately guarded?
 *
 * `validation: 'presence'` is NOT adequate — that is the `-z` bypass. And a path
 * that bypasses the minter is never adequate however the value is validated,
 * because the validation is in the minter.
 */
function isAdequatelyGuarded(source: PrincipalSource): boolean {
  if (source.bypassesMinter) return false;
  return source.validation === 'value';
}

/** Judge ONE principal sink. See `c1` for why every exit is a `return`. */
function judgePrincipal(node: SecurityNode): Finding[] {
  const facet = node.facet as PrincipalFacet;
  const findings: Finding[] = [];

  // Not this class: the value never reaches a tenancy boundary. A role id, a
  // correlation id, a display name are all principal-SHAPED and harmless.
  if (!facet.reachesPartitionKeyOrTenantScope) return findings;

  for (const source of facet.sources) {
    if (!isSynthesizable(source)) continue;
    if (isAdequatelyGuarded(source)) continue;

    const facts: string[] = [
      `${facet.sink} can receive a principal originating from: ${source.origin}`,
      `validation: ${source.validation}; bypasses the guarded minter: ${source.bypassesMinter}`,
      'The oid is a Cosmos PARTITION KEY here, so a placeholder does not mis-attribute — it ' +
        'creates a SHADOW TENANT that no real user occupies (#3818). #3804 records 24 ' +
        'workspaces already orphaned this way.',
    ];

    if (source.validation === 'presence') {
      facts.push(
        'NARROW: the guard checks ABSENCE, not validity — `[[ -z "${VAR:-}" ]]`. An ' +
          'explicitly-set all-zeros value passes it. The guard must assert on the VALUE.',
      );
    }
    if (source.bypassesMinter) {
      facts.push(
        'NARROW: this path reaches the sink WITHOUT calling the guarded minter — a cached ' +
          'storage artifact is preferred and returned directly, so a principal minted before ' +
          'the fix is still loaded after it. Hardening the minter does not close this path.',
      );
    }

    findings.push(
      buildFinding({
        id: `${C7_DETECTOR_ID}:${node.id}:${source.origin}`,
        detectorId: C7_DETECTOR_ID,
        findingClass: 'C7-synthesized-principal',
        severity: 'critical',
        confidence: 'high',
        title:
          `${facet.sink} accepts a principal of provenance '${source.origin}' into a ` +
          'partition/tenant boundary',
        nodeIds: [node.id],
        query:
          'principal where reachesPartitionKeyOrTenantScope AND some source is not a ' +
          'live-token AND (validation !== "value" OR bypassesMinter)',
        facts,
        remediationSummary:
          'Require `observed` provenance for any principal reaching a partition key, tenant ' +
          'scope or authorization input. Assert on the VALUE, not on presence, and close the ' +
          'cached path so it cannot skip the minter. DRAFT ONLY.',
      }),
    );
  }

  // "Eight independent copies and exactly one under test" — the class stays
  // open even when every instance is closed.
  if (facet.checkCopies > facet.checkCopiesUnderTest) {
    findings.push(
      buildFinding({
        id: `${C7_DETECTOR_ID}:${node.id}:copies`,
        detectorId: C7_DETECTOR_ID,
        findingClass: 'POP-population-integrity',
        severity: 'high',
        confidence: 'high',
        title:
          `${facet.sink}'s placeholder-principal check exists in ${facet.checkCopies} copies ` +
          `and ${facet.checkCopiesUnderTest} is/are under test`,
        nodeIds: [node.id],
        query: 'principal where checkCopies > checkCopiesUnderTest',
        facts: [
          `${facet.checkCopies - facet.checkCopiesUnderTest} untested copies of a security ` +
            'check is the defect, independent of whether any instance is currently live.',
          'The narrow bypass this enables is the cheapest one available: fix the copy under ' +
            'test.',
        ],
        remediationSummary:
          'Consolidate onto one implementation, or bring every copy under test and assert the ' +
          'COUNT so a ninth cannot appear silently. DRAFT ONLY.',
      }),
    );
  }

  return findings;
}

export function detectSynthesizedPrincipal(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'principal');
  const findings: Finding[] = [];
  const judged: string[] = [];

  for (const node of nodes) {
    findings.push(...judgePrincipal(node));
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C7_DETECTOR_ID,
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population);
}

export const c7Spec: SecurityDetectorSpec = {
  id: C7_DETECTOR_ID,
  taxonomyClass: 'C7',
  title: 'Synthesized principal (a well-formed literal creates a shadow tenant)',
  run: detectSynthesizedPrincipal,
};
