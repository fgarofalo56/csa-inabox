#!/usr/bin/env node
/**
 * deploy-fiab-gcch: a DECLARED-PAUSED run must stand down COMPLETELY. (refs #4233)
 *
 * ── THE DEFECT THIS EXISTS TO CATCH ────────────────────────────────────────
 * The stand-down was PARTIAL. `Estate is DECLARED paused — this run measures
 * nothing` printed "This run is UNMEASURED, not clean", `Bicep what-if` and
 * `Provision` skipped on `steps.adx_preflight.outputs.estate_paused != 'true'`
 * — and three later steps were gated ONLY on `schedule || run_mode == 'full'`,
 * so they ran anyway. Run 33519232492 (2026-09-01) is the receipt:
 *
 *   ADX preflight                     success   estate_paused=true
 *   Estate is DECLARED paused         success   "UNMEASURED, not clean"
 *   Bicep what-if                     skipped
 *   Image preflight — Gov ACR …       success   ← opened the sovereign ACR firewall
 *   Image-tag revert gate             FAILURE   ← the run went red here
 *   Re-pin appImageTags               skipped   (only because the job had failed)
 *   Provision                         skipped
 *
 * So a run that declared it would measure nothing MUTATED the estate (the ACR
 * lease sets publicNetworkAccess=Enabled) and then failed. That is both halves
 * of deploy-integrity R7: the summary asserted something the run did not do,
 * and the red asserted a deploy problem on a deploy that never happened.
 *
 * ── WHY A DISPOSITION TABLE AND NOT A REGEX COUNT ──────────────────────────
 * scripts/ci/__tests__/estate-preflight.test.mjs already counts step-level
 * gates (`stepGates.length >= 3`). A COUNT cannot see the defect: at the head
 * this file was written against, three gates existed and three steps were
 * unguarded, and the count was satisfied. Population accounting is the fix —
 * every step after the declaration IN `deploy-validate` is named below with a
 * disposition, every top-level JOB is named in JOB_DISPOSITIONS, and an
 * unlisted member of either population FAILS. A new step or job cannot slip
 * past by being new.
 *
 * ── ROUND 2: THE POPULATION WAS THE WRONG POPULATION ───────────────────────
 * The first version of this file accounted for every STEP of `deploy-validate`
 * and then asserted, in the run summary, that the stand-down was complete. It
 * was not. `build-gov-images` is a separate JOB with no `estate_paused` clause
 * and no approval environment, and it calls gov-provision-streaming-migrate.yml
 * in `build-only` mode, which acquires the ACR firewall lease
 * (`publicNetworkAccess=Enabled` on the sovereign GCC-High registry) and
 * `az acr build`s loom-migrate + loom-risingwave into it. Measured on the
 * declared-paused schedule:
 *
 *   run 34138038567 (2026-09-07)  Build both images on the Gov ACR      success
 *                                 Release the ACR firewall lease        success
 *   run 33111419147 (2026-08-27)  same two steps                        success
 *
 * A step census cannot see a job. So `judgeJobs` accounts for the JOB
 * population too, and `build-gov-images` now carries the declaration-only gate
 * from the `pause-declaration` job. The lesson is the one this repo keeps
 * relearning: a complete enumeration of the wrong set reads exactly like a
 * complete enumeration.
 *
 * ── ROUND 4: THE GUARD WAS PRESENT AND THE OUTCOME WAS NOT ASSERTED ────────
 * Rounds 1-3 asserted that the right TEXT was in the right place. A reviewer
 * then found four ways to keep every substring and lose the effect, each
 * MEASURED green at 22 pass / 0 fail against the real workflow file:
 *
 *   1. Delete the single `exit 1` in the Teardown refusal. `refuse` checked
 *      only for /ESTATE_PAUSED/ and /::error::/ in the body — and `::error::`
 *      is an ANNOTATION, not a failure. A declared-paused sovereign estate
 *      gets torn down with a red note printed above the teardown.
 *   2. Drop the parentheses on a guarded `if:`. GitHub binds `&&` tighter than
 *      `||`, so `A || B && GUARD` is `A || (B && GUARD)` — inert on `schedule`,
 *      the exact trigger this file exists for, while `.includes(GUARD)` stays
 *      true.
 *   3. Rename the `pause-declaration` job's output key `declared:`.
 *   4. Replace that job's producing `run:` with `echo noop`.
 *      In 3 and 4 `needs.pause-declaration.outputs.declared` evaluates to EMPTY,
 *      `'' != 'true'` is TRUE, and the image phase opens the sovereign ACR on a
 *      declared pause. Round 3 caught only the third route to the same empty
 *      (a missing `needs:`).
 *
 * The fix is not four more spellings. Each assertion now names the OUTCOME the
 * text was standing in for: a refusal EXITS non-zero inside its own conditional
 * (refusalBlock), a guard is NECESSARY rather than merely present
 * (guardIsBinding, a paren-depth parse, not a substring), and the value a guard
 * reads is actually PUBLISHED by a job that actually computes it
 * (judgeGuardProducer, derived from JOB_GUARD so the two cannot drift).
 *
 * ── ROUND 5: THE OUT-OF-FRAME JUSTIFICATION WAS FALSE, AND THE HOLE WAS
 *    OCCUPIED ──────────────────────────────────────────────────────────────
 * Rounds 1-4 framed the step census as "every step AFTER the declaration", and
 * justified the exclusion of everything before it like this: "the ADX preflight
 * itself is the first thing that touches the estate and it is what produces the
 * verdict." A reviewer MEASURED that premise false. On this PR's own receipt run
 * 33519232492 (job 99896393942) the sovereign registry was opened THREE times
 * inside `deploy-validate`, and the FIRST of them was step 10 —
 * `Image preflight — never adopt a live app onto a missing tag` — which sat six
 * steps ABOVE the declaration with no `if:` at all and calls
 * scripts/csa-loom/preflight-image-tags.sh, which takes the ACR firewall lease
 * unconditionally:
 *
 *   step 10  Image preflight — never adopt …   success   ← NOT guarded, and it
 *     [acr-lease] HELD the ACR firewall lease on 'acrloomdcmt6cqoezlgs' … 75m
 *     [acr-lease] opening ACR … (publicNetworkAccess=Enabled, defaultAction=Allow)
 *     [acr-lease] ACR … VERIFIED locked        (~64s later)
 *   step 14  ADX preflight                     success   estate_paused=true
 *   step 15  Estate is DECLARED paused                   ← the verdict starts here
 *
 * So the summary's "this run neither opened the sovereign ACR's firewall" was
 * false for the same reason round 2's was — a complete enumeration of the wrong
 * set. And a probe inserting `az group delete -n rg-csa-loom-admin-usgovvirginia`
 * BEFORE the declaration passed 22/22, because the frame excluded it by
 * construction.
 *
 * THREE CHANGES, and only two are in this file. The step was MOVED below the
 * declaration and given the same verdict clause `Provision` carries (it is
 * gateable only there — `adx_preflight` is what produces the verdict), so it is
 * now inside the existing census. `leaseTakingSteps` DERIVES the set of steps
 * that reach the ACR firewall lease from the scripts each step actually
 * invokes, and asserts every one carries a binding guard — wherever in the job
 * it sits; that is the check the summary's run-scope claim now rests on,
 * replacing a substring match that could not tell a true enumeration from a
 * false one. And `PRE_DISPOSITIONS` ends the "inherently out of frame" clause
 * altogether: every step ABOVE the declaration is now named with a written
 * reason it is safe to run against an unmeasured estate, its body is scanned
 * for estate-mutating `az`, and the reviewer's `az group delete` probe FAILS.
 *
 * ── ROUND 6: FIXED FOR `needs.*`, UNFIXED FOR `steps.*` ────────────────────
 * Round 4 built judgeGuardProducer, which asserts the whole value chain behind
 * `needs.pause-declaration.outputs.declared`. Nothing asserted the chain behind
 * `steps.adx_preflight.outputs.estate_paused`. A reviewer MEASURED the cost by
 * deleting ONE line — the Teardown step's
 *
 *   ESTATE_PAUSED: ${{ steps.adx_preflight.outputs.estate_paused }}
 *
 * With it gone the shell is byte-identical, `${ESTATE_PAUSED:-}` is the empty
 * string, `'' = "true"` is false, the refusal branch is never taken and
 * `fiab-teardown.sh` destroys a declared-paused sovereign estate. Measured with
 * the line deleted: this suite 34 pass / 0 fail RC=0, estate-preflight.test.mjs
 * 78 pass / 0 fail RC=0, all five scripts/ci/check-* workflow guards RC=0. One
 * deleted line disarmed the lane's only destructive step with every guard in the
 * repo green — because refusalBlock reads the shell TEXT and stops at the text.
 *
 * Empty is the failure mode of every `steps.*.outputs.*` read exactly as it is
 * of every `needs.*.outputs.*` read, so the fix is the same shape and not one
 * more spelling. judgeVerdictReferences DERIVES the population from the parsed
 * YAML — every `if:` and every `env:` value in `deploy-validate` that names
 * `steps.<id>.outputs.<verdict>` — and asserts, per reference: the id belongs to
 * a step that exists in this job, and that step invokes the script that WRITES
 * the value (ensure-adx-cluster-running.mjs). The refuse disposition then adds
 * the half a census cannot see: the shell variable the refusal actually branches
 * on, extracted from the refusal itself, must be one the step's `env:` binds to
 * that verdict. Both ends are derived — the output name from GUARD, the variable
 * name from the shell — so a rename moves them together and only a genuine
 * disconnection goes red.
 *
 * The SAME hole existed one level up and is closed in the same pass, because
 * closing one instance of a class and leaving its twin is the shape this file's
 * own history is made of: `post-deploy-bootstrap` stands down on
 * `needs.deploy-validate.outputs.estate_paused`, and nothing asserted that
 * `deploy-validate` publishes it. judgeGuardProducer is now parameterised by the
 * clause and the producing script, and is applied to both.
 *
 * ── ROUND 7: THE REFUSAL READ THE TEXT AND STOPPED AT THE TEXT ─────────────
 * Round 6 closed the `env:` binding hole. A reviewer then found three more ways
 * to disarm the SAME four-line refusal, each a single-line edit of the real
 * workflow, each MEASURED green: this suite 39 pass / 0 fail RC=0, the sibling
 * estate-preflight 78/78 RC=0, and nine `scripts/ci/check-*` workflow guards
 * RC=0. Byte deltas +44 / +28 / **+0**.
 *
 *   E1  Conjoin the condition with `[ "${LOOM_REFUSE_TEARDOWN:-}" = "true" ]`,
 *       a name nothing anywhere binds. It is the empty string on every run, so
 *       the AND is false on every run and the refusal never fires. Round 6
 *       permitted this ON PURPOSE, reasoning that requiring every name to be
 *       bound "would forbid `[ "$ESTATE_PAUSED" = true ] && [ "$X" ]`". It
 *       would not — requiring every name to be a KEY OF THE STEP'S `env:` still
 *       permits that conjunction whenever `X` is a real env key. Round 6's own
 *       justification for the weak form was the thing that was wrong.
 *   E3  Insert `ESTATE_PAUSED=""` immediately above the branch. The `env:`
 *       binding survives untouched, so round 6's chain check is satisfied; the
 *       VALUE does not survive.
 *   E4  Move the four-line refusal BELOW `bash .github/scripts/fiab-teardown.sh`.
 *       **A pure reorder — zero bytes changed.** It still refuses, it still
 *       exits 1, the log is byte-identical; the estate is already gone when it
 *       does. The same "a move into another position" class this repo has been
 *       burned by before, and the mirror image of round 4's mutant A ("torn down
 *       with a red note printed above the teardown") with the order inverted.
 *
 * E1 and E3 are still assertions about the TEXT. Only E4's fix asserts the
 * OUTCOME — that the refusal is REACHED before control reaches anything
 * destructive — and the destructive set is derived from the SHAPE of the call
 * (a `.sh` handed to a shell, or a MUTATING_AZ write), never from the filename,
 * so renaming the script does not move the refusal back above it.
 *
 * The round-7 nit, fixed in the same pass: `refusalBlock` anchored on
 * `/^ *if .*ESTATE_PAUSED/` — a hardcoded variable name sitting directly above
 * code that derives that same name out of the shell precisely so it is not
 * hardcoded. It now anchors on the shape (`if` … `$VAR`), which is also
 * fail-closed: a decoy conditional planted above the real refusal is what gets
 * returned, and it has no exit in it. The redundant `/ESTATE_PAUSED/` substring
 * check in the `refuse` branch went with it — "the word appears somewhere in the
 * step" is implied by "the variable the refusal branches on is bound by `env:`
 * to the verdict", and the second is derived.
 *
 * ── SCOPE, AND WHAT IS STILL OUTSIDE IT ────────────────────────────────────
 * Stated because the round-1 header said "EVERY step after the declaration",
 * and that was only ever true of ONE job. Precisely what this file frames:
 *
 *   IN FRAME  every top-level job of deploy-fiab-gcch (judgeJobs), and every
 *             step of `deploy-validate` that follows the declaration step
 *             (judge). `parseSteps` anchors on `^  deploy-validate:` and sees
 *             no other job's steps.
 *   IN FRAME  an `exempt` disposition with no reason, and an `exempt` step or
 *             job whose body makes a MUTATING `az` call (see MUTATING_AZ) —
 *             added in round 3, because before it `exempt` asserted nothing at
 *             all and rewriting `Note dry-run completion` to `az group delete`
 *             kept the suite green.
 *   IN FRAME  whether a guard that is PRESENT actually BINDS (guardIsBinding),
 *             whether a refusal actually REFUSES (refusalBlock), and whether
 *             the job-level guard's value is PUBLISHED at all
 *             (judgeGuardProducer) — round 4.
 *   IN FRAME  every step of `deploy-validate` that reaches the ACR firewall
 *             lease, wherever it sits relative to the declaration
 *             (leaseTakingSteps) — round 5. The set is DERIVED from the scripts
 *             each step invokes, so a new lease taker is in frame the day it is
 *             added, and a step that stops taking the lease leaves on its own.
 *   IN FRAME  every step BEFORE the declaration (PRE_DISPOSITIONS) — round 5.
 *             It cannot be gated, because the verdict does not exist yet, so
 *             what is asserted is accounting: a named entry with a written
 *             reason, and no estate-mutating `az` in the body. A new step
 *             inserted up there FAILS until someone writes that reason down.
 *   IN FRAME  the VALUE CHAIN behind every `steps.<id>.outputs.<verdict>` read
 *             in `deploy-validate` — in an `if:` or an `env:` — and the binding
 *             the Teardown refusal's shell variable actually arrives through
 *             (judgeVerdictReferences, and the refuse branch of judge) — round 6.
 *   IN FRAME  whether the refusal is REACHED — every name its condition reads is
 *             a key of the step's `env:`, nothing above the branch reassigns the
 *             verdict variable, and the block sits ABOVE the first destructive
 *             handoff in the same run: body (destructiveHandoffAt) — round 7.
 *   OUT OF FRAME  whether the guard is CORRECT — that the ADX preflight really
 *             sets `estate_paused`, and that the register really says what the
 *             operator meant. That is estate-preflight.test.mjs's population,
 *             not this one's; this file asserts that the verdict, whatever it
 *             is, reaches every member of both populations.
 *   OUT OF FRAME  the steps of `precheck` and `pause-declaration`. Both are
 *             `exempt` JOBS, so the mutating-`az` scan runs over their whole
 *             body — but they are not step-dispositioned individually.
 *   OUT OF FRAME  the reusable workflow `build-gov-images` calls. Its contents
 *             are gov-provision-streaming-migrate.yml's business; what this
 *             file pins is that the CALL does not happen on a declared pause.
 *   OUT OF FRAME  a mutation reached through a SCRIPT FILE, an `actions/*` step
 *             or a REST call, from a pre-declaration step — the lease census is
 *             the one script-following exception, and it follows one script for
 *             one mutation. NOT "inherently": round 5 deleted that word, having
 *             measured it false. This is a real residual, and the written reason
 *             each pre-declaration entry carries is what a human reads instead.
 *
 * ── SEAM ───────────────────────────────────────────────────────────────────
 * LOOM_GCCH_WORKFLOW_PATH overrides the workflow read, so the RED half of this
 * ratchet is reproducible against any commit:
 *   git show <sha>:.github/workflows/deploy-fiab-gcch.yml > /tmp/head.yml
 *   LOOM_GCCH_WORKFLOW_PATH=/tmp/head.yml node --test <this file>
 *
 * Run: node --test scripts/ci/__tests__/gcch-standdown-completeness.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, loadRegister, parseArgs } from '../estate-pause-declared.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_WF = path.join(REPO_ROOT, '.github', 'workflows', 'deploy-fiab-gcch.yml');

/** The estate-pause stand-down clause, verbatim. */
const GUARD = "steps.adx_preflight.outputs.estate_paused != 'true'";
/** The JOB-level clause, which reads the declaration alone (no Azure). */
const JOB_GUARD = "needs.pause-declaration.outputs.declared != 'true'";
/**
 * Where JOB_GUARD's value has to come from — DERIVED from the clause itself, so
 * the guard and the thing that checks its producer cannot drift apart.
 */
const GUARD_SOURCE = /needs\.([\w-]+)\.outputs\.([\w-]+)/.exec(JOB_GUARD);
const PRODUCER_JOB = GUARD_SOURCE[1];
const PRODUCER_OUTPUT = GUARD_SOURCE[2];
/** The script that computes the declaration half with no Azure credential. */
const PRODUCER_SCRIPT = 'estate-pause-declared.mjs';
/**
 * The STEP-level half of the same derivation (round 6). `steps.*.outputs.*` goes
 * empty exactly the way `needs.*.outputs.*` does, and an empty verdict inverts
 * every reader of it. Derived from GUARD so the clause and the chain assertion
 * behind it cannot drift apart.
 */
const STEP_GUARD_SOURCE = /steps\.([\w-]+)\.outputs\.([\w-]+)/.exec(GUARD);
const VERDICT_OUTPUT = STEP_GUARD_SOURCE[2];
/** The script that computes the observed half — the one that writes the value. */
const VERDICT_SCRIPT = 'ensure-adx-cluster-running.mjs';
/** The declaration step every disposition below is measured relative to. */
const DECLARATION_STEP = 'Estate is DECLARED paused — this run measures nothing';
/** The job whose steps `parseSteps` walks and `judge` dispositions. */
const STEP_JOB = 'deploy-validate';

