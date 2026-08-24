/**
 * C2 — THE AGGREGATE ORACLE (a count is an edge when the caller picks the scope).
 *
 * Taxonomy §3. The measured instance: `auto-bind-sweep.ts` (#3808) returned
 * `excludedByAccess` as a COUNT ONLY, with a docblock defending it verbatim —
 * "naming them would be the cross-tenant disclosure the filter exists to
 * prevent." That reasoning is CORRECT and it still shipped a leak, because the
 * same function accepted a caller-supplied `opts.workspaceId` that reached the
 * Cosmos query unchecked:
 *
 *     POST { workspaceId: '<foreign-ws>', itemTypes: ['t'] }
 *       -> excludedByAccess: 5, rows: [], no identifier in the body
 *
 * Existence plus cardinality, narrowable per `itemType`, with every identifier
 * correctly redacted.
 *
 * ── WHY THE OBVIOUS DETECTOR IS THE WRONG ONE ─────────────────────────────
 *
 * The identifier-redaction edge is real and it is correct. It is also THE WRONG
 * EDGE. The disclosure is not the identifiers, it is the CARDINALITY OF A
 * POPULATION THE ATTACKER CHOSE. A redaction defence answers "what leaves?" and
 * says nothing about "who chose what was counted?".
 *
 * So a detector keyed to "a count in a response body" is defeated four ways
 * (§3.4), and all four are in the fixture corpus:
 *
 *   - return it in a HEADER, a `GITHUB_STEP_SUMMARY`, or a telemetry span;
 *   - return a BOOLEAN — `hasExcluded: true` — a count truncated to one bit and
 *     still an existence oracle;
 *   - return it under a DIFFERENT query than the one the scope narrowed, so a
 *     taint-follow from `opts.workspaceId` to the emitted number finds no path;
 *   - expose it as a PAGINATION artifact (`nextCursor` present or absent) or a
 *     TIMING difference — not a number at all.
 *
 * ── THE PREDICATE ─────────────────────────────────────────────────────────
 *
 * Key on SCOPE PROVENANCE, never on the disclosure's shape or channel:
 *
 *     the handler accepts a caller-supplied scope parameter
 *       AND that scope was NOT resolved against `owns` before the data-plane query
 *       AND some disclosure is derived from that query
 *     -> finding, per disclosure, whatever its shape or channel
 *
 * `Disclosure.shape` and `Disclosure.channel` are read ONLY to write the evidence
 * string and to note the asymmetry. `c2-narrow.test.ts` proves that by asserting
 * the boolean, cursor and header variants fire with the same severity as the
 * count.
 *
 * ── THE NEGATIVE CONTROL ──────────────────────────────────────────────────
 *
 * The SAME handler, returning the SAME `excludedByAccess: N`, where `workspaceId`
 * is resolved through the owns resolver and a denial returns the 404 shape BEFORE
 * the query. The count may then be returned freely: the caller can only narrow to
 * scopes they already own. This control is essential — without it a detector that
 * simply flags counts would score identically on the fixture corpus while being
 * useless in production, and it would train reviewers to disable it.
 *
 * The repo's stated answer is `lib/api/route-toolkit.ts:113` — "the same
 * 404-not-403 behaviour the hand-rolled routes use so an id can't be probed for
 * existence across tenants" — applied per-id at `bulk-delete/route.ts:34-36`,
 * where a foreign-tenant id and a nonexistent id report an identical `not_found`.
 * `denialShape` records that, and a `forbidden` denial on an unresolved scope is
 * itself reported: a 403 confirms the resource exists.
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
  Disclosure,
  Finding,
  ScopedHandlerFacet,
  SecurityGraph,
  SecurityNode,
} from '../substrate';

export const C2_DETECTOR_ID = 'security.c2.aggregate-oracle';

/**
 * Every disclosure shape is an oracle. This map exists to WORD the evidence,
 * not to decide it — see the header. Adding a shape must never be required for
 * the detector to fire, so the lookup falls back rather than skipping.
 */
const ORACLE_WORDING: Record<Disclosure['shape'], string> = {
  count: 'cardinality of a caller-chosen population',
  boolean: 'a count truncated to one bit — still an existence oracle',
  'cursor-presence': 'existence, with no number in the response at all',
  duration: 'existence, via a timing difference',
  identifier: 'the identifiers themselves',
  enum: 'existence, via a value drawn from the scoped result',
};

/**
 * Judge ONE handler. Every "not this class" exit is a `return`, so the caller can
 * append to `judged` only after a verdict was produced — see `c1`'s note on why
 * that gives the population contract teeth at loop level, and on its limit.
 */
