#!/usr/bin/env node
/**
 * check-bicepparam-compiled.mjs
 *
 * RULE. Every tracked `*.bicepparam` must be inside the population of a CI step
 * that actually COMPILES it, and that step must live in a job no pull request
 * can skip.
 *
 * WHY (#4466). Measured on 0348d3715e6, before the `bicep-params` job existed:
 *
 *   - `az bicep build-params` appeared in `.github/workflows/` at three sites,
 *     ALL of them comments (deploy-fiab-commercial.yml:1114 and :1172,
 *     loom-guardrails.yml:581) and zero of them executable steps.
 *   - The one bicep-walking CI step enumerated with `git ls-files '*.bicep'`.
 *     That pathspec matches 357 files and ZERO `.bicepparam`
 *     (`git ls-files '*.bicep' | grep -c bicepparam` -> 0), so the param files
 *     were OUTSIDE the population that guard walks, not merely skipped by it.
 *   - The only build of any param file was `bicep-whatif.yml:403`, which hands
 *     `commercial-full.bicepparam` to `az deployment sub what-if` — one file of
 *     seventeen, behind an Azure login, on a lane that no-ops without secrets.
 *
 * So a syntax error, a BCP259 undeclared assignment, a type mismatch or a
 * dangling `using` in `gcc.bicepparam`, `gcc-high.bicepparam`, `il5.bicepparam`,
 * `dlz-attach.bicepparam` or `tenant-dmlz.bicepparam` reached `main` with
 * nothing in CI having parsed it. `il5.bicepparam` was the worst case: compiled
 * by no gate AND executed by no deploy (`deploy-fiab-il5.yml` is `active` with
 * zero recorded runs), so an IL5 first-ever deploy would have been the first
 * time anything parsed it — squarely against `deploy-integrity.md` R4.
 *
 * WHAT THIS GUARD IS FOR, AND WHAT IT IS NOT. The compile itself lives in
 * `.github/workflows/validate.yml` (job `bicep-params`) because it needs the
 * Bicep CLI. This guard is the thing that notices when that job is quietly
 * defeated — by deletion, by acquiring a paths filter, by having its
 * enumeration narrowed, or by an exclusion list added to make a broken file go
 * away. It runs in `loom-guardrails`, which is merge-blocking and needs no CLI.
 *
 * KEYED TO CODE, NOT TO TEXT. Two failure modes of a guard like this are
 * already recorded in this repo and both are avoided by construction:
 *
 *   - "a guard matching RAW SOURCE is satisfied by a COMMENT" (#4467). Every
 *     match below runs against {@link stripComments} output, so the three
 *     commented `build-params` mentions that motivated #4466 cannot satisfy it.
 *     That is not hypothetical: the pre-fix tree had exactly those three, and
 *     R2 must fail on it. The test suite asserts that.
 *   - "a LINE guard no-ops on CRLF" — `validate.yml` is CRLF on Windows and LF
 *     in CI, so `\r` is stripped before anything else looks at the text.
 *
 * The paths-filter rule (R6) is decided by GLOB-MATCHING each declared pattern
 * against each real tracked param path, never by searching for the literal
 * string `**\/*.bicepparam`. A typo'd `**\/*.bicepparams` therefore reds instead
 * of passing.
 *
 * OUT OF SCOPE, NAMED (#4466 "done" #3). Three other CI scripts enumerate bicep
 * and none is widened here, because none of them is a compiler:
 *   - `check-postgres-quota-gate.mjs:863` (`git ls-files -- '*.bicep'`) walks
 *     `module`/`param` DECLARATIONS to prove a quota gate is threaded through
 *     the template graph. A `.bicepparam` declares nothing; it assigns. That
 *     script already reads the two param files it cares about by name (:16-17,
 *     :1161-1162).
 *   - `check-license-inventory.mjs:337` and `check-upstream-image-mirror.mjs:88`
 *     (`platform/fiab/bicep/**\/*.bicep`) both resolve container image
 *     references out of templates. Image TAGS do come from param files, and
 *     that axis is covered by `check-bicepparam-env-reaches-deploy.mjs` (#3161)
 *     and `check-appimagetags-coverage.mjs`, not by compilation.
 * Compilation of every tracked param file is this guard's subject, and the
 * `bicep-params` job is the guard that covers it.
 *
 * Run: node scripts/ci/check-bicepparam-compiled.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** The workflow that must carry the compile. */