function workflowText() {
  // NORMALISED. `.github/workflows/**` is checked in CRLF here (measured: 1544
  // CRLF, 0 bare LF), and a `\n`-anchored regex silently matches nothing
  // against it — a guard that reads as "compliant" because it found no lines
  // at all is the shape this repo keeps re-finding.
  return readFileSync(process.env.LOOM_GCCH_WORKFLOW_PATH || DEFAULT_WF, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Blank the CONTENT of single-quoted literals, length-preserved, so a `(`, `)`
 * or `|` inside a string cannot be read as expression structure.
 *
 * @param {string} expr
 * @returns {string}
 */
function blankLiterals(expr) {
  let out = '';
  let inStr = false;
  for (const c of String(expr)) {
    if (c === "'") {
      inStr = !inStr;
      out += c;
      continue;
    }
    out += inStr && '()|&'.includes(c) ? '_' : c;
  }
  return out;
}

/**
 * Split `expr` on a TOP-LEVEL (paren depth 0) doubled operator.
 *
 * @param {string} expr
 * @param {'|'|'&'} op
 * @returns {string[]}
 */
function splitTopLevel(expr, op) {
  const src = String(expr).trim();
  const scan = blankLiterals(src);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < scan.length; i += 1) {
    const c = scan[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && c === op && scan[i + 1] === op) {
      parts.push(src.slice(start, i));
      i += 1;
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * The TOP-LEVEL disjuncts (paren depth 0) of a GitHub `if:` expression, with any
 * `${{ }}` wrapper stripped.
 *
 * @param {string} expr
 * @returns {string[]}
 */
export function topLevelDisjuncts(expr) {
  return splitTopLevel(stripWrapper(expr), '|');
}

/**
 * Strip a `${{ … }}` wrapper and surrounding whitespace.
 *
 * @param {string} expr
 * @returns {string}
 */
function stripWrapper(expr) {
  return String(expr)
    .trim()
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
}

/**
 * Does the leading `(` of `t` close on its LAST character?
 *
 * @param {string} t
 * @returns {boolean}
 */
function isFullyParenthesised(t) {
  if (!t.startsWith('(') || !t.endsWith(')')) return false;
  const scan = blankLiterals(t);
  let depth = 0;
  for (let i = 0; i < scan.length; i += 1) {
    if (scan[i] === '(') depth += 1;
    else if (scan[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === scan.length - 1;
    }
  }
  return false;
}

/**
 * Evaluate `expr` under the assignment "the guard atom is FALSE, EVERY other
 * atom is TRUE" — i.e. is there any way for this `if:` to be satisfied WITHOUT
 * the guard?
 *
 * Maximally permissive on purpose: an atom this parser does not understand is
 * assumed TRUE, so an unrecognised spelling can only ever make the expression
 * look MORE satisfiable, never less. The check that consumes this then fails
 * closed.
 *
 * @param {string} expr
 * @param {string} guard
 * @returns {boolean}
 */
export function satisfiableWithoutGuard(expr, guard) {
  const src = stripWrapper(expr);
  if (src.length === 0) return true;
  const ors = splitTopLevel(src, '|');
  if (ors.length > 1) return ors.some((o) => satisfiableWithoutGuard(o, guard));
  const ands = splitTopLevel(src, '&');
  if (ands.length > 1) return ands.every((a) => satisfiableWithoutGuard(a, guard));
  let t = src;
  let negated = false;
  while (t.startsWith('!')) {
    negated = !negated;
    t = t.slice(1).trim();
  }
  if (isFullyParenthesised(t)) return negated !== satisfiableWithoutGuard(t.slice(1, -1), guard);
  // The atom. The guard reads FALSE; anything else reads TRUE.
  return negated !== !t.includes(guard);
}

/**
 * Is `guard` NECESSARY for this `if:` to be true?
 *
 * ROUND 4, on a review finding, and the reason this is a PARSE and not a
 * `.includes()`. GitHub binds `&&` tighter than `||`, so
 *
 *   A || B && GUARD      parses as      A || (B && GUARD)
 *
 * and on `schedule` — the exact trigger this whole stand-down exists for — the
 * left disjunct is true on its own and the guard is never evaluated. MEASURED
 * before this check existed: drop the parentheses from the `Image preflight`
 * if: and the suite stayed at 22 pass / 0 fail, because `step.if.includes(GUARD)`
 * was still true. A guard can be PRESENT and INERT, and a substring test cannot
 * tell the two apart — this is the narrow bypass that keeps every spelling.
 *
 * ROUND 8, on a review finding, and the reason it is now an EVALUATION rather
 * than a top-level-disjunct membership test. Membership at depth 0 is NECESSARY
 * and not SUFFICIENT: the reviewer rewrote the image-tag revert gate — the step
 * whose failure produced the incident this PR fixes — to
 *
 *   (github.event_name == 'schedule' || inputs.run_mode == 'full')
 *     && (steps.adx_preflight.outputs.estate_paused != 'true'
 *         || github.event_name == 'schedule')
 *
 * which has exactly ONE top-level disjunct, that disjunct contains the guard,
 * `guardIsBinding` said true, and the suite stayed at 45 pass / 0 fail — while
 * the guard is inert on `schedule`, the exact trigger the stand-down exists for.
 * A guard nested inside a disjunction inside a conjunct is as dead as one at the
 * top level, and the same bypass applied to `job-guard`, `out-guard` and
 * `via-provision`.
 *
 * What is asserted is therefore the semantic property directly, not a spelling
 * and not a shape: NO truth assignment satisfies the `if:` with the guard false.
 * `(a && G) || (b && G)` passes, `a || b && G` fails, and so does
 * `(a || b) && (G || c)`.
 *
 * @param {string} ifExpr
 * @param {string} guard
 * @returns {boolean}
 */
export function guardIsBinding(ifExpr, guard) {
  if (!String(ifExpr).includes(guard)) return false;
  return !satisfiableWithoutGuard(ifExpr, guard);
}

/**
 * @param {'step'|'job'} kind
 * @param {string} name
 * @param {string} ifExpr
 * @param {string} guard
 * @returns {string}
 */
function inertGuardProblem(kind, name, ifExpr, guard) {
  return (
    `${kind} '${name}' CONTAINS \`${guard}\` but the guard is INERT: there is a truth assignment that satisfies ` +
    `\`${ifExpr}\` with the guard FALSE, so the step runs without ever needing it — on 'schedule', the exact ` +
    'trigger this stand-down exists for. GitHub binds && tighter than ||, and a guard nested inside a ' +
    'disjunction inside a conjunct is as dead as one at the top level. Make the guard a conjunct of the ' +
    'whole condition.'
  );
}

/**
 * The first shell conditional in a step body that branches on a shell VARIABLE,
 * with the line indices it spans — or null when there is no such conditional
 * (or it is never closed).
 *
 * ROUND 4, on a review finding. The `refuse` disposition checked only that the
 * body mentioned ESTATE_PAUSED and printed `::error::` — and `::error::` is an
 * ANNOTATION, not a failure. MEASURED: delete the single `exit 1` inside the
 * Teardown refusal and the suite stayed at 22 pass / 0 fail, while a declared-
 * paused sovereign estate would be torn down with a red annotation printed
 * above the teardown. What has to be asserted is the OUTCOME — the refusal
 * refuses — so the exit has to be inside THIS block and not merely somewhere
 * in the step.
 *
 * ROUND 7, on a review nit: the anchor used to be `/^ *if .*ESTATE_PAUSED/`, a
 * hardcoded variable name sitting directly above code that derives that same
 * name out of the shell precisely so it is not hardcoded. It now anchors on the
 * SHAPE — the first `if` that reads any `$VAR` — and the caller decides whether
 * the variable it found is the one carrying the verdict. Anchoring earlier is
 * fail-CLOSED: a decoy `if [ "$X" ]` planted above the real refusal makes this
 * return the decoy, which then has no `exit` in it and goes red.
 *
 * `start` and `end` are indices into `String(body).split('\n')`, so a caller can
 * ask where the block sits RELATIVE to the destructive call — the E4 mutation
 * (move the refusal below the teardown; +0 bytes, pure reorder) is invisible to
 * anything that only reads the block's text.
 *
 * @param {string} body
 * @returns {{text:string, start:number, end:number}|null}
 */
export function refusalBlock(body) {
  const lines = String(body).split('\n');
  const at = lines.findIndex((l) => /^\s*if\s.*\$\{?[A-Za-z_]/.test(l));
  if (at < 0) return null;
  let depth = 0;
  const out = [];
  for (let i = at; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^if\s/.test(t)) depth += 1;
    out.push(lines[i]);
    if (/^fi\b/.test(t)) {
      depth -= 1;
      if (depth <= 0) return { text: out.join('\n'), start: at, end: i };
    }
  }
  return null;
}

/**
 * The value stood in for a name whose runtime content this file does not model:
 * non-empty, and equal to no literal anyone would write in a verdict test.
 */
const UNMODELLED = 'unmodelled';

/**
 * Split a shell condition into words, dropping quote characters. Quoting is
 * irrelevant to the comparison `[ "$X" = "true" ]` performs, and keeping it
 * would only mean unquoting again at every use.
 *
 * @param {string} expr
 * @returns {string[]}
 */
function shellWords(expr) {
  const out = [];
  let cur = '';
  let quoted = false;
  let q = null;
  for (const ch of String(expr)) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      quoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur !== '' || quoted) out.push(cur);
      cur = '';
      quoted = false;
      continue;
    }
    cur += ch;
  }
  if (cur !== '' || quoted) out.push(cur);
  return out;
}

/**
 * Substitute `$NAME`, `${NAME}` and `${NAME:-default}` from `values`, or return
 * null when the word uses a parameter expansion this evaluator does not model.
 * Null is FAIL-CLOSED: the caller reports "not evaluable", never "fine".
 *
 * @param {string} word
 * @param {Map<string,string>} values
 * @returns {string|null}
 */
function expandWord(word, values) {
  const out = String(word).replace(
    /\$\{([A-Za-z_]\w*)(?::-([^}]*))?\}|\$([A-Za-z_]\w*)/g,
    (_m, braced, dflt, bare) => {
      const name = braced || bare;
      const v = values.has(name) ? values.get(name) : UNMODELLED;
      return dflt !== undefined && v === '' ? dflt : v;
    },
  );
  return out.includes('$') ? null : out;
}

/**
 * Evaluate one `[ … ]` test's inner words. Null means "shape not modelled".
 *
 * @param {string[]} words already expanded
 * @returns {boolean|null}
 */
function evalTest(words) {
  if (words.length === 1) return words[0] !== '';
  if (words.length === 2 && words[0] === '-n') return words[1] !== '';
  if (words.length === 2 && words[0] === '-z') return words[1] === '';
  if (words.length === 3 && (words[1] === '=' || words[1] === '==')) return words[0] === words[2];
  if (words.length === 3 && words[1] === '!=') return words[0] !== words[2];
  return null;
}

/**
 * Does the refusal's condition evaluate TRUE when every VERDICT it reads is the
 * EMPTY STRING?
 *
 * ROUND 9, on a review finding. Everything rounds 4-8 assert about this
 * conditional is about its BINDINGS and its POSITION — that each name is an
 * `env:` key, that at least one producer cannot decline to produce, that
 * nothing reassigns it, that the branch precedes the handoff. Not one of them
 * reads the condition's POLARITY, so two edits of the real workflow left
 * `judge()` returning `[]`:
 *
 *   `[ "${ESTATE_DECLARED:-}" != "false" ]` → `= "true"`   (−2 B)
 *   `||` between the two conditions        → `&&`          (+0 B)
 *
 * Both restore the round-8 defect: on `topology=dlz-attach` the ADX preflight
 * returns before writing `estate_paused`, so `ESTATE_PAUSED` is empty, and on
 * either mutant an empty pair of verdicts stops being a refusal. The suite went
 * red on both only because ONE fixture regex at the R8 mutation test pins the
 * literal text of the second conjunct — coincidence, not design, and exactly
 * the fixture-spelling brittleness round 8 recorded.
 *
 * The property asserted here is the OUTCOME the whole refusal exists for: an
 * UNKNOWN verdict must refuse. Empty is what every one of these verdicts
 * collapses to when its producer declines — a step that returns early, a job
 * that is skipped, an output that is never written — so "all verdicts empty" is
 * the state the refusal has to be fail-CLOSED against. Names that are not
 * verdicts keep a non-empty UNMODELLED stand-in rather than being forced empty,
 * so a legitimate second conjunct on a real env key (`[ -n "${RG_NAME:-}" ]`)
 * stays green; anything this evaluator cannot model is reported as
 * not-evaluable rather than assumed correct.
 *
 * @param {string} condition the `if …; then` line, as written
 * @param {Map<string,string>} values name → value to evaluate under
 * @returns {{fires:boolean}|{unevaluable:string}}
 */
export function refusalFiresWhenVerdictsUnknown(condition, values) {
  const expr = String(condition)
    .trim()
    .replace(/^if\s+/, '')
    .replace(/;\s*then\s*$/, '')
    .trim();
  const words = shellWords(expr);
  if (words.length === 0) return { unevaluable: 'the condition is empty' };
  let result = null;
  let op = null;
  let i = 0;
  while (i < words.length) {
    let negate = false;
    while (words[i] === '!') {
      negate = !negate;
      i += 1;
    }
    const close = words[i] === '[' ? ']' : words[i] === '[[' ? ']]' : null;
    if (!close) return { unevaluable: `expected a \`[\` test, found \`${words[i]}\`` };
    i += 1;
    const inner = [];
    while (i < words.length && words[i] !== close) {
      inner.push(words[i]);
      i += 1;
    }
    if (i >= words.length) return { unevaluable: `unterminated \`${close === ']' ? '[' : '[['}\` test` };
    i += 1;
    const expanded = inner.map((w) => expandWord(w, values));
    if (expanded.some((w) => w === null)) {
      return { unevaluable: `an unmodelled parameter expansion in \`${inner.join(' ')}\`` };
    }
    const v = evalTest(expanded);
    if (v === null) return { unevaluable: `an unmodelled test shape \`${inner.join(' ')}\`` };
    const value = negate ? !v : v;
    // `&&` and `||` are equal precedence and left-associative in sh, which is
    // exactly what evaluating in sequence does.
    result = op === null ? value : op === '||' ? result || value : result && value;
    if (i < words.length) {
      if (words[i] !== '||' && words[i] !== '&&') {
        return { unevaluable: `expected \`||\` or \`&&\`, found \`${words[i]}\`` };
      }
      op = words[i];
      i += 1;
      if (i >= words.length) return { unevaluable: `a trailing \`${op}\` with nothing after it` };
    }
  }
  return { fires: result === true };
}

/**
 * The first line index of `lines` at or after `from`, outside `[skipFrom,
 * skipTo]`, that hands control to something destructive — or -1.
 *
 * ROUND 7, on a review finding. The refusal checks all read the block's TEXT,
 * so a reviewer moved the four-line refusal BELOW
 * `bash .github/scripts/fiab-teardown.sh` — a PURE REORDER, +0 bytes, every
 * assertion above still true — and measured this suite 39/39 RC=0, the sibling
 * estate-preflight suite 78/78 RC=0 and nine `scripts/ci/check-*` guards RC=0,
 * with a declared-paused sovereign estate destroyed and *then* refused over.
 * Byte-identical logs; the same "a move into another position" class this repo
 * has been burned by before. Position is the only thing that can catch it, and
 * position is an assertion about the OUTCOME rather than one more property of
 * the text.
 *
 * DERIVED from the shape of the call — a `.sh` handed to a shell, or an `az`
 * that writes (MUTATING_AZ) — never from `fiab-teardown.sh`, so renaming the
 * script does not silently move the refusal back above it.
 *
 * ROUND 8, on a review finding: the shape had exactly three spellings and the
 * reviewer named two more that reach the same script — `bash -c '… .sh …'`
 * (flags between the shell and its argument) and a BARE exec of an executable
 * `.github/scripts/fiab-teardown.sh`, which needs no shell word at all. Both are
 * covered now. `echo "see .github/scripts/fiab-teardown.sh"` still is not: the
 * bare form only fires at a COMMAND POSITION — start of line, or after `;`,
 * `&&`, `||`, `|` or `(` — which is where a script gets executed and is not
 * where a filename gets mentioned. Both directions are pinned by unit
 * assertions below.
 *
 * @param {string[]} lines
 * @param {number} from
 * @param {number} skipFrom
 * @param {number} skipTo
 * @returns {number}
 */
export function destructiveHandoffAt(lines, from, skipFrom, skipTo) {
  for (let i = Math.max(0, from); i < lines.length; i += 1) {
    if (i >= skipFrom && i <= skipTo) continue;
    // ROUND 9. The LOGICAL line starting here, not the physical row: a trailing
    // `\` continues the command onto the next row, and every pattern below
    // stops at the row's end. The index reported is still `i` — the row the
    // command STARTS on, which is where the refusal has to sit above.
    let l = lines[i];
    for (let j = i; j + 1 < lines.length && /\\[ \t]*$/.test(lines[j]); j += 1) {
      l = `${l.replace(/\\[ \t]*$/, '')} ${String(lines[j + 1]).trim()}`;
    }
    // `bash foo.sh`, `sh ./foo.sh`, `. foo.sh`, and `bash -c "… foo.sh …"`.
    if (/(?:^|[\s;&|(])(?:bash|sh|source|\.)\s+(?:-\S+\s+)*['"]?[^\s;&|'"]*\.sh\b/.test(l)) return i;
    if (/(?:^|[\s;&|(])(?:bash|sh)\s+(?:-\S+\s+)*['"][^'"]*\.sh\b/.test(l)) return i;
    // A bare exec at a command position: `./x.sh`, `.github/scripts/x.sh`.
    //
    // ROUND 10, on a review finding. The path class used to be `[\w./-]`, which
    // cannot cross `$` or `{` — so the ORDINARY way a workflow writes this path,
    // `${GITHUB_WORKSPACE}/.github/scripts/fiab-teardown.sh`, walked straight
    // past. MEASURED at the round-9 head: that bare line placed above the
    // refusal was +64 B and left this suite at RC=0, 56 pass / 0 fail, while the
    // SAME line prefixed with `bash ` (+69 B) was caught 34/22 by the two
    // alternatives above — which already tolerate `$` because their class is a
    // negation. Round 8 widened this arm for the bare form and closed one
    // spelling of it; the variable-expanded spelling is the one a real workflow
    // uses. `$`, `{` and `}` are literals inside a character class.
    if (/(?:^|[;&|(])\s*['"]?[\w${}./-]*\.sh\b/.test(l)) return i;
    if (estateMutatingAz(l)) return i;
  }
  return -1;
}

/**
 * A MUTATING `az` invocation: `az <group…> <verb>` where <verb> writes.
 *
 * Round 3, on a review finding. `exempt` previously asserted NOTHING — not the
 * reason, not the behaviour — and the reviewer proved it by rewriting
 * `Note dry-run completion` to `az group delete -n rg-csa-loom-admin-usgovvirginia
 * --yes` and watching the suite stay green. An exemption that cannot be
 * falsified is an allowlist entry with a paragraph attached.
 *
 * DELIBERATELY `az`-SHAPED, not a bare verb list. The intermediate tokens must
 * start with a letter so the match stops at the first flag: `az account show
 * --query id -o tsv` reads `account` then `show`, which is not a write, and
 * does not run on into `--query`. A bare `/delete|create/` scan would flag the
 * `github.rest.issues.create` in the failure notifier — a GitHub write, not an
 * estate write — and the exemption there is correct.
 *
 * KNOWN LIMIT: this sees `az`. A mutation reached through a script file, an
 * `actions/*` step, or a REST call is not visible to it. That is why the
 * reason string is asserted too — the reason is the part a human reads.
 */
const MUTATING_AZ =
  /\baz\s+(?:[a-z][a-z0-9-]*\s+)*(create|delete|update|set|start|stop|restart|purge|upload|import|assign|add|remove|patch|deploy|invoke|replace|publish|enable|disable|revoke|regenerate|reset|attach|detach|move|renew|rotate)\b/;

/**
 * `az rest`, the OTHER spelling — it takes its verb in `--method`, not as a
 * command word, so `MUTATING_AZ` cannot see it: that pattern's intermediate-token
 * loop requires each token to start with a letter and therefore stops dead at
 * the first flag.
 *
 * ROUND 8, on a review finding, MEASURED. The reviewer appended
 *
 *   az rest --method DELETE --url "https://management.usgovcloudapi.net/
 *     subscriptions/SUB/resourcegroups/rg-csa-loom-admin-usgovvirginia?api-version=2021-04-01"
 *
 * to the EXEMPT `Note dry-run completion` step of the real workflow and this
 * suite stayed at 45 pass / 0 fail — the same shape as the round-3 finding
 * (`az group delete` in an exempt step) that `estateMutatingAz` was written to
 * close, in a spelling this repo actually uses: `grep -c 'az rest'` over
 * .github/workflows returns 16 occurrences across 6 files.
 *
 * `az rest --method GET` stays exempt, which is correct — it is a read.
 *
 * ROUND 9, on a review finding, MEASURED. The middle of this pattern is a
 * negated-newline class, so it required the verb to sit on the SAME PHYSICAL
 * LINE as `az rest` — and the reviewer walked past it with the identical call
 * written over a backslash continuation:
 *
 *   az rest \
 *     --method DELETE \
 *     --url "https://management.usgovcloudapi.net/…/rg-csa-loom-admin-…"
 *
 * appended to the EXEMPT `Note dry-run completion` step. One line: RC=1, 29
 * pass / 21 fail. The same call continued: +196 B, RC=0, 50 pass / 0 fail. The
 * continued form is this repo's own idiom — gov-purview-verify.yml:236 and
 * full-app-deploy-commercial.yml:298 both write `az rest --method put` with
 * continuations — it just happens to keep the verb on line 1 today. So
 * `estateMutatingAz` now joins continuations into LOGICAL lines before it
 * scans, and the pattern is anchored to the command rather than to a row.
 */
const MUTATING_AZ_REST = /\baz\s+rest\b[^\n]*?--method[=\s]+['"]?(PUT|POST|PATCH|DELETE)\b/i;

/**
 * Join backslash-continued physical lines into the LOGICAL lines the shell
 * actually executes. `\` + newline + leading indentation collapses to one
 * space, so a command split across rows reads as the single command it is.
 *
 * @param {string} src
 * @returns {string}
 */
export function logicalLines(src) {
  return String(src || '').replace(/[ \t]*\\[ \t]*\r?\n[ \t]*/g, ' ');
}

/**
 * `az` command groups that configure the CLI ON THE RUNNER and can reach no
 * Azure resource at all: `az cloud set` (which endpoint list to use),
 * `az extension add` (install a CLI extension), `az config set`.
 *
 * A PROPERTY of the command namespace, deliberately, not a list of steps. The
 * alternative — exempting the two steps that happen to run them today — is the
 * allowlist this whole file exists to avoid, and it would have to grow every
 * time a lane adds a login. `az group delete` in the same step still fails.
 */
const RUNNER_LOCAL_AZ = /^az\s+(?:cloud|extension|config|version)\b/;

/**
 * The first `az` call in `body` that WRITES to the estate, or null.
 *
 * @param {string} body
 * @returns {string|null}
 */
export function estateMutatingAz(body) {
  // LOGICAL lines, not physical ones — both patterns below stop at a newline,
  // and a trailing `\` is how this repo writes a long `az` call.
  const src = logicalLines(body);
  const rest = MUTATING_AZ_REST.exec(src);
  const m = MUTATING_AZ.exec(src);
  const runnerLocal = m ? RUNNER_LOCAL_AZ.test(m[0]) : true;
  // Report whichever WRITE comes first in the body, so the message points at the
  // line a human has to look at.
  if (rest && (!m || runnerLocal || rest.index < m.index)) return `az rest --method ${rest[1].toUpperCase()}`;
  if (!m) return null;
  return runnerLocal ? null : m[0];
}

/**
 * @param {{mode:string, why?:string}} d
 * @param {{name:string, body?:string}} member
 * @param {'step'|'job'} kind
 * @returns {string[]}
 */
function judgeExemption(d, member, kind) {
  const problems = [];
  if (typeof d.why !== 'string' || d.why.trim().length === 0) {
    problems.push(
      `${kind} '${member.name}' is dispositioned 'exempt' with no reason. The reason IS the disposition: ` +
        'an exemption with no reason is how this table rots into an allowlist.',
    );
  }
  const m = estateMutatingAz(member.body);
  if (m) {
    problems.push(
      `${kind} '${member.name}' is dispositioned 'exempt' — "touches no estate resource" — but its body runs ` +
        `\`${m}\`, which WRITES. Either it is not exempt, or the exemption's reason is now false.`,
    );
  }
  return problems;
}

/**
 * Steps of the `deploy-validate` job, in order.
 *
 * Hand-rolled because this repo's `node --test scripts/ci/__tests__/*.test.mjs`
 * lane (loom-guardrails.yml) runs on a bare node with no dependency install —
 * there is no YAML parser to import. Indentation is fixed and asserted: steps
 * are `      - name:` (6) and their keys `        <key>:` (8). Comment lines
 * are dropped FIRST, because this workflow quotes old `if:` conditions inside
 * its own comment blocks and a naive scan would read one as live config (the
 * exact false positive recorded in check-required-lane-concurrency.mjs).
 *
 * `id:` is captured because round 6 asserts the VALUE CHAIN behind every
 * `steps.<id>.outputs.<verdict>` reference, and that chain terminates in a step
 * id. See judgeVerdictReferences.
 *
 * @param {string} src
 * @returns {{name:string, id:string, if:string, body:string}[]}
 */
export function parseSteps(src) {
  const lines = String(src).split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^  ${STEP_JOB}:\\s*$`).test(l));
  assert.ok(start >= 0, `${STEP_JOB} job not found`);
  let i = lines.findIndex((l, n) => n > start && /^    steps:\s*$/.test(l));
  assert.ok(i > start, `${STEP_JOB} has no steps: block`);

  const steps = [];
  let cur = null;
  for (i += 1; i < lines.length; i += 1) {
    const raw = lines[i];
    // A line at 2-space indent that is not blank ends the job.
    if (/^ {0,3}\S/.test(raw)) break;
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const stepStart = raw.match(/^ {6}- (?:name: (.*)|(uses|id|if|run): .*)$/);
    if (/^ {6}- /.test(raw)) {
      if (cur) steps.push(cur);
      cur = { name: stepStart && stepStart[1] ? stepStart[1].trim() : '(unnamed)', id: '', if: '', body: raw };
      const idStart = raw.match(/^ {6}- id: (.*)$/);
      if (idStart) cur.id = idStart[1].trim();
      continue;
    }
    if (!cur) continue;
    cur.body += `\n${raw}`;
    const ifKey = raw.match(/^ {8}if: (.*)$/);
    if (ifKey) cur.if = ifKey[1].trim();
    const idKey = raw.match(/^ {8}id: (.*)$/);
    if (idKey) cur.id = idKey[1].trim();
  }
  if (cur) steps.push(cur);
  return steps;
}

/**
 * The `env:` map of a single step, as written.
 *
 * ROUND 6. The Teardown refusal's ONLY input is `ESTATE_PAUSED`, and it arrives
 * through this map. `refusalBlock` reads the shell and stops at the shell, so
 * nothing until now looked at where the shell's variable comes FROM.
 *
 * parseSteps has already dropped comment and blank lines, so the first line that
 * is not a 10-space `KEY: value` ends the map.
 *
 * @param {string} body
 * @returns {Map<string,string>}
 */
export function stepEnv(body) {
  const lines = String(body || '').split('\n');
  const map = new Map();
  const at = lines.findIndex((l) => /^ {8}env:\s*$/.test(l));
  if (at < 0) return map;
  for (let i = at + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^ {10}([A-Za-z_][\w.-]*):\s*(.*)$/);
    if (!m) break;
    map.set(m[1], m[2].trim());
  }
  return map;
}

/**
 * Every step id a fragment reads the estate-paused VERDICT from.
 *
 * The output name is DERIVED from GUARD, exactly as PRODUCER_OUTPUT is derived
 * from JOB_GUARD, so the clause and the chain check behind it cannot drift into
 * different spellings. Keyed to the SHAPE — any `steps.<id>.outputs.<verdict>` —
 * never to `adx_preflight`, so renaming the producing step does not silently
 * empty the population this walks.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function verdictRefs(text) {
  const re = new RegExp(`steps\\.([\\w-]+)\\.outputs\\.${VERDICT_OUTPUT}\\b`, 'g');
  return [...String(text || '').matchAll(re)].map((m) => m[1]);
}

/**
 * Every `steps.<id>.outputs.<verdict>` read in `deploy-validate` resolves to a
 * step that EXISTS and actually COMPUTES the verdict.
 *
 * ROUND 6, on a review finding, and it is the `steps.*` half of what round 4
 * built for `needs.*`. `judgeGuardProducer` asserts the whole value chain behind
 * `needs.pause-declaration.outputs.declared`; nothing asserted the chain behind
 * `steps.adx_preflight.outputs.estate_paused`. The reviewer MEASURED the cost by
 * deleting ONE line — the Teardown step's
 *
 *   ESTATE_PAUSED: ${{ steps.adx_preflight.outputs.estate_paused }}
 *
 * — after which `${ESTATE_PAUSED:-}` is the empty string, `'' = "true"` is
 * false, the refusal branch is never taken and `fiab-teardown.sh` destroys a
 * declared-paused sovereign estate. This suite stayed at 34/34 RC=0, the sibling
 * estate-preflight suite at 78/78 RC=0, and all five `scripts/ci/check-*`
 * workflow guards at RC=0. One deleted line disarmed the lane's only destructive
 * step with every guard in the repo green.
 *
 * Empty is the failure mode of EVERY `steps.*.outputs.*` read, the same way it
 * is for `needs.*.outputs.*`, so what is asserted is the chain and not one more
 * spelling: the reference names a step id, a step in this job carries that id,
 * and that step invokes the script that writes the value. The population is
 * DERIVED from the parsed YAML — every `if:` and every `env:` value in the job —
 * so a NEW reader of the verdict is in frame the day it is added.
 *
 * @param {{name:string, id?:string, if?:string, body?:string}[]} steps
 * @returns {string[]}
 */
export function judgeVerdictReferences(steps) {
  const problems = [];
  const byId = new Map();
  for (const s of steps) if (s.id) byId.set(s.id, s);
  for (const step of steps) {
    const sites = [];
    for (const id of verdictRefs(step.if)) sites.push([id, 'its if:']);
    for (const [key, value] of stepEnv(step.body)) {
      for (const id of verdictRefs(value)) sites.push([id, `its env.${key}`]);
    }
    for (const [id, where] of sites) {
      const producer = byId.get(id);
      if (!producer) {
        problems.push(
          `step '${step.name}' reads \`steps.${id}.outputs.${VERDICT_OUTPUT}\` in ${where}, but no step of ` +
            `deploy-validate carries \`id: ${id}\`. A dangling step reference evaluates to EMPTY, which silently ` +
            'inverts every use of it: a `!= \'true\'` guard never suppresses and a refusal never refuses.',
        );
        continue;
      }
      if (!String(producer.body || '').includes(VERDICT_SCRIPT)) {
        problems.push(
          `step '${step.name}' reads \`steps.${id}.outputs.${VERDICT_OUTPUT}\` in ${where}, but step ` +
            `'${producer.name}' (\`id: ${id}\`) does not invoke ${VERDICT_SCRIPT}, so nothing computes that ` +
            'value. It would be EMPTY, and an empty verdict never suppresses and never refuses.',
        );
      }
    }
  }
  return problems;
}

/**
 * Does every `exit 0` in this shell body have the verdict WRITTEN on the path
 * that reaches it?
 *
 * A tiny dataflow over the only shell construct in play — `if` / `elif` / `else`
 * / `fi` — because "written on every path" is what matters and a line-order
 * scan cannot see it. Each arm inherits its parent's flag, a write sets the
 * current arm's flag, and an `if` contributes a guaranteed write to its parent
 * ONLY when it has an `else` and every arm wrote (an `if` with no `else` has a
 * fall-through path that wrote nothing).
 *
 * `exit 1` is deliberately NOT in frame: a non-zero exit FAILS the step, so the
 * job fails and no consumer of the verdict runs on the empty value. It is the
 * SUCCESSFUL early return that publishes nothing and lets thirteen `!= 'true'`
 * consumers open.
 *
 * KNOWN LIMIT, stated rather than implied: `case`, `while`, `for` and functions
 * are not modelled. None appears in this producer, and an unmodelled construct
 * neither sets nor clears a flag — so it can only make this check MORE
 * conservative, never less.
 *
 * @param {string} body the step's `run:` shell, or the whole step block
 * @param {string} output the output key that must be written
 * @returns {{line:string, at:number}[]} the offending `exit 0` lines; empty means total
 */
export function unwrittenEarlyExits(body, output = VERDICT_OUTPUT) {
  const lines = String(body || '').split('\n');
  const write = new RegExp(`${output}=[^\\n]*GITHUB_OUTPUT`);
  const stack = [];
  let wrote = false;
  const bad = [];
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^if\b.*;\s*then$/.test(t) || /^then$/.test(t)) {
      stack.push({ parent: wrote, sawElse: false, armsWrote: [] });
      continue;
    }
    if (/^elif\b.*;\s*then$/.test(t) || /^else$/.test(t)) {
      const f = stack[stack.length - 1];
      if (f) {
        f.armsWrote.push(wrote);
        if (/^else$/.test(t)) f.sawElse = true;
        wrote = f.parent;
      }
      continue;
    }
    if (/^fi$/.test(t)) {
      const f = stack.pop();
      if (f) {
        f.armsWrote.push(wrote);
        wrote = f.parent || (f.sawElse && f.armsWrote.every(Boolean));
      }
      continue;
    }
    if (write.test(t)) wrote = true;
    if (/^exit\s+0\s*$/.test(t) && !wrote) bad.push({ line: t, at: i });
  }
  return bad;
}

/**
 * The STEP-level verdict must be TOTAL: written on every successful path its
 * producer can take.
 *
 * ROUND 10, on a review finding, and it is the `steps.*` half of what round 8
 * built for `needs.*`. `judgeUnconditionalVerdict` proved the TEARDOWN refusal
 * reads a verdict from a job that cannot decline to produce — and fixed exactly
 * that one consumer. The other thirteen readers of
 * `steps.adx_preflight.outputs.estate_paused` (twelve step-level `if:` gates,
 * the `deploy-validate` job output, and through it the chained
 * `post-deploy-bootstrap` gate) still read a value the producing step returned
 * WITHOUT writing on `topology=dlz-attach`:
 *
 *   if [ "${CSA_LOOM_TOPOLOGY:-}" = "dlz-attach" ]; then … exit 0; fi
 *
 * `dlz-attach` is one of four `workflow_dispatch` topology choices and the
 * producer's own `if:` is satisfied by `run_mode=full`, so the producer RAN,
 * produced nothing, and `'' != 'true'` opened every gate — including
 * `Image preflight — Gov ACR must already hold every referenced tag`, which
 * takes the sovereign ACR firewall lease, and `Publish DLZ template + wire
 * deploy env (Gov)`, which `az containerapp update --set-env-vars`s the hub
 * Console. Round 8 named this mechanism and closed one consumer of it; closing
 * it at the PRODUCER closes the class.
 *
 * WHAT THIS DOES **NOT** ASSERT, said plainly so it is not read as more than it
 * is. This is totality over the paths the producer takes WHEN IT RUNS. The step
 * carries its own `if: github.event_name == 'schedule' || inputs.run_mode ==
 * 'full'`, so a `run_mode=whatif-only` dispatch skips it entirely and the
 * verdict is empty there too. That is deliberate and predates round 10 — the
 * preflight STARTS a cluster, and a dry run must not mutate — and on that
 * trigger every gate carrying the `schedule || full` clause is already closed.
 * The steps that are NOT (`Resolve the program budget's IMMUTABLE start date`,
 * `Bicep what-if`, the evidence receipt and its upload) still run on a
 * whatif-only dispatch against a declared-paused estate. Named, not closed.
 *
 * @param {{name:string, id:string, body:string}[]} steps
 * @returns {string[]}
 */
export function judgeVerdictProducerTotality(steps) {
  const producers = steps.filter((s) => s.id && String(s.body || '').includes(VERDICT_SCRIPT));
  if (producers.length === 0) {
    return [
      `no step of ${STEP_JOB} invokes ${VERDICT_SCRIPT}, so nothing computes \`${VERDICT_OUTPUT}\`. ` +
        'Every consumer would read the EMPTY STRING, which is not `true`, so every stand-down opens.',
    ];
  }
  const problems = [];
  for (const p of producers) {
    for (const { line } of unwrittenEarlyExits(p.body)) {
      problems.push(
        `step '${p.name}' is the producer of \`${VERDICT_OUTPUT}\`, and it can reach \`${line}\` without ` +
          `writing that output. A successful early return publishes the EMPTY STRING, \`'' != 'true'\` is ` +
          'TRUE, and every step gate, the job output and the chained bootstrap all open on a DECLARED-PAUSED ' +
          'estate. Publish a verdict before the return — and say in the notice what it was derived from, ' +
          'because on a path that observed nothing the conjunction has no observed term (deploy-integrity R7).',
      );
    }
  }
  return problems;
}

/** The one script in this repo that flips `publicNetworkAccess` on an ACR. */
const LEASE_SCRIPT = 'acr-firewall-lease.sh';

/**
 * Strip whole-line comments so a MENTION of the lease is not read as a CALL.
 *
 * scripts/csa-loom/apply-acr-compliance-tags.sh names `acr-firewall-lease.sh`
 * twice, both times in a comment explaining why the template must not own the
 * ACR's tag dictionary. It takes no lease. A `grep -l` derivation would put it
 * in the census and the census would then be wrong in the harmless direction —
 * which is still wrong, because a census nobody trusts gets deleted.
 *
 * @param {string} src
 * @returns {string}
 */
function stripLineComments(src) {
  return String(src)
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

const leaseCache = new Map();

/**
 * Does this repo script REACH the ACR firewall lease?
 *
 * @param {string} rel repo-relative path, as written in a step body
 * @returns {boolean}
 */
export function scriptTakesLease(rel) {
  if (leaseCache.has(rel)) return leaseCache.get(rel);
  let verdict = false;
  if (rel.endsWith(LEASE_SCRIPT)) {
    verdict = true;
  } else {
    try {
      verdict = stripLineComments(readFileSync(path.join(REPO_ROOT, rel), 'utf8')).includes(LEASE_SCRIPT);
    } catch {
      // A path this file cannot read is NOT evidence of anything (R7). Say so
      // rather than recording a false negative: the caller asserts on it.
      verdict = null;
    }
  }
  leaseCache.set(rel, verdict);
  return verdict;
}

/**
 * Every step of `deploy-validate` that reaches the ACR firewall lease, DERIVED
 * rather than listed.
 *
 * ROUND 5, on a review finding, and the reason it is a derivation. The summary
 * this workflow prints on a stood-down run makes a claim about the whole RUN —
 * "the sovereign ACR firewall was not opened". The check standing behind that
 * claim used to be `summary.body.includes('artifact upload')`: a substring test
 * over the sentence, which by construction cannot tell a true enumeration from
 * a false one. It was green while step 10 of the same job held the lease.
 *
 * So the population is computed from what the steps DO: the repo scripts each
 * `run:` block invokes, and whether those scripts reach acr-firewall-lease.sh.
 * A new lease-taking step joins the census the day it is added, with no list to
 * update — and a step that stops taking the lease leaves it the same way.
 *
 * @param {{name:string, if:string, body:string}[]} steps
 * @returns {{name:string, if:string, via:string[]}[]}
 */
export function leaseTakingSteps(steps) {
  const out = [];
  for (const step of steps) {
    // parseSteps has already dropped every comment line, so what remains of a
    // `run:` block is the shell that actually executes. Tokenise rather than
    // scan: a substring match reads `.github/scripts/fiab-smoke-test.sh` as
    // `scripts/fiab-smoke-test.sh`, a path that does not exist, and the whole
    // census then turns on a file the test cannot open.
    const refs = [
      ...new Set(
        String(step.body)
          .split(/[\s'"`;|&()<>]+/)
          .map((t) => t.replace(/^\.\//, ''))
          .filter((t) => /^(?:\.github\/)?scripts\/[\w./-]+\.(?:sh|mjs)$/.test(t)),
      ),
    ];
    const via = [];
    for (const rel of refs) {
      const verdict = scriptTakesLease(rel);
      assert.notEqual(
        verdict,
        null,
        `step '${step.name}' invokes ${rel}, which this test could not READ. Whether it takes the ACR ` +
          'firewall lease is UNKNOWN, and an unknown must not be recorded as a no.',
      );
      if (verdict) via.push(rel);
    }
    if (via.length > 0) out.push({ name: step.name, if: step.if, via });
  }
  return out;
}

/**
 * Top-level jobs, in order, with their `if:` and `needs:` as written.
 *
 * A STEP census could never have caught the round-2 defect: `build-gov-images`
 * is a JOB, it is not inside `deploy-validate`, and it opened the sovereign ACR
 * firewall on every declared-paused scheduled run while the step census said the
 * stand-down was complete. The population being accounted for has to be BOTH.
 *
 * Same hand-rolled parse as parseSteps, same reason (no YAML parser on the
 * `node --test` lane). Jobs are `  <name>:` at 2-space indent inside `jobs:`.
 *
 * @param {string} src
 * @returns {{name:string, if:string, needs:string, body:string}[]}
 */
export function parseJobs(src) {
  const lines = String(src).split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(start >= 0, 'no top-level jobs: block');
  const jobs = [];
  let cur = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^\S/.test(raw)) break; // back to column 0 => out of `jobs:`
    if (/^\s*#/.test(raw) || raw.trim() === '') continue;
    const head = raw.match(/^ {2}([\w-]+):\s*$/);
    if (head) {
      if (cur) jobs.push(cur);
      cur = { name: head[1], if: '', needs: '', body: raw };
      continue;
    }
    if (!cur) continue;
    cur.body += `\n${raw}`;
    const ifKey = raw.match(/^ {4}if: (.*)$/);
    if (ifKey) cur.if = ifKey[1].trim();
    const needsKey = raw.match(/^ {4}needs: (.*)$/);
    if (needsKey) cur.needs = needsKey[1].trim();
  }
  if (cur) jobs.push(cur);
  return jobs;
}

/**
 * Disposition for EVERY top-level job.
 *
 *   'job-guard'  — must carry JOB_GUARD (the declaration-only clause) in `if:`.
 *   'out-guard'  — must carry the `deploy-validate` estate_paused OUTPUT clause.
 *   'internal'   — stands down step-by-step; DISPOSITIONS below is its census.
 *   'exempt'     — reaches no estate resource, with the reason recorded and
 *                  ASSERTED (judgeExemption): non-empty `why`, no mutating `az`.
 */
const JOB_DISPOSITIONS = new Map([
  [
    'precheck',
    {
      mode: 'exempt',
      why: 'tests four repository secrets for emptiness. No checkout, no network, no az — and it is the gate every other job reads, so adding a failure surface to it would take the lane down for an unrelated reason.',
    },
  ],
  [
    'pause-declaration',
    {
      mode: 'exempt',
      why: 'IS the declaration gate. scripts/ci/estate-pause-declared.mjs is a checkout + a pure file read; _estate-pause-declaration.mjs has no az, fetch, https or child_process. Gating it on itself is not a thing.',
    },
  ],
  ['build-gov-images', { mode: 'job-guard' }],
  [
    'deploy-validate',
    {
      mode: 'internal',
      why: 'runs on always() because it owns the stand-down summary; every one of its steps after the declaration is dispositioned in DISPOSITIONS.',
    },
  ],
  ['post-deploy-bootstrap', { mode: 'out-guard' }],
]);

/**
 * @param {{name:string, if:string, needs:string}[]} jobs
 * @returns {string[]} one problem string per violation; empty means compliant.
 */
export function judgeJobs(jobs) {
  const problems = [];
  for (const job of jobs) {
    const d = JOB_DISPOSITIONS.get(job.name);
    if (!d) {
      problems.push(
        `job '${job.name}' has no disposition. A new job in this workflow runs on the declared-paused schedule ` +
          `unless it says otherwise — add it to JOB_DISPOSITIONS, or gate it on \`${JOB_GUARD}\`.`,
      );
      continue;
    }
    if (d.mode === 'job-guard') {
      if (!job.if.includes(JOB_GUARD)) {
        problems.push(
          `job '${job.name}' must carry \`${JOB_GUARD}\` in its if: — it MUTATES the sovereign estate ` +
            '(ACR firewall lease + az acr build) and runs before the approval gate. Its if: is ' +
            `\`${job.if || '(none)'}\``,
        );
      } else if (!guardIsBinding(job.if, JOB_GUARD)) {
        problems.push(inertGuardProblem('job', job.name, job.if, JOB_GUARD));
      }
      if (!/pause-declaration/.test(job.needs)) {
        problems.push(
          `job '${job.name}' reads needs.pause-declaration but does not declare it in needs: — the expression ` +
            `would evaluate to empty and never suppress. Its needs: is \`${job.needs || '(none)'}\``,
        );
      }
    }
    if (d.mode === 'out-guard') {
      const outGuard = "needs.deploy-validate.outputs.estate_paused != 'true'";
      if (!job.if.includes(outGuard)) {
        problems.push(
          `job '${job.name}' must carry \`${outGuard}\` in its if: — found \`${job.if || '(none)'}\``,
        );
      } else if (!guardIsBinding(job.if, outGuard)) {
        problems.push(inertGuardProblem('job', job.name, job.if, outGuard));
      }
      // ROUND 6. `needs.deploy-validate.outputs.estate_paused` goes empty for
      // the same reasons `needs.pause-declaration.outputs.declared` does — and
      // empty is TRUE against `!= 'true'`, so the chained bootstrap would wire
      // Synapse SQL, Purview and Databricks SCIM on a declared-paused estate.
      // Same chain assertion, now that judgeGuardProducer is parameterised: the
      // producing job publishes THAT key, from a step output, whose id exists,
      // in a job that invokes the script that writes the value.
      problems.push(...judgeGuardProducer(jobs, outGuard, VERDICT_SCRIPT));
    }
    if (d.mode === 'exempt') problems.push(...judgeExemption(d, job, 'job'));
    if (d.mode === 'internal' && (typeof d.why !== 'string' || d.why.trim().length === 0)) {
      // No mutating-`az` scan here: `internal` means the job DOES reach the
      // estate and stands down step by step, so its body is full of writes by
      // design. DISPOSITIONS below is its census; the reason is what says which.
      problems.push(`job '${job.name}' is dispositioned 'internal' with no reason naming the census that covers it`);
    }
  }
  if ([...JOB_DISPOSITIONS.values()].some((d) => d.mode === 'job-guard')) {
    problems.push(...judgeGuardProducer(jobs));
  }
  return problems;
}

/**
 * The lines of the step in `job.body` that carries `id: <id>`, or null.
 *
 * Same hand-rolled shape as parseSteps/parseJobs and for the same reason: the
 * `node --test` lane runs on a bare node with no YAML parser. Steps inside a job
 * are `      - ` at 6-space indent; a step block runs to the next one.
 *
 * @param {string} jobBody
 * @param {string} id
 * @returns {string[]|null}
 */
export function jobStepBlock(jobBody, id) {
  const lines = String(jobBody || '').split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) if (/^ {6}- /.test(lines[i])) starts.push(i);
  for (let k = 0; k < starts.length; k += 1) {
    const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
    const block = lines.slice(starts[k], to);
    if (block.some((l) => new RegExp(`^ {6,8}(?:- )?id: ${id}\\s*$`).test(l))) return block;
  }
  return null;
}

/**
 * A producing STEP that can decline to run publishes the EMPTY STRING, which is
 * the same disarm as a producing JOB that can decline to run.
 *
 * ROUND 10, on a review finding. `judgeGuardProducer` (round 4) and
 * `judgeUnconditionalVerdict` (round 8) between them assert that the producer
 * JOB exists, carries no `if:`, publishes THAT key, reads it from a step id that
 * exists, and invokes the script. Every one of those held while the PRODUCING
 * STEP was disarmed. MEASURED at the round-9 head, through the
 * `LOOM_GCCH_WORKFLOW_PATH` seam, on the real workflow:
 *
 *   producing step given `if: github.event_name == 'workflow_dispatch'`  +54 B
 *     -> RC=0, 56 pass / 0 fail
 *   producing step given `continue-on-error: true`                       +33 B
 *     -> RC=0, 56 pass / 0 fail
 *   the JOB given the same `if:`                                         +50 B
 *     -> RC=1, 33 pass / 23 fail   (round 8's arm, doing its job)
 *
 * On the first mutant `pause-declaration` SUCCEEDS on the daily cron with an
 * EMPTY `declared`, `build-gov-images`'s `!= 'true'` reads true, and the image
 * phase takes the sovereign ACR firewall lease and `az acr build`s loom-migrate
 * + loom-risingwave into the GCC-High registry on a declared pause — the round-2
 * defect, restored in one line, with the whole ratchet green.
 *
 * `continue-on-error` is in the same frame because a step that fails and is
 * forgiven writes nothing either, and its job still reports success.
 *
 * @param {{name:string, body:string}} producer the producing JOB
 * @param {string} id the producing STEP's id
 * @param {string} clause the guard clause whose value chain is being asserted
 * @returns {string[]}
 */
export function judgeProducingStepUnconditional(producer, id, clause) {
  const block = jobStepBlock(String(producer.body), id);
  if (!block) {
    return [
      `job '${producer.name}' was expected to carry a step with \`id: ${id}\` producing \`${clause}\`, ` +
        'but its step block could not be isolated. An unreadable producer is an UNKNOWN, and an unknown ' +
        'must not be recorded as a no.',
    ];
  }
  const problems = [];
  const cond = block.find((l) => /^ {8}if:\s*\S/.test(l));
  if (cond) {
    problems.push(
      `job '${producer.name}' produces \`${clause}\` from the step \`id: ${id}\`, and that STEP carries ` +
        `\`${cond.trim()}\`. A step that can decline to run publishes nothing, the expression evaluates to ` +
        "the EMPTY STRING, `'' != 'true'` is TRUE, and every consumer of this clause opens on a declared " +
        'pause — with the job itself still green. The producer job carrying no `if:` is necessary and not ' +
        'sufficient; the producing step must carry none either.',
    );
  }
  const forgiven = block.find((l) => /^ {8}continue-on-error:\s*true\s*$/.test(l));
  if (forgiven) {
    problems.push(
      `job '${producer.name}' produces \`${clause}\` from the step \`id: ${id}\`, and that STEP carries ` +
        '`continue-on-error: true`. A forgiven failure writes no output and leaves the job green, which is ' +
        'the same EMPTY verdict as a step that never ran.',
    );
  }
  return problems;
}

/**
 * The guard clause is only worth its words if the value it reads is actually
 * PUBLISHED.
 *
 * ROUND 4, on a review finding. `judgeJobs` caught ONE of the three ways
 * `needs.pause-declaration.outputs.declared` goes empty — the missing `needs:` —
 * and missed two, both MEASURED green at 22 pass / 0 fail while the sovereign
 * ACR would open on a declared pause:
 *
 *   (a) rename the job's output key `declared:` to anything else;
 *   (b) replace the producing step's `run:` with `echo noop`.
 *
 * In both, the expression evaluates to empty, `'' != 'true'` is TRUE, and the
 * image phase runs. Empty is the failure mode of EVERY `needs.*.outputs.*` read,
 * so what is asserted here is the whole chain rather than one more spelling: the
 * producer job exists, it publishes THAT key, the key reads a step output, that
 * step id exists in that job, and the job invokes the script that writes it.
 *
 * @param {{name:string, body:string}[]} jobs
 * @param {string} clause the guard clause whose value chain is being asserted
 * @param {string} script the script that must compute it
 * @returns {string[]}
 */
export function judgeGuardProducer(jobs, clause = JOB_GUARD, script = PRODUCER_SCRIPT) {
  const source = /needs\.([\w-]+)\.outputs\.([\w-]+)/.exec(clause);
  assert.ok(source, `judgeGuardProducer was handed \`${clause}\`, which reads no job output at all`);
  const [, producerJob, producerOutput] = source;
  const problems = [];
  const producer = jobs.find((j) => j.name === producerJob);
  if (!producer) {
    return [
      `the image phase stands down on \`${clause}\`, but there is no '${producerJob}' job to produce it. ` +
        "An absent producer makes the clause read '' != 'true', which is TRUE — present, and never suppressing.",
    ];
  }
  const outLine = String(producer.body)
    .split('\n')
    .find((l) => new RegExp(`^ {6}${producerOutput}:`).test(l));
  if (!outLine) {
    problems.push(
      `job '${producerJob}' must publish an output named \`${producerOutput}\` — that is the exact key ` +
        `\`${clause}\` reads, and any other name leaves the clause empty and never suppressing.`,
    );
  } else {
    const ref = /steps\.([\w-]+)\.outputs\.([\w-]+)/.exec(outLine);
    if (!ref) {
      problems.push(
        `job '${producerJob}' publishes \`${producerOutput}\` as \`${outLine.trim()}\`, which reads no step ` +
          'output. The guard would then read whatever that expression evaluates to, including empty.',
      );
    } else if (!new RegExp(`^ {6,}(?:- )?id: ${ref[1]}\\s*$`, 'm').test(String(producer.body))) {
      problems.push(
        `job '${producerJob}' publishes \`${producerOutput}\` from \`steps.${ref[1]}.outputs.${ref[2]}\`, but ` +
          `no step in that job carries \`id: ${ref[1]}\` — the output is empty and the guard never suppresses.`,
      );
    } else if (String(producer.if || '').trim().length === 0) {
      // ROUND 10, and SCOPED deliberately. This arm asserts the "cannot decline
      // to produce" contract, which belongs to a producer job that carries no
      // `if:` — `pause-declaration`, whose whole reason to exist is that it is
      // populated on every topology and every trigger. The OTHER chain this
      // function serves, `needs.deploy-validate.outputs.estate_paused`, is
      // produced by a step that carries a deliberate `if:` (a whatif-only
      // dispatch must not start a cluster), and its emptiness is covered
      // instead by judgeVerdictProducerTotality at the step level plus the
      // residual named on the producer. A conditioned producer JOB is already
      // caught one level up by judgeUnconditionalVerdict, so nothing is lost by
      // not descending into it here.
      problems.push(...judgeProducingStepUnconditional(producer, ref[1], clause));
    }
  }
  if (!String(producer.body).includes(script)) {
    problems.push(
      `job '${producerJob}' no longer invokes ${script}, so nothing computes the declaration ` +
        'verdict. The output would be empty and the image phase would open the sovereign ACR on a declared pause.',
    );
  }
  return problems;
}

/**
 * Disposition for EVERY step that follows the declaration step.
 *
 *   'guard'          — must carry GUARD in its own `if:`.
 *   'refuse'         — must NOT skip; must fail loudly on a paused estate.
 *                      Used only for Teardown: skipping a requested teardown
 *                      would leave the operator believing a sovereign estate
 *                      was destroyed when it was not.
 *   'via-provision'  — cannot run when `Provision` skipped, because its own
 *                      condition reads a Provision result. Transitively guarded.
 *   'exempt'         — touches no estate resource. The reason is ASSERTED, not
 *                      decorative (judgeExemption): an exempt member must carry
 *                      a non-empty `why`, and its body must make no mutating
 *                      `az` call. Before round 3 this mode asserted nothing and
 *                      an exempt step rewritten to `az group delete` stayed
 *                      green — an exemption with no reason and no teeth is how
 *                      this table would rot into an allowlist.
 *
 * `summary` (ROUND 9, on a review nit) is the phrase the stand-down notice must
 * name this step by. Required on every 'guard' and 'via-provision' entry, and
 * walked as a POPULATION — so the notice's "SKIPPED IN THIS JOB" enumeration
 * cannot go one short again the way it did when
 * `Resolve the program budget's IMMUTABLE start date (#4253)` arrived from
 * `main`: the step was dispositioned, carried the guard, skipped on every
 * stood-down run, and was simply not mentioned. An enumeration one short reads
 * exactly like a complete one.
 */
const DISPOSITIONS = new Map([
  // Arrived from `main` in #4409 (the program budget's immutable startDate) and
  // was UNDISPOSITIONED the moment that merge landed on this branch — the
  // census went red on it before any human read the diff, which is the whole
  // point of deriving the population from the parsed YAML instead of listing
  // it. It calls `az consumption budget list` and REFUSES (exit 1) when that
  // read does not complete, so against a declared-paused estate it would turn a
  // deliberate stand-down into a red job. It carries GUARD already.
  ["Resolve the program budget's IMMUTABLE start date (#4253)", { mode: 'guard', summary: 'program budget' }],
  ['Bicep what-if', { mode: 'guard', summary: 'the what-if' }],
  ['Deploy-verification evidence receipt (§7)', { mode: 'guard', summary: 'evidence receipt' }],
  ['Upload GCC-High verification receipt', { mode: 'guard', summary: 'artifact upload' }],
  // Round 5: this one MOVED here from six steps above the declaration, where it
  // had no `if:` at all and opened the sovereign ACR firewall on every
  // declared-paused run. See the header, and leaseTakingSteps.
  [
    'Image preflight — never adopt a live app onto a missing tag',
    { mode: 'guard', summary: 'preflight-image-tags.sh' },
  ],
  [
    'Image preflight — Gov ACR must already hold every referenced tag',
    { mode: 'guard', summary: 'assert-acr-image-tags.sh' },
  ],
  [
    'Image-tag revert gate — never flatten a pinned app to the default',
    { mode: 'guard', summary: 'image-tag revert gate' },
  ],
  [
    'Re-pin appImageTags to the RUNNING images (narrows the roll race — #3683)',
    { mode: 'guard', summary: 'the re-pin' },
  ],
  ['Provision (with full Gov dispatch)', { mode: 'guard', summary: 'the apply' }],
  [
    'Apply ACR compliance tags (merge-patch, out-of-band — #3714)',
    {
      mode: 'via-provision',
      needle: "steps.provision.conclusion == 'success'",
      summary: 'ACR compliance-tag patch',
    },
  ],
  [
    'Approve the Front Door -> ACA private-endpoint connection',
    { mode: 'guard', summary: 'Front Door private-endpoint' },
  ],
  [
    'Export bootstrap coordinates (for the chained Gov bootstrap)',
    {
      mode: 'exempt',
      why: '`az account show` reads the SUBSCRIPTION, not the estate — no Loom resource is read or written. Its only consumer, the post-deploy-bootstrap job, carries its own `needs.deploy-validate.outputs.estate_paused != \'true\'`.',
    },
  ],
  ['Publish DLZ template + wire deploy env (Gov)', { mode: 'guard', summary: 'DLZ template publish' }],
  [
    'Smoke test (Gov-specific)',
    { mode: 'via-provision', needle: "steps.provision.outputs.console_url != ''", summary: 'Gov smoke test' },
  ],
  ['Teardown', { mode: 'refuse' }],
  [
    'Note dry-run completion',
    { mode: 'exempt', why: 'echoes a line on `run_mode == whatif-only`; no az call, no network.' },
  ],
  [
    'Notify on failure (dedicated, OPEN issue - never a closed one)',
    {
      mode: 'exempt',
      why: 'the `failure()` notifier. Gating it on the pause verdict is the precise way 47 days of silent daily failure happened before (deploy-integrity R3) — it must always run.',
    },
  ],
]);

/**
 * Every step that runs BEFORE the declaration, with the reason it is allowed to.
 *
 * ROUND 5. Rounds 1-4 declared this half of the job out of frame "inherently",
 * on the premise that nothing touches the estate before the verdict exists. A
 * reviewer measured that false — `Image preflight — never adopt a live app onto
 * a missing tag` sat here and opened the sovereign ACR firewall on every
 * declared-paused run — and demonstrated the cost by inserting
 * `az group delete -n rg-csa-loom-admin-usgovvirginia` above the declaration and
 * watching all 22 tests pass.
 *
 * The verdict genuinely does not exist yet up here, so there is nothing to gate
 * ON: `steps.adx_preflight.outputs.estate_paused` is empty until step 11. What
 * IS available is accounting. Every step above the declaration is named, with a
 * written reason it is safe to run against an estate this job has not yet
 * measured — and a NEW one fails this suite until someone writes that reason
 * down. The reason is the part a human reads, and it is the sentence whose
 * absence let round 5's defect sit here for the whole life of the lane. Where a
 * step CANNOT honestly claim it is safe, the remedy is the one applied in this
 * PR: move it below the declaration and guard it.
 */
const PRE_DISPOSITIONS = new Map([
  ['(unnamed)', 'actions/checkout. Reads this repository; reaches no Azure endpoint.'],
  [
    'Azure login (Gov sub) — limitlessdata_deploy SP',
    'azure/login. Mints a token for the runner. It grants this job nothing it did not already have and writes no resource.',
  ],
  [
    'Set Azure cloud to Gov',
    '`az cloud set` selects which ENDPOINT LIST the CLI on this runner uses. Runner-local configuration; it cannot reach a resource (see RUNNER_LOCAL_AZ).',
  ],
  ['Setup Bicep', 'Installs the bicep CLI on the runner. No Azure call at all.'],
  [
    'Pre-install the resource-graph CLI extension',
    '`az extension add` installs a CLI extension on the runner. Runner-local; it cannot reach a resource (see RUNNER_LOCAL_AZ).',
  ],
  [
    'Topology guard',
    'Reads the hub RG to decide the topology and REFUSES on a conflict. A read plus a refusal; it writes nothing, and it must run before the verdict because the verdict step needs the topology.',
  ],
  [
    'Resolve the existing MSAL client id (sign-in durability)',
    'Reads the live app registration / Container App to adopt the client id rather than re-minting it, and exports it. A read whose whole purpose is to NOT write.',
  ],
  [
    'Adopt the image tags this estate is running (no repo variable required)',
    'Reads the running Container Apps and exports LOOM_*_TAG. Read-only, and it is the PRODUCER those later steps interpolate bare under `set -u` — skipping it aborts them instead of relaxing them (#3449).',
  ],
  [
    "Adopt the estate's live internal trust token (never re-mint it)",
    'Reads the estate\'s live token and exports it, precisely so bicep does not re-mint and strand every holder (#3056). A read; the alternative to running it is a rotation.',
  ],
  [
    'Adopt the DLZ (discover what the estate already owns — #3380)',
    'Multi-subscription DISCOVERY (deploy-integrity R5): enumerates what the estate already owns and builds LOOM_ADOPT_JSON. Reads only — adopting is what stops the deploy duplicating a resource.',
  ],
  [
    "Resolve the hub DNS resolver's IMMUTABLE IP allocation method",
    'Reads the existing resolver inbound endpoint so the template proposes the allocation method it already has. Read-only.',
  ],
  [
    'ADX preflight — a stopped cluster cannot take its principal assignments',
    'THE VERDICT PRODUCER. It is the one step that cannot be gated on the verdict, because it computes it. Its own mutation — starting a stopped cluster — is exactly what the register suppresses: on a declared pause it publishes estate_paused=true and starts nothing (scripts/ci/ensure-adx-cluster-running.mjs, covered by estate-preflight.test.mjs).',
  ],
]);

/**
 * @param {{name:string, body:string}} step
 * @returns {string[]}
 */
function judgePreVerdict(step) {
  const problems = [];
  const why = PRE_DISPOSITIONS.get(step.name);
  if (typeof why !== 'string' || why.trim().length === 0) {
    problems.push(
      `step '${step.name}' runs BEFORE the declaration and has no entry in PRE_DISPOSITIONS. ` +
        'The estate_paused verdict does not exist yet up there, so it cannot be gated — which is exactly ' +
        'why it has to be ACCOUNTED FOR instead. Write down why it is safe to run against an estate this ' +
        'job has not measured, or move it below the declaration and gate it.',
    );
    return problems;
  }
  const m = estateMutatingAz(step.body);
  if (m) {
    problems.push(
      `step '${step.name}' runs BEFORE the declaration — where nothing can be gated — and its body runs ` +
        `\`${m}\`, which WRITES to the estate. Move it below the declaration and carry \`${GUARD}\`.`,
    );
  }
  return problems;
}

/**
 * Every `needs.<job>.outputs.<key>` an `env:` map binds, with the job it names.
 *
 * @param {Map<string,string>} env
 * @returns {{key:string, job:string, output:string, clause:string}[]}
 */
export function jobOutputBindings(env) {
  const candidates = [];
  for (const [key, value] of env) {
    const m = /needs\.([\w-]+)\.outputs\.([\w-]+)/.exec(String(value));
    if (m) candidates.push({ key, job: m[1], output: m[2], clause: `needs.${m[1]}.outputs.${m[2]}` });
  }
  return candidates;
}

/**
 * The subset of `jobOutputBindings` whose producer job carries no `if:` — the
 * bindings that cannot be conditioned out, and therefore the SECOND kind of
 * verdict this refusal branches on.
 *
 * ROUND 9, on a review finding. Extracted from judgeUnconditionalVerdict so the
 * E3 reassignment arm can share the SAME population. Before this, E3 built its
 * assign/unset regexes from `verdictRefs()` alone — i.e. only names bound to
 * `steps.<id>.outputs.<verdict>` — so `ESTATE_DECLARED`, bound to
 * `needs.pause-declaration.outputs.declared`, was outside every arm's frame.
 * MEASURED: inserting `ESTATE_DECLARED="false"` immediately below
 * `set -euo pipefail` in the real Teardown step (+35 B, one line) left this
 * suite at 50 pass / 0 fail, RC=0, with the round-8 blocking defect restored —
 * on `topology=dlz-attach` the ADX preflight returns before writing
 * `estate_paused`, so BOTH conjuncts are false and fiab-teardown.sh runs
 * against a DECLARED-PAUSED sovereign estate.
 *
 * @param {{name:string, if:string}[]} jobs
 * @param {Map<string,string>} env
 * @returns {{key:string, job:string, output:string, clause:string}[]}
 */
export function unconditionalVerdictBindings(jobs, env) {
  return jobOutputBindings(env).filter((c) => {
    const producer = jobs.find((j) => j.name === c.job);
    return producer && String(producer.if || '').trim().length === 0;
  });
}

/**
 * A refusal on a DESTRUCTIVE step has to branch on a verdict that is POPULATED
 * on every path that step can run on.
 *
 * ROUND 8, on a review finding, and it is the only class rounds 4-7 left open.
 * Each of those rounds asserted one more property of the refusal's TEXT or its
 * BINDING: the guard is a conjunct (4), the branch exits non-zero (4), every
 * name it reads is an `env:` key (7), nothing reassigns the verdict (7), the
 * refusal comes before the handoff (7), and `steps.<id>.outputs.<verdict>`
 * resolves to a step that invokes the producing script (6). ALL of them held
 * while the verdict was the EMPTY STRING at runtime:
 *
 *   `steps.adx_preflight.outputs.estate_paused` is produced by a step whose
 *   body returns at line 5 — `if [ "$CSA_LOOM_TOPOLOGY" = "dlz-attach" ]; then
 *   … exit 0; fi` — WITHOUT writing the output. `dlz-attach` is one of four
 *   `workflow_dispatch` topology choices, and Teardown's own condition
 *   (`run_mode == 'full'`) also satisfies the producer's `if:`, so on
 *   `topology=dlz-attach` + `run_mode=full` + `keep_resources=false` the
 *   producer RAN, produced nothing, `[ "" = "true" ]` was false, and
 *   `.github/scripts/fiab-teardown.sh` — every `rg-csa-loom-*` group enumerated
 *   at `:40` and deleted at `:150` — ran against a DECLARED-PAUSED sovereign
 *   estate with no refusal. `judgeVerdictReferences` requires the producer to
 *   INVOKE the script; it does, on a branch that is not taken.
 *
 * "Populated on every path" is undecidable in general, so what is required is a
 * cheap SUFFICIENT form: at least one of the names the refusal branches on must
 * be bound to a `needs.<job>.outputs.<key>` of a job that has no `if:` of its
 * own — a job with no condition runs on every trigger and every input
 * combination, so its output is written whenever the refusing step can run. The
 * whole value chain behind that clause is then asserted by `judgeGuardProducer`,
 * exactly as it is for the image phase's own guard, so a renamed key or a
 * gutted producer step reds this too.
 *
 * @param {{name:string, body:string}} step
 * @param {{name:string, if:string, needs:string, body:string}[]} jobs
 * @param {Map<string,string>} env the refusing step's `env:` map
 * @returns {string[]}
 */
export function judgeUnconditionalVerdict(step, jobs, env) {
  const problems = [];
  const candidates = jobOutputBindings(env);
  const unconditional = unconditionalVerdictBindings(jobs, env);
  if (unconditional.length === 0) {
    problems.push(
      `step '${step.name}' REFUSES on a destructive action, but its env: binds no verdict to a ` +
        '`needs.<job>.outputs.<key>` of a job that carries NO `if:` of its own. Every verdict it does read is ' +
        'produced by something that can decline to produce — a step that returns early, or a job that is ' +
        'conditioned out — and an unproduced verdict is the EMPTY STRING, which is not `true`, so the refusal ' +
        `never fires and the estate is destroyed. Its env: is {${[...env.keys()].join(', ') || 'empty'}}` +
        `; the job-output bindings it has are {${candidates.map((c) => c.clause).join(', ') || 'none'}}.`,
    );
    return problems;
  }
  // …and that clause's whole value chain, the same assertion the image phase's
  // guard gets: the producer job publishes THAT key, from a step output, whose
  // id exists in that job, and the job invokes the script that computes it.
  for (const c of unconditional) {
    problems.push(...judgeGuardProducer(jobs, c.clause, PRODUCER_SCRIPT));
    const owner = jobs.find((j) => j.name === STEP_JOB);
    if (owner && !new RegExp(`\\b${c.job}\\b`).test(String(owner.needs))) {
      problems.push(
        `step '${step.name}' reads \`${c.clause}\`, but job '${STEP_JOB}' does not declare '${c.job}' in ` +
          `its needs: — the expression evaluates to EMPTY and the refusal never fires. Its needs: is ` +
          `\`${owner.needs || '(none)'}\`.`,
      );
    }
  }
  return problems;
}

/**
 * @param {{name:string, if:string, body:string}[]} steps
 * @param {{name:string, if:string, needs:string, body:string}[]} [jobs]
 * @returns {string[]} one problem string per violation; empty means compliant.
 */
export function judge(steps, jobs = parseJobs(workflowText())) {
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  if (at < 0) return [`the declaration step '${DECLARATION_STEP}' is gone — the stand-down has no anchor at all`];
  const problems = [];
  // ROUND 6. Before any disposition is read: every reader of the verdict, in an
  // `if:` or an `env:`, must resolve to a step that exists and computes it.
  problems.push(...judgeVerdictReferences(steps));
  // ROUND 10: …and the producer of that verdict must write it on every path it
  // can successfully return from, or every reference above resolves to EMPTY.
  problems.push(...judgeVerdictProducerTotality(steps));
  for (const step of steps.slice(0, at)) problems.push(...judgePreVerdict(step));
  for (const step of steps.slice(at + 1)) {
    const d = DISPOSITIONS.get(step.name);
    if (!d) {
      problems.push(
        `step '${step.name}' runs AFTER the declaration and has no disposition. ` +
          'Add it to DISPOSITIONS with a mode, or gate it on the estate_paused verdict.',
      );
      continue;
    }
    if (d.mode === 'guard') {
      if (!step.if.includes(GUARD)) {
        problems.push(
          `step '${step.name}' must carry \`${GUARD}\` in its if:, but its if: is \`${step.if || '(none)'}\``,
        );
      } else if (!guardIsBinding(step.if, GUARD)) {
        problems.push(inertGuardProblem('step', step.name, step.if, GUARD));
      }
    }
    if (d.mode === 'via-provision') {
      if (!step.if.includes(d.needle)) {
        problems.push(
          `step '${step.name}' is dispositioned as transitively guarded through Provision, ` +
            `which requires \`${d.needle}\` in its if: — found \`${step.if || '(none)'}\``,
        );
      } else if (!guardIsBinding(step.if, d.needle)) {
        problems.push(inertGuardProblem('step', step.name, step.if, d.needle));
      }
    }
    if (d.mode === 'refuse') {
      if (step.if.includes(GUARD)) {
        problems.push(
          `step '${step.name}' must REFUSE on a paused estate, not skip: a silently skipped teardown ` +
            'leaves the operator believing a sovereign estate was destroyed when it was not',
        );
      }
      // ROUND 7, on a review nit. This used to also require the literal string
      // `ESTATE_PAUSED` somewhere in the body — a hardcoded spelling of a
      // variable the code below DERIVES out of the shell precisely so it is not
      // hardcoded, and a weaker assertion than the derived one in every case:
      // "the word appears somewhere in the step" is implied by "the variable the
      // refusal branches on is bound by env: to the verdict". Only the annotation
      // half is checked here now; the read is checked where it is derived.
      if (!/::error::/.test(step.body)) {
        problems.push(
          `step '${step.name}' must fail with an ::error:: naming the action that authorises the ` +
            'destruction — a refusal with no annotation leaves the operator reading an exit code.',
        );
      }
      // …and the refusal has to REFUSE. `::error::` is an annotation; it does
      // not fail a step. See refusalBlock() for the measurement.
      const refusal = refusalBlock(step.body);
      if (!refusal) {
        problems.push(
          `step '${step.name}' has no closed shell conditional branching on a variable, so it is not established ` +
            'that the refusal refuses at all — only that the words appear somewhere in the step.',
        );
      } else if (!/\bexit\s+[1-9]/.test(refusal.text)) {
        problems.push(
          `step '${step.name}' PRINTS its refusal and then carries on: the ESTATE_PAUSED branch of its run: ` +
            'contains no non-zero exit, and ::error:: is an annotation rather than a failure. A declared-paused ' +
            'sovereign estate would be torn down with a red annotation printed above the teardown.',
        );
      }
      // …and the value the refusal branches on has to be BOUND to the verdict.
      // ROUND 6, on a review finding. Everything above reads the SHELL and stops
      // at the shell. Delete the one `env:` line that supplies it and the shell
      // is unchanged, every assertion above still passes, `${ESTATE_PAUSED:-}`
      // is the empty string, and the sovereign estate is torn down. So the shell
      // variable the conditional actually tests is extracted from the refusal
      // itself and traced back through `env:` to the verdict — a spelling-free
      // chain, since a rename of the variable moves both ends together.
      //
      // ROUND 7, on a review finding, three mutations of the REAL workflow that
      // were all green here (39/39 RC=0), green in estate-preflight (78/78) and
      // green across nine scripts/ci/check-* guards, each of which destroys a
      // declared-paused sovereign estate:
      //
      //   E1  conjoin the condition with `[ "${LOOM_REFUSE_TEARDOWN:-}" = "true" ]`,
      //       a name bound NOWHERE — +44 B, one line. `''  = "true"` is false, so
      //       the AND is false on every run and the refusal never fires.
      //   E3  insert `ESTATE_PAUSED=""` immediately above the branch — +28 B, one
      //       line. The binding survives, the value does not.
      //   E4  move the four-line refusal BELOW the teardown call — +0 B, a PURE
      //       REORDER. It still refuses; the estate is already gone.
      //
      // Round 6 asserted only that at LEAST ONE variable read carries the
      // verdict, reasoning that requiring all of them "would forbid
      // `[ "$ESTATE_PAUSED" = true ] && [ "$X" ]`". The reviewer showed it would
      // not: requiring every name read to be a KEY OF THE STEP'S `env:` still
      // permits that conjunction when `X` is a real env key, and rejects only
      // names bound to nothing — which is exactly E1.
      if (refusal) {
        const env = stepEnv(step.body);
        // ROUND 8. Before any property of the SHELL: at least one verdict the
        // refusal reads must come from a producer that cannot decline to
        // produce. See judgeUnconditionalVerdict — every check below this point
        // held while the value was empty at runtime on topology=dlz-attach.
        problems.push(...judgeUnconditionalVerdict(step, jobs, env));
        const unconditionalKeys = new Set(unconditionalVerdictBindings(jobs, env).map((c) => c.key));
        const lines = String(step.body).split('\n');
        const condition = refusal.text.split('\n')[0];
        const read = [...new Set([...condition.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
        const bound = read.filter((v) => env.has(v) && verdictRefs(env.get(v)).length > 0);
        if (bound.length === 0) {
          problems.push(
            `step '${step.name}' branches on ${read.length > 0 ? read.map((v) => `\`$${v}\``).join(', ') : '(no shell variable)'} ` +
              `but its env: binds none of them to \`steps.<id>.outputs.${VERDICT_OUTPUT}\`. The variable is then the ` +
              'EMPTY STRING on every run, the refusal branch is never taken, and a declared-paused sovereign estate ' +
              `is torn down. Its env: is {${[...env.keys()].join(', ') || 'empty'}}.`,
          );
        } else {
          // The full set of verdicts the refusal branches on: the
          // `steps.<id>.outputs.<verdict>` half AND the
          // `needs.<job>.outputs.<key>`-of-an-unconditional-producer half. Used
          // by the polarity arm and by E3 below, both of which read one half
          // only until round 9.
          const verdicts = [...new Set([...bound, ...unconditionalKeys].filter((v) => read.includes(v)))];
          // E1. Every OTHER name the condition reads must come from the same
          // env: map. A name bound nowhere is the empty string, and one false
          // conjunct disarms the whole refusal.
          const unbound = read.filter((v) => !env.has(v));
          if (unbound.length > 0) {
            problems.push(
              `step '${step.name}' branches on ${unbound.map((v) => `\`$${v}\``).join(', ')}, which its env: does not ` +
                'bind at all. An unbound name is the EMPTY STRING on every run, so a conjunct reading it is false on ' +
                'every run and the refusal never fires — while the verdict binding beside it still reads as correct. ' +
                `Its env: is {${[...env.keys()].join(', ') || 'empty'}}.`,
            );
          } else {
            // POLARITY (round 9, on a review finding). Every arm above reads a
            // BINDING or a POSITION; none reads what the condition MEANS. Hold
            // every verdict at the empty string — the state each of them
            // collapses to when its producer declines — and the condition must
            // still be TRUE, or the refusal is not fail-closed against an
            // unknown. See refusalFiresWhenVerdictsUnknown for the two edits of
            // the real workflow that left judge() returning [].
            const values = new Map(read.map((v) => [v, verdicts.includes(v) ? '' : UNMODELLED]));
            const polarity = refusalFiresWhenVerdictsUnknown(condition, values);
            if (polarity.unevaluable) {
              problems.push(
                `step '${step.name}' has a refusal condition this suite cannot evaluate — ${polarity.unevaluable} in ` +
                  `\`${condition.trim()}\`. The POLARITY of a refusal on a destructive step is not something to take ` +
                  'on trust: rewrite it in the `[ … ] || [ … ]` form, or teach refusalFiresWhenVerdictsUnknown the ' +
                  'shape. Reported rather than assumed correct, because assuming is how a refusal stops refusing.',
              );
            } else if (!polarity.fires) {
              problems.push(
                `step '${step.name}' does NOT refuse when its verdicts are UNKNOWN: with ` +
                  `${verdicts.map((v) => `\`$${v}\``).join(', ') || '(no verdict)'} held at the EMPTY STRING — what ` +
                  'each becomes when its producer returns early, is skipped, or never writes the output — ' +
                  `\`${condition.trim()}\` evaluates FALSE, so the branch is not taken and ` +
                  '`fiab-teardown.sh` destroys a sovereign estate this run never measured. An unknown must refuse.',
              );
            }
          }
          // E3. Nothing may overwrite the verdict between the `env:` binding and
          // the branch. The binding is then intact and the value is not.
          //
          // ROUND 9, on a review finding, MEASURED. This used to build its
          // regexes from `bound` — the `steps.<id>.outputs.<verdict>` half
          // alone — while the refusal branches on TWO verdicts, the second
          // bound to `needs.pause-declaration.outputs.declared`. So
          // `ESTATE_DECLARED="false"` inserted below `set -euo pipefail`
          // (+35 B, one line) restored the round-8 blocking defect verbatim
          // with this suite at 50 pass / 0 fail, RC=0. The population is now
          // EVERY verdict the refusal reads, whichever producer shape supplies
          // it, so the sentence above is true of all of them and not of one.
          const runAt = lines.findIndex((l) => /^\s{8}run:/.test(l));
          const assign = new RegExp(
            `^\\s*(?:export\\s+|declare\\s+|local\\s+|readonly\\s+)?(?:${verdicts.join('|')})=`,
          );
          const unset = new RegExp(`^\\s*(?:unset|read)\\s.*\\b(?:${verdicts.join('|')})\\b`);
          for (let i = Math.max(0, runAt + 1); i < refusal.start; i += 1) {
            if (assign.test(lines[i]) || unset.test(lines[i])) {
              problems.push(
                `step '${step.name}' REASSIGNS the verdict variable before it branches on it: \`${lines[i].trim()}\` ` +
                  'runs above the refusal. The env: binding is untouched and every text check still passes, but the ' +
                  'refusal reads the reassigned value and a declared-paused sovereign estate is torn down.',
              );
              break;
            }
          }
          // E4. And the refusal has to come FIRST. A refusal below the
          // destructive call still refuses — after the estate is gone.
          const handoff = destructiveHandoffAt(lines, runAt + 1, refusal.start, refusal.end);
          if (handoff >= 0 && handoff < refusal.start) {
            problems.push(
              `step '${step.name}' REFUSES too late: \`${lines[handoff].trim()}\` runs at line ${handoff - runAt} of ` +
                `its run:, above the refusal at line ${refusal.start - runAt}. The step still exits non-zero, so every ` +
                'text check passes and the log is byte-identical — but a declared-paused sovereign estate is destroyed ' +
                'first and refused over afterwards.',
            );
          }
        }
      }
    }
    if (d.mode === 'exempt') problems.push(...judgeExemption(d, step, 'step'));
  }
  return problems;
}

test('MUTATION: the reviewer probe — a mutating step inserted BEFORE the declaration', () => {
  // The exact probe that passed 22/22 against the parent, quoted verbatim from
  // the review: a subscription-scoped delete of the GCC-High admin RG, inserted
  // immediately above the declaration, where rounds 1-4 declared everything
  // "OUT OF FRAME, INHERENTLY".
  const steps = parseSteps(workflowText());
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  assert.ok(at > 0);
  const mutant = {
    name: 'Reconcile the sovereign estate',
    if: '',
    body: '      - name: Reconcile the sovereign estate\n        run: az group delete -n rg-csa-loom-admin-usgovvirginia --yes',
  };
  const problems = judge([...steps.slice(0, at), mutant, ...steps.slice(at)]);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /runs BEFORE the declaration and has no entry in PRE_DISPOSITIONS/);
});

test('MUTATION: a DISPOSITIONED pre-declaration step rewritten to mutate is caught', () => {
  // The narrower bypass: keep the name, keep the reason, change what it does.
  // Reading the estate is what these steps are FOR, so the reason alone cannot
  // carry this — the body has to be scanned too.
  const target = 'Adopt the image tags this estate is running (no repo variable required)';
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === target ? { ...s, body: `${s.body}\n          az group delete -n rg-csa-loom-admin-usgovvirginia --yes` } : s,
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /WRITES to the estate/);
});

test('the runner-local carve-out is a namespace, not an allowlist', () => {
  // `az cloud set` and `az extension add` configure the CLI on the runner and
  // cannot reach a resource; two real pre-declaration steps run them. The
  // carve-out has to be exactly that wide and no wider.
  assert.equal(estateMutatingAz('az cloud set --name AzureUSGovernment'), null);
  assert.equal(estateMutatingAz('az extension add --name resource-graph -y'), null);
  assert.equal(estateMutatingAz('az config set core.only_show_errors=true'), null);
  assert.equal(estateMutatingAz('az group delete -n rg-csa-loom-admin-usgovvirginia --yes'), 'az group delete');
  assert.equal(estateMutatingAz('az containerapp update --set-env-vars X=1'), 'az containerapp update');
  assert.equal(estateMutatingAz('az account show --query id -o tsv'), null);
  // ROUND 8. `az rest` takes its verb in `--method`, so the command-word scan
  // above stops at the first flag and cannot see it. MEASURED: the reviewer
  // appended an `az rest --method DELETE` of the GCC-High admin RG to the
  // EXEMPT `Note dry-run completion` step of the real workflow and this suite
  // stayed at 45 pass / 0 fail. `grep -c 'az rest'` over .github/workflows
  // returns 16 across 6 files, so this is a spelling the repo actually uses.
  assert.equal(
    estateMutatingAz(
      'az rest --method DELETE --url "https://management.usgovcloudapi.net/subscriptions/S/resourcegroups/rg-csa-loom-admin-usgovvirginia?api-version=2021-04-01"',
    ),
    'az rest --method DELETE',
  );
  assert.equal(estateMutatingAz('az rest --method put --url https://x'), 'az rest --method PUT');
  assert.equal(estateMutatingAz('az rest --method=PATCH --url https://x'), 'az rest --method PATCH');
  assert.equal(estateMutatingAz("az rest --method POST --url 'https://x' --body @b.json"), 'az rest --method POST');
  // A REST READ stays exempt — a scan that flagged it would be pressure to
  // delete the scan rather than fix a lane.
  assert.equal(estateMutatingAz('az rest --method GET --url https://x --query value'), null);
  assert.equal(estateMutatingAz('az rest --url https://x'), null);
  // ROUND 9, on a review finding, MEASURED. Both patterns above stop at a
  // newline, so the round-8 fix closed exactly ONE spelling: the reviewer wrote
  // the same DELETE with the verb behind a backslash continuation, appended to
  // the EXEMPT `Note dry-run completion` step, and the suite went from RC=1 /
  // 29 pass / 21 fail (one line, +166 B) to RC=0 / 50 pass / 0 fail (continued,
  // +196 B). `gov-purview-verify.yml:236` and `full-app-deploy-commercial.yml:298`
  // already write `az rest --method put` with continuations, so the multi-line
  // shape is this repo's own idiom — it just keeps the verb on row 1 today.
  const continued =
    'az rest \\\n  --method DELETE \\\n  --url "https://management.usgovcloudapi.net/subscriptions/S/resourcegroups/rg-csa-loom-admin-usgovvirginia?api-version=2021-04-01"';
  assert.equal(estateMutatingAz(continued), 'az rest --method DELETE');
  assert.equal(estateMutatingAz('az group \\\n  delete -n rg-csa-loom-admin-usgovvirginia --yes'), 'az group delete');
  // …and joining continuations does not invent a write out of two reads on
  // separate lines, or the fix would be a scan that flags everything.
  assert.equal(estateMutatingAz('az account show --query id -o tsv\naz rest --method GET --url https://x'), null);
  assert.equal(logicalLines('a \\\n  b'), 'a b');
  assert.equal(logicalLines('a\nb'), 'a\nb', 'a plain newline is NOT a continuation');
  assert.equal(logicalLines('a \\\r\n  b'), 'a b', 'CRLF continues too — this workflow is checked in CRLF');
});

test('every step after the declaration stands down, refuses, or is dispositioned', () => {
  const problems = judge(parseSteps(workflowText()));
  assert.deepEqual(problems, [], `deploy-fiab-gcch stand-down is incomplete:\n  - ${problems.join('\n  - ')}`);
});

test('the parser sees the real step list and is not matching comment text', () => {
  const steps = parseSteps(workflowText());
  assert.ok(steps.length >= 20, `expected the full deploy-validate step list, parsed ${steps.length}`);
  assert.ok(
    steps.some((s) => s.name === DECLARATION_STEP),
    'the declaration step must be found by NAME, not by a substring of a comment',
  );
  // The workflow quotes a retired condition inside a comment block above
  // Teardown; if that leaked into a step's `if:` this would trip.
  const teardown = steps.find((s) => s.name === 'Teardown');
  assert.ok(teardown, 'Teardown step not parsed');
  assert.equal(
    teardown.if,
    "success() && github.event_name != 'schedule' && inputs.run_mode == 'full' && !inputs.keep_resources",
    'Teardown if: parsed from the live mapping, not from the commented-out condition above it',
  );
});

test('MUTATION: dropping the guard from the revert gate is caught', () => {
  const steps = parseSteps(workflowText());
  const mutated = steps.map((s) =>
    s.name === 'Image-tag revert gate — never flatten a pinned app to the default'
      ? { ...s, if: "github.event_name == 'schedule' || inputs.run_mode == 'full'" }
      : s,
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got ${problems.length}`);
  assert.match(problems[0], /Image-tag revert gate/);
});

test('MUTATION: the #4233 head shape — three steps gated only on schedule/full — is caught', () => {
  const scheduleOnly = "github.event_name == 'schedule' || inputs.run_mode == 'full'";
  const regressed = new Set([
    'Image preflight — Gov ACR must already hold every referenced tag',
    'Image-tag revert gate — never flatten a pinned app to the default',
    'Re-pin appImageTags to the RUNNING images (narrows the roll race — #3683)',
  ]);
  const mutated = parseSteps(workflowText()).map((s) => (regressed.has(s.name) ? { ...s, if: scheduleOnly } : s));
  const problems = judge(mutated);
  assert.equal(problems.length, 3, `expected 3 problems, got ${problems.length}: ${problems.join(' | ')}`);
});

test('MUTATION: a NEW step added after the declaration must be dispositioned', () => {
  const steps = parseSteps(workflowText());
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  const mutated = [...steps];
  mutated.splice(at + 1, 0, { name: 'Reconcile something new', if: '', body: '        run: az group delete' });
  const problems = judge(mutated);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /has no disposition/);
});

test('MUTATION: turning Teardown into a silent skip is caught', () => {
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown' ? { ...s, if: `${s.if} && ${GUARD}` } : s,
  );
  const problems = judge(mutated);
  assert.ok(
    problems.some((p) => /must REFUSE on a paused estate, not skip/.test(p)),
    `expected the silent-skip refusal, got: ${problems.join(' | ')}`,
  );
});

test('MUTATION: an EXEMPT step rewritten to mutate the estate is caught', () => {
  // The reviewer's silence probe S3, verbatim: `Note dry-run completion` is
  // dispositioned exempt ("echoes a line; no az call, no network"), and before
  // round 3 rewriting it to a subscription-scoped delete left the suite GREEN,
  // because `judge` had no `exempt` branch at all.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Note dry-run completion'
      ? { ...s, body: `${s.body}\n          az group delete -n rg-csa-loom-admin-usgovvirginia --yes` }
      : s,
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /Note dry-run completion/);
  assert.match(problems[0], /az group delete/);
});

test('MUTATION R9: the SAME estate write, behind a line continuation, is caught', () => {
  // The round-8 fix closed one physical-line spelling of `az rest --method
  // DELETE` in this exempt step; the reviewer walked past it by writing the
  // identical call over three rows (+196 B), and the suite stayed at 50 pass /
  // 0 fail, RC=0. Two rows of the SAME call is not a different call.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Note dry-run completion'
      ? {
          ...s,
          body:
            `${s.body}\n          az rest \\\n            --method DELETE \\\n` +
            '            --url "https://management.usgovcloudapi.net/subscriptions/S/resourcegroups/' +
            'rg-csa-loom-admin-usgovvirginia?api-version=2021-04-01"',
        }
      : s,
  );
  assert.match(
    mutated.find((s) => s.name === 'Note dry-run completion').body,
    /az rest \\\n\s+--method DELETE/,
    'the mutation must be CONTINUED — the verb off row 1 is the whole point',
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /Note dry-run completion/);
  assert.match(problems[0], /az rest --method DELETE/);
});

test('MUTATION: an exemption whose reason is deleted is caught, for steps and for jobs', () => {
  // `why` is the whole content of an exemption, so an empty or whitespace-only
  // one has to be a failure rather than a shrug. Both populations, so the two
  // cannot drift apart.
  const blankStep = judgeExemption(
    { mode: 'exempt', why: '   ' },
    { name: 'Note dry-run completion', body: 'run: |\n  echo hi' },
    'step',
  );
  assert.equal(blankStep.length, 1, `expected the missing-reason problem, got: ${blankStep.join(' | ')}`);
  assert.match(blankStep[0], /step 'Note dry-run completion' is dispositioned 'exempt' with no reason/);

  const missingJob = judgeExemption({ mode: 'exempt' }, { name: 'precheck', body: '' }, 'job');
  assert.equal(missingJob.length, 1, `expected the missing-reason problem, got: ${missingJob.join(' | ')}`);
  assert.match(missingJob[0], /job 'precheck' is dispositioned 'exempt' with no reason/);
});

test('the exempt scan does NOT flag a read, or a GitHub-side write', () => {
  // A negative control. `az account show` is a read of the SUBSCRIPTION and
  // `github.rest.issues.create` is a GitHub write, not an estate write — both
  // are correctly exempt, and a scan that flagged them would be pressure to
  // delete the scan rather than fix the workflow.
  assert.deepEqual(
    judgeExemption({ mode: 'exempt', why: 'reads the subscription' }, {
      name: 'Export bootstrap coordinates (for the chained Gov bootstrap)',
      body: 'run: |\n  ADMIN_SUB=$(az account show --query id -o tsv)',
    }, 'step'),
    [],
  );
  assert.deepEqual(
    judgeExemption({ mode: 'exempt', why: 'the failure notifier' }, {
      name: 'Notify on failure',
      body: 'run: |\n  await github.rest.issues.create({ owner, repo })',
    }, 'step'),
    [],
  );
});

test('the disjunct parse reads STRUCTURE, not text', () => {
  assert.deepEqual(topLevelDisjuncts('a || b'), ['a', 'b']);
  assert.deepEqual(topLevelDisjuncts('(a || b) && c'), ['(a || b) && c']);
  assert.deepEqual(topLevelDisjuncts('${{ (a || b) && c }}'), ['(a || b) && c']);
  // A `||` inside a string literal is text, not structure.
  assert.deepEqual(topLevelDisjuncts("contains(x, 'a || b') && c"), ["contains(x, 'a || b') && c"]);
  assert.equal(guardIsBinding('(a || b) && G', 'G'), true);
  assert.equal(guardIsBinding('a || b && G', 'G'), false);
  // A guard repeated in EVERY disjunct is still necessary — a check that
  // rejected it would be pressure to delete the check rather than fix a lane.
  assert.equal(guardIsBinding('(a && G) || (b && G)', 'G'), true);
  // ROUND 8. Top-level-disjunct MEMBERSHIP is necessary and not sufficient: a
  // guard nested inside a disjunction inside the single top-level conjunct is
  // just as dead, and the membership test called it binding. What is asserted
  // now is that NO truth assignment satisfies the condition with the guard
  // false, so these fail and the legitimate shapes above still pass.
  assert.equal(guardIsBinding('(a || b) && (G || c)', 'G'), false);
  assert.equal(guardIsBinding('((a && G) || c) && d', 'G'), false);
  assert.equal(guardIsBinding('a && (b || (c && G))', 'G'), false);
  // …and the semantics survive a `!`, a `${{ }}` wrapper and a literal.
  assert.equal(guardIsBinding('${{ !a && G }}', 'G'), true);
  assert.equal(guardIsBinding("contains(x, 'a || b') && G", 'G'), true);
  assert.equal(guardIsBinding('a && b', 'G'), false, 'an ABSENT guard is not a binding guard');
});

test('MUTATION: the guard survives as a substring and stops binding (&& over ||)', () => {
  // Reviewer probe, round 4. GitHub binds && tighter than ||, so dropping the
  // parentheses leaves `event_name == 'schedule' || (run_mode == 'full' && GUARD)`
  // — TRUE on schedule with the guard never read. Measured against the real file
  // before this assertion existed: RC=0, 22 pass / 0 fail.
  const target = 'Image preflight — Gov ACR must already hold every referenced tag';
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === target ? { ...s, if: s.if.replace(/^\((.*?)\)/, '$1') } : s,
  );
  const mutatedIf = mutated.find((s) => s.name === target).if;
  assert.ok(mutatedIf.includes(GUARD), 'the mutant must KEEP the guard substring — that is the whole point');
  assert.notEqual(mutatedIf, parseSteps(workflowText()).find((s) => s.name === target).if);
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /INERT/);
});

