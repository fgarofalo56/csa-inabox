/**
 * Self-tests for the CodeQL scan-liveness guard.
 *
 * Run: node --test scripts/ci/__tests__/codeql-scan-liveness.test.mjs
 *
 * The fixtures below are TRANSCRIBED FROM THE LIVE API on 2026-08-03, not
 * invented. That distinction has bitten this repo: a hand-written fake once
 * emitted a shape the real dependency never produces, and a deploy-breaking
 * defect shipped straight past its own guard. The two records that matter:
 *
 *   failed run -> results_count: 0,   rules_count: 0,
 *                 error: 'unsuccessful execution, exit code: 0, description:  '
 *   real run   -> results_count: 105, rules_count: 103, error: ''
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateScanLiveness,
  isRealAnalysis,
  categoryLanguage,
  parseWorkflowLanguages,
  CODEQL_WORKFLOW,
  DEFAULT_MAX_AGE_HOURS,
} from '../codeql-scan-liveness.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = { name: 'CodeQL', guid: null, version: '2.26.2' };

/** A real, completed analysis — shape copied from the live API. */
const real = (sha, at, category = '/language:javascript-typescript') => ({
  id: 1,
  ref: 'refs/heads/main',
  commit_sha: sha,
  analysis_key: '.github/workflows/codeql.yml:analyze',
  environment: '{"language":"javascript-typescript"}',
  category,
  error: '',
  created_at: at,
  results_count: 105,
  rules_count: 103,
  deletable: true,
  warning: '',
  tool: TOOL,
});

/** The failed-run upload the action makes when the job is killed mid-analysis. */
const failed = (sha, at, category = '/language:javascript-typescript') => ({
  ...real(sha, at, category),
  error: 'unsuccessful execution, exit code: 0, description:  ',
  results_count: 0,
  rules_count: 0,
});

const LANGS = ['python', 'javascript-typescript'];
const NOW = '2026-08-03T11:30:00Z';

// ---------------------------------------------------------------- CONTROLS --
// These assert invariants that hold regardless of the verdict logic, so they
// pass both with and without the fix. They exist to prove the suite is wired
// to the real module and the real workflow, not to a copy that drifted.

test('CONTROL: categoryLanguage parses the real category format', () => {
  assert.equal(categoryLanguage('/language:javascript-typescript'), 'javascript-typescript');
  assert.equal(categoryLanguage('/language:python'), 'python');
  assert.equal(categoryLanguage('trivy-image-loom-console'), null);
  assert.equal(categoryLanguage(undefined), null);
});

test('CONTROL: the guard reads its language list from the REAL workflow matrix', () => {
  const src = readFileSync(join(REPO_ROOT, CODEQL_WORKFLOW), 'utf8');
  const langs = parseWorkflowLanguages(src);
  assert.ok(langs.includes('javascript-typescript'), `expected javascript-typescript in ${JSON.stringify(langs)}`);
  assert.ok(langs.includes('python'), `expected python in ${JSON.stringify(langs)}`);
});

test('CONTROL: an empty matrix yields no languages (guard must then refuse to pass)', () => {
  assert.deepEqual(parseWorkflowLanguages('jobs:\n  analyze:\n    steps: []\n'), []);
});

test('CONTROL: both matrix forms parse, and the init step is not mistaken for one', () => {
  const inline = '    strategy:\n      matrix:\n        language: [python, javascript-typescript]\n';
  assert.deepEqual(parseWorkflowLanguages(inline).sort(), ['javascript-typescript', 'python']);

  const include =
    '    strategy:\n      matrix:\n        include:\n' +
    '          - language: python\n            analysisTimeout: 25\n' +
    '          - language: javascript-typescript\n            analysisTimeout: 90\n' +
    '    steps:\n      - with:\n          languages: ${{ matrix.language }}\n';
  assert.deepEqual(parseWorkflowLanguages(include).sort(), ['javascript-typescript', 'python']);
});

// ------------------------------------------------------- THE MASKED BODY ----
// A failed-run record must NOT be able to satisfy the guard. Both tells are
// checked independently so that neither one alone can carry the decision.

test('a failed-run upload is not a real analysis (error string set)', () => {
  assert.equal(isRealAnalysis(failed('a'.repeat(40), NOW)), false);
});

test('rules_count alone cannot vouch for a run: rules>0 with an error set is NOT real', () => {
  const sneaky = { ...real('b'.repeat(40), NOW), error: 'unsuccessful execution, exit code: 0, description:  ' };
  assert.equal(isRealAnalysis(sneaky), false);
});

test('a clean error string alone cannot vouch for a run: rules_count 0 is NOT real', () => {
  const sneaky = { ...real('c'.repeat(40), NOW), error: '', results_count: 0, rules_count: 0 };
  assert.equal(isRealAnalysis(sneaky), false);
});

