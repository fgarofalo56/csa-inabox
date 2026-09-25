#!/usr/bin/env node
/**
 * GUARDRAIL: no single `run:` step may carry an Actions expression AND exceed
 * the size at which GitHub refuses to LOAD the whole workflow file.
 *
 * WHY THIS EXISTS (#4586)
 * -----------------------
 * On `fix/4495-op19-function-apps`, `full-app-deploy-commercial.yml` — the
 * canonical from-scratch app deploy path (`.claude/rules/no-vaporware.md`
 * §Bicep sync, step 2) — stopped loading entirely. The symptom is silent and
 * looks like nothing: GitHub creates ONE run for the push, concludes it
 * `failure` with **zero jobs**, and names it by `.path` because it never got
 * as far as reading `name:`. The file is valid YAML, has no duplicate keys, a
 * sound `needs` graph, and passes actionlint. Twelve consecutive pushes from
 * 2026-09-18 onward each produced one of those 0-job failures against a deploy
 * path that `.claude/rules/deploy-integrity.md` R1 calls P0, and nothing in the
 * gate set watched it.
 *
 * The cause is a size limit GitHub applies AFTER parsing, which no local tool
 * checks. A 24-probe bisect (issue #4586, comment 5837620548) pinned the
 * boundary to a single byte, twice, with two different character compositions:
 *
 *     20,944 UTF-8 bytes -> loads       20,945 UTF-8 bytes -> does NOT load
 *
 * It is BYTES, not characters: probe `x3` had exactly the same 20,896
 * characters as a probe that loaded, but 200 of its ASCII pad characters were
 * em dashes (3 bytes each), putting it at 21,344 bytes — and it failed. A
 * character-counting guard would therefore pass a file GitHub refuses, which is
 * why `runStepBytes` below measures `Buffer.byteLength(..., 'utf8')`.
 *
 * THE LIMIT APPLIES ONLY TO A `run:` SCRIPT CONTAINING `${{ }}`
 * ------------------------------------------------------------
 * This is the part the original bisect did not cover, and getting it wrong
 * would have made this guard red on day one. `release-please.yml` carries a
 * **39,839-byte** `run:` step — 18,895 bytes over the boundary — and it loads
 * and runs (run 36158347527: `success`, 1 job). So the limit is NOT universal
 * to every `run:` step. Three probes pushed on 2026-09-25 isolate the
 * difference; each was a one-file commit on a branch off `origin/main`, and the
 * instrument is the same binary readout as the bisect (the probe workflow is
 * `workflow_dispatch`-only, so a push creates NO run if the file loads and
 * exactly one `push`/`failure`/0-job run if it does not):
 *
 *   | probe             | run bytes | `${{ }}` in run | verdict                    |
 *   |-------------------|-----------|-----------------|----------------------------|
 *   | `ctl-small-expr`  |     1,000 | yes             | loads (0 runs)             |
 *   | `expr-21000`      |    21,000 | yes             | FAILS (run 36178435019,    |
 *   |                   |           |                 | push/failure/0 jobs)       |
 *   | `noexpr-21000`    |    21,000 | no              | loads (0 runs)             |
 *
 * The negative control proves the instrument can read "loads", the positive
 * control reproduces the #4586 signature exactly, and the third arm is the
 * discriminator. `release-please.yml` corroborates it from the live tree, and
 * also rules out the weaker reading "any expression anywhere in the step": its
 * 39,839-byte step HAS `${{ secrets.GITHUB_TOKEN }}` in its `env:` block and
 * still loads. What matters is an expression inside the `run:` scalar itself —
 * which is exactly the thing GitHub must template before it can store the step.
 *
 * WHAT IT COSTS TO BE WRONG IN EACH DIRECTION
 * -------------------------------------------
 * Failing expression-free steps too would red `release-please.yml`, a file
 * proven to load — a false positive on a green lane. Not watching them at all
 * would miss a real latent hazard: such a step is ONE `${{ }}` away from
 * freezing its workflow. So they are REPORTED as notes and do not fail the
 * gate; the moment someone adds an expression, the fail arm catches it.
 *
 * THE THRESHOLD IS 20,000, NOT THE MEASURED 20,944
 * ------------------------------------------------
 * 944 bytes (4.5%) of deliberate headroom, for two reasons and not for taste:
 *   1. The limit is GitHub-side, undocumented, and not ours to depend on to the
 *      byte. A guard sitting one byte under a number we do not control is a
 *      guard that goes false-green when that number moves.
 *   2. The bisect measured the SOURCE byte count. Whether GitHub accounts the
 *      script before or after expression substitution is not established — and
 *      a substitution changes length (`${{ inputs.subscription ||
 *      secrets.AZURE_SUBSCRIPTION_ID }}` is 54 source bytes and resolves to a
 *      36-byte GUID, but an expression can just as easily expand). A script
 *      passing at 20,943 source bytes could still flip on a value change.
 * The cost of the headroom is zero today: after #4586's extraction the largest
 * expression-bearing `run:` step in the tree is 15,682 bytes.
 *
 * THE REMEDY when this fires is not to shave comments off the script. Either
 * move it to `scripts/csa-loom/<name>.sh` and pass the `${{ }}` values in
 * through the step's `env:` (what #4586 did — see
 * `scripts/csa-loom/start-copilot-evaluator-rebaseline.sh`), or split the step.
 * Both are proven: probe `s3b` shipped the identical 38,226 characters as three
 * `run:` steps and loaded.
 *
 * FAILS CLOSED. `parseWorkflow` throws rather than half-reading a construct it
 * cannot model; a throw is reported as a finding, never skipped. A guard that
 * silently drops the one file it could not read is the defect class this repo
 * keeps finding in its own controls.
 *
 * Usage:      node scripts/ci/check-workflow-run-step-size.mjs
 * Self-tests: node --test scripts/ci/__tests__/workflow-run-step-size.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseWorkflow } from './_workflow-yaml.mjs';

const WORKFLOW_DIR = '.github/workflows';

/** Bytes at which a run: step carrying `${{ }}` stops loading (measured, #4586). */
export const MEASURED_FAIL_AT = 20945;
/** Largest run: step carrying `${{ }}` that still loads (measured, #4586). */
export const MEASURED_LOAD_AT = 20944;
/** What this guard enforces. See "THE THRESHOLD IS 20,000" above. */
export const BYTE_LIMIT = 20000;