test('MUTATION R8: a NESTED disjunction leaves the guard inert, at every guarded mode', () => {
  // Reviewer probe, round 8, MEASURED green before this: rewriting the
  // image-tag revert gate's condition to
  //   (event_name == 'schedule' || run_mode == 'full') && (GUARD || event_name == 'schedule')
  // gives it exactly ONE top-level disjunct, that disjunct contains the guard,
  // the membership test said binding, and the suite stayed at 45 pass / 0 fail
  // — while the guard is inert on `schedule`, the trigger it exists for. The
  // same bypass applied to `job-guard`, `out-guard` and `via-provision`, so all
  // four modes are probed here rather than only the one that was reported.
  const nest = (ifExpr, guard) =>
    `(github.event_name == 'schedule' || inputs.run_mode == 'full') && (${guard} || github.event_name == 'schedule')`;

  const stepTargets = [
    ['Image-tag revert gate — never flatten a pinned app to the default', GUARD],
    ['Provision (with full Gov dispatch)', GUARD],
    ['Apply ACR compliance tags (merge-patch, out-of-band — #3714)', "steps.provision.conclusion == 'success'"],
  ];
  for (const [name, guard] of stepTargets) {
    const mutated = parseSteps(workflowText()).map((s) => (s.name === name ? { ...s, if: nest(s.if, guard) } : s));
    assert.ok(mutated.find((s) => s.name === name).if.includes(guard), 'the mutant must KEEP the guard substring');
    const problems = judge(mutated);
    assert.equal(problems.length, 1, `${name}: expected exactly one problem, got: ${problems.join(' | ')}`);
    assert.match(problems[0], /INERT/);
    assert.match(problems[0], new RegExp(name.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const jobTargets = [
    ['build-gov-images', JOB_GUARD],
    ['post-deploy-bootstrap', "needs.deploy-validate.outputs.estate_paused != 'true'"],
  ];
  for (const [name, guard] of jobTargets) {
    const mutated = parseJobs(workflowText()).map((j) => (j.name === name ? { ...j, if: nest(j.if, guard) } : j));
    const problems = judgeJobs(mutated);
    assert.equal(problems.length, 1, `${name}: expected exactly one problem, got: ${problems.join(' | ')}`);
    assert.match(problems[0], /INERT/);
    assert.match(problems[0], new RegExp(`job '${name}'`));
  }
});

test('MUTATION: a refusal that PRINTS and carries on is caught', () => {
  // Reviewer probe, round 4. `::error::` does not fail a step; only the exit
  // does. Measured against the real file with the single `exit 1` deleted,
  // before this assertion existed: RC=0, 22 pass / 0 fail.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown' ? { ...s, body: s.body.replace(/\n\s*exit 1\b/, '') } : s,
  );
  const teardown = mutated.find((s) => s.name === 'Teardown');
  assert.ok(
    /::error::/.test(teardown.body) && /ESTATE_PAUSED/.test(teardown.body),
    'the mutant must keep the annotation and the variable read — only the exit goes',
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /non-zero exit/);
});

test('the verdict chain: every step reference resolves to a step that COMPUTES it', () => {
  // The positive half. The `if:`/`env:` population is derived from the parsed
  // YAML, so this must be non-empty — a chain check over zero references is the
  // vacuous-green shape this file exists to avoid.
  const steps = parseSteps(workflowText());
  const readers = steps.filter(
    (s) => verdictRefs(s.if).length > 0 || [...stepEnv(s.body).values()].some((v) => verdictRefs(v).length > 0),
  );
  assert.ok(readers.length >= 10, `expected the job's verdict readers, found ${readers.length}`);
  // The Teardown refusal is the one that reads it through `env:` rather than
  // `if:`, and it is the reference that had no chain assertion at all.
  const teardown = steps.find((s) => s.name === 'Teardown');
  const bindings = [...stepEnv(teardown.body)].filter(([, v]) => verdictRefs(v).length > 0);
  assert.equal(bindings.length, 1, `Teardown must bind the verdict through env:, found ${bindings.length}`);
  assert.equal(bindings[0][0], 'ESTATE_PAUSED');
  assert.deepEqual(judgeVerdictReferences(steps), []);
});

test('MUTATION: the reviewer probe — deleting the Teardown env: binding is caught', () => {
  // Reviewer probe, round 6, VERBATIM: delete the single line
  //   ESTATE_PAUSED: ${{ steps.adx_preflight.outputs.estate_paused }}
  // Measured green before this assertion existed: this suite 34/34 RC=0, the
  // sibling estate-preflight suite 78/78 RC=0, all five scripts/ci/check-*
  // workflow guards RC=0 — with `fiab-teardown.sh` free to destroy a declared-
  // paused sovereign estate.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown'
      ? { ...s, body: s.body.split('\n').filter((l) => !/^ {10}ESTATE_PAUSED:/.test(l)).join('\n') }
      : s,
  );
  const teardown = mutated.find((s) => s.name === 'Teardown');
  assert.ok(
    /ESTATE_PAUSED/.test(teardown.body) && /exit 1/.test(teardown.body) && /::error::/.test(teardown.body),
    'the mutant must keep the whole shell refusal — only the env: binding goes, which is what makes it a bypass',
  );
  assert.equal(stepEnv(teardown.body).has('ESTATE_PAUSED'), false);
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /binds none of them/);
});

