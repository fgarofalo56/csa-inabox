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
 * The TOP-LEVEL disjuncts (paren depth 0) of a GitHub `if:` expression, with any
 * `${{ }}` wrapper stripped.
 *
 * @param {string} expr
 * @returns {string[]}
 */
export function topLevelDisjuncts(expr) {
  const src = String(expr)
    .trim()
    .replace(/^\$\{\{/, '')
    .replace(/\}\}$/, '')
    .trim();
  const scan = blankLiterals(src);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < scan.length; i += 1) {
    const c = scan[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && c === '|' && scan[i + 1] === '|') {
      parts.push(src.slice(start, i));
      i += 1;
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
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
 * What is asserted is the semantic property, not a spelling: the guard must
 * appear in EVERY top-level disjunct, i.e. no truth assignment satisfies the
 * `if:` without it. `(a && G) || (b && G)` therefore passes and `a || b && G`
 * does not.
 *
 * @param {string} ifExpr
 * @param {string} guard
 * @returns {boolean}
 */
export function guardIsBinding(ifExpr, guard) {
  const disjuncts = topLevelDisjuncts(ifExpr);
  return disjuncts.length > 0 && disjuncts.every((d) => d.includes(guard));
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
    `${kind} '${name}' CONTAINS \`${guard}\` but the guard is INERT: GitHub binds && tighter than ||, so ` +
    `\`${ifExpr}\` has a top-level disjunct with no guard in it and is satisfied without ever reading it — ` +
    "on 'schedule', the exact trigger this stand-down exists for. Parenthesise the disjunction."
  );
}

/**
 * The body of the shell conditional that reads ESTATE_PAUSED, or null when
 * there is no such conditional (or it is never closed).
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
 * @param {string} body
 * @returns {string|null}
 */
export function refusalBlock(body) {
  const lines = String(body).split('\n');
  const at = lines.findIndex((l) => /^\s*if\s.*ESTATE_PAUSED/.test(l));
  if (at < 0) return null;
  let depth = 0;
  const out = [];
  for (let i = at; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^if\s/.test(t)) depth += 1;
    out.push(lines[i]);
    if (/^fi\b/.test(t)) {
      depth -= 1;
      if (depth <= 0) return out.join('\n');
    }
  }
  return null;
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
  const m = MUTATING_AZ.exec(String(body || ''));
  if (!m) return null;
  return RUNNER_LOCAL_AZ.test(m[0]) ? null : m[0];
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
  const start = lines.findIndex((l) => /^  deploy-validate:\s*$/.test(l));
  assert.ok(start >= 0, 'deploy-validate job not found');
  let i = lines.findIndex((l, n) => n > start && /^    steps:\s*$/.test(l));
  assert.ok(i > start, 'deploy-validate has no steps: block');

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
 */
const DISPOSITIONS = new Map([
  ['Bicep what-if', { mode: 'guard' }],
  ['Deploy-verification evidence receipt (§7)', { mode: 'guard' }],
  ['Upload GCC-High verification receipt', { mode: 'guard' }],
  // Round 5: this one MOVED here from six steps above the declaration, where it
  // had no `if:` at all and opened the sovereign ACR firewall on every
  // declared-paused run. See the header, and leaseTakingSteps.
  ['Image preflight — never adopt a live app onto a missing tag', { mode: 'guard' }],
  ['Image preflight — Gov ACR must already hold every referenced tag', { mode: 'guard' }],
  ['Image-tag revert gate — never flatten a pinned app to the default', { mode: 'guard' }],
  ['Re-pin appImageTags to the RUNNING images (narrows the roll race — #3683)', { mode: 'guard' }],
  ['Provision (with full Gov dispatch)', { mode: 'guard' }],
  [
    'Apply ACR compliance tags (merge-patch, out-of-band — #3714)',
    { mode: 'via-provision', needle: "steps.provision.conclusion == 'success'" },
  ],
  ['Approve the Front Door -> ACA private-endpoint connection', { mode: 'guard' }],
  [
    'Export bootstrap coordinates (for the chained Gov bootstrap)',
    {
      mode: 'exempt',
      why: '`az account show` reads the SUBSCRIPTION, not the estate — no Loom resource is read or written. Its only consumer, the post-deploy-bootstrap job, carries its own `needs.deploy-validate.outputs.estate_paused != \'true\'`.',
    },
  ],
  ['Publish DLZ template + wire deploy env (Gov)', { mode: 'guard' }],
  [
    'Smoke test (Gov-specific)',
    { mode: 'via-provision', needle: "steps.provision.outputs.console_url != ''" },
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
 * @param {{name:string, if:string, body:string}[]} steps
 * @returns {string[]} one problem string per violation; empty means compliant.
 */
export function judge(steps) {
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  if (at < 0) return [`the declaration step '${DECLARATION_STEP}' is gone — the stand-down has no anchor at all`];
  const problems = [];
  // ROUND 6. Before any disposition is read: every reader of the verdict, in an
  // `if:` or an `env:`, must resolve to a step that exists and computes it.
  problems.push(...judgeVerdictReferences(steps));
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
      if (!/ESTATE_PAUSED/.test(step.body) || !/::error::/.test(step.body)) {
        problems.push(
          `step '${step.name}' must read the estate_paused verdict into its body and fail with an ::error:: ` +
            'naming the action that authorises the destruction',
        );
      }
      // …and the refusal has to REFUSE. `::error::` is an annotation; it does
      // not fail a step. See refusalBlock() for the measurement.
      const refusal = refusalBlock(step.body);
      if (!refusal) {
        problems.push(
          `step '${step.name}' has no closed shell conditional on ESTATE_PAUSED, so it is not established ` +
            'that the refusal refuses at all — only that the words appear somewhere in the step.',
        );
      } else if (!/\bexit\s+[1-9]/.test(refusal)) {
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
      // At least ONE of the variables read has to carry the verdict: requiring
      // all of them would forbid `[ "$ESTATE_PAUSED" = true ] && [ "$X" ]`.
      if (refusal) {
        const env = stepEnv(step.body);
        const condition = refusal.split('\n')[0];
        const read = [...new Set([...condition.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
        const bound = read.filter((v) => env.has(v) && verdictRefs(env.get(v)).length > 0);
        if (bound.length === 0) {
          problems.push(
            `step '${step.name}' branches on ${read.length > 0 ? read.map((v) => `\`$${v}\``).join(', ') : '(no shell variable)'} ` +
              `but its env: binds none of them to \`steps.<id>.outputs.${VERDICT_OUTPUT}\`. The variable is then the ` +
              'EMPTY STRING on every run, the refusal branch is never taken, and a declared-paused sovereign estate ' +
              `is torn down. Its env: is {${[...env.keys()].join(', ') || 'empty'}}.`,
          );
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
