/**
 * COUNTERFACTUAL FIXTURE for #4128 — a file that moves the POPULATION without
 * moving the GRAPH.
 *
 * This module lives under `scripts/**`, so it is inside the publication scan
 * scope the artifact declares and it increments
 * `meta.scanScopes[].filesMatched`. It deliberately contains NO publication
 * construct — no write to a standard stream, no inherited descriptor, no
 * annotation or output call — so the extractor emits ZERO nodes from it and the
 * node and edge counts are byte-identical with and without it.
 *
 * That is the exact shape #4128 measured on PR #4127: the drift gate compared
 * only `{graph, join}`, so a file like this one slipped past it while the
 * required census in `no-estate-identifiers.test.ts` went red. Keeping the
 * fixture in the tree means the blind spot is reproducible on demand rather
 * than described in a commit message.
 *
 * It is imported by `scripts/ci/__tests__/security-graph-drift-shape.test.mjs`,
 * which asserts the two properties above so that a later edit adding a sink
 * here reddens a required lane instead of silently weakening the fixture.
 */

/** Nothing here reaches a stream. The value exists only to be asserted on. */
export const CENSUS_DRIFT_PROBE = {
  purpose: 'population moves, graph does not',
  issue: 4128,
};