test('MUTATION: renaming the producing step id leaves every reference dangling', () => {
  // The `steps.*` twin of round 4's "delete the producer job". Every reader —
  // the ten guards, the declaration summary and the Teardown env: binding —
  // resolves to nothing, evaluates to EMPTY, and stops suppressing or refusing.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.id === 'adx_preflight' ? { ...s, id: 'adx_preflight_renamed' } : s,
  );
  const problems = judgeVerdictReferences(mutated);
  assert.ok(problems.length >= 10, `expected every reader to be caught, got ${problems.length}`);
  assert.ok(problems.every((p) => /no step of deploy-validate carries `id: adx_preflight`/.test(p)));
  assert.ok(
    problems.some((p) => /^step 'Teardown' reads .* in its env\.ESTATE_PAUSED/.test(p)),
    `the Teardown env: binding must be in the population, got: ${problems.join(' | ')}`,
  );
});

test('MUTATION: binding the refusal to a step that does NOT compute the verdict is caught', () => {
  // The narrower bypass: keep the `env:` line, keep a REAL step id, and point it
  // at a step that never writes the value. `steps.provision.outputs.estate_paused`
  // is empty on every run, so the refusal never refuses — while every substring
  // and every id-existence check stays satisfied.
  const steps = parseSteps(workflowText());
  assert.ok(steps.some((s) => s.id === 'provision'), 'the decoy id must be a REAL step id, or this proves nothing');
  const mutated = steps.map((s) =>
    s.name === 'Teardown'
      ? { ...s, body: s.body.replace(/steps\.adx_preflight\.outputs\.estate_paused/, 'steps.provision.outputs.estate_paused') }
      : s,
  );
  assert.equal(
    stepEnv(mutated.find((s) => s.name === 'Teardown').body).get('ESTATE_PAUSED'),
    '${{ steps.provision.outputs.estate_paused }}',
    'the mutant must still BIND ESTATE_PAUSED — only the producer changes',
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /does not invoke ensure-adx-cluster-running\.mjs/);
});

