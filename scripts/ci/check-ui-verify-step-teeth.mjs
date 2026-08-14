#!/usr/bin/env node
/**
 * GUARDRAIL: in loom-ui-verify.yml, a browser/verification step's verdict must
 * be able to reach the job conclusion.
 *
 * WHY THIS EXISTS (refs #2875 — third occurrence, same file)
 * ---------------------------------------------------------
 * `loom-ui-verify` is the only lane that drives a real browser against the live
 * console. On the weekly cron nobody opens a green run, so the job conclusion is
 * the entire signal. Three times now a step in this file has produced a true
 * negative verdict that never reached that conclusion:
 *
 *   #2787  `Run extra Playwright projects` was continue-on-error and swallowed a
 *          real /admin/tenant-settings mount failure.
 *   #2837  `Login-health preflight`, two steps up, carried BOTH
 *          continue-on-error AND a trailing `exit 0`; it printed
 *          "::error::LOGIN BROKEN" and concluded success.
 *   #2875  `Run publish-version E2E` carried continue-on-error and — the part
 *          that made it unfixable-by-accident — NO `id:`. Run 30824614880
 *          reported success while Playwright printed "1 failed, 6 passed" for
 *          `version timeline + restore — report`. Without an id there is no
 *          `steps.<id>.outcome` to read, so the final gate added by #2871 could
 *          not have consumed the result even if someone had tried.
 *
 * Each fix was applied to the step in front of the author and not to its
 * siblings. That is the recurrence mechanism this guard exists to break: it
 * judges EVERY browser step in the file, so "fixed one, left the neighbour"
 * fails the build instead of waiting for the next incident.
 *
 * THE RULES (all scoped to .github/workflows/loom-ui-verify.yml)
 * -------------------------------------------------------------
 *  R1  Every step that runs a Playwright project or the e2e-receipt harness
 *      declares an `id:`. An id-less step is not merely tolerated, it is
 *      UNREFERENCEABLE — the #2875 shape.
 *  R2  Every such step's `steps.<id>.outcome` (or `.conclusion`) is read by a
 *      LATER gating step. Belt-and-braces when the step is blocking anyway, and
 *      the only thing standing between a future `continue-on-error` and another
 *      silent green.
 *  R3  The step doing the reading is really a gate: `if: always()` (so it is not
 *      skipped by the very failure it judges) and no `continue-on-error` of its
 *      own (tolerating the gate defeats the gate).
 *  R4  Any VERIFICATION step — the Playwright ones plus anything invoking a
 *      *-verdict.sh, a scripts/ci check, or `node --test` — that declares
 *      `continue-on-error: true` must satisfy R1+R2+R3. Tolerance is allowed
 *      only when the verdict is recorded and enforced later; that is the second
 *      remedy check-annotation-teeth.mjs itself prescribes, and it is the one
 *      honest way to keep a step non-fatal.
 *
 * WHAT A COMMENT CANNOT DO — the trap this guard had to avoid, because the
 * repo has just been bitten by three controls that a comment, a stub, or a
 * string literal could satisfy. A reference only counts when it appears in the
 * consuming step's `env:` / `run:` / `with:` data, with whole-line comments
 * stripped and `name:` and `if:` lines excluded:
 *   - `name:` is prose. `- name: enforce steps.foo.outcome` must not pass.
 *   - `#` lines are prose. This file is full of steps that discuss their own
 *     outcomes in comments; every one of those discussions must be worth zero.
 *   - `if:` is a CONDITION, not enforcement. `if: steps.foo.outcome=='failure'`
 *     decides whether a step runs; it does not make its failure fatal.
 * All three are pinned by fixtures in the self-test.
 *
 * DELIBERATELY NOT CHECKED (so nobody reads more into a green run than is here):
 *   - Whether the gate SCRIPT actually fails on a 'failure' outcome. That is
 *     scripts/ci/__tests__/ui-verify-gate.test.mjs, which drives the matrix.
 *   - Whether the referenced ids exist. That is the WIRING test in the same
 *     suite ("the gate is fed the ids of steps that actually exist").
 *   - Other workflows. The tolerance decisions in the deploy lanes are
 *     genuinely different (best-effort grants, third-party uploads, a job-level
 *     fire-and-forget) and an over-broad rule here would be noise. This file is
 *     the one with three recurrences.
 *
 * ESCAPE HATCH: none. If a step must not fail the job, give it an id and let the
 * final gate consume its outcome — then this check passes honestly.
 *
 * Usage: node scripts/ci/check-ui-verify-step-teeth.mjs [workflow-path]
 *   The optional argument exists for the self-test in
 *   scripts/ci/__tests__/ui-verify-step-teeth.test.mjs; CI passes nothing.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_WORKFLOW = path.resolve(
  __dirname,
  '..',
  '..',
  '.github',
  'workflows',
  'loom-ui-verify.yml',
);

/**
 * How many browser steps this workflow is known to run. A parser that stops
 * matching — a reindent, a `run:` folded differently, a renamed CLI — would
 * otherwise report "0 violations across 0 steps" and read as a pass. Discovery
 * finding FEWER than this is treated as breakage, not as good news.
 *
 * Today: verify, extra projects, publish-version, receipt. If a project step is
 * legitimately retired, lower this in the same commit — deliberately, with the
 * reason. A silent drop is how a sweep quietly stops sweeping.
 */
