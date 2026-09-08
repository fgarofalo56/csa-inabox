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
 *   OUT OF FRAME, INHERENTLY  a step inserted BEFORE the declaration step. The
 *             estate_paused verdict does not exist yet at that point, so there
 *             is nothing for it to stand down on; the ADX preflight itself is
 *             the first thing that touches the estate and it is what produces
 *             the verdict.
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
  const m = MUTATING_AZ.exec(String(member.body || ''));
  if (m) {
    problems.push(
      `${kind} '${member.name}' is dispositioned 'exempt' — "touches no estate resource" — but its body runs ` +
        `\`${m[0]}\`, which WRITES. Either it is not exempt, or the exemption's reason is now false.`,
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
 * @param {string} src
 * @returns {{name:string, if:string, body:string}[]}
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
      cur = { name: stepStart && stepStart[1] ? stepStart[1].trim() : '(unnamed)', if: '', body: raw };
      continue;
    }
    if (!cur) continue;
    cur.body += `\n${raw}`;
    const ifKey = raw.match(/^ {8}if: (.*)$/);
    if (ifKey) cur.if = ifKey[1].trim();
  }
  if (cur) steps.push(cur);
  return steps;
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
 * @returns {string[]}
 */
export function judgeGuardProducer(jobs) {
  const problems = [];
  const producer = jobs.find((j) => j.name === PRODUCER_JOB);
  if (!producer) {
    return [
      `the image phase stands down on \`${JOB_GUARD}\`, but there is no '${PRODUCER_JOB}' job to produce it. ` +
        "An absent producer makes the clause read '' != 'true', which is TRUE — present, and never suppressing.",
    ];
  }
  const outLine = String(producer.body)
    .split('\n')
    .find((l) => new RegExp(`^ {6}${PRODUCER_OUTPUT}:`).test(l));
  if (!outLine) {
    problems.push(
      `job '${PRODUCER_JOB}' must publish an output named \`${PRODUCER_OUTPUT}\` — that is the exact key ` +
        `\`${JOB_GUARD}\` reads, and any other name leaves the clause empty and never suppressing.`,
    );
  } else {
    const ref = /steps\.([\w-]+)\.outputs\.([\w-]+)/.exec(outLine);
    if (!ref) {
      problems.push(
        `job '${PRODUCER_JOB}' publishes \`${PRODUCER_OUTPUT}\` as \`${outLine.trim()}\`, which reads no step ` +
          'output. The guard would then read whatever that expression evaluates to, including empty.',
      );
    } else if (!new RegExp(`^ {6,}(?:- )?id: ${ref[1]}\\s*$`, 'm').test(String(producer.body))) {
      problems.push(
        `job '${PRODUCER_JOB}' publishes \`${PRODUCER_OUTPUT}\` from \`steps.${ref[1]}.outputs.${ref[2]}\`, but ` +
          `no step in that job carries \`id: ${ref[1]}\` — the output is empty and the guard never suppresses.`,
      );
    }
  }
  if (!String(producer.body).includes(PRODUCER_SCRIPT)) {
    problems.push(
      `job '${PRODUCER_JOB}' no longer invokes ${PRODUCER_SCRIPT}, so nothing computes the declaration ` +
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
 * @param {{name:string, if:string, body:string}[]} steps
 * @returns {string[]} one problem string per violation; empty means compliant.
 */
export function judge(steps) {
  const at = steps.findIndex((s) => s.name === DECLARATION_STEP);
  if (at < 0) return [`the declaration step '${DECLARATION_STEP}' is gone — the stand-down has no anchor at all`];
  const problems = [];
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
    }
    if (d.mode === 'exempt') problems.push(...judgeExemption(d, step, 'step'));
  }
  return problems;
}

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
    j.name === PRODUCER_JOB ? { ...j, body: j.body.replace(/^ {6}declared:/m, '      declared_paused:') } : j,
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
