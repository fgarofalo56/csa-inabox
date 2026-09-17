/**
 * Self-tests for check-bicepparam-compiled.mjs (#4466).
 *
 * WHAT VALUE WOULD MAKE EACH OF THESE FAIL — stated per test, per
 * `.claude/rules/assertion-design.md`. Every control below is chosen to DIE
 * under a specific, named mutation of the guard, and every arm with no kill
 * power is labelled as such rather than counted.
 *
 * ── THE ANCHOR IS PINNED TO A SHA, NOT TO `origin/main` ──────────────────────
 *
 * The first revision read `git show origin/main:…` — a MOVING ref. It was
 * correctly RED before the merge and would have been GREEN after it, failing
 * `assert.deepEqual(…, ['R2'])` and turning the REQUIRED `guardrails` context
 * red on main and on every PR opened afterwards. Two reviewers reproduced that
 * independently by pointing `refs/remotes/origin/main` at the fixed tree.
 * `PRE_FIX_SHA` below is immutable, so the fixture cannot drift out from under
 * the assertion — and {@link preFixWorkflow} additionally PROVES the fixture is
 * the pre-fix shape before any verdict is asserted about it, rather than
 * inferring that from the verdict it produces. Prior art for sha-pinning a
 * fixture in this directory: `release-please-dispatch-decision.test.mjs:653`.
 *
 * ── THE POPULATION ARMS ─────────────────────────────────────────────────────
 *
 * The second reviewer's finding was that every arm in the first revision
 * weakened the CHECK and none narrowed the POPULATION — the exact shape of the
 * defect #4466 reports. The `POPULATION:` tests below are that reviewer's seven
 * survivors plus the escapes from the other two findings, each reproduced here
 * as a mutation of the shipped workflow.
 *
 * Run: node --test scripts/ci/__tests__/bicepparam-compiled.test.mjs
 * (Auto-discovered by scripts/ci/check-node-test-suites.mjs, which the
 *  merge-blocking `guardrails` job runs — so these have teeth in CI.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  analyze,
  commandPositionMatches,
  enumerationLine,
  gitPathspecToRegExp,
  globToRegExp,
  jobsOf,
  pushTriggerPaths,
  stripComments,
  trackedBicepParams,
  triggerPaths,
  BUILD_PARAMS_HEAD,
  NEGATIVE_CONTROL_SENTINEL,
  PARAM_PATHSPEC,
  REPO_ROOT,
  WORKFLOW,
} from '../check-bicepparam-compiled.mjs';

const LIVE = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8');

/**
 * The same text, LF-normalised, used ONLY as the substrate for the mutation
 * controls below.
 *
 * `validate.yml` is CRLF in a Windows checkout and LF in CI, so a mutation
 * anchor written with `\n` matches on one platform and not the other — the
 * "a line guard no-ops on CRLF" trap, which bit this file once already.
 * `mutateLive` asserts its anchor was found precisely so that a silently
 * unapplied mutation can never masquerade as a passing control.
 *
 * `analyze` strips `\r` itself, so LF and CRLF substrates are equivalent inputs
 * to it; the POSITIVE control deliberately feeds it the RAW file so the real
 * line endings are exercised at least once.
 */
const LIVE_LF = LIVE.replace(/\r/g, '');
const PARAMS = trackedBicepParams();

/**
 * The one line five mutations share.
 *
 * Hoisted because the previous revision inlined it five times: any legitimate
 * reformat of the enumeration — for instance into the three-line backslash
 * continuation the sibling `.bicep` step uses, which the guard is explicitly
 * built to tolerate — reddened five tests with "mutation anchor not found",
 * a message that names nothing about the defect. That is the "could not pass"
 * direction of assertion-design.md, fired by a change that is not a defect.
 * Its presence is now pinned ONCE, below, with an explanation.
 */
const ENUMERATION_LINE = `          git ls-files -- '${PARAM_PATHSPEC}' > /tmp/bicepparam-files.txt`;

/** The immutable tree #4466 was measured against. */
const PRE_FIX_SHA = '0348d3715e6';

/** Violation codes present in a verdict, e.g. ['R2', 'R6']. */
const codesOf = (violations) => violations.map((v) => v.slice(0, 2));

/** Replace the first occurrence of `find` in the live workflow, asserting it was there. */
function mutateLive(find, replace) {
  assert.ok(
    LIVE_LF.includes(find),
    `mutation anchor not found in ${WORKFLOW}: ${JSON.stringify(find)}\n` +
      'If the enumeration line was legitimately reformatted, update ENUMERATION_LINE at the top of this file; ' +
      'this message means the mutation was NOT applied, so the arm below measured nothing.',
  );
  return LIVE_LF.replace(find, replace);
}