function judgeHandler(node: SecurityNode): Finding[] {
  const facet = node.facet as ScopedHandlerFacet;
  const findings: Finding[] = [];

  // Not this class: the handler narrows nothing on caller input.
  if (facet.callerSuppliedScopeParams.length === 0) return findings;

  // NEGATIVE CONTROL — the scope was resolved against `owns` before the query,
  // so the caller can only narrow to scopes they already own. Any disclosure
  // derived from it is theirs to see.
  if (facet.scopeResolvedBeforeQuery) return findings;

  for (const disclosure of facet.disclosures) {
    if (!disclosure.derivedFromScopedQuery) continue;

    // THE ASYMMETRY SIGNATURE: identifiers redacted, a derived quantity not.
    // It raises confidence rather than gating the finding, because a handler
    // that redacts nothing is worse, not exempt.
    const asymmetric = facet.identifiersRedacted && disclosure.shape !== 'identifier';

    const facts: string[] = [
      `handler ${facet.handler} accepts caller-supplied scope: ${facet.callerSuppliedScopeParams.join(', ')}`,
      'that scope reaches the data-plane query WITHOUT being resolved against the owns relation',
      `disclosure ${disclosure.field} (${disclosure.shape} on the ${disclosure.channel} channel) ` +
        `discloses ${ORACLE_WORDING[disclosure.shape] ?? 'a property of the caller-chosen scope'}`,
      `identifiers redacted: ${facet.identifiersRedacted ? 'yes' : 'no'}; denial shape: ${facet.denialShape}`,
    ];

    if (asymmetric) {
      facts.push(
        'ASYMMETRY: the identifier-redaction edge is present and correct, and it is the ' +
          'WRONG EDGE. #3808 shipped with a docblock correctly defending the redaction while ' +
          'the caller still chose what was counted.',
      );
    }
    if (disclosure.channel !== 'body') {
      facts.push(
        `NARROW: the disclosure leaves on the ${disclosure.channel} channel, not the response ` +
          'body. A detector keyed to response-body counts does not see this.',
      );
    }
    if (disclosure.shape !== 'count') {
      facts.push(
        `NARROW: the disclosure is a ${disclosure.shape}, not a count. A count-typed detector ` +
          'does not see this.',
      );
    }
    if (facet.denialShape === 'forbidden') {
      facts.push(
        'The denial shape is 403, which confirms the resource exists. The repo standard is ' +
          '404-not-403 (lib/api/route-toolkit.ts:113) so a foreign-tenant id and a nonexistent ' +
          'id are indistinguishable.',
      );
    }

    findings.push(
      buildFinding({
        id: `${C2_DETECTOR_ID}:${node.id}:${disclosure.field}`,
        detectorId: C2_DETECTOR_ID,
        findingClass: 'C2-aggregate-oracle',
        severity: 'high',
        confidence: asymmetric ? 'high' : 'medium',
        title:
          `${facet.handler} discloses ${disclosure.field} derived from a caller-chosen scope ` +
          'that was never resolved against the owns relation',
        nodeIds: [node.id],
        query:
          'scoped-handler where callerSuppliedScopeParams is non-empty AND ' +
          'scopeResolvedBeforeQuery is false AND some disclosure.derivedFromScopedQuery — ' +
          'independent of the disclosure shape and channel',
        facts,
        remediationSummary:
          `Resolve ${facet.callerSuppliedScopeParams.join(', ')} through the owns resolver ` +
          'BEFORE the data-plane query and return the 404-not-403 shape on denial, so an id ' +
          'cannot be probed for existence across tenants. Redacting identifiers does not ' +
          'address this; the leak is the cardinality of a population the caller chose. ' +
          'DRAFT ONLY.',
        proposedPatchDescription:
          `Move the access resolution ahead of the query in ${facet.handler}; on denial return ` +
          'the not-found shape before any aggregate is computed.',
      }),
    );
  }

  return findings;
}

export function detectAggregateOracle(graph: SecurityGraph): DetectorResult {
  const nodes = candidatesOfKind(graph, 'scoped-handler');
  const findings: Finding[] = [];
  const judged: string[] = [];

  for (const node of nodes) {
    findings.push(...judgeHandler(node));
    judged.push(node.id);
  }

  const population: Population = {
    detectorId: C2_DETECTOR_ID,
    declaredKinds: ['scoped-handler'],
    candidates: nodes.map((n) => n.id),
    judged,
    unjudged: [],
    emptyIsExpected: false,
  };

  return detectorResult(findings, population, graph);
}

export const c2Spec: SecurityDetectorSpec = {
  id: C2_DETECTOR_ID,
  taxonomyClass: 'C2',
  title: 'Aggregate oracle (caller-chosen scope, derived disclosure)',
  run: detectAggregateOracle,
};
