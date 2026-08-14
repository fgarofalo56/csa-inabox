#!/usr/bin/env node
/**
 * GUARDRAIL: every control in scripts/ci/ is actually INVOKED by a workflow.
 *
 * WHY THIS EXISTS (refs #2860)
 * ---------------------------
 * On 2026-08-02 an audit found four controls that existed and did not run.
 * Two of them were guard scripts sitting in this very directory:
 *
 *   check-route-smoke-floor.mjs   — its own header calls it a "merge-blocker
 *                                   (RATCHETING)". No workflow invoked it.
 *                                   It had never executed in CI, once.
 *   check-insecure-randomness.mjs — a Math.random() ratchet with a BASELINE
 *                                   constant and an --update-baseline mode.
 *                                   Only its unit test ran, and that test
 *                                   covers stripComments() alone, so the
 *                                   RATCHET protected nothing.
 *
 * Both read, in review, exactly like enforcement. Both were decoration. That is
 * the repo's dominant defect class — a control that runs, measures nothing, and
 * reports success — one rung further down: a control that does not run at all.
 * #2835 closed the same hole for orphaned TEST SUITES
 * (check-node-test-suites.mjs); this closes it for the guards themselves.
 *
 * THE RULE
 * --------
 * Every CONTROL in scripts/ci/ must be named inside the `run:` body of some
 * step in .github/workflows/, directly or transitively through another
 * reachable script. A control is:
 *   - `check-*.mjs` / `check-*.sh`  — the repo's naming convention for a guard
 *   - `test-*.sh`                   — a self-test of one of the above
 *   - `*-verdict.sh`                — the pure pass/fail half of a workflow
 *                                     step (login-health-verdict.sh,
 *                                     service-health-verdict.sh). These decide
 *                                     a job conclusion, so an orphaned one is
 *                                     the same defect as an orphaned guard.
 *   - any other `*.mjs` here that implements a `--check` drift mode (a
 *     generator whose --check IS a gate; generate-route-inventory.mjs and
 *     generate-coverage-summary.mjs are both this shape)
 * Excluded from the population, with reasons:
 *   - `_`-prefixed files      — shared libraries, not controls (_ratchet-count.mjs)
 *   - `__tests__/`            — owned by check-node-test-suites.mjs
 *   - `*.json`                — baselines, not executables
 *   - `*.py`                  — invoked by the Python lanes, different corpus
 *
 * COMMENTS DO NOT COUNT — and this is the whole difficulty of writing this
 * check honestly. Half these scripts name themselves in their own header, in
 * an --unblock string, or in another guard's remediation text. If a bare
 * substring search over the workflow file counted, then
 *
 *     # we should really wire scripts/ci/check-route-smoke-floor.mjs in
 *
 * would satisfy the guard, and a check that a COMMENT can satisfy is the exact
 * defect being closed. So mentions are only counted inside a step's `run:`
 * block, with whole-line comments stripped first, in workflows AND in the
 * scripts walked transitively. See the fixture tests.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK (stated so nobody reads more into a
 * green run than is there):
 *   - WHICH workflow invokes it. A guard wired only into a
 *     `workflow_dispatch:`-only workflow is reachable by this check but is not
 *     merge-blocking. The manual-only list is PRINTED for review; it is not a
 *     failure, because deploy-time controls legitimately live there and an
 *     allowlist would be guesswork.
 *   - Whether the invocation can fail. That is check-annotation-teeth.mjs.
 *   - Whether the control measures anything. That is each control's own
 *     refuse-to-pass-vacuously branch.
 *
 * ESCAPE HATCH: add an EXEMPT entry with a reason. It is currently EMPTY and
 * should stay that way — "wire it in" is nearly always cheaper than justifying
 * why a control does not run.
 *
 * Usage: node scripts/ci/check-ci-guard-reachability.mjs [repo-root]
 *   The optional argument exists for the self-test; CI passes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Controls that legitimately have no CI lane. Each entry is a review: say what
 * runs it instead, or why nothing should. EMPTY BY DESIGN.
 * @type {Map<string, string>}
 */
export const EXEMPT = new Map([]);

/** Strip whole-line comments so prose cannot satisfy a reachability claim. */
export function stripCommentLines(src) {
  return src
    // PHYSICAL-LINES-OK: needs only a control's PRESENCE inside a `run:` body —
  // one token, `body.includes(name)`. A second token on a continuation cannot
  // change the answer, and the run bodies are re-joined before matching (#3420).
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/**
 * The `run:` bodies of a workflow file, concatenated, comments stripped.
 *
 * Only `run:` counts. A workflow that merely NAMES a script in a step name, an
 * `if:`, or a comment has not invoked it.
 */
export function runBodies(yaml) {
  const lines = yaml.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const block = /^(\s*)run:\s*([|>][-+]?)?\s*(.*)$/.exec(lines[i]);
    if (!block) continue;
    const [, indent, folded, inline] = block;
    if (!folded) {
      // `run: node scripts/ci/foo.mjs` — a one-line command.
      if (inline) out.push(inline);
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (lines[j].match(/^(\s*)/)[1].length <= indent.length) break;
      out.push(lines[j]);
      i = j;
    }
  }
  return stripCommentLines(out.join('\n'));
}