/**
 * ROUND 7. The reviewer's E1 / E3 / E4, applied to the real workflow as the
 * single-line edits they were: measured against the round-6 suite at
 * `a6f944e1c3f` through the LOOM_GCCH_WORKFLOW_PATH seam, all three were
 * **RC=0, 39 pass / 0 fail**, with `estate-preflight` 78/78 RC=0 and nine
 * `scripts/ci/check-*` guards RC=0. Byte deltas +44 / +28 / **+0**.
 *
 * Each is a bypass of a DIFFERENT kind: E1 adds a conjunct nothing binds, E3
 * keeps the binding and destroys the value, E4 changes no bytes at all and only
 * moves the block. The first two are still assertions about the text; only E4's
 * is about the OUTCOME — that the refusal is reached before the estate is gone.
 */
/**
 * Rewrite the FIRST LINE of the Teardown's refusal conditional — the `if …; then`
 * — DERIVED from `refusalBlock` rather than pinned to its current spelling.
 *
 * ROUND 8. These mutations used to `.replace()` a hardcoded
 * `if [ "${ESTATE_PAUSED:-}" = "true" ]; then`. When the refusal grew its second
 * verdict (see judgeUnconditionalVerdict) every one of them silently stopped
 * applying — and each one's own "the mutation must have applied" assertion is
 * the only reason that showed up as a red rather than as four tests quietly
 * proving nothing. Anchoring on the block means the next change to the condition
 * mutates whatever is actually there.
 *
 * @param {string} body
 * @param {(condition:string) => string} rewrite
 * @returns {string}
 */
