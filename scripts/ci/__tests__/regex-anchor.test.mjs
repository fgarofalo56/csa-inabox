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
import {
  topLevelAlternatives,
  anchorsOf,
  mixesAnchors,
  isPredicateUse,
  isSecretVocabulary,
  regexLiteralsOn,
  scanSource,
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