/** Every control filename in scripts/ci (basenames, sorted). */
export function discoverControls(root) {
  const dir = path.join(root, 'scripts', 'ci');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => {
      if (n.startsWith('_')) return false;
      if (/^(check|test)-.*\.(mjs|sh)$/.test(n)) return true;
      if (/-verdict\.sh$/.test(n)) return true;
      if (!n.endsWith('.mjs')) return false;
      // a generator whose --check mode is a gate
      return /['"`]--check['"`]/.test(fs.readFileSync(path.join(dir, n), 'utf8'));
    })
    .sort();
}

/** Files whose (comment-stripped) text may establish reachability. */
function scriptCorpus(root) {
  const out = new Map();
  const roots = [path.join(root, 'scripts'), path.join(root, 'apps')];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|cjs|sh|ts|json)$/.test(e.name)) {
        out.set(path.relative(root, p).split(path.sep).join('/'), stripCommentLines(fs.readFileSync(p, 'utf8')));
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/** Automatic (non-dispatch) trigger? Used only for the informational split. */
function hasAutoTrigger(yaml) {
  return /^\s{0,4}(pull_request|push|schedule|workflow_call)\s*:/m.test(yaml);
}

export function analyze(root) {
  const wfDir = path.join(root, '.github', 'workflows');
  const wfFiles = fs.existsSync(wfDir)
    ? fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort()
    : [];

  const workflows = wfFiles.map((f) => {
    const raw = fs.readFileSync(path.join(wfDir, f), 'utf8');
    return { file: f, body: runBodies(raw), auto: hasAutoTrigger(raw) };
  });

  const controls = discoverControls(root);
  const scripts = scriptCorpus(root);

  // BFS: a control is reachable if a workflow run-body names it, or if a
  // script that is itself reachable names it.
  const reachedBy = new Map(); // control -> {via, auto}
  const frontier = [];
  for (const c of controls) {
    const hits = workflows.filter((w) => w.body.includes(c));
    if (hits.length) {
      reachedBy.set(c, { via: hits.map((h) => `.github/workflows/${h.file}`), auto: hits.some((h) => h.auto) });
      frontier.push(`scripts/ci/${c}`);
    }
  }
  // Anything a reachable script invokes is itself reachable.
  const seen = new Set(frontier);
  while (frontier.length) {
    const cur = frontier.shift();
    const body = scripts.get(cur);
    if (!body) continue;
    for (const c of controls) {
      if (reachedBy.has(c) || !body.includes(c)) continue;
      reachedBy.set(c, { via: [cur], auto: reachedBy.get(path.basename(cur))?.auto ?? false });
      const next = `scripts/ci/${c}`;
      if (!seen.has(next)) { seen.add(next); frontier.push(next); }
    }
  }

  const orphans = controls.filter((c) => !reachedBy.has(c) && !EXEMPT.has(c));
  const manualOnly = controls.filter((c) => reachedBy.get(c) && !reachedBy.get(c).auto);
  const staleExempt = [...EXEMPT.keys()].filter((c) => !controls.includes(c) || reachedBy.has(c));
  return { controls, workflows: wfFiles, reachedBy, orphans, manualOnly, staleExempt };
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
  const { controls, workflows, orphans, manualOnly, staleExempt } = analyze(root);

  // Refuse to pass vacuously: a scanner that stops matching must not read as
  // "everything is wired". This is the defect the check exists to catch.
  if (controls.length === 0 || workflows.length === 0) {
    console.error(
      `[ci-guard-reachability] REFUSING TO PASS: found ${controls.length} control(s) in scripts/ci ` +
        `and ${workflows.length} workflow(s). This repo has dozens of each. Discovery is broken — ` +
        'fix the scanner, do not ship a green check that measures nothing.',
    );
    process.exit(1);
  }

  if (staleExempt.length) {
    console.error('\n[ci-guard-reachability] FAIL — stale EXEMPT entries (the exemption outlived its reason):');
    for (const c of staleExempt) console.error(`  - ${c}`);
    console.error('  Remove the entry. An exemption nobody revisits is how a hole becomes permanent.\n');
    process.exit(1);
  }

  if (orphans.length) {
    console.error(`\n[ci-guard-reachability] FAIL — ${orphans.length} control(s) that NO workflow runs:\n`);
    for (const c of orphans) console.error(`  scripts/ci/${c}`);
    console.error(
      '\n  A guard nobody executes reads as enforcement in review and enforces nothing.\n' +
        '  Wire it into .github/workflows/loom-guardrails.yml (the merge-blocking lane),\n' +
        '  or add an EXEMPT entry in this file stating what runs it instead.\n' +
        '  Note: a mention in a COMMENT does not count — only a step `run:` body does.\n',
    );
    process.exit(1);
  }

  console.log(
    `[ci-guard-reachability] OK — ${controls.length} control(s) across ${workflows.length} workflows; ` +
      'every one is invoked.',
  );
  if (manualOnly.length) {
    console.log(
      `  NOTE (not a failure): ${manualOnly.length} reachable only from manually-dispatched workflows — ` +
        `${manualOnly.join(', ')}. Reachable, but not merge-blocking.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
