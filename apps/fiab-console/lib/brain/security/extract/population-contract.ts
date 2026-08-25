/**
 * LOOM BRAIN — SECURITY EXTRACTION: the population discipline, applied to the
 * EXTRACTOR's own walk.
 *
 * ── WHY THIS FILE EXISTS, MEASURED ────────────────────────────────────────
 *
 * `../population.ts` makes a DETECTOR unable to report a narrowed sweep as
 * clean. Nothing did the same for the PRODUCER, and on 2026-08-24 an independent
 * review measured the consequence. One `continue` on `/admin/` inside
 * `extractRouteNodes`, then regenerate:
 *
 *     nodes        909 -> 511   (-398, 43.8% of the population)
 *     authorizers  298 -> 103   (-65%)
 *     inputsDigest 4cb40cd4b109d5f5  -> IDENTICAL
 *     filesScanned 2041              -> IDENTICAL
 *     skipped      243               -> IDENTICAL
 *     generator RC=0 · --check RC=0 ("OK — 511 nodes") · vitest RC=0 (77/77)
 *
 * Every gate green, 44% of the estate gone. The digest is blind because the
 * INPUTS did not change; `--check` is blind because it compares the artifact to
 * what the same mutated extractor produces; the suite is blind because the only
 * assertion that could have moved is a named-instance test defending exactly one
 * route, and a narrowing that spares that route is invisible to it.
 *
 * That is `../population.ts`'s thesis one layer further out: the dominant evasion
 * is not an unguarded edge, it is falling outside the examined population. So the
 * extractor gets the same two structural answers the detectors already have.
 *
 *   1. {@link assertEveryCandidateJudged} — the `judged`-after-verdict contract.
 *      `c1-unauthorized-inbound-edge.ts:257-271` appends to `judged` ONLY after a
 *      verdict was produced, precisely so a loop-level `continue` makes
 *      `detectorResult()` throw. The extractor's walks now do the same: a file
 *      that entered the population and left it without a verdict — nodes emitted,
 *      or an explicit `SkippedSubject` — aborts the build.
 *
 *   2. {@link assertCensusAgrees} — an INDEPENDENT denominator.
 *      Point 1 compares `judged` against `candidates`, and both descend from the
 *      same loop, so neither can see a narrowing applied while `candidates` is
 *      being BUILT (a mutated `routePathOf` shrinks both together and the
 *      contract still balances). `population.ts` point 4 answers exactly this on
 *      the detector side by recomputing the population by a traversal that does
 *      not call `candidatesOfKind`. Same answer here: the caller recomputes the
 *      census with a DIFFERENT expression of the rule and the two must agree.
 *
 * Neither is total, and the limit is stated rather than implied: a narrowing
 * injected INSIDE the per-handler emit (below the loop, after the file is already
 * counted as judged) is invisible to both, exactly as C1 discloses for
 * `judgeAuthorizer`. What they close is the LOOP-LEVEL skip, which is the shape
 * that was actually measured escaping. The residual is tracked in #4027.
 */

/**
 * Refuse a walk that entered a subject into the population and produced no
 * verdict for it.
 *
 * `judged` must be a permutation of `candidates`. Duplicates are refused for the
 * same reason `join.ts#assertJoinCoversGraph` refuses them: a repeated entry
 * restores the total while leaving another subject unaccounted for, which is the
 * padded-list evasion with the count intact.
 */
export function assertEveryCandidateJudged(
  subject: string,
  candidates: readonly string[],
  judged: readonly string[],
): void {
  const seen = new Set<string>();
  for (const id of judged) {
    if (seen.has(id)) {
      throw new Error(
        `[security-extract] ${subject}: '${id}' was judged twice. A duplicate restores the ` +
          'count while leaving another subject unaccounted for.',
      );
    }
    seen.add(id);
  }

  const candidateSet = new Set<string>();
  for (const id of candidates) {
    if (candidateSet.has(id)) {
      throw new Error(
        `[security-extract] ${subject}: '${id}' entered the population twice. The extractor ` +
          'must enumerate each subject once, or the denominator is not a count of anything.',
      );
    }
    candidateSet.add(id);
  }

  const unjudged = candidates.filter((id) => !seen.has(id));
  if (unjudged.length > 0) {
    throw new Error(
      `[security-extract] ${subject}: ${unjudged.length} of ${candidates.length} subject(s) ` +
        `entered the population and left it WITHOUT a verdict (${unjudged.slice(0, 5).join(', ')}` +
        `${unjudged.length > 5 ? ', …' : ''}). A subject that is silently skipped shrinks the ` +
        'graph while every count that a reader checks — filesScanned, inputsDigest, skipped — ' +
        'stays identical. Emit nodes for it, or record a SkippedSubject naming the reason.',
    );
  }

  const foreign = [...seen].filter((id) => !candidateSet.has(id));
  if (foreign.length > 0) {
    throw new Error(
      `[security-extract] ${subject}: ${foreign.length} judged subject(s) were never enumerated ` +
        `as candidates (${foreign.slice(0, 5).join(', ')}). The population model is broken.`,
    );
  }
}

/**
 * Refuse an examined count that disagrees with a census computed independently
 * of the walk that produced it.
 *
 * `how` names the independent derivation, so a failure says WHICH two things
 * disagree rather than asserting a cause it did not establish
 * (`deploy-integrity.md` R7).
 */
export function assertCensusAgrees(
  subject: string,
  examined: number,
  census: number,
  how: string,
): void {
  if (examined === census) return;
  throw new Error(
    `[security-extract] ${subject}: examined ${examined} subject(s) but an independent census ` +
      `counts ${census} (${how}). The two disagree, so the scope this artifact REPORTS is not ` +
      'the scope it SCANNED. Refusing to write an artifact that overstates its own population.',
  );
}