/** Mutate the enumeration line, the anchor five arms share. */
const mutateEnumeration = (replacement) => mutateLive(ENUMERATION_LINE, replacement);

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS. Without these, every negative control below is satisfied
// by a guard that flags everything unconditionally (assertion-design.md §4).
// ---------------------------------------------------------------------------

test('POSITIVE: the shipped validate.yml passes every rule', () => {
  const { violations, job } = analyze(LIVE, PARAMS);
  // FAILS IF: the `bicep-params` job is deleted, gated, narrowed, given an
  // exclusion, or loses its negative control or its reconciliation — i.e. any
  // regression of this PR.
  assert.deepEqual(violations, [], `expected a clean verdict, got:\n${violations.join('\n')}`);
  assert.equal(job, 'bicep-params');
});

test('POSITIVE: the enumeration line this file mutates is present verbatim', () => {
  // FAILS IF: the enumeration is reformatted or its pathspec changed. This is
  // the ONE place that fact is pinned; the five arms that mutate that line all
  // route through `mutateEnumeration`, so a legitimate reformat now reds here,
  // once, with a message that says what to do — instead of reddening five arms
  // with "anchor not found".
  assert.ok(
    LIVE_LF.includes(ENUMERATION_LINE),
    `the enumeration line moved. Update ENUMERATION_LINE in this file to match ${WORKFLOW}.`,
  );
});

test('POSITIVE: the tracked .bicepparam population is non-empty and includes il5', () => {
  // FAILS IF: `git ls-files -- ':(icase)*.bicepparam'` stops matching, which is
  // the corpus-drift case R1 exists for. Pinned to il5 specifically because it
  // is the file #4466 names as compiled by no gate and executed by no deploy.
  assert.ok(PARAMS.length > 0, 'no tracked .bicepparam files found at all');
  assert.ok(
    PARAMS.includes('platform/fiab/bicep/params/il5.bicepparam'),
    `il5.bicepparam missing from the population: ${PARAMS.join(', ')}`,
  );
});

// ---------------------------------------------------------------------------
// THE ANCHOR: the real pre-fix tree, at an IMMUTABLE sha.
// ---------------------------------------------------------------------------

/**
 * The pre-fix workflow, read from a fixed sha, with its SHAPE checked.
 *
 * @returns {string|null} null when the object is unreachable (shallow clone)
 */
