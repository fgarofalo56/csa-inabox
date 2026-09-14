/**
 * Build-stamp identity -- is a string a commit, and do two stamps name the SAME
 * commit? PURE: no Azure surface, no I/O beyond reading `LOOM_BUILD_SHA`.
 *
 * WHY THIS IS ITS OWN MODULE (#4498 round 4)
 * ------------------------------------------
 * Split out of `loom-docs-index.ts`, which this PR's round-4 commentary had
 * pushed to 1509 LOC -- back over the 1500-line threshold in
 * `scripts/ci/check-file-size.mjs` that round 4's FIRST split
 * (`docs-corpus-ranker.ts`) had just brought it under, at 1462. Re-reddening the
 * very guard a split was performed to fix is not a case for an allowlist entry:
 * that guard's escalation policy names splitting by bounded context as the
 * preferred fix and treats an entry as an exception request.
 *
 * Shaving the prose down to land on exactly 1500 was the other option and was
 * rejected. It satisfies the number rather than the rule, leaves zero headroom,
 * and would delete the measured reasoning that is the whole reason these three
 * functions are correct.
 *
 * This is a real bounded context rather than a convenient 100 lines: storage and
 * retrieval (what `loom-docs-index` owns) do not care what a commit is, and
 * NOTHING here imports from `lib/azure`. It is also the home the consolidation
 * in #4499 needs -- `GIT_OBJECT_ID` is currently declared four times across this
 * app, and a `lib/azure` module that neither reaches into `lib/admin` nor is
 * reached from it is where the shared copy can land without a cycle.
 *
 * `sameCommit` is NEW in this PR and under review; it is named here rather than
 * moved quietly, because a reviewer's verdict is pinned to the head it measured.
 * `GIT_OBJECT_ID`, `isBuildCommit` and `currentSourceCommit` move byte-for-byte
 * (extracted by script, not retyped); the only edits are the four `export`
 * keywords and one corrected copy-count, both called out in the round-4 message.
 */

/** A build stamp is a commit only if it has the SHAPE of one.
 *
 * `Dockerfile:41` and `:96` both declare `ARG LOOM_BUILD_SHA=unknown`, so any
 * image built without `--build-arg` ships the literal string `unknown` in that
 * env var. Treating it as a revision is not a cosmetic bug: two such replicas
 * "agree", the commit comparison engages, and freshness reports FRESH over a
 * corpus whose staged docs have changed -- a false green on the one gate that
 * exists to catch a stale index. Measured by a reviewer with otherwise
 * identical inputs: the commit path said `fresh (built from this revision
 * (unknown))` where the stat path said `stale`.
 *
 * This matches the SHAPE rather than enumerating spellings, because a spelling
 * list only rejects the placeholders someone thought to write down: an earlier
 * revision of this guard listed seven, and `n/a`, `dirty`, `<none>` and a bare
 * branch name all sailed through it. The `lib/admin` build-stamp parsers
 * already key on shape -- `lib/admin/estate-fleet.ts:141` and
 * `lib/admin/deploy-status.ts:272` are this same regex, character for
 * character, and `scripts/ci/__fixtures__/build-markers.json:128` is the
 * fixture that records `unknown` as unparseable and says every parser must drop
 * it. This was the one that did not.
 *
 * Round 4 correction: this paragraph claimed "EVERY other build-stamp parser in
 * this repo already keys on shape". That universal is false, and a reviewer
 * falsified it from inside this same app -- `lib/updates/readBuildMarker()`
 * parses `sha=` out of the very same /build-marker.txt and then discriminates
 * by SPELLING, `sha && sha !== 'unknown'`, in both its file branch and its
 * env-var fallback. That is the same defect class this guard exists to close
 * (and the same one as the classifier's `state === 'unknown'`): keying on a
 * sentinel's VALUE rather than its SHAPE, so it drops `unknown` and admits
 * `n/a`, `dirty` and a bare branch name. It is named here rather than quietly
 * softened into "the lib/admin parsers" because a future reader consolidating
 * these copies needs to know that one of them still has the bug. Fixing it is
 * out of scope for a roll fix; the claim is corrected now, the code is not.
 *
 * Counted, not recalled: `GIT_OBJECT_ID` is declared FOUR times in this app.
 * `lib/admin/estate-fleet.ts:141` EXPORTS it, so a shared import is available;
 * `lib/admin/deploy-status.ts:272` and
 * `app/api/admin/deploy-status/route.ts:170` each declined that import and kept
 * a private copy. This module is the fourth. An earlier revision of this
 * paragraph said "a third private copy" while naming only two sites -- the
 * right number over the wrong set, which is the same miscount-in-a-comment
 * this PR has now made twice. Consolidating all four is #4499, not a roll fix.
 *
 * The accepted width is 7-40 hex, which covers every value the repo actually
 * stamps. Counted, not estimated -- `grep -rn "LOOM_BUILD_SHA=" .github/workflows`
 * returns exactly six build-args, and they split three and three:
 *
 *   40 hex, `${{ github.sha }}`   build-fiab-images-acr-tasks.yml:447
 *                                 full-app-deploy-commercial.yml:613
 *                                 publish-ghcr-images.yml:111
 *    8 hex, `--short=8 HEAD`      console-bluegreen-roll.yml:375  (SHA set :275)
 *                                 gov-console-roll.yml:442        (SHA set :293)
 *                                 gov-build-images.yml:449    (SHA_TAG set :299)
 *
 * Both roll workflows are single-job, so the assignment above each build-arg is
 * the value it passes. 8 and 40 are both inside [7,40], so this has no false
 * negatives on any image the repo can currently produce. */