export const WORKFLOW = '.github/workflows/validate.yml';

/**
 * Sentinel the negative control assigns to a SANDBOX COPY of a param file.
 *
 * Lifted from here by the test rather than transcribed there, so a rename
 * cannot make the probe disagree with the rule (assertion-design.md §3).
 */
export const NEGATIVE_CONTROL_SENTINEL = 'zzzGateNegativeControlUndeclaredParam';

/** The command that actually type-checks a params file against its `using` target. */
export const COMPILE_VERB = 'build-params';

/**
 * Strip YAML/shell `#` comments and normalise line endings.
 *
 * Line-based and quote-aware: a `#` inside a single- or double-quoted run of
 * the same line is left alone, so `echo "a#b"` survives while
 * `# az bicep build-params …` does not. Erring toward NOT stripping is the safe
 * direction — a missed strip can only make this guard stricter.
 *
 * `\r` goes first. `validate.yml` is CRLF in a Windows checkout, and a guard
 * that matched `[^\n]*$` against it would silently see every line as ending in
 * a carriage return.
 *
 * @param {string} text
 * @returns {string} the same text, comments blanked, LF-terminated
 */
export function stripComments(text) {
  const out = [];
  for (const rawLine of text.replace(/\r/g, '').split('\n')) {
    let inSingle = false;
    let inDouble = false;
    let cut = -1;
    for (let i = 0; i < rawLine.length; i += 1) {
      const c = rawLine[i];
      if (c === "'" && !inDouble) inSingle = !inSingle;
      else if (c === '"' && !inSingle) inDouble = !inDouble;
      else if (c === '#' && !inSingle && !inDouble) {
        cut = i;
        break;
      }
    }
    out.push(cut === -1 ? rawLine : rawLine.slice(0, cut));
  }
  return out.join('\n');
}

/**
 * Split a workflow into its top-level jobs.
 *
 * A job starts at a two-space-indented `name:` key under `jobs:` and runs to
 * the next such key. Good enough here because the only question asked of the
 * result is "which job contains this text", and deliberately NOT a YAML parse:
 * the guard must judge the file as written, including its `run:` shell bodies,
 * which a parser would hand back as opaque scalars anyway.
 *
 * @param {string} text comment-stripped workflow text
 * @returns {Map<string,string>} job id -> job body (including its header line)
 */
export function jobsOf(text) {
  const lines = text.split('\n');
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) jobs.set(current, buf.join('\n'));
    current = null;
    buf = [];
  };
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    // A non-indented, non-blank line ends the jobs block.
    if (line.trim() !== '' && !/^\s/.test(line)) {
      flush();
      inJobs = false;
      continue;
    }
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1];
    }
    if (current) buf.push(line);
  }
  flush();
  return jobs;
}

/**
 * The `paths:` list of the workflow's `push:` trigger.
 *
 * @param {string} text comment-stripped workflow text
 * @returns {string[]} the declared glob patterns, in order
 */
export function pushTriggerPaths(text) {
  const lines = text.split('\n');
  const patterns = [];
  let inPush = false;
  let inPaths = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) break;
    if (/^ {2}push:\s*$/.test(line)) {
      inPush = true;
      inPaths = false;
      continue;
    }
    if (inPush && /^ {2}\S/.test(line)) {
      // another top-level trigger (pull_request:, merge_group:, …)
      inPush = false;
      inPaths = false;
      continue;
    }
    if (!inPush) continue;
    if (/^ {4}paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const m = /^ {6}-\s*'([^']*)'\s*$/.exec(line) || /^ {6}-\s*"([^"]*)"\s*$/.exec(line);
      if (m) patterns.push(m[1]);
      else if (line.trim() !== '') inPaths = false;
    }
  }
  return patterns;
}

