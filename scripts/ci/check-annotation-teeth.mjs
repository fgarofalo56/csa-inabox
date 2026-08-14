#!/usr/bin/env node
/**
 * GUARDRAIL: a workflow step that emits `::error::` must be able to FAIL.
 *
 * WHY THIS EXISTS (#2837, recurrence of #2787)
 * -------------------------------------------
 * `::error::` is an ANNOTATION. It colours a line in the log; it does not set
 * an exit status and it does not change a job's conclusion. A step that emits
 * one and then cannot fail reports SUCCESS while telling you the thing it
 * exists to detect has happened. On an unattended cron — where the job
 * conclusion is the entire signal, because nobody opens a green run — that is
 * indistinguishable from having no detector at all.
 *
 * It has happened twice in the SAME FILE:
 *   #2787  loom-ui-verify.yml `Run extra Playwright projects` was
 *          continue-on-error, and swallowed a real /admin/tenant-settings mount
 *          failure. Fixed; the comment left behind says "NO continue-on-error."
 *   #2837  loom-ui-verify.yml `Login-health preflight`, two steps above, still
 *          carried BOTH `continue-on-error: true` AND a trailing `exit 0`. It
 *          printed "::error::LOGIN BROKEN — N auth/callback invalid_client
 *          errors" and concluded success — the only in-workflow detector for
 *          the 2026-07-19 AADSTS7000215 sign-in outage class.
 * The second one is why prose in a comment is not a control.
 *
 * THE RULE
 * --------
 * For every step whose `run:` block contains `::error::`, BOTH must hold:
 *   a) the step does not declare `continue-on-error: true`, and
 *   b) the run block's LAST effective statement is not a bare `exit 0`.
 *
 * DELIBERATELY NARROW — what this does NOT flag, and why:
 *   - `exit 0` in an early-return branch (e.g. "resource not deployed in this
 *     estate → skip"). loom-synthetic-monitor.yml does exactly this and is a
 *     working detector: the step can still fail further down. Only the FINAL
 *     statement is checked, because that is the one that overrides every
 *     verdict computed above it.
 *   - `continue-on-error` on a step with no `::error::` of its own. That is a
 *     tolerance decision about a third-party action, not a discarded verdict.
 *   - `::warning::` / `::notice::`. Those are advisory by construction.
 *   - `2>/dev/null` masking. Related class, different check, not this one.
 *
 * ESCAPE HATCH: none, by design. If a step must annotate an error and still
 * not fail, the verdict belongs in a variable that a later step enforces —
 * express it that way and this check passes honestly. There is no allowlist to
 * grow, and the class is currently at ZERO.
 *
 * SELF-DEFENCE: this check refuses to pass vacuously. If it finds no workflows,
 * or examines zero `::error::`-emitting steps, it FAILS rather than printing OK
 * — a scanner that silently stops matching is the same defect it exists to
 * catch (see the 2026-07-28 "gates that measure nothing" class).
 *
 * Usage: node scripts/ci/check-annotation-teeth.mjs [workflow-dir]
 *   The optional directory argument exists for the self-test in
 *   scripts/ci/__tests__/annotation-teeth.test.mjs; CI passes nothing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = '.github/workflows';
const WORKFLOW_DIR = process.argv[2] || DEFAULT_DIR;
const IS_DEFAULT = WORKFLOW_DIR === DEFAULT_DIR;

/** A step begins at a YAML sequence item inside a `steps:` list. */
const STEP_START = /^(\s*)-\s+(name|uses|run|id|if|with|env|shell|continue-on-error):/;
const CONTINUE_ON_ERROR_TRUE = /^\s*continue-on-error:\s*(true|'true'|"true")\s*(#.*)?$/;
const BARE_EXIT_ZERO = /^\s*exit\s+0\s*(#.*)?$/;
const ERROR_ANNOTATION = /::error::/;

/** Slice the lines belonging to one step, starting at `start`. */
function stepBody(lines, start) {
  const indent = lines[start].match(/^(\s*)/)[1].length;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const ind = line.match(/^(\s*)/)[1].length;
    // next sibling step, or a dedent out of the steps list
    if (ind === indent && /^\s*-\s+\S/.test(line)) return lines.slice(start, j);
    if (ind < indent) return lines.slice(start, j);
  }
  return lines.slice(start);
}

/** The lines of a `run: |` block within a step body (empty when there is none). */
function runBlock(body) {
  const idx = body.findIndex((l) => /^\s*run:\s*[|>][-+]?\s*$/.test(l));
  if (idx < 0) return [];
  const indent = body[idx].match(/^(\s*)/)[1].length;
  const out = [];
  for (let k = idx + 1; k < body.length; k++) {
    const line = body[k];
    if (line.trim() === '') { out.push(line); continue; }
    if (line.match(/^(\s*)/)[1].length <= indent) break;
    out.push(line);
  }
  return out;
}

const violations = [];
let examined = 0; // steps that emit ::error:: — the population this check judges
const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

for (const file of files) {
  // PHYSICAL-LINES-OK: judges YAML STEP STRUCTURE (`continue-on-error:`) and a
// whole-command `exit 0` as the last effective line. Neither continues with a
// backslash: a YAML key cannot, and `exit 0` is a complete simple command (#3420).
  const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!STEP_START.test(lines[i])) continue;
    const body = stepBody(lines, i);
    i += body.length - 1;

    const run = runBlock(body);
    if (run.length === 0) continue;
    if (!run.some((l) => ERROR_ANNOTATION.test(l))) continue;
    examined++;

    const name = (body.find((l) => /^\s*-?\s*name:/.test(l)) || '')
      .replace(/^\s*-?\s*name:\s*/, '').trim() || '(unnamed step)';

    if (body.some((l) => CONTINUE_ON_ERROR_TRUE.test(l))) {
      violations.push({
        file,
        line: i - body.length + 2,
        name,
        why: 'continue-on-error: true — the step\'s failure never reaches the job conclusion',
      });
      continue;
    }

    const effective = run.filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
    const last = effective[effective.length - 1];
    if (last && BARE_EXIT_ZERO.test(last)) {
      violations.push({
        file,
        line: i - body.length + 2,
        name,
        why: 'the run block ends with a bare `exit 0` — it hard-codes success over every verdict above it',
      });
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\n[annotation-teeth] ${violations.length} step(s) emit ::error:: but cannot fail:\n`,
  );
  for (const v of violations) {
    console.error(`  ${WORKFLOW_DIR}/${v.file}:${v.line}  ${v.name}`);
    console.error(`      ${v.why}`);
  }
  console.error(
    '\n  A step that prints ::error:: and exits 0 reports SUCCESS while saying the\n' +
      '  thing it detects has happened. On a cron the job conclusion is the whole\n' +
      '  signal (#2837, recurrence of #2787).\n' +
      '\n  Fix it one of two ways:\n' +
      '    1. Let the step fail — drop continue-on-error / `exit $RC` instead of\n' +
      '       `exit 0`. Keep "could not check" on 0 and fail only on evidence;\n' +
      '       scripts/ci/login-health-verdict.sh is the worked example.\n' +
      '    2. If the run must continue, record the verdict (GITHUB_OUTPUT) and\n' +
      '       have a LATER step enforce it. Then this check passes honestly.\n',
  );
  process.exit(1);
}

// A scanner that matches nothing is not a passing check — it is a broken one.
// Only asserted for the real workflow directory; the self-test drives fixtures.
if (IS_DEFAULT && (files.length === 0 || examined === 0)) {
  console.error(
    `[annotation-teeth] REFUSING TO PASS: scanned ${files.length} workflow(s) and found ` +
      `${examined} step(s) emitting ::error::. This repo has many. The parser has ` +
      'stopped matching (YAML shape change?) — fix the scanner, do not ship a green ' +
      'check that measures nothing.',
  );
  process.exit(1);
}

console.log(
  `[annotation-teeth] OK — ${files.length} workflows, ${examined} ::error::-emitting step(s); every one can fail.`,
);
