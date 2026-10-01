/**
 * FIXTURE for #4128 and #4798 — a file that moves the POPULATION without
 * moving the GRAPH.
 *
 * This module lives under `scripts/**`, so it is inside the publication scan
 * scope the artifact declares and it increments that scope's run count
 * (`run.scanScopes[].filesMatched`). It deliberately contains NO publication
 * construct — no write to a standard stream, no inherited descriptor, no
 * annotation or output call — so the extractor emits ZERO nodes from it and the
 * node and edge counts are byte-identical with and without it.
 *
 * #4128 measured this shape on PR #4127: the drift gate compared only
 * `{graph, join}`, so a file like this one slipped past it while the required
 * census in `no-estate-identifiers.test.ts` went red on the COMMITTED count.
 * #4798 then stopped committing that count, because it made every pair of open
 * PRs conflict: a file like this one now changes no committed byte at all, and
 * needs no regeneration. The census moved to the generator's enumeration in
 * `scripts/ci/__tests__/security-graph-drift-shape.test.mjs`.
 *
 * That suite asserts this module still emits no node, so a later edit adding a
 * sink here reddens a required lane instead of silently changing what it is.
 */

/** Nothing here reaches a stream. The value exists only to be asserted on. */
export const CENSUS_DRIFT_PROBE = {
  purpose: 'population moves, graph does not',
  issue: 4128,
};