/**
 * Compile a GitHub path filter glob to a regex.
 *
 * Only the subset these filters use: `**` across separators, `*` within a
 * segment, `?` for one non-separator character. Everything else is literal.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` may match zero segments, which is what makes '**/*.bicepparam'
        // match a repo-root file as well as a nested one.
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * The exclusion regex a shell body applies to its enumerated file list, if any.
 *
 * Recognises the `grep -vE '<re>'` / `grep -v -E "<re>"` shape the sibling
 * `.bicep` step uses. Returns null when the body filters nothing.
 *
 * @param {string} body comment-stripped job body
 * @returns {RegExp|null}
 */
export function exclusionRegExp(body) {
  const m = /grep\s+(?:-v\s*-?E?|-vE)\s+'([^']+)'/.exec(body) || /grep\s+(?:-v\s*-?E?|-vE)\s+"([^"]+)"/.exec(body);
  if (!m) return null;
  return new RegExp(m[1]);
}

/** Every tracked `*.bicepparam`, repo-relative, forward-slashed. */
export function trackedBicepParams() {
  const out = execFileSync('git', ['ls-files', '--', '*.bicepparam'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\\/g, '/'));
}

/**
 * Decide the whole rule against a workflow and a param-file population.
 *
 * Pure, so the tests can drive it with embedded controls instead of only with
 * the live tree.
 *
 * @param {string} workflowText raw workflow text (CRLF tolerated)
 * @param {string[]} params tracked `.bicepparam` paths
 * @returns {{violations: string[], job: string|null, stats: object}}
 */
