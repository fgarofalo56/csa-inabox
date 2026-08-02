#!/usr/bin/env node
/**
 * GUARDRAIL: every `scripts/csa-loom/deploy-*-job.sh` must be EXECUTABLE from CI,
 * and the workflow that executes it must be WATCHED for staleness.
 *
 * WHY THIS EXISTS (#2816, class of #2814). Five scripts provision Container Apps
 * jobs — building an image, creating/updating the job. Not one was executed by
 * any `run:` step in any workflow. They appeared in `.github/workflows/` only
 * as `::warning::` STRINGS telling a human to go run them on a workstation with
 * `az` write access:
 *
 *   loom-roll-and-validate.yml:394
 *     echo "::warning::loom-uat Container App Job not found ... (deploy it via
 *      scripts/csa-loom/deploy-loom-uat-job.sh to enable)"
 *
 * A naive `grep -c` scores that line as a hit, which is why the gap survived
 * review: the reference is real, the execution is not. This check distinguishes
 * the two, because that distinction IS the bug.
 *
 * The consequences are the recurring shape in this repo — a control that exists,
 * reads green, and is not executing:
 *   1. Fixes to those services cannot reach production. #2799 added the
 *      evaluator's `probeErrors` diagnostic and it stayed inert after merge for
 *      exactly this reason.
 *   2. They are invisible to the "merged != deployed" watchdog (#2775).
 *      check-deploy-staleness.mjs compares a WATCHED WORKFLOW's last successful
 *      run against the code it deploys — a deploy path that is not a workflow
 *      cannot appear stale, because it can never run. So reachability alone is
 *      not enough: the workflow must also be registered, with the script in its
 *      `paths`, or a script change still drifts silently.
 *
 * THE RULE, per script:
 *   a) some workflow INVOKES it in a `run:` step (not inside an echo, not in a
 *      YAML comment), and
 *   b) that workflow is an entry in `WATCHED` in check-deploy-staleness.mjs,
 *      whose `paths` include the script itself.
 *
 * Usage: node scripts/ci/check-deploy-script-reachability.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCRIPT_DIR = 'scripts/csa-loom';
const WORKFLOW_DIR = '.github/workflows';
const STALENESS = 'scripts/ci/check-deploy-staleness.mjs';

/** Workflow-command markers. A line carrying one of these is OUTPUT, not execution. */
const ANNOTATION = /::(?:warning|notice|error|debug)::/;

/**
 * Does `line` actually RUN `path`?
 *
 * Deliberately narrow. It must match a shell invocation shape —
 *   bash scripts/csa-loom/x.sh | sh ./scripts/... | source scripts/... | ./scripts/...
 * — and must not be a YAML comment or an `echo`/annotation that merely NAMES the
 * script. Being too permissive here would re-admit exactly the false positive
 * that let #2816 sit unnoticed: a warning string counted as a deploy path.
 */