function mutateRefusal(body, rewrite) {
  const block = refusalBlock(body);
  assert.ok(block, 'the real Teardown must have a refusal block to mutate');
  const lines = String(body).split('\n');
  lines.splice(block.start, 1, ...rewrite(lines[block.start]).split('\n'));
  return lines.join('\n');
}

test('MUTATION E1: a conjunct bound to NOTHING disarms the refusal', () => {
  // `[ "${LOOM_REFUSE_TEARDOWN:-}" = "true" ]` is false on every run, because
  // nothing anywhere sets it — so the AND is false on every run and a declared-
  // paused sovereign estate is torn down. Round 6 permitted this deliberately,
  // on the reasoning that requiring every name to be bound "would forbid
  // `[ "$ESTATE_PAUSED" = true ] && [ "$X" ]`". It does not: `$X` is allowed
  // whenever `X` is a real key of the step's env:, which is asserted below.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown'
      ? {
          ...s,
          body: mutateRefusal(s.body, (c) =>
            c.replace(/; then$/, ' && [ "${LOOM_REFUSE_TEARDOWN:-}" = "true" ]; then'),
          ),
        }
      : s,
  );
  const teardown = mutated.find((s) => s.name === 'Teardown');
  assert.match(teardown.body, /LOOM_REFUSE_TEARDOWN/, 'the mutation must have applied');
  assert.equal(
    stepEnv(teardown.body).get('ESTATE_PAUSED'),
    '${{ steps.adx_preflight.outputs.estate_paused }}',
    'the verdict binding must SURVIVE — that is what makes this a bypass rather than a break',
  );
  assert.match(refusalBlock(teardown.body).text, /exit 1/, 'the refusal must still contain its exit');
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /which its env: does not bind at all/);
});

test('MUTATION E1b: a second conjunct that IS bound stays green', () => {
  // The negative control for E1, and the case round 6 was protecting. `$RG_NAME`
  // is a real key of the same env: map, so conjoining on it is a legitimate
  // condition and must NOT be rejected. Without this, the E1 fix would be a
  // blanket ban on conjunctions rather than a ban on unbound names.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown'
      ? { ...s, body: mutateRefusal(s.body, (c) => c.replace(/; then$/, ' && [ -n "${RG_NAME:-}" ]; then')) }
      : s,
  );
  const teardown = mutated.find((s) => s.name === 'Teardown');
  assert.match(teardown.body, /RG_NAME:-/, 'the mutation must have applied');
  assert.ok(stepEnv(teardown.body).has('RG_NAME'), 'the decoy must be a REAL env key, or this proves nothing');
  assert.deepEqual(judge(mutated), []);
});

test('MUTATION E3: overwriting the verdict above the branch is caught', () => {
  // The binding survives, every text check survives, and `ESTATE_PAUSED` is the
  // empty string by the time the branch reads it. One inserted line, +28 B.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown'
      ? { ...s, body: mutateRefusal(s.body, (c) => `${c.match(/^\s*/)[0]}ESTATE_PAUSED=""\n${c}`) }
      : s,
  );
  const teardown = mutated.find((s) => s.name === 'Teardown');
  assert.match(teardown.body, /^\s*ESTATE_PAUSED=""$/m, 'the mutation must have applied');
  assert.equal(
    stepEnv(teardown.body).get('ESTATE_PAUSED'),
    '${{ steps.adx_preflight.outputs.estate_paused }}',
    'the env: binding must SURVIVE — the value is destroyed in the shell, not the binding',
  );
  assert.match(refusalBlock(teardown.body).text, /exit 1/);
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /REASSIGNS the verdict variable before it branches on it/);
});

test('MUTATION R9: overwriting the OTHER verdict above the branch is caught — +35 bytes', () => {
  // THE ROUND-9 BLOCKING FINDING, pinned. E3 above protects `ESTATE_PAUSED`,
  // the `steps.<id>.outputs.<verdict>` half. The refusal branches on TWO
  // verdicts, and the second — `ESTATE_DECLARED`, bound to
  // `needs.pause-declaration.outputs.declared` — was outside every arm's frame,
  // because `bound` was filtered through `verdictRefs()`, whose regex is
  // derived from GUARD and matches `steps.*` only.
  //
  // MEASURED at head before the fix: this one inserted line left the suite at
  // 50 pass / 0 fail, RC=0 — and it restores the round-8 defect verbatim. On a
  // `topology=dlz-attach` + `run_mode=full` + `keep_resources=false` dispatch
  // the ADX preflight returns before writing `estate_paused`, so `ESTATE_PAUSED`
  // is empty AND `ESTATE_DECLARED` is forced to `false`: both conjuncts false,
  // no refusal, `.github/scripts/fiab-teardown.sh` against a DECLARED-PAUSED
  // sovereign estate. A defaulting line is also the most ordinary edit anyone
  // would make next, which is what makes it worth a ratchet arm.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown'
      ? { ...s, body: mutateRefusal(s.body, (c) => `${c.match(/^\s*/)[0]}ESTATE_DECLARED="false"\n${c}`) }
      : s,
  );
  const teardown = mutated.find((s) => s.name === 'Teardown');
  assert.match(teardown.body, /^\s*ESTATE_DECLARED="false"$/m, 'the mutation must have applied');
  assert.equal(
    stepEnv(teardown.body).get('ESTATE_DECLARED'),
    '${{ needs.pause-declaration.outputs.declared }}',
    'the env: binding must SURVIVE — the value is destroyed in the shell, not the binding',
  );
  assert.match(refusalBlock(teardown.body).text, /exit 1/);
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /REASSIGNS the verdict variable before it branches on it/);
  assert.match(problems[0], /ESTATE_DECLARED="false"/);
});