export function analyze(workflowText, params) {
  const violations = [];
  const text = stripComments(workflowText);
  const jobs = jobsOf(text);

  // R1 — the population must not be empty. A renamed tree or a changed
  // extension would otherwise leave every rule below vacuously satisfied.
  if (params.length === 0) {
    violations.push(
      'R1 tracked `*.bicepparam` population is EMPTY — nothing can be compiled, so no verdict about coverage is reported.',
    );
    return { violations, job: null, stats: { jobs: jobs.size, params: 0 } };
  }

  // R2 — some job must carry an EXECUTABLE build-params invocation. Comments
  // are already gone, so the three commented mentions that motivated #4466
  // cannot satisfy this.
  const carriers = [...jobs.entries()].filter(([, body]) => body.includes(COMPILE_VERB));
  if (carriers.length === 0) {
    violations.push(
      `R2 no job in ${WORKFLOW} runs \`bicep ${COMPILE_VERB}\` outside a comment — nothing compiles any .bicepparam (#4466).`,
    );
    return { violations, job: null, stats: { jobs: jobs.size, params: params.length } };
  }
  const [job, body] = carriers[0];

  // R3 — the carrying job must be unskippable. `needs: changes` plus an
  // `if: needs.changes.outputs.*` is how the sibling .bicep job is gated, and a
  // skipped job reads as green to anyone scanning the run.
  if (/^\s{4}needs:\s*changes\s*$/m.test(body) || /needs\.changes\.outputs/.test(body)) {
    violations.push(
      `R3 job '${job}' is gated on the path-filter job \`changes\` — a .bicepparam-only PR could skip it, and a skipped job reads as green (#4466 "done" #2).`,
    );
  }
  if (/^\s{4}if:/m.test(body)) {
    violations.push(
      `R3 job '${job}' carries a job-level \`if:\` — it must be unconditional so no PR can skip the only .bicepparam compile.`,
    );
  }

  // R4 — the enumeration must be the tracked param population, not a hand list.
  const enumerates = /git\s+ls-files[^\n]*\*\.bicepparam/.test(body);
  if (!enumerates) {
    violations.push(
      `R4 job '${job}' does not enumerate with \`git ls-files … '*.bicepparam'\` — a hand-maintained list silently drops the next param file added.`,
    );
  }

  // R5 — no exclusion may drop a tracked param file. This is the "do not
  // weaken the guard to make something green" arm: adding `grep -v il5` to
  // silence a broken file fails here.
  const exclude = exclusionRegExp(body);
  const excluded = exclude ? params.filter((p) => exclude.test(p)) : [];
  if (excluded.length) {
    violations.push(
      `R5 job '${job}' excludes ${excluded.length} tracked param file(s) from the compile: ${excluded.join(', ')}. Every tracked .bicepparam compiled clean when this rule was written; an exclusion is a weakening, not a fix.`,
    );
  }

  // R6 — the push trigger must reach every tracked param file, or a push to
  // main that touches only a param file never starts this workflow at all.
  // Glob-MATCHED, never string-searched, so a typo'd pattern reds.
  const pushPatterns = pushTriggerPaths(text).map((g) => ({ glob: g, re: globToRegExp(g) }));
  const unreached = params.filter((p) => !pushPatterns.some(({ re }) => re.test(p)));
  if (unreached.length) {
    violations.push(
      `R6 the \`push:\` \`paths:\` filter of ${WORKFLOW} matches none of ${unreached.length} tracked param file(s): ${unreached.slice(0, 5).join(', ')}${unreached.length > 5 ? ', …' : ''}. A push to main touching only those files would not start this workflow.`,
    );
  }

  // R7 — the negative control must still be there. EXISTENCE only, and said so:
  // this arm cannot tell a working control from a broken one, so it is NOT
  // counted as evidence that the control has kill power. What it CAN do is
  // notice DELETION, which is the realistic way a control that reds someone's
  // PR disappears — the sentinel occurs nowhere else in executable text, so
  // removing the step removes it. The control's actual kill power is
  // re-established on every run of the job itself, which is the stronger
  // evidence and the reason this arm does not need to be more than existence.
  if (!body.includes(NEGATIVE_CONTROL_SENTINEL)) {
    violations.push(
      `R7 job '${job}' no longer contains the negative control (sentinel '${NEGATIVE_CONTROL_SENTINEL}') — the compile would run with nothing establishing that it can fail (assertion-design.md §2).`,
    );
  }

  return {
    violations,
    job,
    stats: { jobs: jobs.size, params: params.length, pushPatterns: pushPatterns.length, carriers: carriers.length },
  };
}

function main() {
  const wfPath = path.join(REPO_ROOT, WORKFLOW);
  let workflowText;
  try {
    workflowText = readFileSync(wfPath, 'utf8');
  } catch (err) {
    // Fail closed and say what actually happened — never report "no violations"
    // because the evidence could not be read (deploy-integrity.md R7).
    console.error(`[bicepparam-compiled] FAIL: could not read ${WORKFLOW}: ${err.message}`);
    return 1;
  }
  const params = trackedBicepParams();
  const { violations, job, stats } = analyze(workflowText, params);

  if (violations.length) {
    console.error('[bicepparam-compiled] FAIL — .bicepparam files are not provably compiled by CI (#4466).');
    for (const v of violations) console.error(`  - ${v}`);
    console.error('  Fix in .github/workflows/validate.yml, job `bicep-params`.');
    return 1;
  }

  console.log(
    `[bicepparam-compiled] OK — job '${job}' compiles all ${stats.params} tracked .bicepparam file(s) with ` +
      `\`bicep ${COMPILE_VERB}\`, is unconditional (no PR can skip it), excludes none, carries its negative control, ` +
      `and the push trigger's ${stats.pushPatterns} path pattern(s) reach every one of them.`,
  );
  return 0;
}

// Only run when invoked directly, so the tests can import the pure functions.
if (process.argv[1] && process.argv[1].endsWith('check-bicepparam-compiled.mjs')) {
  process.exit(main());
}