test('a genuine completed analysis IS real', () => {
  assert.equal(isRealAnalysis(real('d'.repeat(40), NOW)), true);
});

// ------------------------------------------------------ THE OBSERVED BUG ----

test('THE 2026-08-03 OUTAGE: 24 failed uploads after a real scan must FAIL', () => {
  const analyses = [real('8c0b10b1', '2026-08-03T00:52:00Z'), real('py000001', '2026-08-03T10:39:34Z', '/language:python')];
  // 24 consecutive failed-run uploads, exactly as observed.
  for (let i = 0; i < 24; i++) {
    analyses.push(failed(`dead${String(i).padStart(4, '0')}`, new Date(Date.parse('2026-08-03T01:12:08Z') + i * 60_000).toISOString()));
  }

  const r = evaluateScanLiveness({ analyses, languages: LANGS, now: NOW });
  assert.equal(r.ok, false, 'a scanner that has failed 24 times running must not report OK');

  const p = r.problems.find((x) => x.language === 'javascript-typescript');
  assert.ok(p, 'expected a javascript-typescript problem');
  assert.equal(p.kind, 'scanner-failing');
  assert.match(p.why, /FROZEN at the last real scan/);
  assert.match(p.why, /8c0b10b1/);

  // Python was healthy that day and must not be swept up.
  assert.equal(r.problems.some((x) => x.language === 'python'), false, 'python was green and must stay green');

  const js = r.summary.find((s) => s.language === 'javascript-typescript');
  assert.equal(js.failedSinceLastReal, 24);
  assert.equal(js.real, 1);
});

test('the healthy case passes: newest attempt for every language is real', () => {
  const analyses = [
    real('aaaaaaaa', '2026-08-03T10:52:00Z'),
    failed('bbbbbbbb', '2026-08-01T00:00:00Z'), // an old blip, since recovered
    real('cccccccc', '2026-08-03T10:39:34Z', '/language:python'),
  ];
  const r = evaluateScanLiveness({ analyses, languages: LANGS, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.problems, null, 2));
});

test('recovery clears it: one real scan NEWER than the failures returns OK', () => {
  const analyses = [
    real('8c0b10b1', '2026-08-03T00:52:00Z'),
    failed('deadbeef', '2026-08-03T01:12:08Z'),
    real('fixedfix', '2026-08-03T11:00:00Z'), // the fix lands, analysis completes
    real('pypypypy', '2026-08-03T10:39:34Z', '/language:python'),
  ];
  const r = evaluateScanLiveness({ analyses, languages: LANGS, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.problems, null, 2));
});

test('a language that has NEVER been analyzed fails (empty != clean)', () => {
  const analyses = [real('aaaaaaaa', '2026-08-03T10:52:00Z')]; // js only, no python
  const r = evaluateScanLiveness({ analyses, languages: LANGS, now: NOW });
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.language === 'python');
  assert.equal(p.kind, 'never-analyzed');
});

test('every attempt being a failed run fails as no-real-analysis, not as "0 findings"', () => {
  const analyses = [failed('aaaaaaaa', '2026-08-03T10:52:00Z'), real('pypypypy', '2026-08-03T10:39:34Z', '/language:python')];
  const r = evaluateScanLiveness({ analyses, languages: LANGS, now: NOW });
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.language === 'javascript-typescript');
  assert.equal(p.kind, 'no-real-analysis');
  assert.match(p.why, /not clean/);
});

test('#2714 class: a real but ancient scan is stale even with no failed attempts', () => {
  const analyses = [
    real('aaaaaaaa', '2026-07-01T00:00:00Z'),
    real('pypypypy', '2026-08-03T10:39:34Z', '/language:python'),
  ];
  const r = evaluateScanLiveness({ analyses, languages: LANGS, now: NOW });
  assert.equal(r.ok, false);
  const p = r.problems.find((x) => x.language === 'javascript-typescript');
  assert.equal(p.kind, 'stale');
});

test('an idle repo inside the weekly-cron window is NOT reported stale', () => {
  const hoursAgo = (h) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
  const analyses = [
    real('aaaaaaaa', hoursAgo(DEFAULT_MAX_AGE_HOURS - 1)),
    real('pypypypy', hoursAgo(DEFAULT_MAX_AGE_HOURS - 1), '/language:python'),
  ];
  const r = evaluateScanLiveness({ analyses, languages: LANGS, now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r.problems, null, 2));
});

test('non-CodeQL tools (Trivy, checkov) are ignored, not counted as coverage', () => {
  const trivy = {
    ...real('aaaaaaaa', '2026-08-03T10:55:27Z'),
    category: 'trivy-image-loom-console',
    tool: { name: 'Trivy', guid: null, version: '0.69.3' },
  };
  const r = evaluateScanLiveness({ analyses: [trivy], languages: LANGS, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2, 'a Trivy upload must not stand in for either CodeQL language');
});