export const BROWSER_STEP_FLOOR = 4;

/** A step begins at a YAML sequence item inside a `steps:` list. */
const STEP_START = /^(\s*)-\s+(name|uses|run|id|if|with|env|shell|continue-on-error):/;
const CONTINUE_ON_ERROR_TRUE = /^\s*continue-on-error:\s*(true|'true'|"true")\s*(#.*)?$/;

/** Runs a Playwright project, or the minted-session receipt harness. */
const BROWSER_RUN = /playwright\s+test\b|e2e-receipt\.mjs/;

/**
 * Reaches a verdict of any kind: the browser steps, the pure *-verdict.sh
 * scripts, the scripts/ci guards, and node:test suites.
 */
const VERIFICATION_RUN =
  /playwright\s+test\b|e2e-receipt\.mjs|scripts\/ci\/[\w.-]*verdict\.sh|scripts\/ci\/check-[\w.-]+|node\s+--test\b/;

/** `if: always()` — with or without the `${{ }}` wrapper. */
const IF_ALWAYS = /^\s*if:\s*(\$\{\{\s*)?always\(\)\s*(\}\})?\s*$/;

/** Slice the lines belonging to one step, starting at `start`. */
export function stepBody(lines, start) {
  const indent = lines[start].match(/^(\s*)/)[1].length;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') continue;
    const ind = line.match(/^(\s*)/)[1].length;
    if (ind === indent && /^\s*-\s+\S/.test(line)) return lines.slice(start, j);
    if (ind < indent) return lines.slice(start, j);
  }
  return lines.slice(start);
}

