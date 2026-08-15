/**
 * regex-anchor guard tests.
 *
 * The guard exists because `/password|secret|key$/i` READS as "contains
 * password, secret or key" and PARSES as `password` OR `secret` OR `key$` —
 * only the last alternative anchored. That put connection secrets into Cosmos
 * in plaintext (#2772), and two more copies of the same shape were still live
 * in env-config.ts and honest-gate.tsx when this guard was written.
 *
 * MUTATION-PROVEN (counts in the PR body): restoring either of those two
 * regexes turns the repo-wide guard RED naming that exact file and line — 2
 * violations for 2 mutations, 0 after restore.
 *
 * The CONTROL rows below matter at least as much. Run without the
 * secret-vocabulary condition the guard finds EIGHT sites and SIX are correct
 * by design (YAML quoting, git ref rules, language sniffing). Those must stay
 * GREEN in both directions or the guard is noise, and noise gets deleted.
 *
 * Run: node --test scripts/ci/__tests__/regex-anchor.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  topLevelAlternatives,
  anchorsOf,
  mixesAnchors,
  isPredicateUse,
  isSecretVocabulary,
  regexLiteralsOn,
  scanSource,
  runControls,
  REDOS_FIXTURES,
  REDOS_BUDGET_MS,
} from '../check-regex-anchor.mjs';

/* --------------------------- alternation split --------------------------- */

test('splits on top-level | only', () => {
  assert.deepEqual(topLevelAlternatives('password|secret|key$'), ['password', 'secret', 'key$']);
});

test('does NOT split inside a group — that is a different scope', () => {
  assert.deepEqual(topLevelAlternatives('(^|_)name$'), ['(^|_)name$']);
});

test('does NOT split inside a character class', () => {
  assert.deepEqual(topLevelAlternatives('[a|b]c'), ['[a|b]c']);
});

test('does NOT split on an escaped pipe', () => {
  assert.deepEqual(topLevelAlternatives('a\\|b'), ['a\\|b']);
});

/* ------------------------------- anchoring ------------------------------- */

test('recognises start and end anchors', () => {
  assert.deepEqual(anchorsOf('^abc'), { start: true, end: false });
  assert.deepEqual(anchorsOf('abc$'), { start: false, end: true });
  assert.deepEqual(anchorsOf('^abc$'), { start: true, end: true });
  assert.deepEqual(anchorsOf('abc'), { start: false, end: false });
});

test('an ESCAPED dollar is a literal, not an anchor', () => {
  assert.deepEqual(anchorsOf('cost\\$'), { start: false, end: false });
  // …and an escaped backslash before a real anchor still anchors.
  assert.deepEqual(anchorsOf('path\\\\$'), { start: false, end: true });
});

/* ------------------------------ mixing rule ------------------------------ */

test('THE BUG: some alternatives anchored, others not', () => {
  assert.equal(mixesAnchors('password|secret|key$'), true);
  assert.equal(mixesAnchors('SECRET|PASSWORD|_KEY$|_KEYS$|_PWD$|TOKEN$'), true);
});

test('CONTROL: a single alternative can never mix', () => {
  assert.equal(mixesAnchors('^_+$'), false);
  assert.equal(mixesAnchors('secret'), false);
});

test('CONTROL: the edge-trim idiom is consistently anchored, not mixed', () => {
  // `.replace(/^_+|_+$/g, '')` appears ~30 times in this repo and is CORRECT.
  assert.equal(mixesAnchors('^_+|_+$'), false);
  assert.equal(mixesAnchors('^"|"$'), false);
});

test('CONTROL: every alternative unanchored is consistent', () => {
  assert.equal(mixesAnchors('password|secret|key'), false);
});

test('grouping the alternation is the fix, and reads as unmixed', () => {
  assert.equal(mixesAnchors('^(?:password|secret|key)$'), false);
});

/* ---------------------------- predicate scoping --------------------------- */

test('a predicate use is .test / .match / new RegExp', () => {
  assert.equal(isPredicateUse('if (/a|b$/.test(x)) return;'), true);
  assert.equal(isPredicateUse('const m = s.match(/a|b$/);'), true);
  assert.equal(isPredicateUse('new RegExp(src)'), true);
});

test('CONTROL: a .replace() rewrite is not a predicate', () => {
  assert.equal(isPredicateUse("s.replace(/^_+|_+$/g, '')"), false);
});

/* --------------------------- vocabulary scoping --------------------------- */

test('secret vocabulary is what makes a mixed anchor a security bug', () => {
  assert.equal(isSecretVocabulary('SECRET|PASSWORD|_KEY$'), true);
  assert.equal(isSecretVocabulary('password|secret|key$'), true);
  assert.equal(isSecretVocabulary('SECRET|PASSWORD|_KEY$|_KEYS$|_PWD$|TOKEN$'), true);
});

