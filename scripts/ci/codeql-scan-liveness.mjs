#!/usr/bin/env node
/**
 * CodeQL scan-liveness guard — "the scanner ran" is not "the scanner analyzed".
 *
 * WHY THIS EXISTS. On 2026-08-03 six js/log-injection alerts were still open on
 * main after #2850 had demonstrably fixed all six call sites. They were not
 * open findings. The SCAN was dead:
 *
 *   - The last JS/TS analysis that evaluated anything was 8c0b10b1 (00:52Z),
 *     `results_count: 105, rules_count: 103`.
 *   - From 8022cec6 (01:12Z) onward, 24 CONSECUTIVE JS/TS analyses reported
 *     `results_count: 0, rules_count: 0`.
 *   - Cause: `Security/CWE-912/HttpToFileAccess.ql` went from 22.4s at 8c0b10b1
 *     to >17m56s and never finished, so query 105/105 was still running when
 *     `timeout-minutes: 30` killed the job.
 *   - On that timeout the CodeQL action runs
 *     `codeql database export-diagnostics --output=../codeql-failed` and uploads
 *     `codeql-failed-run.sarif`. GitHub records it as an analysis, correctly
 *     REFUSES to retire alerts from it ("Analysis upload status is failed"),
 *     and the alert list silently freezes at the last real scan.
 *   - The run conclusion is `cancelled`, not `failure`, and CodeQL is not a
 *     required check — so nothing blocked, nothing paged, and for ~10 hours
 *     every merge (including four security PRs) landed unscanned while the
 *     alert list still looked authoritative.
 *
 * That is this repo's dominant defect once more: a control that runs, reports,
 * and establishes nothing. #2714 already fixed a version of this by widening
 * the push path filter so main would re-analyze after a TypeScript merge — but
 * it only made the workflow TRIGGER. It never checked that the analysis
 * COMPLETED. This guard closes that gap.
 *
 * THE RULE, and why it is activity-independent.
 *   Do not ask "is the newest analysis recent?" — on an idle repo that yields
 *   false alarms, which is how a guard gets switched off. Ask instead:
 *
 *     Is the NEWEST ATTEMPT for this language a REAL analysis?
 *
 *   If attempts exist that are newer than the newest real analysis, the scanner
 *   is running and failing. That is exactly the observed failure mode and it
 *   holds whether the repo saw 1 push or 100. A stale-age backstop is kept as a
 *   secondary check for the "never triggered at all" class (#2714's).
 *
 * WHAT COUNTS AS REAL. Verified against the live API on 2026-08-03, not assumed
 * — the failed-run record carries TWO independent tells, and this guard demands
 * both, so neither a changed error string nor a future 0-rule real analysis can
 * quietly satisfy it:
 *
 *   failed run:  { results_count: 0, rules_count: 0,
 *                  error: 'unsuccessful execution, exit code: 0, description:  ' }
 *   real run:    { results_count: 105, rules_count: 103, error: '' }
 *
 * Usage:
 *   node scripts/ci/codeql-scan-liveness.mjs [--repo owner/name] [--ref refs/heads/main]
 *                                            [--max-age-hours 192] [--json]
 *
 * Requires `gh` authenticated with `security-events: read` on the repo.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
export const CODEQL_WORKFLOW = '.github/workflows/codeql.yml';

/** Weekly cron is '37 3 * * 1', so 7 days + a day of slack before we cry wolf. */
export const DEFAULT_MAX_AGE_HOURS = 192;

/**
 * A CodeQL job that dies mid-run still uploads a SARIF, and GitHub still lists
 * it as an analysis. Both tells must be clean for it to count as a real scan.
 */
export function isRealAnalysis(a) {
  if (!a || typeof a !== 'object') return false;
  if (typeof a.error === 'string' && a.error.trim() !== '') return false;
  return Number(a.rules_count) > 0;
}

/** `/language:javascript-typescript` -> `javascript-typescript`. */
export function categoryLanguage(category) {
  if (typeof category !== 'string') return null;
  const m = /^\/language:(.+)$/.exec(category.trim());
  return m ? m[1] : null;
}