/** The lines of a `run: |` block within a step body (empty when there is none). */
export function runBlock(body) {
  const idx = body.findIndex((l) => /^\s*-?\s*run:\s*[|>][-+]?\s*$/.test(l));
  if (idx >= 0) {
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
  // `run: node scripts/ci/foo.mjs` — a one-line command.
  const inline = body.find((l) => /^\s*-?\s*run:\s*\S/.test(l));
  return inline ? [inline.replace(/^\s*-?\s*run:\s*/, '')] : [];
}

/**
 * The part of a step body in which a `steps.<id>.outcome` reference is real
 * DATA rather than prose. Whole-line comments go, and so do `name:` (a label)
 * and `if:` (a condition, not enforcement). What survives is `env:`, `with:`,
 * and the `run:` body — the channels through which an outcome is actually
 * consumed.
 *
 * The trailing-comment strip deliberately requires NON-SPACE content before the
 * `#` (`(\S)\s+#`). Written as the obvious `\s#.*$` it also swallowed
 * whole-line comments, which made the first filter below redundant: mutating
 * that filter away changed no behaviour and failed no test — an inert line
 * masquerading as a control, which is the shape this repo has been shipping by
 * accident. Now each of the four strips owns exactly one case and each has a
 * test that goes red when it is removed.
 */
export function consumingText(body) {
  return body
    .filter((l) => !/^\s*#/.test(l)) // whole-line comment
    .filter((l) => !/^\s*-?\s*name:/.test(l)) // a label is prose
    .filter((l) => !/^\s*if:/.test(l)) // a condition is not enforcement
    .map((l) => l.replace(/(\S)\s+#.*$/, '$1')) // trailing comment
    .join('\n');
}

/** Parse every step in the workflow into a comparable record. */
export function parseSteps(yaml) {
  // PHYSICAL-LINES-OK: slices YAML step bodies by indentation and then tests
  // single-token PRESENCE (`playwright test`, `e2e-receipt.mjs`) against the whole
  // joined run block, plus YAML keys (`continue-on-error:`, `if:`) that never
  // continue with a backslash (#3420).
  const lines = yaml.split(/\r?\n/);
  const steps = [];
  for (let i = 0; i < lines.length; i++) {
    if (!STEP_START.test(lines[i])) continue;
    const body = stepBody(lines, i);
    const startLine = i + 1; // 1-based, for a clickable diagnostic
    i += body.length - 1;

    const name =
      (body.find((l) => /^\s*-?\s*name:/.test(l)) || '')
        .replace(/^\s*-?\s*name:\s*/, '')
        .replace(/\s*$/, '')
        .replace(/^['"]|['"]$/g, '') || '(unnamed step)';
    const idLine = body.find((l) => /^\s*-?\s*id:\s*\S/.test(l));
    const id = idLine ? idLine.replace(/^\s*-?\s*id:\s*/, '').trim() : null;

    // The run body with comments stripped: a step that merely TALKS about
    // `playwright test` in a comment is not running one.
    const run = runBlock(body)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

    steps.push({
      name,
      id,
      startLine,
      body,
      run,
      continueOnError: body.some((l) => CONTINUE_ON_ERROR_TRUE.test(l)),
      ifAlways: body.some((l) => IF_ALWAYS.test(l)),
      isBrowser: BROWSER_RUN.test(run),
      isVerification: VERIFICATION_RUN.test(run),
      consuming: consumingText(body),
    });
  }
  return steps;
}

/** Steps AFTER `idx` that qualify as gates under R3. */
function gatesAfter(steps, idx) {
  return steps.slice(idx + 1).filter((s) => s.ifAlways && !s.continueOnError);
}

/** Does any later gating step read this step's outcome? */
function consumedBy(steps, idx) {
  const { id } = steps[idx];
  if (!id) return null;
  const ref = new RegExp(`steps\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(outcome|conclusion)\\b`);
  // Any later step that references it at all — so the diagnostic can tell
  // "nobody reads it" apart from "something reads it but is not a gate".
  const readers = steps.slice(idx + 1).filter((s) => ref.test(s.consuming));
  const gates = gatesAfter(steps, idx).filter((s) => ref.test(s.consuming));
  return { readers, gates };
}

export function analyze(yaml) {
  const steps = parseSteps(yaml);
  const violations = [];
  const browser = [];
  const consumedIds = new Set();

  steps.forEach((step, idx) => {
    const mustBeWired = step.isBrowser;
    const mustBeWiredForTolerance = step.isVerification && step.continueOnError;
    if (!mustBeWired && !mustBeWiredForTolerance) return;
    if (step.isBrowser) browser.push(step);

    const why = step.isBrowser
      ? 'it runs a browser project, so its result IS the signal this workflow exists to produce'
      : 'it declares continue-on-error: true, so its own failure can never reach the job conclusion';

    if (!step.id) {
      violations.push({
        line: step.startLine,
        name: step.name,
        why:
          `no \`id:\` — ${why}. Without an id there is no \`steps.<id>.outcome\` ` +
          'to read, so no later step could enforce it even if one wanted to. ' +
          'This is exactly the #2875 shape.',
      });
      return;
    }

    const { readers, gates } = consumedBy(steps, idx);
    if (gates.length === 0) {
      const detail =
        readers.length > 0
          ? `\`steps.${step.id}.outcome\` is read by ${readers
              .map((r) => `"${r.name}"`)
              .join(', ')}, but none of those is a gate: a consuming step needs \`if: always()\` (or it is skipped by the very failure it judges) and must not carry continue-on-error (tolerating the gate defeats the gate).`
          : `nothing later in the job reads \`steps.${step.id}.outcome\`. Add it to the UVG_BLOCKING list on "Enforce login-health verdict + blocking suite results".`;
      violations.push({ line: step.startLine, name: step.name, why: `${detail} (${why})` });
      return;
    }
    consumedIds.add(step.id);
  });

  return { steps, browser, violations, consumedIds };
}

/**
 * Turn an analysis into an exit code. Pure, so the self-test can drive EVERY
 * branch — including the refuse-to-pass-vacuously ones, which are the branches
 * most likely to be wrong and least likely to be exercised by accident.
 *
 * This function exists because the first draft of this guard had the exact
 * defect it was written to prevent. The vacuity checks were gated on "are we
 * looking at the real workflow", so pointing it at any other path skipped them
 * — and pointing it at an EMPTY FILE printed
 *     "OK — 0 step(s), 0 browser step(s), every verdict reaches the job conclusion"
 * and exited 0. A control that reports success over a file it understood
 * nothing of is the class this repo keeps getting bitten by, so the zero-steps
 * case now fails for every caller and only the browser-step FLOOR (which
 * fixtures legitimately sit below) remains scoped to the real file.
 *
 * @param {{steps:object[], browser:object[], violations:object[]}} analysis
 * @param {{isDefault:boolean, floor?:number}} opts
 * @returns {{code:number, reason:string}}
 */
export function decide({ steps, browser, violations }, { isDefault, floor = BROWSER_STEP_FLOOR }) {
  // Vacuity FIRST. A file that parsed to nothing cannot have "no violations" —
  // it has no evidence either way, and reporting that as health is the bug.
  if (steps.length === 0) {
    return {
      code: 1,
      reason:
        'REFUSING TO PASS: parsed ZERO steps. Either the file is empty/unreadable or the step ' +
        'parser has stopped matching. Fix the input or the scanner; do not ship a green check ' +
        'that measures nothing.',
    };
  }
  if (violations.length > 0) {
    return { code: 1, reason: `${violations.length} step(s) whose verdict cannot reach the job conclusion` };
  }
  if (isDefault && browser.length < floor) {
    return {
      code: 1,
      reason:
        `REFUSING TO PASS: found ${browser.length} browser step(s), floor is ${floor}. Either a ` +
        'Playwright/receipt step was deleted, or BROWSER_RUN no longer matches how they are ' +
        'invoked. If a project was retired on purpose, lower BROWSER_STEP_FLOOR in this file in ' +
        'the same commit.',
    };
  }
  return {
    code: 0,
    reason: `${steps.length} step(s), ${browser.length} browser step(s), every verdict reaches the job conclusion`,
  };
}

function main(argv) {
  const wf = argv[0] ? path.resolve(argv[0]) : DEFAULT_WORKFLOW;
  const isDefault = path.resolve(wf) === path.resolve(DEFAULT_WORKFLOW);

  if (!existsSync(wf)) {
    console.error(`[ui-verify-step-teeth] REFUSING TO PASS: ${wf} does not exist.`);
    return 1;
  }
  const analysis = analyze(readFileSync(wf, 'utf8'));
  const { violations, browser } = analysis;

  if (violations.length > 0) {
    console.error(
      `\n[ui-verify-step-teeth] ${violations.length} step(s) in ${path.basename(wf)} whose verdict cannot reach the job conclusion:\n`,
    );
    for (const v of violations) {
      console.error(`  ${path.basename(wf)}:${v.line}  ${v.name}`);
      console.error(`      ${v.why}\n`);
    }
    console.error(
      '  This workflow is the only lane that drives a real browser against the live\n' +
        '  console, and on the weekly cron the job conclusion is the entire signal.\n' +
        '  Three separate steps here have already reported success over a true\n' +
        '  negative verdict (#2787, #2837, #2875) — each fix touched one step and\n' +
        '  not its neighbour.\n' +
        '\n  Fix it one of two ways:\n' +
        '    1. Let the step fail — drop continue-on-error. If the reason it was\n' +
        '       added is intermittency, give the Playwright project `retries` so a\n' +
        '       flaky test is reported FLAKY (exit 0) and a broken one FAILED; see\n' +
        '       route-smoke and publish-version in apps/fiab-console/playwright.config.ts.\n' +
        '    2. Keep it non-fatal HONESTLY — give it an `id:` and add\n' +
        '       `<label>=${{ steps.<id>.outcome }}` to UVG_BLOCKING on the final\n' +
        '       "Enforce login-health verdict + blocking suite results" step.\n',
    );
    return 1;
  }

  const { code, reason } = decide(analysis, { isDefault });
  if (code !== 0) {
    console.error(`[ui-verify-step-teeth] ${reason}`);
    return code;
  }

  console.log(`[ui-verify-step-teeth] OK — ${path.basename(wf)}: ${reason}`);
  for (const b of browser) console.log(`    ${b.id.padEnd(16)} ${b.name}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