test('CONTROL: the six correct mixed-anchor regexes in this repo are NOT secret predicates', () => {
  // YAML quoting — contains a special char, OR starts/ends with space, OR empty.
  assert.equal(isSecretVocabulary("[:#\\-?{}[\\],&*!|>'\"%@`]|^\\s|\\s$|^$"), false);
  // git ref rules — contains '..', OR ends '.lock', OR starts '.'.
  assert.equal(isSecretVocabulary('\\.\\.|@\\{|[~^:?*[\\\\]|\\/\\/|\\.lock$|^\\.|\\/$'), false);
  // language sniffing.
  assert.equal(isSecretVocabulary('sparkr|^r$|\\br\\b'), false);
  // column-name sniffing.
  assert.equal(isSecretVocabulary('full.?name|(^|_)name$'), false);
});

/* -------------------------------- scanning -------------------------------- */

test('regexLiteralsOn finds the body between the delimiters', () => {
  assert.deepEqual(regexLiteralsOn('return /a|b$/i.test(k);'), ['a|b$']);
});

test('END TO END: the #2772 regex is flagged', () => {
  const hits = scanSource('function f(n){ return /password|secret|key$/i.test(n); }\n', 'x.ts');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('END TO END CONTROL: the YAML-quoting predicate is NOT flagged', () => {
  const src = "const needsQuote = /[:#\\-?{}[\\],&*!|>'\"%@`]|^\\s|\\s$|^$/.test(s);\n";
  assert.deepEqual(scanSource(src, 'y.ts'), []);
});

test('END TO END CONTROL: the trim idiom is NOT flagged', () => {
  assert.deepEqual(scanSource("const s = raw.replace(/^_+|_+$/g, '');\n", 'z.ts'), []);
});

test('END TO END CONTROL: a comment describing the bug is NOT flagged', () => {
  assert.deepEqual(scanSource('// was /password|secret|key$/i.test(n) — the #2772 bug\n', 'c.ts'), []);
});

/* ------------------------- ReDoS in the guard (#3488) ------------------------ */
/*
 * regexLiteralsOn was itself a ReDoS — CodeQL #757/#758, HIGH — because two of
 * its alternations were AMBIGUOUS: `[^\]]` also matched a backslash that `\\.`
 * could take, and `[^/\\\n]` also matched a `[` that the bracket branch could
 * take. Two branches over the same character means the engine must try every
 * partition before it may fail, which is exponential.
 *
 * Measured on the shipped regex: '/' + '[]'x26 took 5.3s and x28 ran past 20s;
 * '/[' + '\'x42 took 19.1s. Through scanSource() a 100-character line cost 6.9s.
 * This guard runs in loom-guardrails on every PR.
 *
 * It was not hypothetical: lib/coe-library/templates-content.ts carries 56 lines
 * of embedded escaped JSON, INSIDE the guard's scan population, that the old
 * regex could not finish (>4s each, killed). CI stayed green only because
 * scanSource() skips lines with no `.test(` / `.match(` / `new RegExp` on them.
 *
 * EVERY TEST IN THIS SECTION MUST FAIL IN BOUNDED TIME, NOT HANG. That is not a
 * nicety. `loom-guardrails.yml` runs the guard step and `node --test
 * scripts/ci/__tests__/*.test.mjs` in the SAME job, every step carries
 * `if: ${{ !cancelled() }}`, and the job's budget is `timeout-minutes: 25`. So a
 * test file that hangs does not stop at the guard's ~10s failure — it burns the
 * whole 25 minutes, and GitHub reports the kill as `cancelled`, which in a run
 * list reads like "superseded by a newer push" rather than "this job died".
 * The workflow says so in its own comment above that timeout.
 *
 * The first cut of this section got that wrong: it asserted on
 * `'[]'.repeat(100000)`, which is catastrophic on ANY regressed variant, and
 * node:test's default reporter buffers per file — so against a regressed regex
 * the run produced ZERO per-test output and was still going at 120s. The two
 * budget assertions that DID fail never printed. Only sizes near the control's
 * own fixtures are "over budget but finite"; anything larger is a hang, so the
 * large-input case now runs in a child process under a hard timeout.
 *
 * The fixed regex answers each fixture in ~0.05ms, so the budget sits four
 * orders of magnitude clear of runner noise, and the fixture sizes are picked so
 * that a REGRESSED regex costs ~1-2.5s each — detectable, not a hung job.
 */

test('THE #3488 BUG: the CodeQL fixtures answer well inside the budget', () => {
  for (const f of REDOS_FIXTURES) {
    const t0 = process.hrtime.bigint();
    regexLiteralsOn(f.input);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < REDOS_BUDGET_MS, `${f.why}: ${ms.toFixed(0)}ms exceeds ${REDOS_BUDGET_MS}ms budget`);
  }
});

test('the fixtures must FAIL to match — a fixture that matches proves nothing', () => {
  // Catastrophic backtracking is the cost of the FAILING search. A fixture with
  // a closing '/' in it returns fast on the BROKEN regex too, so it would pass
  // the timing test while measuring nothing. All three must find zero.
  for (const f of REDOS_FIXTURES) {
    assert.deepEqual(regexLiteralsOn(f.input), [], f.why);
  }
});

test('there is one fixture per disjointness property, and there are THREE', () => {
  // The outer catch-all excludes BOTH '[' and '\'. The first cut of this control
  // covered only two of the three properties, and a mutant that dropped just the
  // outer backslash exclusion was MISSED — runControls() returned [] in 0ms
  // against an exponential regex. Each fixture only catches its own property:
  // #757's input is unambiguous once the '[' rule is in place, so it cannot see
  // an inner-only regression, and neither of the first two can see this one.
  assert.equal(REDOS_FIXTURES.length, 3);
});

test('the crafted input scales: 100k repetitions still returns promptly', () => {
  // IN A CHILD PROCESS, UNDER A HARD TIMEOUT. A 200k-char catastrophic input
  // cannot be interrupted from inside this process, so asserting on it in-process
  // turns a regression into a 25-minute job timeout reported as `cancelled`
  // instead of a test failure. spawnSync kills the child and we assert on that.
  //
  // The backslash payload is built with String.fromCharCode(92) so nothing has to
  // survive escaping through the -e argument.
  const url = new URL('../check-regex-anchor.mjs', import.meta.url).href;
  const code = `
    import(${JSON.stringify(url)}).then((m) => {
      m.regexLiteralsOn('/' + '[]'.repeat(100000));
      m.regexLiteralsOn('/[' + String.fromCharCode(92).repeat(100000));
      m.regexLiteralsOn('/' + String.fromCharCode(92).repeat(100000));
      process.exit(0);
    }).catch((e) => { console.error(e); process.exit(2); });
  `;
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, ['-e', code], { timeout: 20000, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  assert.equal(r.signal, null, `killed by the ${20000}ms timeout after ${ms.toFixed(0)}ms — 200k-char inputs did not return, so regexLiteralsOn is backtracking again`);
  assert.equal(r.status, 0, `child exited ${r.status}: ${r.stderr}`);
});

test('the embedded control passes on the shipped implementation', () => {
  assert.deepEqual(runControls(), []);
});

/* ------------------ #3488 behaviour: '[' always opens a class ---------------- */

test('DOCUMENTED CHANGE: an UNTERMINATED "[" now yields nothing', () => {
  // `[` no longer falls through to the outer catch-all, so it can only open a
  // character class. `/a[b/` therefore extracts NOTHING where it used to
  // extract `a[b`. That text is not a regex literal JS can parse either — the
  // class is never closed — so the only place it can occur is a comment or a
  // string, which is exactly where the old behaviour produced a junk "body".
  assert.deepEqual(regexLiteralsOn('if (/a[b/.test(s)) f();'), []);
  // The real shapes this shows up on in this repo: doc comments spelling out a
  // REST path with an optional segment.
  assert.deepEqual(regexLiteralsOn(' *   - Knowledge sources:  GET/PUT/DELETE /knowledgesources[/{name}]'), ['PUT']);
});

test('CONTROL: a TERMINATED class is unaffected — every real literal still parses', () => {
  assert.deepEqual(regexLiteralsOn('if (/[abc]+/.test(s)) f();'), ['[abc]+']);
  assert.deepEqual(regexLiteralsOn('if (/[a-z]|[0-9]$/.test(s)) f();'), ['[a-z]|[0-9]$']);
  // A '/' inside a character class does NOT close the literal.
  assert.deepEqual(regexLiteralsOn('if (/[/]x/.test(s)) f();'), ['[/]x']);
  // An escaped ']' inside the class does not close it either.
  assert.deepEqual(regexLiteralsOn('if (/[a\\]b]/.test(s)) f();'), ['[a\\]b]']);
  // A '[' inside a class is an ordinary character.
  assert.deepEqual(regexLiteralsOn('if (/[[\\]]/.test(s)) f();'), ['[[\\]]']);
  // An ESCAPED bracket outside a class is consumed by `\\.`, not by the class.
  assert.deepEqual(regexLiteralsOn('if (/\\[a\\]/.test(s)) f();'), ['\\[a\\]']);
});

test('CONTROL: the #2772 verdict is unchanged by the ReDoS fix', () => {
  // The whole point of the guard. Behaviour parity was also measured across the
  // tree: 4089 files / 1,045,200 lines in the guard's population, 0 files whose
  // scanSource() verdict differs before vs after.
  const hits = scanSource('function f(n){ return /password|secret|key$/i.test(n); }\n', 'x.ts');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].body, 'password|secret|key$');
});
