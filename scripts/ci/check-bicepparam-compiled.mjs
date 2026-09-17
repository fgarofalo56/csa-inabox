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
 * ── WHAT THIS GUARD IS FOR, AND WHAT IT IS NOT ──────────────────────────────
 *
 * The compile itself lives in `.github/workflows/validate.yml` (job
 * `bicep-params`) because it needs the Bicep CLI. This guard is the thing that
 * notices when that job is quietly defeated. It runs in `loom-guardrails`,
 * which is merge-blocking and needs no CLI.
 *
 * IT IS THE SECOND LINE, NOT THE FIRST. The first revision of this guard shipped
 * with a hole of exactly the shape #4466 is about: every arm judged the CHECK
 * and nothing judged the POPULATION, so seven one-line narrowings of the
 * enumeration — `head -n 1`, a positive `grep -E`, a SECOND `grep -v` after a
 * harmless first, `grep -vF` instead of `-vE`, `sed -i '/params.il5/d'`, a
 * truncated list with `COUNT` forced to 1, and substituting `echo` for the
 * compiler — all left this guard, its whole test suite, AND the job itself
 * green while between 0 and 16 of 17 files were compiled. The primary fix is in
 * the JOB: it now reconciles the number of compiler INVOCATIONS against an
 * independently re-derived tracked count, and treats a zero-exit that produced
 * no ARM JSON as a failure. A count the job computes about its own behaviour is
 * what a one-line narrowing cannot fake. R8 below requires that reconciliation
 * to still be present; R5 and R4 are the static backstop.
 *
 * ── KEYED TO CODE, NOT TO TEXT ──────────────────────────────────────────────
 *
 * Four failure modes of a guard like this are recorded in this repo and each is
 * avoided by construction:
 *
 *   - "a guard matching RAW SOURCE is satisfied by a COMMENT" (#4467). Every
 *     match runs against {@link stripComments} output, so the three commented
 *     `build-params` mentions that motivated #4466 cannot satisfy it.
 *   - "…and by a STRING". A comment-stripped substring match is still satisfied
 *     by `echo "pretending to bicep build-params"`, which was demonstrated.
 *     {@link commandPositionMatches} requires the verb to begin a command —
 *     after a line start, `|`, `;`, `&&`, `then`, `do`, `if`, or `$(`.
 *   - "a LINE guard no-ops on CRLF" — `validate.yml` is CRLF on Windows and LF
 *     in CI, so line endings are normalised at the source.
 *   - "a guard blind to CONTINUATION lines" (#3420) — the sibling `.bicep` step
 *     in this same workflow writes `git ls-files … | grep -vE … > file` across
 *     three physical lines. {@link stripComments} folds continuations with the
 *     shared `_logical-lines.mjs` primitive first.
 *
 * The paths-filter rules (R6) are decided by GLOB-MATCHING each declared pattern
 * against each real tracked param path, never by searching for a literal
 * `**` + `/*.bicepparam`. A typo'd `…bicepparams` therefore reds instead of
 * passing a substring check.
 *
 * ── DISCLOSED LIMITS (assertion-design.md §5 — named, not counted) ───────────
 *
 *   1. SHARED LENS. {@link trackedBicepParams} and the job's own enumeration
 *      use the SAME query, `git ls-files -- ':(icase)*.bicepparam'`. A corpus
 *      that query cannot see is invisible to both by construction. The `:(icase)`
 *      magic closes the case-variant hole that was measured — a file committed
 *      as `x.BICEPPARAM` was compiled by nothing and noticed by nothing — and
 *      `git ls-files -- ':(icase)*.BICEPPARAM'` returning the same 17 files is
 *      the evidence the magic is honoured. It does NOT close a different
 *      spelling (`x.bicep-param`, a param file with no extension). Nothing here
 *      watches for that, and this guard is not evidence about it.
 *   2. R7 and R8 are EXISTENCE-ONLY. They notice deletion of the negative
 *      control and of the reconciliation; they cannot tell a working one from a
 *      declawed one. The real evidence for both is produced by the job running
 *      them on every execution. They are not counted as proof of kill power.
 *   3. THE COMPILE IS NOT A REQUIRED CONTEXT. `Bicep Params Compile` is not one
 *      of main's 15 required status checks and no ruleset requires it, so a RED
 *      compile does not block a merge today — only `guardrails`, i.e. THIS
 *      file, blocks, and this file judges the job's SHAPE, never the compile's
 *      RESULT. #4466's premise (nothing parses il5.bicepparam) is closed; the
 *      stronger claim (a broken il5.bicepparam cannot reach main) needs an
 *      operator to add the context to branch protection. Deliberately not done
 *      from here.
 *   4. WHAT NO RULE HERE CAN SEE: a change to branch protection, and a change to
 *      the workflow's `on:` verbs (removing `pull_request:` outright).
 *
 * ── OUT OF SCOPE, NAMED (#4466 "done" #3) ───────────────────────────────────
 *
 * Three other CI scripts enumerate bicep and none is widened here, because none
 * of them is a compiler:
 *   - `check-postgres-quota-gate.mjs` (`git ls-files -- '*.bicep'`) walks
 *     `module`/`param` DECLARATIONS. A `.bicepparam` declares nothing; it
 *     assigns. It already reads the two param files it cares about by name.
 *   - `check-license-inventory.mjs` and `check-upstream-image-mirror.mjs`
 *     (`platform/fiab/bicep` + `/**` + `/*.bicep`) both resolve container image
 *     references out of templates. Image TAGS do come from param files, and
 *     that axis is covered by `check-bicepparam-env-reaches-deploy.mjs` (#3161)
 *     and `check-appimagetags-coverage.mjs`, not by compilation.
 *
 * Run: node scripts/ci/check-bicepparam-compiled.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLogicalLines } from './_logical-lines.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');

/** The workflow that must carry the compile. */
export const WORKFLOW = '.github/workflows/validate.yml';

/**
 * Pathspec for the param-file population.
 *
 * Exported so the tests and the workflow can be checked against ONE spelling
 * rather than three transcriptions of it (assertion-design.md §3).
 */
export const PARAM_PATHSPEC = ':(icase)*.bicepparam';

/**
 * Sentinel the negative control assigns to a SANDBOX COPY of a param file.
 *
 * Lifted from here by the test rather than transcribed there, so a rename
 * cannot make the probe disagree with the rule.
 */
export const NEGATIVE_CONTROL_SENTINEL = 'zzzGateNegativeControlUndeclaredParam';

/** The command that actually type-checks a params file against its `using` target. */
export const COMPILE_VERB = 'build-params';

/**
 * Fold backslash continuations into logical lines, then blank `#` comments.
 *
 * TWO normalisations, both load-bearing:
 *
 *   1. LOGICAL LINES (`_logical-lines.mjs`, #3420). R4 asks whether the
 *      enumeration is `git ls-files … '*.bicepparam'`, and the sibling `.bicep`
 *      step in this very workflow writes its enumeration across THREE physical
 *      lines with backslash continuations. A physical-line reader would see
 *      `git ls-files \` with no pathspec on it and report a violation against a
 *      correct workflow — the "guard blind to continuation lines" class this
 *      repo has already measured twice.
 *   2. COMMENTS. Quote-aware: a `#` inside a single- or double-quoted run of
 *      the same logical line is left alone, so `echo "a#b"` survives while
 *      `# az bicep build-params …` does not. Erring toward NOT stripping is the
 *      safe direction — a missed strip can only make this guard stricter.
 *
 * `readLogicalLines` splits on `/\r?\n/`, so CRLF is handled at the source.
 *
 * YAML structure is unaffected — a `jobs:` key, a job id, or a `paths:` entry
 * never ends in a backslash, so nothing outside a `run:` body is ever folded,
 * and a folded line keeps the indentation of its FIRST physical line.
 *
 * @param {string} text
 * @returns {string} continuations folded, comments blanked, LF-terminated
 */
export function stripComments(text) {
  const out = [];
  for (const { text: rawLine } of readLogicalLines(text)) {
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
 * Split shell text into the fragments that can START a command.
 *
 * A command begins at a line start or after `|`, `||`, `&&`, `;`, `$(`, a
 * backtick, or one of the compound-command keywords. Everything inside a quoted
 * argument therefore lands in the MIDDLE of a fragment, which is what lets
 * {@link commandPositionMatches} tell `bicep build-params …` from
 * `echo "pretending to bicep build-params"`.
 *
 * Deliberately not a shell lexer. It is allowed to over-split (that can only
 * create extra candidate command starts, making the guard stricter about where
 * it finds the verb); it must not under-split, which is why every operator this
 * repo's workflow shell actually uses is listed.
 *
 * @param {string} text comment-stripped shell text
 * @returns {string[]}
 */
export function commandFragments(text) {
  return text.split(/\|\||&&|[|;`\n]|\$\(|\bthen\b|\bdo\b|\belif\b|\bif\b|\bwhile\b|\buntil\b|\belse\b/);
}

/**
 * Does `verb` appear at a command position anywhere in `text`?
 *
 * A fragment counts when, after dropping leading whitespace, a `!` negation and
 * any `VAR=value` prefixes, it BEGINS with the verb (optionally via `az`).
 *
 * @param {string} text comment-stripped shell text
 * @param {RegExp} verbRe anchored at the start of a fragment
 * @returns {number} how many command positions matched
 */
export function commandPositionMatches(text, verbRe) {
  let n = 0;
  for (const frag of commandFragments(text)) {
    const head = frag
      .replace(/^\s*/, '')
      .replace(/^!\s*/, '')
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '');
    if (verbRe.test(head)) n += 1;
  }
  return n;
}

/** `bicep build-params` / `az bicep build-params` at the head of a fragment. */
export const BUILD_PARAMS_HEAD = new RegExp(`^(?:az\\s+)?bicep\\s+${COMPILE_VERB}\\b`);

/** `git ls-files` at the head of a fragment. */
export const GIT_LS_FILES_HEAD = /^git\s+ls-files\b/;

/**
 * Split a job body into its steps.
 *
 * A step begins at a six-space `- ` list item. Used so R2b can ask the question
 * that actually matters — does the step that ENUMERATES also COMPILE — rather
 * than the weaker "does this job mention the verb anywhere", which the job's own
 * negative control satisfies on its own.
 *
 * @param {string} body comment-stripped job body
 * @returns {string[]}
 */
export function stepsOf(body) {
  const steps = [];
  let buf = null;
  for (const line of body.split('\n')) {
    if (/^ {6}- /.test(line)) {
      if (buf !== null) steps.push(buf.join('\n'));
      buf = [line];
      continue;
    }
    if (buf !== null) buf.push(line);
  }
  if (buf !== null) steps.push(buf.join('\n'));
  return steps;
}

/**
 * Split a workflow into its top-level jobs.
 *
 * A job starts at a two-space-indented key under `jobs:` and runs to the next
 * such key. Deliberately NOT a YAML parse: the only questions asked of the
 * result are about the file as written, including its `run:` shell bodies,
 * which a parser hands back as opaque scalars anyway.
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
 * The `paths:` list of one of the workflow's triggers.
 *
 * @param {string} text comment-stripped workflow text
 * @param {'push'|'pull_request'} trigger
 * @returns {string[]} the declared glob patterns, in order (empty = no filter)
 */
export function triggerPaths(text, trigger) {
  const lines = text.split('\n');
  const patterns = [];
  let inTrigger = false;
  let inPaths = false;
  const header = new RegExp(`^ {2}${trigger}:\\s*$`);
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) break;
    if (header.test(line)) {
      inTrigger = true;
      inPaths = false;
      continue;
    }
    if (inTrigger && /^ {2}\S/.test(line)) {
      // another top-level trigger
      inTrigger = false;
      inPaths = false;
      continue;
    }
    if (!inTrigger) continue;
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

/** Back-compat alias used by the tests and by R6's push arm. */
export const pushTriggerPaths = (text) => triggerPaths(text, 'push');

/**
 * Compile a GitHub path-filter glob to a regex.
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
        // `**/` may match zero segments, which is what makes a leading
        // double-star pattern match a repo-root file as well as a nested one.
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
 * The logical line in `body` that enumerates the param files into a list file.
 *
 * @param {string} body comment-stripped job body
 * @returns {{text:string, listPath:string|null, pathspecs:string[]}|null}
 */
export function enumerationLine(body) {
  for (const line of body.split('\n')) {
    if (!/\bgit\s+ls-files\b/.test(line)) continue;
    if (!/\.bicepparam/.test(line)) continue;
    if (!/>/.test(line)) continue;
    const m = /(?:^|[^>])>\s*(\S+)/.exec(line);
    // Strip surrounding quotes: the list path is written `> "$RUNNER_TEMP/…"`,
    // and carrying the quotes into the rewrite/redirect matchers below made
    // them look for a literal `"` that the consumer line does not have there.
    const listPath = m ? m[1].replace(/^["']|["']$/g, '') : null;
    const pathspecs = [...line.matchAll(/'([^']+)'|"([^"]+)"/g)]
      .map((q) => q[1] ?? q[2])
      .filter((s) => /\.bicepparam/i.test(s) && !/bicepparam-files/i.test(s));
    return { text: line, listPath, pathspecs };
  }
  return null;
}

/**
 * Strip git pathspec magic (`:(icase)`, `:!`, `:/`) from a pathspec.
 *
 * @param {string} spec
 * @returns {string} the glob part
 */
export function pathspecGlob(spec) {
  return spec.replace(/^:\([^)]*\)/, '').replace(/^:[!/^]*/, '');
}

/**
 * Compile a GIT PATHSPEC to a regex.
 *
 * NOT the same dialect as {@link globToRegExp}, and conflating the two is a
 * real defect that this guard hit while being written: a GitHub Actions
 * `paths:` glob treats `*` as "within one segment", but a git pathspec with no
 * `:(glob)` magic is matched by fnmatch WITHOUT `FNM_PATHNAME`, so its `*`
 * crosses `/`. That is why `git ls-files -- '*.bicepparam'` returns the nested
 * files at all. Judging a pathspec with the Actions compiler declared all 17
 * tracked files unreachable by a pathspec that demonstrably reaches them.
 *
 * `:(icase)` magic is honoured as a case-insensitive match, which is the whole
 * reason the job uses it (a `x.BICEPPARAM` was invisible to both lenses).
 *
 * @param {string} spec a git pathspec, magic included
 * @returns {RegExp}
 */
export function gitPathspecToRegExp(spec) {
  const icase = /^:\([^)]*\bicase\b[^)]*\)/.test(spec);
  const glob = pathspecGlob(spec);
  let re = '';
  for (const c of glob) {
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, icase ? 'i' : '');
}

/**
 * Commands the enumeration's logical line is allowed to be built from.
 *
 * DELIBERATELY JUST ONE. The previous revision tried to recognise the SHAPE of
 * a narrowing (`grep -vE '…'`) and was defeated by every spelling it had not
 * thought of: `grep -v il5` unquoted, `grep -vF`, a SECOND `grep -v` after a
 * harmless first (the matcher used `.exec`, so it only ever saw the first),
 * `sed '/il5/d'`, and `head -3`. Enumerating the bad shapes is a losing game;
 * enumerating the ONE good shape is not. The enumeration must be a bare
 * `git ls-files … > listfile` with no pipe and no second command.
 *
 * If a future change genuinely needs a filter there, widening this is a
 * deliberate act with a reviewer attached — which is the friction this repo
 * wants around "weakening a guard to make something green".
 */
export const ENUMERATION_EXTRA_COMMANDS = /\||&&|;|\$\(|`/;

/** Every tracked param file, repo-relative, forward-slashed. */
export function trackedBicepParams() {
  const out = execFileSync('git', ['ls-files', '--', PARAM_PATHSPEC], {
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

  // R2 — exactly one job must run build-params at a COMMAND POSITION.
  //
  // Comment-stripped is not enough: `echo "pretending to bicep build-params"`
  // satisfied the previous substring test. And "the first carrier" is not
  // enough either — a decoy job placed earlier in the file made this guard
  // judge the wrong body and miss a real exclusion in the right one.
  const carriers = [...jobs.entries()].filter(
    ([, body]) => commandPositionMatches(body, BUILD_PARAMS_HEAD) > 0,
  );
  if (carriers.length === 0) {
    const asText = [...jobs.values()].some((b) => b.includes(COMPILE_VERB));
    violations.push(
      `R2 no job in ${WORKFLOW} runs \`bicep ${COMPILE_VERB}\` at a command position — nothing compiles any .bicepparam (#4466).` +
        (asText ? ' The verb DOES occur, but only inside an argument or a string, which compiles nothing.' : ''),
    );
    return { violations, job: null, stats: { jobs: jobs.size, params: params.length } };
  }
  if (carriers.length > 1) {
    violations.push(
      `R2 ${carriers.length} jobs run \`bicep ${COMPILE_VERB}\` (${carriers.map(([n]) => n).join(', ')}). Exactly one must, or the rules below judge an arbitrary one of them and a narrowing in the other goes unexamined.`,
    );
  }
  const [job, body] = carriers[0];

  // R3 — the carrying job must be unskippable.
  //
  // WIDENED IN REVIEW. The previous version matched a job-level `if:` at four
  // spaces and the scalar `needs: changes` only. Both were escaped: an `if:` on
  // a STEP (eight spaces) skips the compile while the job stays green, and
  // `needs: [changes]` is the list spelling of the same key. Any `if:` and any
  // `needs:` anywhere in this job is now a violation, with one exception — the
  // `!cancelled()` shape, which cannot skip a step, only keep it running after
  // an earlier failure (`check-guardrails-observability.mjs` requires it
  // elsewhere in this repo, so it must stay expressible).
  for (const line of body.split('\n')) {
    const ifKey = /^\s+if:\s*(.*)$/.exec(line);
    if (ifKey && !/!\s*cancelled\(\)/.test(ifKey[1])) {
      violations.push(
        `R3 job '${job}' carries \`if:${ifKey[1]}\` — an \`if:\` at job OR step level can skip the only .bicepparam compile, and a skipped step reads as green (#4466 "done" #2). Only the \`!cancelled()\` shape is allowed.`,
      );
    }
    if (/^\s{4}needs:/.test(line)) {
      violations.push(
        `R3 job '${job}' declares \`needs:\` — any dependency makes it skippable when its dependency is skipped or path-filtered, whichever spelling (scalar or list) is used.`,
      );
    }
  }

  // R4 — the enumeration must be the tracked param population, not a hand list,
  // and its PATHSPEC must actually reach every tracked param file.
  //
  // The second half is not pedantry: a typo to `'*.bicepparams'` still contains
  // the substring `*.bicepparam`, so a substring test passes while the pathspec
  // matches nothing and the step compiles zero files. Glob-MATCHED against the
  // real population, the same way R6 judges the path filters.
  const enumeration = enumerationLine(body);
  if (!enumeration) {
    violations.push(
      `R4 job '${job}' does not enumerate with \`git ls-files … '*.bicepparam' > <list>\` — a hand-maintained list silently drops the next param file added, which is the population defect #4466 is about.`,
    );
  } else if (enumeration.pathspecs.length === 0) {
    violations.push(
      `R4 job '${job}' enumerates with \`git ls-files\` but no quoted .bicepparam pathspec could be read from it: \`${enumeration.text.trim()}\`.`,
    );
  } else {
    const res = enumeration.pathspecs.map((s) => gitPathspecToRegExp(s));
    const unreached = params.filter((p) => !res.some((re) => re.test(p)));
    if (unreached.length) {
      violations.push(
        `R4 job '${job}'s pathspec (${enumeration.pathspecs.join(', ')}) matches none of ${unreached.length} tracked param file(s): ${unreached.slice(0, 5).join(', ')}${unreached.length > 5 ? ', …' : ''}. The enumeration would hand the compiler a shorter list than the repo carries.`,
      );
    }
  }

  // R2b — the step that ENUMERATES must also COMPILE.
  //
  // R2 asks whether the job runs the verb anywhere, and this job's own negative
  // control runs it twice on a sandbox copy. So substituting `echo` for the
  // real invocation inside the compile step left R2 satisfied by the CONTROL's
  // calls while nothing compiled the repo's files. Scoping the question to the
  // step that owns the enumeration is what makes the answer mean something.
  if (enumeration) {
    const enumStep = stepsOf(body).find((s) => s.includes(enumeration.text));
    if (enumStep && commandPositionMatches(enumStep, BUILD_PARAMS_HEAD) === 0) {
      violations.push(
        `R2 the step that enumerates the param files in job '${job}' never runs \`bicep ${COMPILE_VERB}\` at a command position. Another step doing so (the negative control does, on a sandbox copy) is not the same thing: the enumerated files would reach no compiler.`,
      );
    }
  }

  // R5 — the enumeration must be a BARE `git ls-files … > file`.
  // Not "no exclusion I recognise": no pipe, no second command, at all. See
  // ENUMERATION_EXTRA_COMMANDS for why the allowlist shape replaced a
  // denylist of `grep -v` spellings.
  if (enumeration && ENUMERATION_EXTRA_COMMANDS.test(enumeration.text)) {
    violations.push(
      `R5 job '${job}' pipes or chains its enumeration into another command: \`${enumeration.text.trim()}\`. The enumeration must be a bare \`git ls-files … > <list>\` so that no filter can narrow the population. If a filter is genuinely required, widen this rule deliberately rather than around it.`,
    );
  }

  // R5b — nothing may REWRITE the list file between enumeration and use, and
  // the compile must read that same file.
  //
  // `head -n 1 list > tmp && mv tmp list` and `sed -i '/il5/d' list` both
  // narrowed the population while leaving the enumeration line pristine.
  // READS are fine and expected — the step `cat`s the list into the log and
  // `wc -l < list`s it — so this flags WRITE shapes only, and separately pins
  // that the compile consumes the file the enumeration produced rather than
  // some derived one.
  if (enumeration && enumeration.listPath) {
    const lp = enumeration.listPath;
    const WRITES = new RegExp(`(?:>>?\\s*"?${lp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?)|\\b(?:mv|cp|install|tee|truncate|dd)\\b|\\bsed\\b[^\\n]*\\s-i\\b`);
    for (const line of body.split('\n')) {
      if (!line.includes(lp)) continue;
      if (line === enumeration.text) continue;
      if (!WRITES.test(line)) continue;
      violations.push(
        `R5 job '${job}' REWRITES the enumeration's list file (${lp}) after it was written: \`${line.trim()}\`. Only the enumeration may write it — rewriting it in between is how a narrowing hides from the enumeration check.`,
      );
    }
    // The compile must consume THAT list, by redirect, not a derived one and
    // not a pipe. `head -n 1 list | xargs …` narrowed the population to one
    // file while every other static check stayed green.
    if (!new RegExp(`<\\s*"?${lp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?`).test(body)) {
      violations.push(
        `R5 job '${job}' never reads '${lp}' with a \`< ${lp}\` redirect — whatever feeds the compiler is not demonstrably the enumerated list.`,
      );
    }
    for (const line of body.split('\n')) {
      if (/\|\s*xargs\b/.test(line)) {
        violations.push(
          `R5 job '${job}' pipes into xargs: \`${line.trim()}\`. The compiler's input must be the enumerated list by redirect; a pipe lets any command in front of it narrow the population invisibly.`,
        );
      }
    }
  }

  // R6 — BOTH triggers must be able to start this workflow for a param change.
  //
  // WIDENED IN REVIEW. The previous version checked `push:` only, so adding
  // `paths: ['docs/**']` under `pull_request:` stopped the workflow on every PR
  // — this job included — completely invisibly. Absence of a `paths:` on a
  // trigger is correct and stays correct; a present one must reach every
  // tracked param file. Glob-MATCHED, never string-searched, so a typo reds.
  for (const trigger of ['push', 'pull_request']) {
    const globs = triggerPaths(text, trigger);
    if (globs.length === 0) continue; // no filter = reaches everything
    const res = globs.map((g) => ({ glob: g, re: globToRegExp(g) }));
    const unreached = params.filter((p) => !res.some(({ re }) => re.test(p)));
    if (unreached.length) {
      violations.push(
        `R6 the \`${trigger}:\` \`paths:\` filter of ${WORKFLOW} matches none of ${unreached.length} tracked param file(s): ${unreached.slice(0, 5).join(', ')}${unreached.length > 5 ? ', …' : ''}. A ${trigger} touching only those files would not start this workflow, so the compile would not run.`,
      );
    }
  }

  // R7 — the negative control must still be there.
  // EXISTENCE-ONLY, and disclosed as such in the header: it notices DELETION,
  // which is the realistic way a control that reds someone's PR disappears, and
  // it cannot tell a working control from a declawed one. Not counted as
  // evidence of kill power — the job re-establishes that on every run.
  if (!body.includes(NEGATIVE_CONTROL_SENTINEL)) {
    violations.push(
      `R7 job '${job}' no longer contains the negative control (sentinel '${NEGATIVE_CONTROL_SENTINEL}') — the compile would run with nothing establishing that it can fail (assertion-design.md §2).`,
    );
  }

  // R8 — the population reconciliation must still be there.
  //
  // This is the arm that actually defeats a narrowing, and it lives in the job
  // because only the job can count what it did. Required here in the same
  // EXISTENCE-ONLY sense as R7, and disclosed identically: it notices deletion,
  // not declawing. Three things must be present — a SECOND, independent
  // `git ls-files` of the param pathspec (not a re-read of the list file), a
  // count of the compiler invocations, and a comparison that exits non-zero.
  if (carriers.length) {
    // COMMAND POSITION, not substring — and this rule learned that the hard
    // way. The step's own `::error::` text contains the words "git ls-files"
    // and ".bicepparam", so a substring count read THREE independent
    // enumerations where there are two, and the arm that is supposed to catch
    // a reconciliation counting its own narrowed list stayed green. A guard
    // reading its own error strings as evidence is the #4467 shape one level in.
    const enumerations = body
      .split('\n')
      .filter((l) => /\.bicepparam/i.test(l) && commandPositionMatches(l, GIT_LS_FILES_HEAD) > 0).length;
    if (enumerations < 2) {
      violations.push(
        `R8 job '${job}' re-derives the tracked param count ${enumerations} time(s); it needs TWO independent \`git ls-files\` of the param pathspec — one to enumerate, one to reconcile against. Counting the list file it just wrote would agree with any narrowing of that list.`,
      );
    }
    if (!/ATTEMPTED/.test(body) || !/EXPECTED/.test(body)) {
      violations.push(
        `R8 job '${job}' has lost its population reconciliation (ATTEMPTED vs EXPECTED). Without it, seven measured one-line narrowings of the enumeration — head, a positive grep, a second grep -v, grep -vF, sed -i, a truncated list, and substituting echo for the compiler — all leave the job GREEN while it prints a file count it never established (deploy-integrity.md R7).`,
      );
    }
    // R8c — the zero-population fail-closed check. NOT redundant with the
    // reconciliation, and that was measured rather than assumed: if the corpus
    // genuinely drifts to zero, ATTEMPTED and EXPECTED are BOTH zero and the
    // reconciliation agrees with itself. Only an explicit "the population is
    // empty" arm distinguishes "nothing to do" from "nothing was done". A
    // reviewer flagged that this check was required by no rule at all, so
    // deleting it was green everywhere.
    // Keyed to the COUNT comparison specifically, not to a bare `-eq 0`: the
    // negative control in this same job legitimately writes `"$MUT_RC" -eq 0`,
    // so a loose pattern was satisfied by it and this arm was green against the
    // very mutation it names.
    if (!/COUNT"?\s+-eq\s+0\b/.test(body) || !/corpus drifted/.test(body)) {
      violations.push(
        `R8 job '${job}' has lost its zero-population fail-closed check. The reconciliation cannot cover this case — an empty corpus makes both sides of it zero — so a drifted pathspec would exit 0 having compiled nothing.`,
      );
    }
  }

  return {
    violations,
    job,
    stats: {
      jobs: jobs.size,
      params: params.length,
      carriers: carriers.length,
      pushPaths: triggerPaths(text, 'push').length,
      pullRequestPaths: triggerPaths(text, 'pull_request').length,
    },
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
      `\`bicep ${COMPILE_VERB}\` at a command position, enumerates them with a bare \`git ls-files\` and ` +
      'reconciles the compiler invocations against an independently re-derived count, carries no `if:`/`needs:` ' +
      `at any level, and is reachable by both triggers (push: ${stats.pushPaths} path pattern(s), pull_request: ` +
      `${stats.pullRequestPaths || 'no'} path filter). DISCLOSED: this checks the job's SHAPE — the compile ` +
      'itself is not a required status check, so a RED compile does not block a merge (see the header).',
  );
  return 0;
}

// Only run when invoked directly, so the tests can import the pure functions.
if (process.argv[1] && process.argv[1].endsWith('check-bicepparam-compiled.mjs')) {
  process.exit(main());
}