function isExecution(line, path) {
  if (/^\s*#/.test(line)) return false;              // YAML comment
  if (!line.includes(path)) return false;
  if (ANNOTATION.test(line)) return false;           // ::warning:: etc.
  if (/\becho\b/.test(line)) return false;           // echoed, not run
  const p = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `bash <path>` / `sh <path>` / `source <path>` / `. <path>`, optionally quoted
  // and optionally prefixed with $GITHUB_WORKSPACE or ./
  const viaInterpreter = new RegExp(
    `(?:^|[\\s;&|(])(?:bash|sh|source|\\.)\\s+["']?(?:\\$\\{?GITHUB_WORKSPACE\\}?/|\\./)?${p}\\b`,
  );
  // direct `./scripts/csa-loom/x.sh` execution
  const direct = new RegExp(`(?:^|[\\s;&|(])["']?\\./${p}\\b`);
  return viaInterpreter.test(line) || direct.test(line);
}

const scripts = existsSync(join(ROOT, SCRIPT_DIR))
  ? readdirSync(join(ROOT, SCRIPT_DIR)).filter((f) => /^deploy-.*-job\.sh$/.test(f)).sort()
  : [];

if (scripts.length === 0) {
  console.error(`[deploy-script-reachability] FAIL — no deploy-*-job.sh found under ${SCRIPT_DIR}.`);
  console.error('  Either the scripts moved or this check is pointed at the wrong tree. A guard');
  console.error('  that silently finds nothing to check is the failure mode it exists to prevent.');
  process.exit(1);
}

const workflows = existsSync(join(ROOT, WORKFLOW_DIR))
  ? readdirSync(join(ROOT, WORKFLOW_DIR)).filter((f) => /\.ya?ml$/.test(f)).sort()
  : [];

const stalenessSrc = existsSync(join(ROOT, STALENESS))
  ? readFileSync(join(ROOT, STALENESS), 'utf8')
  : '';
const watched = new Set([...stalenessSrc.matchAll(/workflow:\s*'([^']+)'/g)].map((m) => m[1]));

const failures = [];
const rows = [];

for (const script of scripts) {
  const rel = `${SCRIPT_DIR}/${script}`;
  const executors = [];
  const mentions = [];

  for (const wf of workflows) {
    const text = readFileSync(join(ROOT, WORKFLOW_DIR, wf), 'utf8');
    if (!text.includes(rel)) continue;
    const lines = text.split('\n');
    if (lines.some((l) => isExecution(l.replace(/\r$/, ''), rel))) executors.push(wf);
    else mentions.push(wf);
  }

  if (executors.length === 0) {
    failures.push({
      script: rel,
      kind: 'unreachable',
      detail: mentions.length
        ? `named in ${mentions.join(', ')} but only as text (comment / echo / ::warning::) — a mention is not an execution`
        : 'referenced by no workflow at all',
    });
    rows.push({ script, status: 'UNREACHABLE', via: mentions.join(', ') || '-' });
    continue;
  }

  // Reachable. Now: is at least one executing workflow watched for staleness,
  // WITH this script in its paths? Without both, a change to the script drifts
  // undeployed and nothing says so.
  const watchedExec = executors.filter((wf) => watched.has(wf));
  if (watchedExec.length === 0) {
    failures.push({
      script: rel,
      kind: 'unwatched',
      detail: `executed by ${executors.join(', ')}, but no executing workflow is a WATCHED entry in ${STALENESS}`,
    });
    rows.push({ script, status: 'UNWATCHED', via: executors.join(', ') });
    continue;
  }
  if (!stalenessSrc.includes(rel)) {
    failures.push({
      script: rel,
      kind: 'not-in-paths',
      detail: `${watchedExec.join(', ')} is WATCHED, but '${rel}' is not in its paths — editing the script would not register as drift`,
    });
    rows.push({ script, status: 'NOT-IN-PATHS', via: watchedExec.join(', ') });
    continue;
  }

  rows.push({ script, status: 'ok', via: executors.join(', ') });
}

console.log(`[deploy-script-reachability] ${scripts.length} deploy-*-job.sh script(s):`);
for (const r of rows) {
  console.log(`  ${r.status === 'ok' ? 'ok        ' : r.status.padEnd(10)} ${r.script.padEnd(34)} ${r.via}`);
}

if (failures.length === 0) {
  console.log('[deploy-script-reachability] OK — every deploy job script is executed by a workflow that is watched for staleness.');
  process.exit(0);
}

console.error(`\n[deploy-script-reachability] FAIL — ${failures.length} deploy script(s) cannot be deployed from CI (or drift unwatched).\n`);
for (const f of failures) {
  console.error(`  ${f.script}`);
  console.error(`    ${f.detail}`);
}
console.error('\n  A deploy path only a laptop can run is undeployable in practice and untested in fact.');
console.error('  Fix: add a workflow_dispatch wrapper that INVOKES the script (do not reimplement it),');
console.error('  then register that workflow in check-deploy-staleness.mjs with the script in its paths.');
console.error('  .github/workflows/deploy-copilot-evaluator.yml is the template (#2815).\n');
process.exit(1);