function preFixWorkflow() {
  try {
    return execFileSync('git', ['show', `${PRE_FIX_SHA}:${WORKFLOW}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

test('ANCHOR: the guard is RED on the real pre-fix validate.yml, read at a FIXED sha', (t) => {
  const preFix = preFixWorkflow();
  if (preFix === null) {
    // A shallow clone is not a verdict about the guard. SKIP, never silently
    // pass — a swallowed failure here would be the "green over nothing" shape
    // #4466 is about. (`loom-guardrails.yml` checks out with fetch-depth: 0,
    // so in CI this path is not taken; both reviewers confirmed the anchor RAN.)
    t.skip(`${PRE_FIX_SHA}:${WORKFLOW} is not reachable in this checkout`);
    return;
  }

  // FIXTURE SHAPE CHECKED BEFORE THE VERDICT (assertion-design.md §3). If the
  // sha were ever repointed at a tree that already carries the fix, this says
  // so in one sentence instead of failing on a confusing deepEqual.
  const stripped = stripComments(preFix);
  assert.equal(
    commandPositionMatches(stripped, BUILD_PARAMS_HEAD),
    0,
    `${PRE_FIX_SHA} is supposed to be the PRE-FIX tree, but its validate.yml already runs bicep build-params. ` +
      'Re-point PRE_FIX_SHA at a commit before the bicep-params job landed.',
  );

  const { violations } = analyze(preFix, PARAMS);
  // FAILS IF: R2 is deleted, or `analyze` stops requiring an executable
  // build-params invocation. Measured on 0348d3715e6: exactly one violation,
  // R2, because that tree's validate.yml contains `build-params` nowhere.
  assert.deepEqual(codesOf(violations), ['R2'], `pre-fix verdict was: ${violations.join(' | ')}`);
  assert.match(violations[0], /nothing compiles any \.bicepparam/);
});

test('ANCHOR: the fixture is immutable — the same sha yields the same bytes twice', () => {
  const a = preFixWorkflow();
  if (a === null) return; // covered by the skip above
  const b = preFixWorkflow();
  // FAILS IF: someone re-points the anchor at a moving ref. A moving ref can
  // read the same twice in one process, so this is NOT a strong proof and is
  // NOT counted as one — DISCLOSED as documentation of intent. The real
  // protection is that PRE_FIX_SHA is a hex sha, pinned by the assertion below.
  assert.equal(a, b);
  assert.match(PRE_FIX_SHA, /^[0-9a-f]{7,40}$/, 'the anchor must be a sha, never a branch or a moving ref');
});

// ---------------------------------------------------------------------------
// R2 — a COMMENT must not satisfy the rule (#4467 class), and neither must a
// STRING.
// ---------------------------------------------------------------------------

/** The #4466 shape verbatim: build-params present, but only ever in comments. */
const COMMENTED_ONLY = [
  'name: t',
  'on:',
  '  push:',
  '    branches: [main]',
  '    paths:',
  "      - '**/*.bicepparam'",
  '  pull_request:',
  'jobs:',
  '  bicep-lint:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      # Proven with `az bicep build-params` on an unset env:',
  '      - name: Build every Bicep file',
  '        run: |',
  '          # bicep build-params type-checks the file in isolation',
  "          git ls-files '*.bicep' > /tmp/f.txt",
  '',
].join('\n');

test('R2: build-params mentioned ONLY in comments does not count as a compile', () => {
  const { violations } = analyze(COMMENTED_ONLY, PARAMS);
  // FAILS IF: `analyze` stops routing through stripComments (delete that call
  // and this control goes GREEN, because the two `#` lines contain the literal
  // string `build-params`). That is #4467 — a guard matching raw source is
  // satisfied by a comment — reproduced with the real comment text from
  // deploy-fiab-commercial.yml:1114 and loom-guardrails.yml:581.
  assert.ok(codesOf(violations).includes('R2'), `expected R2, got: ${violations.join(' | ')}`);
});

test('R2: the verb inside a STRING does not count as a compile either', () => {
  const mutated = mutateLive(
    'if ! out=$(bicep build-params "$f" --outfile "$OUT_DIR/$flat.json" 2>&1); then',
    'if ! out=$(echo "pretending to bicep build-params" 2>&1); then',
  );
  const { violations } = analyze(mutated, PARAMS);
  const r2 = violations.find((v) => v.startsWith('R2'));
  // FAILS IF: R2 reverts to `body.includes('build-params')`, OR if it stops
  // scoping the question to the ENUMERATING step. Measured by a reviewer
  // against the previous revision: this exact substitution left the guard rc=0
  // and the whole suite green while the step compiled NOTHING. Note that the
  // job-wide question is not enough on its own — the negative control in this
  // same job legitimately invokes the compiler twice on a sandbox copy, so a
  // job-scoped R2 stays satisfied by those. R2b asks the narrower question.
  assert.ok(r2, `expected R2, got: ${violations.join(' | ')}`);
  assert.match(r2, /never runs `bicep build-params` at a command position/);
});

test('R2: a decoy carrier job earlier in the file is a violation, not a redirect', () => {
  const mutated = mutateLive(
    '  bicep-params:\n',
    [
      '  decoy:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: not the real one',
      '        run: |',
      '          bicep build-params /dev/null --outfile /dev/null',
      '  bicep-params:',
      '',
    ].join('\n'),
  );
  const { violations } = analyze(mutated, PARAMS);
  // FAILS IF: R2 goes back to judging `carriers[0]` silently. A reviewer showed
  // that a decoy job placed before the real one made every later rule judge the
  // decoy's body, so a genuine exclusion in `bicep-params` went unexamined and
  // the guard returned rc=0.
  const r2 = violations.find((v) => v.startsWith('R2') && /2 jobs run/.test(v));
  assert.ok(r2, `expected a multi-carrier R2, got: ${violations.join(' | ')}`);
  assert.match(r2, /decoy/);
});

test('stripComments leaves a `#` inside quotes alone', () => {
  // FAILS IF: stripComments is simplified to `line.split('#')[0]` — the return
  // is then `        run: echo "a` and this assertion reds.
  assert.equal(stripComments('        run: echo "a#b"'), '        run: echo "a#b"');
  assert.equal(stripComments("        run: echo 'a#b' # gone"), "        run: echo 'a#b' ");
});

test('stripComments normalises CRLF away', () => {
  // FAILS IF: the fold stops splitting on `/\r?\n/` — the output then still
  // carries the carriage returns.
  //
  // DISCLOSED, NOT COUNTED: a whole-workflow CRLF-vs-LF verdict comparison has
  // NO kill power against that mutation today, because every regex in the guard
  // uses `\s` or `[^\n]`, both of which already tolerate `\r`. A reviewer ran
  // the full 16-arm matrix on both substrates and got identical verdicts,
  // confirming that. This assertion pins the normalisation itself so a future
  // line-anchored pattern cannot silently no-op on a Windows checkout.
  assert.ok(!stripComments('a: 1\r\nb: 2\r\n').includes('\r'));
});

// ---------------------------------------------------------------------------
// POPULATION — the seven narrowings that survived the first revision.
// Each keeps the check intact and shrinks WHAT gets compiled.
// ---------------------------------------------------------------------------

test('POPULATION P2: `head -n 1` + `mv` over the list file is caught', () => {
  const mutated = mutateEnumeration(
    `${ENUMERATION_LINE}\n          head -n 1 /tmp/bicepparam-files.txt > /tmp/x && mv /tmp/x /tmp/bicepparam-files.txt`,
  );
  const r5 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R5'));
  // FAILS IF: the R5 rewrite arm is deleted. Reviewer-measured against the
  // previous revision: compiled 1 of 17, guard rc=0, suite 19 pass 0 fail.
  assert.ok(r5, `expected R5, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
  assert.match(r5, /REWRITES the enumeration's list file/);
});

test('POPULATION P3: a POSITIVE grep keeping only the 7 fiab params is caught', () => {
  const mutated = mutateEnumeration(
    `          git ls-files -- '${PARAM_PATHSPEC}' | grep -E '^platform/fiab/bicep/params/' > /tmp/bicepparam-files.txt`,
  );
  const r5 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R5'));
  // FAILS IF: R5 goes back to hunting for `grep -v` shapes. This narrowing is
  // not an exclusion at all — it is an inclusion — which is why a denylist of
  // bad shapes could never have caught it and the rule is now an allowlist of
  // the ONE good shape. Reviewer-measured: compiled 7 of 17, guard rc=0.
  assert.ok(r5, 'a positive grep narrowing must be caught');
  assert.match(r5, /pipes or chains its enumeration/);
});

test('POPULATION P4: a SECOND `grep -v` after a harmless first is caught', () => {
  const mutated = mutateEnumeration(
    `          git ls-files -- '${PARAM_PATHSPEC}' | grep -v 'zzz-nothing' | grep -v 'params/il5' > /tmp/bicepparam-files.txt`,
  );
  const r5 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R5'));
  // FAILS IF: R5 reverts to `exclusionRegExp`, which used `.exec` and therefore
  // evaluated only the FIRST `grep -v` in the body — a one-call hole a reviewer
  // walked straight through (16 of 17 compiled, guard rc=0).
  assert.ok(r5, 'a second grep -v must be caught');
});

test('POPULATION P5: `grep -vF`, a spelling the old rule did not know, is caught', () => {
  const mutated = mutateEnumeration(
    `          git ls-files -- '${PARAM_PATHSPEC}' | grep -vF 'params/il5' > /tmp/bicepparam-files.txt`,
  );
  // FAILS IF: R5 is keyed to spellings again. -vF, unquoted -v, -v with a
  // regex, `awk`, `comm`, `perl -ne` — the denylist was always going to be
  // short by one, so the rule stopped enumerating bad shapes.
  assert.ok(analyze(mutated, PARAMS).violations.some((v) => v.startsWith('R5')), '`grep -vF` must be caught');
});

test('POPULATION P5b: an UNQUOTED `grep -v il5` is caught', () => {
  const mutated = mutateEnumeration(
    `          git ls-files -- '${PARAM_PATHSPEC}' | grep -v il5 > /tmp/bicepparam-files.txt`,
  );
  // FAILS IF: R5 requires a QUOTED argument, which the previous
  // `exclusionRegExp` did — the first reviewer measured `grep -v il5` as a
  // survivor for exactly that reason.
  assert.ok(analyze(mutated, PARAMS).violations.some((v) => v.startsWith('R5')), 'an unquoted grep -v must be caught');
});

test('POPULATION P6: `sed -i` over the list file is caught', () => {
  const mutated = mutateEnumeration(
    `${ENUMERATION_LINE}\n          sed -i '/params.il5/d' /tmp/bicepparam-files.txt`,
  );
  // FAILS IF: the rewrite arm only looks for `>` redirection. `sed -i` narrows
  // in place with no redirect at all. Reviewer-measured: 16 of 17, rc=0.
  assert.ok(analyze(mutated, PARAMS).violations.some((v) => v.startsWith('R5')), '`sed -i` must be caught');
});

test('POPULATION P7: `head -3` — a narrowing that is not an exclusion at all — is caught', () => {
  const mutated = mutateEnumeration(
    `          git ls-files -- '${PARAM_PATHSPEC}' | head -3 > /tmp/bicepparam-files.txt`,
  );
  // FAILS IF: R5 asks "is there an exclusion?" instead of "is this a bare
  // enumeration?". The first reviewer's header finding was precisely that the
  // guard CLAIMED to notice a narrowed enumeration while `head -3` passed.
  assert.ok(analyze(mutated, PARAMS).violations.some((v) => v.startsWith('R5')), '`head -3` must be caught');
});

test('POPULATION X4: piping the list into xargs instead of redirecting is caught', () => {
  const mutated = mutateLive(
    "          ' _ < /tmp/bicepparam-files.txt",
    "          ' _ ;\n          head -n 1 /tmp/bicepparam-files.txt | xargs -n1 true",
  );
  const r5 = analyze(mutated, PARAMS).violations.filter((v) => v.startsWith('R5'));
  // FAILS IF: the guard only judges the enumeration line and not how the list
  // reaches the compiler. `head -n 1 list | xargs …` compiled 1 of 17 with the
  // previous revision fully green.
  assert.ok(r5.length, `expected R5, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
  assert.ok(
    r5.some((v) => /pipes into xargs/.test(v)) || r5.some((v) => /never reads/.test(v)),
    `expected the pipe or the missing-redirect arm, got: ${r5.join(' | ')}`,
  );
});

test('POPULATION A5: a pathspec TYPO that matches nothing is caught', () => {
  const mutated = mutateEnumeration(
    "          git ls-files -- ':(icase)*.bicepparams' > /tmp/bicepparam-files.txt",
  );
  const r4 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R4'));
  // FAILS IF: R4 tests for the SUBSTRING `*.bicepparam`. `*.bicepparams`
  // contains it, so a substring test passes while git matches zero files — the
  // same substring-vs-glob confusion R6 was already built to avoid, on the
  // other side of the same job. Reviewer-measured as a survivor.
  assert.ok(r4, `expected R4, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
  assert.match(r4, /matches none of 17 tracked param file\(s\)/);
});

test('POPULATION A7/R8: deleting the reconciliation is a violation', () => {
  const mutated = LIVE_LF.split('ATTEMPTED').join('IGNORED_COUNT');
  assert.notEqual(mutated, LIVE_LF, 'the reconciliation was not present to remove');
  const r8 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R8'));
  // FAILS IF: R8 is deleted. DISCLOSED, in the same terms as R7: this arm is
  // EXISTENCE-ONLY. It notices the reconciliation being removed; it cannot tell
  // a working reconciliation from a declawed one. The kill power itself is
  // re-established by the job on every run, and is exercised in this PR's shell
  // matrix (ATTEMPTED != EXPECTED goes red there, on real files).
  assert.ok(r8, `expected R8, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
});

test('R8: one enumeration is not enough — the reconciliation needs an INDEPENDENT count', () => {
  const mutated = mutateLive(
    "          EXPECTED=$(git ls-files -- ':(icase)*.bicepparam' | wc -l)",
    '          EXPECTED=$(wc -l < /tmp/bicepparam-files.txt)',
  );
  const r8 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R8') && /TWO independent/.test(v));
  // FAILS IF: R8 accepts a reconciliation that counts the list file it just
  // wrote. That is the whole trap: a count derived from the narrowed list
  // agrees with the narrowed list, so the comparison passes while 1 of 17 is
  // compiled. This is the single most important arm in the file.
  //
  // It is also the arm that caught a defect in R8 itself: counting the
  // enumerations by SUBSTRING read THREE, because the step's own `::error::`
  // string contains the words "git ls-files" and ".bicepparam". Dropping to two
  // therefore still passed the `< 2` test, and this control was green against
  // the very mutation it names. R8 now counts COMMAND POSITIONS.
  assert.ok(r8, `expected the "TWO independent" R8, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
});

test('R8c: deleting the zero-population fail-closed check is a violation', () => {
  const mutated = mutateLive('          if [ "$COUNT" -eq 0 ]; then', '          if [ "$COUNT" -eq -1 ]; then');
  const r8 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R8') && /zero-population/.test(v));
  // FAILS IF: R8c is deleted. A reviewer measured that this check was required
  // by NO rule, so removing it was green everywhere — and it is NOT redundant
  // with the reconciliation, which was verified in the shell: on a genuinely
  // empty corpus ATTEMPTED and EXPECTED are BOTH zero and the reconciliation
  // agrees with itself. Only this arm distinguishes "nothing to do" from
  // "nothing was done". DISCLOSED: existence-only, like R7 and the R8 arm above.
  assert.ok(r8, `expected the zero-population R8, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
});

// ---------------------------------------------------------------------------
// R3 / R6 — the two measured escapes from "no PR can skip it".
// ---------------------------------------------------------------------------

test('R3: a JOB-level `if:` is a violation', () => {
  const mutated = mutateLive(
    '  bicep-params:\n    name: Bicep Params Compile\n',
    '  bicep-params:\n    name: Bicep Params Compile\n    if: false\n',
  );
  assert.ok(codesOf(analyze(mutated, PARAMS).violations).includes('R3'), 'a job-level if: must be caught');
});

test('R3: a STEP-level `if:` is a violation too', () => {
  const mutated = mutateLive(
    '      - name: Compile every tracked .bicepparam\n        run: |',
    '      - name: Compile every tracked .bicepparam\n        if: false\n        run: |',
  );
  const r3 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R3'));
  // FAILS IF: R3 anchors to four-space indent. A step `if:` sits at eight, so
  // the previous revision saw nothing: the step was skipped, the job was green,
  // and NOTHING was compiled. Reviewer-measured, guard rc=0, suite 19/0.
  assert.ok(r3, `expected R3, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
});

test('R3: the `!cancelled()` shape is still allowed', () => {
  const mutated = mutateLive(
    '      - name: Compile every tracked .bicepparam\n        run: |',
    '      - name: Compile every tracked .bicepparam\n        if: ${{ !cancelled() }}\n        run: |',
  );
  // FAILS IF: R3 rejects every `if:` without exception. That shape cannot skip
  // a step for a path reason — it only keeps it running after an earlier
  // failure — and `check-guardrails-observability.mjs` REQUIRES it elsewhere in
  // this repo, so it has to stay expressible. This is the boundary of R3.
  assert.deepEqual(analyze(mutated, PARAMS).violations, [], 'the !cancelled() shape must not be rejected');
});

test('R3: `needs:` in LIST form is a violation, not just the scalar spelling', () => {
  const mutated = mutateLive(
    '  bicep-params:\n    name: Bicep Params Compile\n',
    '  bicep-params:\n    name: Bicep Params Compile\n    needs: [changes]\n',
  );
  // FAILS IF: R3 matches `needs: changes` literally. `needs: [changes]` is the
  // same key in YAML's flow form, and a reviewer measured it as a survivor.
  assert.ok(codesOf(analyze(mutated, PARAMS).violations).includes('R3'), 'the list form of needs: must be caught');
});

test('R6: a `paths:` filter under pull_request is a violation', () => {
  const mutated = mutateLive('  pull_request:\n    branches: [main]', "  pull_request:\n    paths:\n      - 'docs/**'");
  const r6 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R6') && /pull_request/.test(v));
  // FAILS IF: R6 stays push-only. A `paths:` filter there stops the WHOLE
  // workflow on every PR — `Bicep Params Compile` included — and the previous
  // revision could not see it at all (guard rc=0, suite 19/0).
  assert.ok(r6, `expected a pull_request R6, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
});

test('R6: NO `paths:` under pull_request stays correct', () => {
  // FAILS IF: R6 is written as "pull_request must declare paths". Absence is
  // the reachable state and must not be flagged — this pins the boundary so the
  // arm above cannot be satisfied by rejecting everything.
  assert.deepEqual(analyze(LIVE_LF, PARAMS).violations, []);
  assert.equal(triggerPaths(stripComments(LIVE_LF), 'pull_request').length, 0);
});

test('R6: a typo in the push paths filter is caught, and a substring check would NOT catch it', () => {
  const mutated = mutateLive("      - '**/*.bicepparam'\n", "      - '**/*.bicepparams'\n");
  const r6 = analyze(mutated, PARAMS).violations.find((v) => v.startsWith('R6'));
  // FAILS IF: R6 is implemented as a string search. The typo'd pattern CONTAINS
  // the correct one as a prefix, so a substring check passes while the filter
  // matches nothing.
  assert.ok(r6, `expected R6, got: ${analyze(mutated, PARAMS).violations.join(' | ')}`);
  assert.match(r6, /matches none of \d+ tracked param file\(s\)/);
});

// ---------------------------------------------------------------------------
// The remaining rules, and the primitives, proven on known pairs.
// ---------------------------------------------------------------------------

test('R4: a hand-maintained file list instead of git ls-files is a violation', () => {
  const mutated = mutateEnumeration(
    '          printf "platform/fiab/bicep/params/il5.bicepparam\\n" > /tmp/bicepparam-files.txt',
  );
  // FAILS IF: the R4 arm is deleted. A hand list is how the NEXT param file
  // added to the repo silently leaves the population — the same shape as
  // `git ls-files '*.bicep'` never having matched `*.bicepparam`.
  assert.ok(codesOf(analyze(mutated, PARAMS).violations).includes('R4'), 'a hand list must be caught');
});

test('R4/R5: a CONTINUED enumeration is judged as the command the shell runs', () => {
  const mutated = mutateEnumeration(
    `          git ls-files \\\n            -- '${PARAM_PATHSPEC}' \\\n            > /tmp/bicepparam-files.txt`,
  );
  // FAILS IF: stripComments stops folding backslash continuations. R4's reader
  // needs `git ls-files`, the pathspec and the `>` on ONE logical line, and the
  // sibling `.bicep` step in this same workflow is written exactly this way —
  // so a physical-line reader reds a workflow that is entirely correct. The
  // false-RED direction of #3420; the false-GREEN direction is the next test.
  assert.deepEqual(
    analyze(mutated, PARAMS).violations,
    [],
    'a legitimately continued enumeration must still pass',
  );
});

test('R5: an exclusion hidden on a CONTINUATION line is still caught', () => {
  const mutated = mutateEnumeration(
    `          git ls-files -- '${PARAM_PATHSPEC}' \\\n            | grep -vE 'params/il5' \\\n            > /tmp/bicepparam-files.txt`,
  );
  // FAILS IF: the fold is removed. This is the false-GREEN direction of #3420,
  // and the way a real author would write it — the sibling `.bicep` step is
  // formatted precisely like this. Pairs with the test above: one direction
  // each, which is the pairing assertion-design.md §4 asks for.
  assert.ok(analyze(mutated, PARAMS).violations.some((v) => v.startsWith('R5')), 'a continued exclusion must be caught');
});

test('R7: deleting the negative control is a violation', () => {
  const mutated = LIVE_LF.split(NEGATIVE_CONTROL_SENTINEL).join('someOtherParamName');
  assert.notEqual(mutated, LIVE_LF, 'the sentinel was not present to remove');
  // FAILS IF: the R7 arm is deleted. DISCLOSED at the guard's site and here:
  // EXISTENCE-ONLY. It cannot distinguish a working negative control from a
  // declawed one — a reviewer confirmed that keeping the `::error::` message
  // while removing the teeth stays green — and it is NOT counted as evidence
  // the control has kill power. That evidence is produced by the job running
  // the control on every CI execution, and by this PR's shell matrix.
  assert.ok(codesOf(analyze(mutated, PARAMS).violations).includes('R7'), 'a deleted negative control must be caught');
});

test('R1: an empty param population is a hard failure, not a vacuous pass', () => {
  const { violations } = analyze(LIVE, []);
  // FAILS IF: R1 is deleted. With no population, R4, R5 and R6 are all
  // vacuously satisfied (nothing to exclude, nothing to reach), so a guard
  // without R1 would report the cleanest possible verdict at the precise moment
  // it had stopped watching anything.
  assert.deepEqual(codesOf(violations), ['R1'], `expected only R1, got: ${violations.join(' | ')}`);
});

test('globToRegExp: `**/` matches zero segments as well as many', () => {
  const re = globToRegExp('**/*.bicepparam');
  // FAILS IF: `**/` compiles to `.*/` (requiring at least one separator) — a
  // repo-root param file is then unreachable and R6 would pass a filter that
  // does not cover it.
  assert.ok(re.test('root.bicepparam'), 'repo-root file should match');
  assert.ok(re.test('platform/fiab/bicep/params/il5.bicepparam'), 'nested file should match');
  assert.ok(!re.test('platform/fiab/bicep/main.bicep'), '.bicep must not match a .bicepparam glob');
});

test("globToRegExp: the pre-existing '*.bicep' root pattern does not reach nested files", () => {
  const re = globToRegExp('*.bicep');
  // FAILS IF: `*` compiles to `.*` instead of `[^/]*`. This pins the
  // MEASUREMENT behind the push-trigger widening: the old `- '*.bicep'` entry
  // reached the repo root only, which is why 185 `.bicep` files under
  // platform/fiab/bicep/ — and 223 repo-wide — never triggered the workflow on
  // a push to main. (The "198" in an earlier revision of that comment was the
  // count of ALL TRACKED FILES under that directory, not of `.bicep` files;
  // corrected after review, measured three ways.)
  assert.ok(re.test('main.bicep'));
  assert.ok(!re.test('platform/fiab/bicep/main.bicep'));
});

test('gitPathspecToRegExp is a DIFFERENT dialect from the Actions glob', () => {
  // FAILS IF: the two are conflated — which happened while writing this guard.
  // A git pathspec with no `:(glob)` magic is fnmatch WITHOUT FNM_PATHNAME, so
  // its `*` crosses `/`; an Actions `paths:` glob's `*` does not. Judging the
  // pathspec with the Actions compiler declared all 17 tracked files
  // unreachable by a pathspec that demonstrably reaches them.
  assert.ok(gitPathspecToRegExp('*.bicepparam').test('platform/fiab/bicep/params/il5.bicepparam'));
  assert.ok(!globToRegExp('*.bicepparam').test('platform/fiab/bicep/params/il5.bicepparam'));
  // FAILS IF: `:(icase)` magic is not honoured — the case variant that is
  // invisible to a case-sensitive lens is the whole reason the job uses it.
  assert.ok(gitPathspecToRegExp(':(icase)*.bicepparam').test('x.BICEPPARAM'));
  assert.ok(!gitPathspecToRegExp('*.bicepparam').test('x.BICEPPARAM'));
});

test('commandPositionMatches tells a command from an argument', () => {
  // FAILS IF: the fragment splitter drops an operator this repo's shell uses —
  // each left-hand case below reaches the verb through a different one.
  assert.equal(commandPositionMatches('bicep build-params a', BUILD_PARAMS_HEAD), 1);
  assert.equal(commandPositionMatches('if ! bicep build-params a; then', BUILD_PARAMS_HEAD), 1);
  assert.equal(commandPositionMatches('out=$(bicep build-params a)', BUILD_PARAMS_HEAD), 1);
  assert.equal(commandPositionMatches('az bicep build-params --file a', BUILD_PARAMS_HEAD), 1);
  // FAILS IF: it goes back to a substring test — these three are how the verb
  // appears in this job WITHOUT compiling anything.
  assert.equal(commandPositionMatches('echo "pretending to bicep build-params"', BUILD_PARAMS_HEAD), 0);
  assert.equal(commandPositionMatches('printf "::error::bicep build-params failed"', BUILD_PARAMS_HEAD), 0);
  assert.equal(commandPositionMatches('echo "run bicep build-params yourself"', BUILD_PARAMS_HEAD), 0);
});

test('triggerPaths reads the right trigger and does not leak `branches:` items', () => {
  const patterns = pushTriggerPaths(stripComments(LIVE));
  // FAILS IF: the reader walks past `pull_request:` into another trigger's keys.
  assert.ok(patterns.includes('**/*.bicepparam'), `patterns were: ${patterns.join(', ')}`);
  assert.ok(patterns.includes('.github/workflows/**'));

  // A BLOCK-STYLE, QUOTED `branches:` — the fixture that makes the leak check
  // killable. In the LIVE substrate `branches: [main]` is an inline flow
  // sequence that no six-space `- 'x'` reader can capture, so asserting against
  // the live file alone would be un-killable; a reviewer flagged exactly that
  // as an undisclosed no-kill-power assertion. Here `- 'main'` IS a six-space
  // quoted item, so:
  // FAILS IF: triggerPaths stops tracking WHICH four-space key it is under and
  // treats any six-space `- 'x'` as a path. It would then return ['main', 'a'].
  const fixture = [
    'on:',
    '  push:',
    '    branches:',
    "      - 'main'",
    '    paths:',
    "      - 'a/**'",
    'jobs:',
  ].join('\n');
  assert.deepEqual(triggerPaths(fixture, 'push'), ['a/**']);
});

test('jobsOf finds the compile job and does not bleed into the next one', () => {
  const jobs = jobsOf(stripComments(LIVE));
  const body = jobs.get('bicep-params');
  // FAILS IF: jobsOf never flushes on the next `  <id>:` key — the body would
  // swallow `secret-scan`, and R3's `if:`/`needs:` probes would read another
  // job's keys. (`bicep-lint` carries `needs: changes` AND an `if:`, so a
  // bleeding reader would report a false R3 on a correct tree.)
  assert.ok(body, `bicep-params not found; jobs were: ${[...jobs.keys()].join(', ')}`);
  assert.ok(!body.includes('gitleaks'), 'job body bled into secret-scan');
  assert.ok(jobs.has('bicep-lint') && jobs.get('bicep-lint').includes('needs: changes'));
});

test('enumerationLine reads the list path and the pathspec out of the live job', () => {
  const e = enumerationLine(jobsOf(stripComments(LIVE)).get('bicep-params'));
  // FAILS IF: the reader mistakes the `>>`/`2>&1` forms for the output redirect,
  // or picks up a quoted string that is not a pathspec. Both would silently
  // disable R5's rewrite arm, since it keys on the list path it extracts here.
  assert.ok(e, 'no enumeration line found');
  assert.equal(e.listPath, '/tmp/bicepparam-files.txt');
  assert.deepEqual(e.pathspecs, [PARAM_PATHSPEC]);
});