test('the E3 population is EVERY verdict the refusal reads, from either producer shape', () => {
  // The negative half of the arm above: not "one more name was added to a
  // list", but "the list is derived from both binding shapes". `bound` comes
  // from verdictRefs (steps.*), the rest from unconditionalVerdictBindings
  // (needs.* of a job with no if:), and the real Teardown has exactly one of
  // each. If either derivation silently emptied, this would read as compliant.
  const teardown = parseSteps(workflowText()).find((s) => s.name === 'Teardown');
  const env = stepEnv(teardown.body);
  const jobs = parseJobs(workflowText());
  assert.deepEqual(
    [...env].filter(([, v]) => verdictRefs(v).length > 0).map(([k]) => k),
    ['ESTATE_PAUSED'],
    'the steps.<id>.outputs.<verdict> half',
  );
  assert.deepEqual(
    unconditionalVerdictBindings(jobs, env).map((c) => c.key),
    ['ESTATE_DECLARED'],
    'the needs.<job>.outputs.<key>-of-an-unconditional-producer half',
  );
  // …and a CONDITIONED producer is not in it: that is what makes this half a
  // measurement of the producer rather than a spelling of the key.
  assert.deepEqual(
    unconditionalVerdictBindings(
      jobs.map((j) => (j.name === 'pause-declaration' ? { ...j, if: "github.event_name == 'schedule'" } : j)),
      env,
    ),
    [],
  );
});

test('MUTATION R9: a refusal that stops firing on an UNKNOWN verdict is caught', () => {
  // POLARITY. Two edits of the real condition, each of which restores the
  // round-8 defect, and each of which left `judge()` returning `[]` at head:
  // the suite went red only because one fixture regex pins the literal text of
  // the second conjunct — coincidence, not design.
  const cases = [
    ['= "true" on the declaration half (−2 B)', / != "false" \]; then$/m, ' = "true" ]; then'],
    ['|| becomes && (+0 B)', / \|\| \[ "\$\{ESTATE_DECLARED/m, ' && [ "${ESTATE_DECLARED'],
  ];
  for (const [label, find, replace] of cases) {
    const mutated = parseSteps(workflowText()).map((s) =>
      s.name === 'Teardown' ? { ...s, body: mutateRefusal(s.body, (c) => c.replace(find, replace)) } : s,
    );
    const teardown = mutated.find((s) => s.name === 'Teardown');
    const condition = refusalBlock(teardown.body).text.split('\n')[0];
    assert.notEqual(
      condition,
      refusalBlock(parseSteps(workflowText()).find((s) => s.name === 'Teardown').body).text.split('\n')[0],
      `${label}: the mutation must have applied`,
    );
    // Every binding and every position survives: this is a change of MEANING.
    assert.equal(stepEnv(teardown.body).get('ESTATE_PAUSED'), '${{ steps.adx_preflight.outputs.estate_paused }}');
    assert.equal(stepEnv(teardown.body).get('ESTATE_DECLARED'), '${{ needs.pause-declaration.outputs.declared }}');
    assert.match(refusalBlock(teardown.body).text, /exit 1/, `${label}: the refusal still contains its exit`);
    const problems = judge(mutated);
    assert.equal(problems.length, 1, `${label}: expected exactly one problem, got: ${problems.join(' | ')}`);
    assert.match(problems[0], /does NOT refuse when its verdicts are UNKNOWN/, label);
  }
});

test('the polarity check reads the condition, and says so when it cannot', () => {
  const empty = new Map([
    ['ESTATE_PAUSED', ''],
    ['ESTATE_DECLARED', ''],
  ]);
  // The real shape: an unknown pair REFUSES.
  assert.deepEqual(
    refusalFiresWhenVerdictsUnknown(
      'if [ "${ESTATE_PAUSED:-}" = "true" ] || [ "${ESTATE_DECLARED:-}" != "false" ]; then',
      empty,
    ),
    { fires: true },
  );
  // Both polarity mutants, at the level of the condition itself.
  assert.deepEqual(
    refusalFiresWhenVerdictsUnknown(
      'if [ "${ESTATE_PAUSED:-}" = "true" ] || [ "${ESTATE_DECLARED:-}" = "true" ]; then',
      empty,
    ),
    { fires: false },
  );
  assert.deepEqual(
    refusalFiresWhenVerdictsUnknown(
      'if [ "${ESTATE_PAUSED:-}" = "true" ] && [ "${ESTATE_DECLARED:-}" != "false" ]; then',
      empty,
    ),
    { fires: false },
  );
  // `&&` and `||` are equal precedence and LEFT-associative in sh; evaluating
  // right-first would call the next line a refusal, which it is not.
  assert.deepEqual(
    refusalFiresWhenVerdictsUnknown(
      'if [ -n "${ESTATE_PAUSED:-}" ] && [ -n "${ESTATE_DECLARED:-}" ] || [ -z "${ESTATE_PAUSED:-}" ]; then',
      empty,
    ),
    { fires: true },
  );
  assert.deepEqual(
    refusalFiresWhenVerdictsUnknown(
      'if [ -z "${ESTATE_PAUSED:-}" ] || [ -n "${ESTATE_DECLARED:-}" ] && [ -n "${ESTATE_PAUSED:-}" ]; then',
      empty,
    ),
    { fires: false },
  );
  // A name this file does not model keeps a NON-EMPTY stand-in, so a legitimate
  // second conjunct on a real env key is not called a polarity defect.
  assert.deepEqual(
    refusalFiresWhenVerdictsUnknown(
      'if [ "${ESTATE_PAUSED:-}" = "true" ] || [ "${ESTATE_DECLARED:-}" != "false" ] && [ -n "${RG_NAME:-}" ]; then',
      empty,
    ),
    { fires: true },
  );
  // `!` negation, and a default that is not empty.
  assert.deepEqual(refusalFiresWhenVerdictsUnknown('if ! [ -n "${ESTATE_PAUSED:-}" ]; then', empty), { fires: true });
  assert.deepEqual(refusalFiresWhenVerdictsUnknown('if [ "${ESTATE_PAUSED:-true}" = "true" ]; then', empty), {
    fires: true,
  });
  // And FAIL-CLOSED on anything it cannot evaluate: a shape it does not model
  // is REPORTED, never assumed to refuse. Silence on an unread condition is
  // how the polarity went unasserted for eight rounds.
  assert.ok(refusalFiresWhenVerdictsUnknown('if grep -q x "$FILE"; then', empty).unevaluable);
  assert.ok(refusalFiresWhenVerdictsUnknown('if [ "${ESTATE_PAUSED:+x}" = "x" ]; then', empty).unevaluable);
  assert.ok(refusalFiresWhenVerdictsUnknown('if [ "$A" -lt 3 ]; then', empty).unevaluable);
  assert.ok(refusalFiresWhenVerdictsUnknown('if [ "$A" = "b"; then', empty).unevaluable);
});

test('MUTATION E4: a refusal moved BELOW the teardown is caught — +0 bytes', () => {
  // The one that costs nothing to write and nothing to review: a pure reorder,
  // log byte-identical, every assertion in this file true. The estate is
  // destroyed and THEN refused over. Only position can see it.
  const teardownSrc = parseSteps(workflowText()).find((s) => s.name === 'Teardown');
  const block = refusalBlock(teardownSrc.body);
  assert.ok(block, 'the real Teardown must have a refusal block to move');
  const lines = teardownSrc.body.split('\n');
  const call = destructiveHandoffAt(lines, 0, block.start, block.end);
  assert.ok(call > block.end, 'at head the refusal must precede the destructive call');
  const reordered = [
    ...lines.slice(0, block.start),
    ...lines.slice(block.end + 1, call + 1),
    ...lines.slice(block.start, block.end + 1),
    ...lines.slice(call + 1),
  ];
  assert.equal(
    reordered.join('\n').length,
    teardownSrc.body.length,
    'E4 must be a PURE REORDER — byte length identical, or it is not the mutation that was measured',
  );
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown' ? { ...s, body: reordered.join('\n') } : s,
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /REFUSES too late/);
});

test('the destructive-handoff scan is keyed to the SHAPE of the call, not to fiab-teardown.sh', () => {
  // If this were a filename list, renaming the script would move the refusal
  // back above it silently. A `.sh` handed to a shell and an estate-writing `az`
  // are both handoffs; an `az` read and a bare mention of a path are not.
  assert.equal(destructiveHandoffAt(['bash .github/scripts/anything-else.sh'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['  sh ./scripts/x.sh --yes'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['az group delete -n rg --yes'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['echo "see .github/scripts/fiab-teardown.sh"'], 0, -1, -1), -1);
  assert.equal(destructiveHandoffAt(['az account show --query id -o tsv'], 0, -1, -1), -1);
  assert.equal(destructiveHandoffAt(['bash x.sh'], 0, 0, 0), -1, 'lines inside the refusal are skipped');
  // ROUND 8, on a review finding: two more spellings of the SAME handoff that
  // the shell-word pattern could not see. `bash -c` puts flags between the
  // shell and its argument; a bare exec needs no shell word at all.
  assert.equal(destructiveHandoffAt(['bash -c "cd /tmp && ./fiab-teardown.sh --yes"'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['  .github/scripts/fiab-teardown.sh'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['  ./scripts/x.sh --yes'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['  echo hi && ./teardown.sh'], 0, -1, -1), 0);
  // …and the bare form fires only at a COMMAND POSITION, so a filename that is
  // merely MENTIONED is still not a handoff. Both directions, or this is a ban
  // on writing the word rather than a scan for the call.
  assert.equal(destructiveHandoffAt(['          echo "run .github/scripts/fiab-teardown.sh to remove it"'], 0, -1, -1), -1);
  assert.equal(destructiveHandoffAt(['          RG_NAME=rg-csa-loom-admin-usgovvirginia'], 0, -1, -1), -1);
  // ROUND 10, on a review finding: the bare form's path could not cross a `$` or
  // a `{`, so the ORDINARY workflow spelling of that path walked past — while
  // the same line with `bash ` in front was caught, because those alternatives
  // use a negated class. Measured at the round-9 head: +64 B green vs +69 B red.
  assert.equal(destructiveHandoffAt(['  ${GITHUB_WORKSPACE}/.github/scripts/fiab-teardown.sh'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['  $GITHUB_WORKSPACE/.github/scripts/fiab-teardown.sh --yes'], 0, -1, -1), 0);
  assert.equal(destructiveHandoffAt(['  echo hi && ${HOME}/x.sh'], 0, -1, -1), 0);
  // …and widening the class must not turn a MENTION into a call.
  assert.equal(destructiveHandoffAt(['          echo "run ${GITHUB_WORKSPACE}/scripts/x.sh"'], 0, -1, -1), -1);
  assert.equal(destructiveHandoffAt(['          TEARDOWN=${GITHUB_WORKSPACE}/scripts/x.sh'], 0, -1, -1), -1);
});

test('MUTATION R8: a BARE exec above the refusal is caught', () => {
  // M4 of round 8. `.github/scripts/fiab-teardown.sh` is executable, so it needs
  // no `bash` in front of it — and the round-7 shape required one.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown'
      ? { ...s, body: mutateRefusal(s.body, (c) => `${c.match(/^\s*/)[0]}.github/scripts/fiab-teardown.sh\n${c}`) }
      : s,
  );
  const problems = judge(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /REFUSES too late/);
  assert.match(problems[0], /fiab-teardown\.sh/);
});

test('MUTATION R8: the refusal reading only a verdict its producer can DECLINE to write', () => {
  // THE ROUND-8 BLOCKING FINDING, pinned. `steps.adx_preflight.outputs.estate_paused`
  // is written by a step that returns at line 5 of its own body on
  // `topology=dlz-attach` — one of four workflow_dispatch topology choices, and
  // one that satisfies Teardown's own `run_mode == 'full'` condition. So the
  // producer RAN, produced nothing, `[ "" = "true" ]` was false, and
  // fiab-teardown.sh destroyed a DECLARED-PAUSED sovereign estate while every
  // static chain assertion in this file held. Deleting the second binding — the
  // one whose producer job carries no `if:` at all — must go red.
  const mutated = parseSteps(workflowText()).map((s) =>
    s.name === 'Teardown'
      ? {
          ...s,
          body: s.body
            .split('\n')
            .filter((l) => !/^ {10}ESTATE_DECLARED:/.test(l))
            .join('\n')
            .replace(/ \|\| \[ "\$\{ESTATE_DECLARED:-\}" != "false" \]; then$/m, '; then'),
        }
      : s,
  );
  const teardown = mutated.find((s) => s.name === 'Teardown');
  assert.ok(!stepEnv(teardown.body).has('ESTATE_DECLARED'), 'the mutation must have applied');
  // ROUND 9, on a review nit. The `.replace()` above pins the LITERAL text of
  // the second conjunct, and round 8 recorded what that costs: the round-4..7
  // fixtures "silently stopped applying when the refusal grew its second
  // verdict". Assert the SHELL half landed too, so a reworded condition fails
  // this test loudly instead of measuring a mutant that was never applied.
  assert.doesNotMatch(
    refusalBlock(teardown.body).text.split('\n')[0],
    /ESTATE_DECLARED/,
    'the CONDITION half of the mutation must have applied — otherwise this measures the unmutated refusal',
  );
  assert.equal(
    stepEnv(teardown.body).get('ESTATE_PAUSED'),
    '${{ steps.adx_preflight.outputs.estate_paused }}',
    'the step-output binding must SURVIVE — round 6 and round 7 both stay green on this mutant',
  );
  assert.match(refusalBlock(teardown.body).text, /exit 1/, 'the refusal still refuses, on a value that is empty');
  const problems = judge(mutated);
  // TWO problems since round 9, from two independent arms: the binding arm
  // (no verdict from a producer that cannot decline) and the polarity arm (the
  // surviving condition does not fire when its one verdict is empty). Both are
  // this defect; requiring both is strictly stronger than the "exactly one"
  // this asserted while the polarity of the refusal went unread.
  assert.equal(problems.length, 2, `expected exactly two problems, got: ${problems.join(' | ')}`);
  assert.ok(
    problems.some((p) => /binds no verdict to a `needs\.<job>\.outputs\.<key>` of a job that carries NO `if:`/.test(p)),
    `the binding arm must fire: ${problems.join(' | ')}`,
  );
  assert.ok(
    problems.some((p) => /does NOT refuse when its verdicts are UNKNOWN/.test(p)),
    `the polarity arm must fire: ${problems.join(' | ')}`,
  );
});

test('MUTATION R8: conditioning the producer JOB disarms the same refusal', () => {
  // The narrower bypass on the same arm: keep the binding, give its producer a
  // condition. A job with an `if:` can be skipped, a skipped job publishes no
  // output, and an unpublished output is the empty string.
  const jobs = parseJobs(workflowText()).map((j) =>
    j.name === 'pause-declaration' ? { ...j, if: "github.event_name == 'schedule'" } : j,
  );
  const problems = judge(parseSteps(workflowText()), jobs);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /binds no verdict to a `needs\.<job>\.outputs\.<key>` of a job that carries NO `if:`/);
});

test('MUTATION R10: conditioning the producing STEP disarms the same guard, and stays green without this arm', () => {
  // The narrower bypass on round 8's arm: keep the JOB unconditional — which is
  // all rounds 4 and 8 ever asked — and condition the STEP that writes the
  // output. `pause-declaration` then SUCCEEDS on the daily cron publishing an
  // EMPTY `declared`, and `build-gov-images` opens the sovereign ACR on a
  // declared pause. Measured at the round-9 head: +54 B, RC=0, 56 pass / 0 fail.
  const jobs = parseJobs(workflowText()).map((j) =>
    j.name === 'pause-declaration'
      ? {
          ...j,
          body: j.body
            .split('\n')
            .flatMap((l) => (/^ {6}- id: read\s*$/.test(l) ? [l, "        if: github.event_name == 'workflow_dispatch'"] : [l]))
            .join('\n'),
        }
      : j,
  );
  const problems = judge(parseSteps(workflowText()), jobs);
  assert.ok(
    problems.some((p) => /that STEP carries `if: github\.event_name == 'workflow_dispatch'`/.test(p)),
    `the producing-step arm must fire: ${problems.join(' | ') || '(none)'}`,
  );
  // …and the forgiven-failure spelling of the same disarm.
  const forgiven = parseJobs(workflowText()).map((j) =>
    j.name === 'pause-declaration'
      ? {
          ...j,
          body: j.body
            .split('\n')
            .flatMap((l) => (/^ {6}- id: read\s*$/.test(l) ? [l, '        continue-on-error: true'] : [l]))
            .join('\n'),
        }
      : j,
  );
  assert.ok(
    judge(parseSteps(workflowText()), forgiven).some((p) => /carries\s+`continue-on-error: true`/.test(p)),
    'a forgiven producing step writes no output and leaves the job green',
  );
});

test('MUTATION R8: dropping the producer from deploy-validate needs: is caught', () => {
  // The third way the same expression goes empty: `needs.<job>.outputs.<key>`
  // evaluates to nothing at all when the job is not declared as a need, so the
  // binding is present and the value never is.
  const jobs = parseJobs(workflowText()).map((j) =>
    j.name === 'deploy-validate' ? { ...j, needs: '[precheck, build-gov-images]' } : j,
  );
  const problems = judge(parseSteps(workflowText()), jobs);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /does not declare 'pause-declaration' in its needs:/);
});

test('refusalBlock anchors on the SHAPE of the conditional, not on the variable name', () => {
  // Round-7 nit: the anchor used to hardcode `ESTATE_PAUSED` directly above code
  // that derives that same name out of the shell so it is NOT hardcoded. A
  // consistent rename of the shell variable must keep working…
  const teardown = parseSteps(workflowText()).find((s) => s.name === 'Teardown');
  const renamed = teardown.body.replace(/ESTATE_PAUSED/g, 'LOOM_ESTATE_VERDICT');
  const block = refusalBlock(renamed);
  assert.ok(block, 'a consistent rename must not blind the anchor');
  assert.match(block.text, /exit 1/);
  assert.deepEqual(
    judge(parseSteps(workflowText()).map((s) => (s.name === 'Teardown' ? { ...s, body: renamed } : s))),
    [],
  );
  // …and anchoring on the FIRST variable-reading conditional is fail-closed: a
  // decoy planted above the real refusal is returned, and it has no exit in it.
  const decoyed = mutateRefusal(teardown.body, (c) => {
    const pad = c.match(/^\s*/)[0];
    return `${pad}if [ -n "\${RG_NAME:-}" ]; then\n${pad}  echo "decoy"\n${pad}fi\n${c}`;
  });
  assert.notEqual(decoyed, teardown.body, 'the decoy must have been inserted');
  const decoyProblems = judge(parseSteps(workflowText()).map((s) => (s.name === 'Teardown' ? { ...s, body: decoyed } : s)));
  assert.ok(
    decoyProblems.some((p) => /contains no non-zero exit/.test(p)),
    `a decoy conditional above the refusal must go red, got: ${decoyProblems.join(' | ') || '(none)'}`,
  );
});

const VERDICT_PRODUCER = 'ADX preflight — a stopped cluster cannot take its principal assignments';

function mutateProducer(rewrite) {
  return parseSteps(workflowText()).map((s) =>
    s.name === VERDICT_PRODUCER ? { ...s, body: rewrite(s.body) } : s,
  );
}

test('MUTATION R10: the producer returning WITHOUT writing the verdict is caught', () => {
  // The round-8 mechanism, at the producer instead of at one consumer. Delete
  // the verdict write from the dlz-attach return and the step still runs, still
  // exits 0, still invokes the script on the other branch — and publishes the
  // EMPTY STRING on `topology=dlz-attach`, which opens all twelve step gates,
  // the job output, and the chained bootstrap on a DECLARED-PAUSED estate.
  const problems = judge(
    mutateProducer((b) => b.split('\n').filter((l) => !/estate_paused=[^\n]*GITHUB_OUTPUT/.test(l)).join('\n')),
  );
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ') || '(none)'}`);
  assert.match(problems[0], /can reach `exit 0` without\s+writing that output/);
});

test('MUTATION R10: a NEW early return with no verdict write is caught', () => {
  // The class, not the instance: any future early return has to publish too.
  const problems = judge(
    mutateProducer((b) =>
      b.replace(
        /^(\s+)set -euo pipefail$/m,
        '$1set -euo pipefail\n$1if [ "${CSA_LOOM_SKIP:-}" = "1" ]; then\n$1  echo "::notice::skipping"\n$1  exit 0\n$1fi',
      ),
    ),
  );
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ') || '(none)'}`);
  assert.match(problems[0], /can reach `exit 0` without\s+writing that output/);
});

test('the totality check is per-PATH, so losing ONE arm of the branch is caught', () => {
  // The narrow bypass a line-order scan cannot see: leave a write in the file,
  // above the return, but only on one arm. The other arm reaches `exit 0`
  // having written nothing — and a "is there a write above this line" scan
  // reads green.
  let dropped = false;
  const problems = judge(
    mutateProducer((b) =>
      b
        .split('\n')
        .filter((l) => {
          if (!dropped && /estate_paused=[^\n]*GITHUB_OUTPUT/.test(l)) {
            dropped = true;
            return false;
          }
          return true;
        })
        .join('\n'),
    ),
  );
  assert.ok(dropped, 'the mutation must have removed exactly one write');
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ') || '(none)'}`);
  assert.match(problems[0], /can reach `exit 0` without\s+writing that output/);
});

test('unwrittenEarlyExits models the branch, and says nothing about exit 1', () => {
  const W = 'echo "estate_paused=true" >> "$GITHUB_OUTPUT"';
  // An `if` with no `else` guarantees nothing on the fall-through path.
  assert.equal(unwrittenEarlyExits(['if [ x ]; then', W, 'fi', 'exit 0'].join('\n')).length, 1);
  // …with an `else` that also writes, it does.
  assert.equal(
    unwrittenEarlyExits(['if [ x ]; then', W, 'else', W, 'fi', 'exit 0'].join('\n')).length,
    0,
  );
  // …with an `else` that does NOT, it does not.
  assert.equal(
    unwrittenEarlyExits(['if [ x ]; then', W, 'else', 'echo no', 'fi', 'exit 0'].join('\n')).length,
    1,
  );
  // A write inherited from the parent arm covers a nested exit.
  assert.equal(unwrittenEarlyExits([W, 'if [ x ]; then', 'exit 0', 'fi'].join('\n')).length, 0);
  // `exit 1` FAILS the step, so no consumer runs on the empty verdict.
  assert.equal(unwrittenEarlyExits(['if [ x ]; then', 'exit 1', 'fi'].join('\n')).length, 0);
  // A write that does not reach $GITHUB_OUTPUT publishes nothing.
  assert.equal(unwrittenEarlyExits(['estate_paused=true', 'exit 0'].join('\n')).length, 1);
});

test('MUTATION: deleting the deploy-validate job OUTPUT unbinds the chained bootstrap', () => {
  // ROUND 6, the same class one level up. `post-deploy-bootstrap` stands down on
  // `needs.deploy-validate.outputs.estate_paused != 'true'`; delete the single
  // line that PUBLISHES that key and the clause reads '' != 'true' — TRUE — so
  // the bootstrap wires Synapse SQL, Purview and Databricks SCIM against a
  // declared-paused estate whose SQL pool is paused alongside its ADX cluster.
  // The if: is untouched, so every guard-presence and guard-binding check passes.
  const mutated = parseJobs(workflowText()).map((j) =>
    j.name === 'deploy-validate'
      ? { ...j, body: j.body.split('\n').filter((l) => !/^ {6}estate_paused:/.test(l)).join('\n') }
      : j,
  );
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /job 'deploy-validate' must publish an output named `estate_paused`/);
});

test('every JOB is dispositioned, and the image phase stands down on the declaration', () => {
  const problems = judgeJobs(parseJobs(workflowText()));
  assert.deepEqual(problems, [], `deploy-fiab-gcch job-level stand-down is incomplete:\n  - ${problems.join('\n  - ')}`);
});

test('the job parser sees the real job list and is not matching comment text', () => {
  const names = parseJobs(workflowText()).map((j) => j.name);
  assert.deepEqual(
    names,
    ['precheck', 'pause-declaration', 'build-gov-images', 'deploy-validate', 'post-deploy-bootstrap'],
    'the parsed job list must be the workflow\'s real jobs, in order',
  );
});

test('MUTATION: the round-2 head shape — build-gov-images ungated — is caught', () => {
  const mutated = parseJobs(workflowText()).map((j) =>
    j.name === 'build-gov-images'
      ? {
          ...j,
          needs: 'precheck',
          if: "needs.precheck.outputs.configured == 'true' && (github.event_name == 'schedule' || inputs.run_mode == 'full')",
        }
      : j,
  );
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 2, `expected the if: and the needs: problem, got: ${problems.join(' | ')}`);
  assert.ok(problems.every((p) => /build-gov-images/.test(p)));
});

test('MUTATION: reading the gate without declaring the need is caught', () => {
  // `needs.pause-declaration.outputs.declared` evaluates to empty when the job
  // is not in `needs:`, so the clause is always true and never suppresses — a
  // guard that is present and unreachable.
  const mutated = parseJobs(workflowText()).map((j) =>
    j.name === 'build-gov-images' ? { ...j, needs: 'precheck' } : j,
  );
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /does not declare it in needs:/);
});

test('MUTATION: a NEW job must be dispositioned', () => {
  const mutated = [...parseJobs(workflowText()), { name: 'roll-something', if: '', needs: '', body: '' }];
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /job 'roll-something' has no disposition/);
});

test('MUTATION: the producer publishes a DIFFERENT key than the guard reads', () => {
  // Reviewer probe, round 4(a). `needs.pause-declaration.outputs.declared` then
  // evaluates to empty, `'' != 'true'` is TRUE, and the image phase opens the
  // sovereign ACR on a declared pause. Measured green at 22/0 before this.
  const mutated = parseJobs(workflowText()).map((j) =>
    j.name === PRODUCER_JOB
      ? { ...j, body: j.body.replace(new RegExp(`^ {6}${PRODUCER_OUTPUT}:`, 'm'), `      ${PRODUCER_OUTPUT}_renamed:`) }
      : j,
  );
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /must publish an output named/);
});

