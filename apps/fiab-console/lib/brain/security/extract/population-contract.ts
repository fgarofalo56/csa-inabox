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
 *   3. {@link assertEveryEmitAccounted} — the PER-NODE ledger (#4027).
 *      Points 1 and 2 are per-FILE while the emitted unit is per-HANDLER, so a
 *      narrowing injected BELOW the loop — a `return` at the top of
 *      `emitAuthorizer` — dropped authorizer nodes while `candidates`, `judged`
 *      and both censuses stayed balanced. Measured on this tree before this
 *      contract existed, with the exact `if (a.file.path.includes('/admin/'))
 *      return;` #4027 names:
 *
 *          nodes          920 -> 722   (-198, 21.5% of the population)
 *          console BFF routes scope   706 -> 508 node(s)
 *          edges          174 -> 37
 *          inputsDigest   1a21ee345eb6e3a0 -> IDENTICAL
 *          filesScanned   2059             -> IDENTICAL
 *          skipped        251              -> IDENTICAL
 *          generator RC=0 · --check RC=0 ("OK — 722 nodes") · vitest RC=0 (114/114)
 *
 *      The ledger's denominator is the HANDLER ENUMERATION, which
 *      `findExportedHandlers` already returns, crossed with the emit KINDS the
 *      loop attempts. Every `(file, handler, kind)` triple must be accounted for
 *      by an emitted node or by a declared no-emit REASON.
 *
 * None is total, and the limits are stated rather than implied — with the
 * residual MEASURED rather than guessed at. Point 3 keys on "did anything come
 * out, and if not was a reason declared", so three mutation shapes were run
 * against the real tree:
 *
 *     A  `return;`                          -> ledger RC=1 (329 of 5280 emits
 *                                              unaccounted, /admin/ named)
 *     B  `return null;` (type-correct)      -> ledger RC=1, same message. The
 *                                              ledger counts the OUTPUT ARRAY,
 *                                              so returning "no reason" while
 *                                              pushing nothing does not balance.
 *     C  `return 'no-admin-claim-spelling';`-> the ledger BALANCES. This is the
 *                                              residual, and it is a deliberate
 *                                              false statement in a closed
 *                                              enumeration rather than a silent
 *                                              `return`. It is caught one layer
 *                                              over, by the positive assertion in
 *                                              `__tests__/population-contract.test.ts`
 *                                              that the `/admin/` corpus route
 *                                              EMITS its authorizer node
 *                                              (measured: vitest RC=1).
 *
 * The reason codes are a closed union validated at runtime so that the cheapest
 * evasion — inventing a plausible-sounding reason — is refused outright, leaving
 * only C, which requires knowingly mislabelling a subject with a code that means
 * something else.
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

/**
 * The CLOSED set of reasons an emit may legitimately produce nothing (#4027).
 *
 * Closed, and validated at runtime, on purpose. If a reason were free text, the
 * cheapest way past {@link assertEveryEmitAccounted} would be to invent one — so
 * the ledger would be defeated by the same edit that defeats a comment. Adding a
 * member here is a visible, reviewable act; returning a string that is not one is
 * refused.
 */
export const NO_EMIT_REASONS = [
  /** `emitAuthorizer`: the handler body names no admin-claim spelling. */
  'no-admin-claim-spelling',
  /** `emitVerdictCalls`: the handler body contains no verdict call. */
  'no-verdict-call',
] as const;

export type NoEmitReason = (typeof NO_EMIT_REASONS)[number];

/** One `(file, handler, kind)` triple the extractor attempted to emit for. */
export interface EmitLedgerEntry {
  /** `<file path>#<HTTP method>:<emit kind>` — unique per attempted emit. */
  readonly subject: string;
  /** How many nodes the emit actually pushed. Counted from the OUTPUT array. */
  readonly emitted: number;
  /**
   * Why nothing was emitted, when nothing was.
   *
   * `unknown` rather than `NoEmitReason | null` because the whole point is to
   * catch a function that returned something the type system would have refused
   * — a bare `return;` under a bundler that does not typecheck yields
   * `undefined`, and that must be a LOUD failure rather than a silent `null`.
   */
  readonly reason: unknown;
}

/**
 * Refuse an extraction where an attempted emit produced neither a node nor a
 * declared reason (#4027).
 *
 * WHY THE COUNT COMES FROM THE OUTPUT ARRAY AND NOT FROM THE RETURN VALUE. The
 * caller measures `nodes.length` before and after each emit and passes the
 * DIFFERENCE. A function that returns a reason while having pushed nodes, or
 * pushes nothing while returning nothing, is caught either way — the ledger never
 * takes the emit's word for what it did.
 */
export function assertEveryEmitAccounted(
  subject: string,
  ledger: readonly EmitLedgerEntry[],
): void {
  if (ledger.length === 0) {
    throw new Error(
      `[security-extract] ${subject}: the per-emit ledger is EMPTY. A ledger with no entries ` +
        'certifies nothing — it is the zero-population state this contract exists to refuse, ' +
        'one layer below the file walk.',
    );
  }

  const seen = new Set<string>();
  const unaccounted: string[] = [];
  const contradictory: string[] = [];
  const badReason: string[] = [];
  const allowed = new Set<string>(NO_EMIT_REASONS);

  for (const entry of ledger) {
    if (seen.has(entry.subject)) {
      throw new Error(
        `[security-extract] ${subject}: '${entry.subject}' appears twice in the per-emit ledger. ` +
          'A duplicate restores the total while leaving another emit unaccounted for.',
      );
    }
    seen.add(entry.subject);

    if (entry.emitted > 0) {
      // Emitting AND claiming a reason for not emitting is a contradiction. It is
      // refused rather than resolved in the ledger's favour, because whichever
      // half is wrong, the ledger is no longer describing what happened.
      if (entry.reason !== null && entry.reason !== undefined) {
        contradictory.push(`${entry.subject} (emitted ${entry.emitted}, reason ${String(entry.reason)})`);
      }
      continue;
    }

    if (typeof entry.reason !== 'string') {
      unaccounted.push(entry.subject);
      continue;
    }
    if (!allowed.has(entry.reason)) badReason.push(`${entry.subject} -> '${entry.reason}'`);
  }

  if (unaccounted.length > 0) {
    throw new Error(
      `[security-extract] ${subject}: ${unaccounted.length} of ${ledger.length} attempted emit(s) ` +
        `produced NO node and declared NO reason (${unaccounted.slice(0, 5).join(', ')}` +
        `${unaccounted.length > 5 ? ', …' : ''}). This is the #4027 shape: a narrowing below the ` +
        'file loop drops nodes while candidates, judged, filesScanned, skipped and inputsDigest ' +
        'all stay identical. Emit a node, or return one of: ' +
        `${NO_EMIT_REASONS.join(' | ')}.`,
    );
  }

  if (badReason.length > 0) {
    throw new Error(
      `[security-extract] ${subject}: ${badReason.length} attempted emit(s) declared a reason ` +
        `that is not in the closed set (${badReason.slice(0, 5).join(', ')}). Allowed: ` +
        `${NO_EMIT_REASONS.join(' | ')}. The set is closed so a skip cannot be laundered by ` +
        'inventing a plausible-sounding reason.',
    );
  }

  if (contradictory.length > 0) {
    throw new Error(
      `[security-extract] ${subject}: ${contradictory.length} emit(s) pushed nodes AND declared a ` +
        `no-emit reason (${contradictory.slice(0, 5).join(', ')}). The ledger is not describing ` +
        'what happened, so nothing it reports can be relied on.',
    );
  }
}
