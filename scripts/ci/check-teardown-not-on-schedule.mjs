#!/usr/bin/env node
/**
 * GUARDRAIL: a teardown step must be UNREACHABLE from a scheduled run.
 *
 * WHY THIS EXISTS (2026-08-10)
 * ----------------------------
 * Both sovereign deploy lanes carried this:
 *
 *   - name: Teardown
 *     if: success() && (github.event_name == 'schedule' || inputs.run_mode == 'full')
 *         && !inputs.keep_resources
 *
 * A `schedule` event carries NO inputs, so `inputs.keep_resources` is the empty
 * string and `!inputs.keep_resources` is TRUE. Nothing else stood in the way. So
 * the daily cron — 10:00 UTC on gcch, 08:00 UTC on gcc — would DESTROY the
 * sovereign estate on every successful run.
 *
 * `deploy-fiab-commercial.yml` has always had this right:
 *     github.event_name != 'schedule'
 * The sovereign lanes inverted the same condition.
 *
 * WHY IT MATTERED RIGHT THEN. `deploy-fiab-gcch` was `disabled_manually`, and 12
 * of GCC-High's 16 blocked capabilities are merged fixes waiting on that lane to
 * run. "Just re-enable it" was the obvious next move and would have armed an
 * unattended sovereign teardown. The defect was invisible from `gh run list` —
 * a disabled lane does not appear there — and invisible from the run history,
 * because the teardown had never fired while the lane was off.
 *
 * THE RULE
 * --------
 * Any step whose name or `run:` invokes a teardown MUST have an `if:` that
 * excludes scheduled events — either `github.event_name != 'schedule'`, or a
 * condition that can only be true for a dispatch (e.g. testing an input that a
 * schedule cannot set to a truthy value, such as `inputs.run_mode == 'full'`,
 * PROVIDED the expression does not also OR-in `github.event_name == 'schedule'`).
 *
 * The check is deliberately conservative: it FAILS when a teardown step's
 * condition mentions `github.event_name == 'schedule'` at all, and when a
 * teardown step has no `if:` whatsoever. Both are unreviewable.
 *
 * NOT CHECKED: whether `keep_resources` is honoured. That is a separate
 * property, and a lane with no such input (deploy-fiab-il5) is not wrong for
 * lacking it.
 *
 * SELF-DEFENCE: refuses to pass vacuously — zero workflows, or zero teardown
 * steps found, FAILS.
 *
 * Usage: node scripts/ci/check-teardown-not-on-schedule.mjs [workflow-dir]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_DIR = '.github/workflows';
const WORKFLOW_DIR = process.argv[2] || DEFAULT_DIR;
const IS_DEFAULT = WORKFLOW_DIR === DEFAULT_DIR;

const STEP_START = /^(\s*)-\s+(name|uses|run|id|if|with|env|shell|continue-on-error):/;
/**
 * A step that performs a teardown. Matched ONLY on the step's own `name:` line
 * or a line that actually INVOKES a teardown script — never on arbitrary body
 * text, because a comment mentioning teardown is not a teardown, and the step
 * slicer can over-extend past a step boundary.
 *
 * Both shapes were real false positives on the first draft: the read-only
 * "Resolve reconcile target" step, and the dedicated teardown-fiab-commercial
 * workflow. A guard that cries wolf is a guard someone disables.
 */
const IS_TEARDOWN_NAME = /^\s*-?\s*name:\s*.*teardown/i;
const IS_TEARDOWN_RUN = /^\s*(run:\s*)?(bash\s+)?\S*teardown[\w.-]*\.sh\b/i;
/** Only a workflow that can actually be triggered by cron is in scope. */
const HAS_CRON = /^\s*-\s*cron:/m;

function stepBody(lines, start) {
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

/** The step's `if:` text, including a block-scalar continuation. */
function ifText(body) {
  const idx = body.findIndex((l) => /^\s*if:/.test(l));
  if (idx < 0) return null;
  const first = body[idx].replace(/^\s*if:\s*/, '').replace(/^[|>][-+]?\s*$/, '');
  const indent = body[idx].match(/^(\s*)/)[1].length;
  const out = [first];
  for (let k = idx + 1; k < body.length; k++) {
    if (body[k].trim() === '') continue;
    if (body[k].match(/^(\s*)/)[1].length <= indent) break;
    out.push(body[k].trim());
  }
  return out.join(' ').trim();
}

const violations = [];
let examined = 0;
const files = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

let skippedNoCron = 0;
for (const file of files) {
  const src = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
  // No cron => a scheduled teardown is not reachable, whatever the `if:` says.
  // teardown-fiab-commercial.yml is exactly this: a DEDICATED, dispatch-only
  // teardown workflow whose whole purpose is to tear down, so an unconditional
  // step there is correct, not a defect.
  if (!HAS_CRON.test(src)) { skippedNoCron++; continue; }
  // PHYSICAL-LINES-OK: reads the `on:` trigger block and each step's `if:` guard
  // by YAML indentation, including block-scalar `if: |` bodies. YAML keys and
  // block scalars are not spliced by a trailing backslash (#3420).
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!STEP_START.test(lines[i])) continue;
    const body = stepBody(lines, i);
    const start = i;
    i += body.length - 1;
    if (!body.some((l) => IS_TEARDOWN_NAME.test(l) || IS_TEARDOWN_RUN.test(l))) continue;
    examined++;

    const cond = ifText(body);
    const name = (body.find((l) => /^\s*-?\s*name:/.test(l)) || '')
      .replace(/^\s*-?\s*name:\s*/, '').trim() || '(unnamed step)';

    if (cond === null) {
      violations.push({ file, line: start + 1, name, why: 'teardown step has NO `if:` at all — it runs on every trigger, including the cron' });
      continue;
    }
    if (/github\.event_name\s*==\s*'schedule'/.test(cond)) {
      violations.push({
        file, line: start + 1, name,
        why: `condition ADMITS scheduled runs: ${cond.slice(0, 140)}`,
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`\n[teardown-not-on-schedule] ${violations.length} teardown step(s) reachable from a cron:\n`);
  for (const v of violations) {
    console.error(`  ${WORKFLOW_DIR}/${v.file}:${v.line}  ${v.name}`);
    console.error(`      ${v.why}`);
  }
  console.error(
    '\n  A `schedule` event carries NO inputs, so `!inputs.keep_resources` is `!\'\'`\n' +
      '  = TRUE and cannot stop it. Both sovereign lanes had exactly this, with daily\n' +
      '  crons (gcch 10:00 UTC, gcc 08:00 UTC) — turning either lane back on would\n' +
      '  have armed an unattended teardown of a sovereign estate.\n' +
      "\n  Use deploy-fiab-commercial's form: github.event_name != 'schedule'.\n",
  );
  process.exit(1);
}

if (IS_DEFAULT && (files.length === 0 || examined === 0)) {
  console.error(
    `[teardown-not-on-schedule] REFUSING TO PASS: scanned ${files.length} workflow(s), found ` +
      `${examined} teardown step(s). This repo has several. The matcher has stopped matching — ` +
      'fix the scanner, do not ship a green check that measures nothing.',
  );
  process.exit(1);
}

console.log(
  `[teardown-not-on-schedule] OK — ${files.length} workflows (${skippedNoCron} have no cron, out of scope), ${examined} teardown step(s) in cron-capable lanes; none reachable from a cron.`,
);