test('MUTATION: the producer stops invoking the gate script', () => {
  // Reviewer probe, round 4(b): the job, the output key and the `needs:` all
  // survive, and nothing writes the value. Measured green at 22/0 before this.
  const mutated = parseJobs(workflowText()).map((j) =>
    j.name === PRODUCER_JOB
      ? { ...j, body: j.body.replace(/run: node scripts\/ci\/estate-pause-declared\.mjs.*/, 'run: echo noop') }
      : j,
  );
  const problems = judgeJobs(mutated);
  assert.equal(problems.length, 1, `expected exactly one problem, got: ${problems.join(' | ')}`);
  assert.match(problems[0], /no longer invokes estate-pause-declared\.mjs/);
});

test('MUTATION: deleting the producer job leaves the guard present and inert', () => {
  const mutated = parseJobs(workflowText()).filter((j) => j.name !== PRODUCER_JOB);
  const problems = judgeJobs(mutated);
  assert.ok(
    problems.some((p) => new RegExp(`no '${PRODUCER_JOB}' job to produce it`).test(p)),
    `expected the absent-producer problem, got: ${problems.join(' | ')}`,
  );
});

test('every step that reaches the ACR firewall lease stands down, wherever it sits', () => {
  const takers = leaseTakingSteps(parseSteps(workflowText()));
  // A green assertion over an empty population is the shape this repo keeps
  // re-finding, so the census has to be non-empty and it has to name the steps
  // the run log named. Run 33519232492 opened the registry three times inside
  // this job; those three are exactly what this must find.
  assert.equal(
    takers.length,
    3,
    `expected the three known lease takers in deploy-validate, found ${takers.length}: ${takers
      .map((t) => `${t.name} [${t.via.join(',')}]`)
      .join(' | ')}`,
  );
  const unguarded = takers
    .filter((t) => !t.if.includes(GUARD) || !guardIsBinding(t.if, GUARD))
    .map((t) => `${t.name} (reaches the lease via ${t.via.join(', ')}) if=\`${t.if || '(none)'}\``);
  assert.deepEqual(
    unguarded,
    [],
    'a step of deploy-validate opens the sovereign ACR firewall on a run that has declared it measures ' +
      `nothing, which makes the stand-down summary's run-scope claim false (deploy-integrity R7):\n  - ${unguarded.join(
        '\n  - ',
      )}`,
  );
});

test('MUTATION: the round-5 head shape — an UNGUARDED lease taker — is caught', () => {
  // The exact shape measured at the parent: the adoption preflight sitting
  // before the declaration with no `if:` at all, while the summary said the
  // firewall was not opened. Position is irrelevant to this census, so the
  // mutant only has to drop the clause.
  const target = 'Image preflight — never adopt a live app onto a missing tag';
  const mutated = parseSteps(workflowText()).map((s) => (s.name === target ? { ...s, if: '' } : s));
  const takers = leaseTakingSteps(mutated);
  const hit = takers.find((t) => t.name === target);
  assert.ok(hit, 'the mutant must still be recognised as a lease taker — that is what makes it a defect');
  assert.equal(hit.if, '');
  assert.ok(!hit.if.includes(GUARD), 'the mutant has no guard, which is the whole point');
});

test('the lease census DERIVES its population and does not just pattern-match a name', () => {
  // Negative control. `apply-acr-compliance-tags.sh` MENTIONS acr-firewall-lease.sh
  // twice, in comments, and takes no lease; a `grep -l` derivation would put it
  // in the census. And the lease script itself must resolve true, or the whole
  // derivation is vacuous.
  assert.equal(scriptTakesLease('scripts/csa-loom/acr-firewall-lease.sh'), true);
  assert.equal(scriptTakesLease('scripts/csa-loom/preflight-image-tags.sh'), true);
  assert.equal(scriptTakesLease('scripts/ci/assert-acr-image-tags.sh'), true);
  assert.equal(scriptTakesLease('scripts/ci/assert-no-silent-image-tag-revert.mjs'), true);
  assert.equal(scriptTakesLease('scripts/csa-loom/apply-acr-compliance-tags.sh'), false);
  assert.equal(scriptTakesLease('scripts/ci/adopt-image-tags.mjs'), false);
  // An unreadable path is an UNKNOWN, never a no (R7).
  assert.equal(scriptTakesLease('scripts/ci/this-script-does-not-exist.mjs'), null);
});

test('the stand-down summary claims only what the run established (R7)', () => {
  const summary = parseSteps(workflowText()).find((s) => s.name === DECLARATION_STEP);
  assert.ok(summary, 'the declaration summary step is gone');
  // The parent copy said the run skipped "the image preflight (which would have
  // opened this boundary's ACR firewall)" and that nothing "should touch an
  // estate this run has declared it will not measure" — while build-gov-images
  // opened that firewall in the same run. The summary must NAME the job it is
  // making a claim about, so the claim is checkable against the run's job list.
  assert.match(
    summary.body,
    /build-gov-images/,
    'the summary asserts this run did not touch the estate; it must name the image-phase JOB that would otherwise have, so the claim can be checked against the run',
  );
  for (const skipped of ['evidence receipt', 'artifact upload']) {
    assert.ok(
      summary.body.toLowerCase().includes(skipped),
      `the summary enumerates what was skipped and omits the ${skipped} — an incomplete enumeration reads as a complete one`,
    );
  }
  // ROUND 5 — the part a substring test could never do. The summary makes a
  // claim about the whole RUN, not this job: that the sovereign ACR firewall was
  // not opened. Two things have to hold for that sentence to be TRUE, and both
  // are checked here rather than read:
  //   1. every lease taker INSIDE this job stands down on the same verdict that
  //      makes this summary print (`leaseTakingSteps`, asserted above and
  //      re-asserted here so deleting that test cannot quietly re-open this one);
  //   2. the lease taker OUTSIDE this job — the `build-gov-images` image phase —
  //      is named, so the claim is checkable against the run's job list.
  // The parent's copy failed 1 while passing the old substring form of 2.
  const claimsTheFirewall = /firewall/i.test(summary.body);
  if (claimsTheFirewall) {
    const takers = leaseTakingSteps(parseSteps(workflowText()));
    const unguarded = takers.filter((t) => !t.if.includes(GUARD) || !guardIsBinding(t.if, GUARD));
    assert.deepEqual(
      unguarded.map((t) => t.name),
      [],
      'the stand-down summary tells the operator the sovereign ACR firewall was not opened, and a step of ' +
        'this same job takes the lease on exactly the runs that print it. Correct the copy or gate the step ' +
        '(deploy-integrity R7).',
    );
    assert.match(
      summary.body,
      /build-gov-images/,
      'a run-scope claim about the ACR firewall must name the image-phase JOB, which is the lease taker this ' +
        'step census cannot see',
    );
  }
});

test('the stand-down notice names EVERY step it stands down — the enumeration is derived', () => {
  // ROUND 9, on a review nit. The notice enumerated ten of the thirteen steps
  // that skip on this verdict; `Resolve the program budget's IMMUTABLE start
  // date (#4253)` arrived from `main`, was dispositioned, carried the guard,
  // skipped on every stood-down run — and was simply not named. Nothing could
  // have caught that, because the enumeration was PROSE and the census was
  // code. It is one population now: every 'guard' / 'via-provision'
  // disposition carries the phrase the notice must name it by, so a new
  // guarded step reds this the day it is added rather than quietly making the
  // list one short. An enumeration one short reads exactly like a complete one.
  const summary = parseSteps(workflowText()).find((s) => s.name === DECLARATION_STEP);
  assert.ok(summary, 'the declaration summary step is gone');
  const from = summary.body.indexOf('SKIPPED IN THIS JOB');
  assert.ok(from >= 0, 'the notice must carry a SKIPPED IN THIS JOB enumeration');
  const to = summary.body.indexOf('THE SOVEREIGN ACR FIREWALL', from);
  assert.ok(to > from, 'the enumeration must end at the firewall claim, or this reads the whole notice');
  const enumeration = summary.body.slice(from, to).toLowerCase();

  const skipped = [...DISPOSITIONS].filter(([, d]) => d.mode === 'guard' || d.mode === 'via-provision');
  assert.ok(skipped.length >= 13, `expected the full guarded population, got ${skipped.length}`);
  const missingNeedle = skipped.filter(([, d]) => typeof d.summary !== 'string' || d.summary.trim() === '');
  assert.deepEqual(
    missingNeedle.map(([name]) => name),
    [],
    'every guarded / transitively-guarded step must declare the phrase the stand-down notice names it by',
  );
  const unnamed = skipped.filter(([, d]) => !enumeration.includes(d.summary.toLowerCase()));
  assert.deepEqual(
    unnamed.map(([name, d]) => `${name} (expected the notice to say "${d.summary}")`),
    [],
    'the stand-down notice tells the operator what this run skipped; these steps skip and are not named',
  );
  // …and the needles are not a set of substrings that match anything: each one
  // has to be distinctive enough that a DIFFERENT step's phrase does not cover
  // it, or "complete" would mean "the words happened to appear".
  const needles = skipped.map(([, d]) => d.summary.toLowerCase());
  assert.equal(new Set(needles).size, needles.length, 'two steps must not claim the same phrase in the notice');
});

test('CLOUD PARITY: no sibling deploy lane has an UNGATED image phase on a cron', () => {
  // cloud-parity.md: a defect fixed in one boundary and left in another is not
  // fixed. Measured at this head, so the claim is a MEASUREMENT and not a
  // memory — if someone gives deploy-fiab-il5 a cron, or gives deploy-fiab-gcc
  // an image phase, this goes red instead of the sovereign firewall opening.
  //
  // HONEST LIMIT, because a green assertion over an empty population is the
  // shape this repo keeps re-finding. Measured over the four lanes below:
  //   deploy-fiab-gcch        cron=yes  image phase=yes  -> EXAMINED
  //   deploy-fiab-gcc         cron=yes  image phase=NO   -> nothing to gate
  //   deploy-fiab-il5         cron=NO   image phase=yes  -> dispatch-only, so a
  //                                                         deliberate operator
  //                                                         act, never unattended
  //   deploy-fiab-commercial  cron=yes  image phase=NO   -> nothing to gate
  // So ONE lane is actually examined today. The negative control that says the
  // predicate discriminates rather than passing vacuously: run this same check
  // against the pre-fix deploy-fiab-gcch and it reports cron=true, guarded=false.
  //
  // IL5 IS A REAL, TRACKED GAP, not a clean skip (#4391). It has the image
  // phase, no cron, and `grep -c estate_paused` = 0 — so the day an IL5 entry
  // is added to the register, a `run_mode=full` dispatch opens the IL5 registry
  // on a declared-paused estate. cloud-parity.md calls a fix landed in one
  // boundary and left in another INCOMPLETE, and this comment is the disclosure,
  // not the excuse.
  const lanes = ['deploy-fiab-gcch', 'deploy-fiab-gcc', 'deploy-fiab-il5', 'deploy-fiab-commercial'];
  const unguarded = [];
  for (const lane of lanes) {
    const src = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', `${lane}.yml`), 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    // A cron-capable lane runs UNATTENDED; that is what makes an ungated
    // estate mutation different in kind from one an operator dispatched.
    const hasCron = /^ {4}- cron:/m.test(src);
    const imagePhase = parseJobs(src).find((j) => j.name === 'build-gov-images');
    if (!hasCron || !imagePhase) continue;
    if (!imagePhase.if.includes(JOB_GUARD)) unguarded.push(`${lane}: if=\`${imagePhase.if || '(none)'}\``);
  }
  assert.deepEqual(
    unguarded,
    [],
    'a cron-triggered lane has an image phase that acquires the boundary ACR firewall lease with no ' +
      `estate-pause declaration clause:\n  - ${unguarded.join('\n  - ')}`,
  );
});

test('the daily cron cannot stack at the approval gate, and cannot cancel a live apply', () => {
  const wf = workflowText();
  const block = /\nconcurrency:\n((?: {2}.*\n)+)/.exec(wf);
  assert.ok(block, 'deploy-fiab-gcch has no top-level concurrency: block — scheduled runs stack at gcc-high-deploy');
  const body = block[1]
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1').trimEnd())
    .join('\n');
  assert.match(body, /group:\s*\S/, 'concurrency needs a group');
  assert.match(
    body,
    /group:[^\n]*github\.event_name/,
    'the group must be keyed by event_name, or an operator dispatch queues behind a cron run waiting for an approval nobody intends to give',
  );
  assert.match(
    body,
    /cancel-in-progress:\s*false\s*$/m,
    'cancel-in-progress must be literally false: this lane holds an ACR firewall lease (publicNetworkAccess=Enabled) inside a step, and a cancel there leaves the sovereign registry open until the 75m lease TTL plus acr-firewall-sweeper re-lock it',
  );
});

// ── The gate the image phase reads ────────────────────────────────────────────
// scripts/ci/estate-pause-declared.mjs is the whole reason `build-gov-images`
// can stand down without an Azure credential. Its contract has two halves and
// both are load-bearing: SUPPRESS only on positive evidence, and NEVER fail the
// job — a crash here would take a P0 sovereign deploy lane down for a JSON
// parse error.

test('the declaration gate suppresses only on a real, owned, unexpired entry', () => {
  const register = {
    paused: [
      {
        boundary: 'GCC-High',
        owner: 'fgarofalo56',
        declaredOn: '2026-08-26',
        reviewBy: '2026-11-24',
        reason: 'x'.repeat(80),
      },
    ],
  };
  assert.equal(decide({ register, readError: null, boundary: 'GCC-High', today: '2026-09-07' }).declared, true);
  // A different boundary's declaration never covers this one.
  assert.equal(decide({ register, readError: null, boundary: 'IL5', today: '2026-09-07' }).declared, false);
  // Expiry is the teeth: past reviewBy the image phase runs again.
  assert.equal(decide({ register, readError: null, boundary: 'GCC-High', today: '2026-11-25' }).declared, false);
});

test('every uncertain outcome resolves to NOT-suppressing, and says why', () => {
  for (const [label, args] of [
    ['no register at all', { register: null, readError: null }],
    ['unreadable register', { register: null, readError: 'EACCES' }],
    ['register is an array', { register: [], readError: null }],
    ['register has no paused array', { register: {}, readError: null }],
  ]) {
    const v = decide({ ...args, boundary: 'GCC-High', today: '2026-09-07' });
    assert.equal(v.declared, false, `${label} must NOT suppress`);
    assert.ok(v.lines.join('|').length > 0, `${label} must print a reason`);
  }
  // An unreadable register is an UNKNOWN and must be visible, not swallowed:
  // the operator would otherwise believe the estate is declared paused and be
  // unable to see why the image phase ran anyway (deploy-integrity R7).
  const unread = decide({ register: null, readError: 'EACCES', boundary: 'GCC-High', today: '2026-09-07' });
  assert.match(unread.lines.join('|'), /::warning::/);
});

test('loadRegister never throws, and tells an absent file apart from a broken one', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pausereg-'));
  // ENOENT is the ordinary "no estate is paused" case, not a warning.
  assert.deepEqual(loadRegister(path.join(dir, 'nope.json')), { register: null, readError: null });
  // Unparseable is an UNKNOWN and must be reported.
  const bad = path.join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  const broken = loadRegister(bad);
  assert.equal(broken.register, null);
  assert.match(String(broken.readError), /not parseable JSON/);
});

test('parseArgs ignores what it does not understand rather than failing', () => {
  assert.deepEqual(parseArgs(['--boundary', 'GCC-High', '--today', '2026-09-07']), {
    boundary: 'GCC-High',
    today: '2026-09-07',
  });
  // A flag with no value must not swallow the next flag.
  assert.deepEqual(parseArgs(['--boundary', '--today', '2026-09-07']), { today: '2026-09-07' });
  assert.deepEqual(parseArgs([]), {});
});

test('the gate exits 0 and writes a value even with no boundary at all', () => {
  const script = path.join(REPO_ROOT, 'scripts', 'ci', 'estate-pause-declared.mjs');
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'pauseout-')), 'gh-output');
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
  assert.equal(r.status, 0, `the gate must never fail the job; stderr: ${r.stderr}`);
  assert.match(r.stdout, /declared_paused=false/);
  assert.equal(readFileSync(out, 'utf8').trim(), 'declared_paused=false');
});