/**
 * UTF-8 byte length of a `run:` script as GitHub sees it.
 *
 * `_workflow-yaml.mjs` pops trailing blank lines and joins with '\n', so its
 * value never ends in a newline. A YAML `|` block with default (clip) chomping
 * — the form every `run:` in this repo uses — keeps exactly one. Adding it back
 * makes this agree with the PyYAML-based measurement the boundary was
 * established with. On a `|-` (strip) block this overcounts by exactly 1 byte,
 * which errs toward failing early and never toward missing a real one.
 */
export function runStepBytes(runText) {
  const withNewline = runText.endsWith('\n') ? runText : `${runText}\n`;
  return Buffer.byteLength(withNewline, 'utf8');
}

/** Does this script carry an Actions template expression GitHub must evaluate? */
export function hasExpression(runText) {
  return runText.includes('${{');
}

/**
 * Scan one workflow's text. Returns `{ findings, notes }`, where a finding
 * fails the gate and a note is reported only.
 */
export function scanWorkflowText(name, text) {
  const findings = [];
  const notes = [];

  let doc;
  try {
    doc = parseWorkflow(text);
  } catch (err) {
    findings.push({
      file: name,
      kind: 'unparseable',
      message: `could not be parsed, so its run: steps were NOT measured: ${err.message}`,
    });
    return { findings, notes };
  }

  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return { findings, notes };

  for (const [jobId, job] of Object.entries(jobs)) {
    const steps = job?.steps;
    if (!Array.isArray(steps)) continue;
    steps.forEach((step, index) => {
      const run = step?.run;
      if (!run || typeof run !== 'object' || typeof run.v !== 'string') return;
      const bytes = runStepBytes(run.v);
      if (bytes <= BYTE_LIMIT) return;
      const stepName =
        typeof step?.name?.v === 'string' ? step.name.v : `<unnamed step ${index}>`;
      const where = { file: name, jobId, index, line: run.line, bytes, stepName };
      if (hasExpression(run.v)) {
        findings.push({ ...where, kind: 'oversize-with-expression' });
      } else {
        notes.push({ ...where, kind: 'oversize-without-expression' });
      }
    });
  }
  return { findings, notes };
}