export const GIT_OBJECT_ID = /^[0-9a-f]{7,40}$/i;

export function isBuildCommit(value: string): boolean {
  return GIT_OBJECT_ID.test(value);
}

/** Do two build stamps name the SAME commit, allowing for abbreviation?
 *
 * #4498 round 4. The comparison this replaces was `currentCommit !==
 * indexedCommit`, which is only correct if every producer stamps the same
 * width -- and the table above proves they do not. Three stamp 40 hex and
 * three stamp `--short=8`, and the split is NOT by cloud, which is the trap:
 * `console-bluegreen-roll.yml:15` serves "Commercial + Gov" off a `cloud:`
 * input and stamps 8 hex for BOTH, while `full-app-deploy-commercial.yml:613`
 * and `build-fiab-images-acr-tasks.yml:447` stamp 40 hex for Commercial. So a
 * Commercial estate serves either width depending only on which producer last
 * built the image, and a blue/green roll puts mixed-width replicas alongside
 * each other BY CONSTRUCTION.
 *
 * Measured before the fix: `'deadbeef'` against `'deadbeef' + 'c'.repeat(32)`
 * -- the same commit, abbreviated -- returned
 * `{state:'stale', reason:'The index was built from deadbeef and this
 * revision serves deadbeefcccc.'}`. That is a FABRICATED revision gap, and it
 * is an R7 violation of the same family as the classifier defect this round
 * fixes: the code asserts "these are different revisions" when all it
 * established is "these strings differ in length". Downstream it is worse than
 * cosmetic -- the roll's own reindex gate reads this state, so it would refuse
 * a correctly-indexed corpus and time out.
 *
 * Prefix comparison is exactly git's own abbreviation rule. It is applied only
 * to values `isBuildCommit` already bounded to 7-40 hex, so the shortest
 * possible prefix is 7 hex (28 bits); git uses the same floor for the same
 * reason. `GIT_OBJECT_ID` carries the `i` flag, so the case fold is required
 * rather than defensive -- a stamp is accepted in either case and the two
 * producers need not agree on it. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

/** The staged source commit / build SHA, when the image genuinely stamps one.
 *
 * Returns null for anything that is not commit-shaped, which routes freshness
 * back to the stat comparison -- weaker across replicas, but weaker in the SAFE
 * direction: a replica-local fingerprint compared against a shared manifest
 * over-reports `stale` rather than under-reporting it. */
export function currentSourceCommit(): string | null {
  const raw = (process.env.LOOM_BUILD_SHA || '').trim();
  if (!raw) return null;
  if (!isBuildCommit(raw)) return null;
  return raw;
}