/**
 * Languages the CodeQL workflow actually analyzes, read from its matrix, so
 * adding a language cannot silently escape this guard.
 *
 * Handles BOTH matrix forms, because the workflow uses each at different times:
 *   matrix:
 *     language: [python, javascript-typescript]      # inline list
 * and
 *     include:
 *       - language: python                            # per-entry, with knobs
 *         analysisTimeout: 25
 *
 * Deliberately does NOT match `languages: ${{ matrix.language }}` on the init
 * step: that key is plural, and the value starts with `$`.
 */
export function parseWorkflowLanguages(src) {
  if (typeof src !== 'string') return [];
  const found = [];

  const inline = /^\s*language:\s*\[([^\]]+)\]\s*$/m.exec(src);
  if (inline) {
    for (const part of inline[1].split(',')) {
      const v = part.trim().replace(/^['"]|['"]$/g, '');
      if (v) found.push(v);
    }
  }

  for (const m of src.matchAll(/^\s*-?\s*language:\s*(['"]?)([A-Za-z][\w.+-]*)\1\s*$/gm)) {
    found.push(m[2]);
  }

  return [...new Set(found)];
}

/**
 * @param {object} o
 * @param {Array} o.analyses    raw code-scanning analyses (any tool, any category)
 * @param {string[]} o.languages required languages, e.g. ['python','javascript-typescript']
 * @param {number} [o.maxAgeHours]
 * @param {Date|string|number} [o.now]
 * @returns {{ok: boolean, problems: Array, summary: Array}}
 */
export function evaluateScanLiveness({ analyses, languages, maxAgeHours = DEFAULT_MAX_AGE_HOURS, now = Date.now() }) {
  const nowMs = new Date(now).getTime();
  const problems = [];
  const summary = [];

  const codeql = (Array.isArray(analyses) ? analyses : []).filter(
    (a) => a && a.tool && a.tool.name === 'CodeQL',
  );

  for (const language of languages) {
    const forLang = codeql
      .filter((a) => categoryLanguage(a.category) === language)
      .sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime());

    if (forLang.length === 0) {
      problems.push({
        language,
        kind: 'never-analyzed',
        why:
          `no CodeQL analysis has EVER been recorded for '${language}' on this ref.\n` +
          `    The workflow matrix lists it, so either the job never ran or every\n` +
          `    upload was rejected. Alerts for this language are meaningless.`,
      });
      summary.push({ language, attempts: 0, real: 0 });
      continue;
    }

    const newest = forLang[0];
    const newestReal = forLang.find(isRealAnalysis);
    // Attempts newer than the last real scan == the scanner is running and failing.
    const deadSince = newestReal
      ? forLang.filter((a) => new Date(a.created_at).getTime() > new Date(newestReal.created_at).getTime())
      : forLang;

    summary.push({
      language,
      attempts: forLang.length,
      real: forLang.filter(isRealAnalysis).length,
      newestAttempt: { sha: String(newest.commit_sha || '').slice(0, 8), at: newest.created_at, real: isRealAnalysis(newest) },
      newestReal: newestReal
        ? { sha: String(newestReal.commit_sha || '').slice(0, 8), at: newestReal.created_at, rules: newestReal.rules_count }
        : null,
      failedSinceLastReal: deadSince.length,
    });

    if (!newestReal) {
      problems.push({
        language,
        kind: 'no-real-analysis',
        why:
          `every recorded analysis for '${language}' is a FAILED-RUN upload\n` +
          `    (rules_count: 0 / error set). ${forLang.length} attempt(s), 0 real scans.\n` +
          `    Nothing has been evaluated, so the alert list for this language is empty\n` +
          `    by construction — not clean.`,
      });
      continue;
    }

    if (!isRealAnalysis(newest)) {
      const err = String(newest.error || '').trim() || '(no error string)';
      problems.push({
        language,
        kind: 'scanner-failing',
        why:
          `the newest '${language}' analysis is a FAILED-RUN upload, not a scan.\n` +
          `    newest attempt : ${String(newest.commit_sha || '').slice(0, 8)} at ${newest.created_at}\n` +
          `                     results_count=${newest.results_count} rules_count=${newest.rules_count}\n` +
          `                     error="${err}"\n` +
          `    last REAL scan : ${String(newestReal.commit_sha || '').slice(0, 8)} at ${newestReal.created_at}\n` +
          `                     (rules_count=${newestReal.rules_count})\n` +
          `    ${deadSince.length} attempt(s) have failed since that last real scan.\n` +
          `    GitHub does NOT retire alerts from a failed run, so the alert list is\n` +
          `    FROZEN at the last real scan and reads as current. Every merge since is\n` +
          `    unscanned. Check the 'Perform CodeQL Analysis' step: a single query that\n` +
          `    stops terminating will burn the job timeout and land exactly here.`,
      });
      continue;
    }

    const ageHours = (nowMs - new Date(newestReal.created_at).getTime()) / 3_600_000;
    if (ageHours > maxAgeHours) {
      problems.push({
        language,
        kind: 'stale',
        why:
          `the newest REAL '${language}' scan is ${ageHours.toFixed(1)}h old (limit ${maxAgeHours}h).\n` +
          `    ${String(newestReal.commit_sha || '').slice(0, 8)} at ${newestReal.created_at}.\n` +
          `    Even the weekly cron should beat this, so the workflow is probably not\n` +
          `    triggering — the class #2714 fixed by widening the push path filter.`,
      });
    }
  }

  return { ok: problems.length === 0, problems, summary };
}

// ------------------------------------------------------------------ CLI ----
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fetchAnalyses(repo, ref) {
  const out = execFileSync(
    'gh',
    ['api', '--paginate', `repos/${repo}/code-scanning/analyses?ref=${encodeURIComponent(ref)}&per_page=100`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // `gh --paginate` concatenates pages as separate JSON arrays when they are not
  // merged; normalise both shapes rather than assume one.
  const parsed = JSON.parse(out.trim().replace(/\]\s*\[/g, ','));
  return Array.isArray(parsed) ? parsed : [];
}

function main() {
  const repo = arg('repo', process.env.GITHUB_REPOSITORY || 'fgarofalo56/csa-inabox');
  const ref = arg('ref', 'refs/heads/main');
  const maxAgeHours = Number(arg('max-age-hours', String(DEFAULT_MAX_AGE_HOURS)));

  let languages = [];
  try {
    languages = parseWorkflowLanguages(readFileSync(join(REPO_ROOT, CODEQL_WORKFLOW), 'utf8'));
  } catch {
    /* fall through to the explicit failure below */
  }
  if (languages.length === 0) {
    console.error(
      `[codeql-liveness] FAIL — could not read the analyzed languages from ${CODEQL_WORKFLOW}.\n` +
        '    Without them this guard would check nothing and pass, which is the exact\n' +
        '    defect it exists to prevent.',
    );
    process.exit(1);
  }

  let analyses;
  try {
    analyses = fetchAnalyses(repo, ref);
  } catch (e) {
    // "Could not check" is NOT "nothing wrong". Fail, and say which it was.
    console.error(
      `[codeql-liveness] FAIL — could not read code-scanning analyses for ${repo} ${ref}.\n` +
        `    ${String(e && e.message ? e.message : e).split('\n')[0]}\n` +
        "    This needs `gh` authenticated with 'security-events: read'. An unreadable\n" +
        '    API and a healthy scanner look identical from here, so this exits non-zero.',
    );
    process.exit(1);
  }

  const result = evaluateScanLiveness({ analyses, languages, maxAgeHours });

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  }

  for (const s of result.summary) {
    const real = s.newestReal ? `${s.newestReal.sha} @ ${s.newestReal.at} (rules=${s.newestReal.rules})` : 'NONE';
    console.log(
      `[codeql-liveness] ${s.language}: ${s.attempts} attempt(s), ${s.real} real; last real = ${real}; ` +
        `failed since = ${s.failedSinceLastReal ?? 0}`,
    );
  }

  if (result.ok) {
    console.log(`[codeql-liveness] OK — every analyzed language has a real, current scan on ${ref}.`);
    process.exit(0);
  }

  console.error(`\n[codeql-liveness] FAIL — ${result.problems.length} problem(s).\n`);
  for (const p of result.problems) {
    console.error(`  ${p.language} [${p.kind}]`);
    console.error(`    ${p.why}\n`);
  }
  console.error('  The alert list for the affected language(s) is STALE, not clean.');
  console.error('  Do not triage code-scanning alerts until this is green again.\n');
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