function main() {
  const files = readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();

  const findings = [];
  const notes = [];
  let maxWithExpression = { bytes: 0 };
  let stepCount = 0;

  for (const file of files) {
    const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    const result = scanWorkflowText(file, text);
    findings.push(...result.findings);
    notes.push(...result.notes);

    // Report the live maximum so the margin to the limit is a known number
    // rather than an assumption. Re-derived here, not cached in a constant.
    let doc;
    try {
      doc = parseWorkflow(text);
    } catch {
      continue; // already recorded as a finding above
    }
    for (const [jobId, job] of Object.entries(doc?.jobs ?? {})) {
      for (const [index, step] of (job?.steps ?? []).entries()) {
        const run = step?.run;
        if (!run || typeof run.v !== 'string') continue;
        stepCount++;
        if (!hasExpression(run.v)) continue;
        const bytes = runStepBytes(run.v);
        if (bytes > maxWithExpression.bytes) {
          maxWithExpression = { bytes, file, jobId, index, line: run.line };
        }
      }
    }
  }

  console.log(
    `checked ${stepCount} run: steps across ${files.length} workflow files; ` +
      `limit ${BYTE_LIMIT} UTF-8 bytes for a step containing \${{ }} ` +
      `(GitHub refuses to load at ${MEASURED_FAIL_AT}; ${MEASURED_LOAD_AT} still loads)`
  );
  if (maxWithExpression.bytes) {
    const m = maxWithExpression;
    const delta = BYTE_LIMIT - m.bytes;
    const margin = delta >= 0 ? `${delta} bytes of margin` : `OVER the limit by ${-delta} bytes`;
    console.log(
      `largest run: step carrying an expression: ${m.bytes} bytes — ` +
        `${m.file} job=${m.jobId} step[${m.index}] (line ${m.line}); ${margin}`
    );
  }

  for (const n of notes) {
    console.log(
      `NOTE ${n.file}:${n.line} job=${n.jobId} step[${n.index}] "${n.stepName}" is ` +
        `${n.bytes} bytes, over the ${BYTE_LIMIT}-byte limit but carrying NO \${{ }} — ` +
        `it loads today (release-please.yml proves a 39,839-byte expression-free step ` +
        `loads), so this does not fail the gate. Adding ONE expression to this script ` +
        `would make its workflow unloadable.`
    );
  }

  if (findings.length === 0) {
    console.log('OK: no run: step carries an expression while exceeding the limit.');
    return 0;
  }

  for (const f of findings) {
    if (f.kind === 'unparseable') {
      console.error(`FAIL ${f.file}: ${f.message}`);
      continue;
    }
    console.error(
      `FAIL ${f.file}:${f.line} job=${f.jobId} step[${f.index}] "${f.stepName}" — ` +
        `run: script is ${f.bytes} UTF-8 bytes and contains \${{ }}, over the ` +
        `${BYTE_LIMIT}-byte limit by ${f.bytes - BYTE_LIMIT}. GitHub will refuse to ` +
        `LOAD this workflow: the push produces one run with ZERO jobs and no other ` +
        `signal. Move the script to scripts/csa-loom/<name>.sh and pass the \${{ }} ` +
        `values in through the step's env: (see #4586), or split the step.`
    );
  }
  console.error(`\n${findings.length} finding(s).`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
