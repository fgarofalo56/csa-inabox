#!/usr/bin/env node
/**
 * regex-anchor guard — bans a MIXED-ANCHOR alternation in a security predicate.
 *
 * WHY THIS EXISTS. `/password|secret|key$/i` reads as "contains password,
 * secret or key". It does not. Alternation binds looser than the anchor, so it
 * parses as `password` OR `secret` OR `key$` — only the LAST alternative is
 * end-anchored. `sslKeyPem`, `privateKeyPem` and `keyData` therefore failed the
 * secret test and were persisted to Cosmos in PLAINTEXT (#2772).
 *
 * The regex was not wrong-looking. It was wrong-PARSING, and it read correctly
 * to every reviewer for as long as it shipped. That is the whole reason this is
 * a guard and not a code-review note.
 *
 * WHAT IS FLAGGED: a regex literal whose TOP-LEVEL alternation mixes anchored
 * and unanchored alternatives, is used as a predicate (`.test(` / `.match(` /
 * `new RegExp`), AND asks about SECRET-ness. All three conditions matter — see
 * `isSecretVocabulary` for why the third one is what keeps this guard alive.
 * Either anchor every alternative or group them:
 *
 *     BAD   /password|secret|key$/i          -> key$ only
 *     OK    /^(?:password|secret|key)$/i     -> the group is anchored
 *     OK    /password|secret|key/i           -> all unanchored, consistently
 *     BEST  word-split + a Set               -> lib/util/secret-prop-name.ts
 *
 * WHAT IS NOT FLAGGED, deliberately:
 *   - `.replace(/^_+|_+$/g, '')` and friends. Every alternative IS anchored
 *     (one at the start, one at the end) — that is the standard edge-trim
 *     idiom, it is not a predicate, and flagging ~30 correct call sites is how
 *     a guard earns an `--ignore` flag and stops meaning anything.
 *   - test files. A test may legitimately PIN a historically broken pattern as
 *     a negative fixture; `lib/util/__tests__/secret-prop-name.test.ts` does
 *     exactly that, on purpose, and it is the reason #2772 cannot silently
 *     come back.
 *   - comments.
 *
 * Usage:
 *   node scripts/ci/check-regex-anchor.mjs              # CHECK
 *   node scripts/ci/check-regex-anchor.mjs --self-test  # embedded controls only
 *
 * Tests: node --test scripts/ci/__tests__/regex-anchor.test.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const SCAN = [
  { dir: 'apps/fiab-console/lib', exts: ['.ts', '.tsx'] },
  { dir: 'apps/fiab-console/app', exts: ['.ts', '.tsx'] },
  { dir: 'apps/loom-cli/src', exts: ['.ts'] },
];

const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', '__tests__', '__mocks__', 'coverage']);

/**
 * Split a regex body on TOP-LEVEL `|` only — alternation inside a group is a
 * different scope and is not what bites. Escapes and character classes are
 * tracked so `[a|b]` and `\|` do not split.
 *
 * @param {string} body regex source between the delimiters
 * @returns {string[]} top-level alternatives
 */
export function topLevelAlternatives(body) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '\\') { cur += c + (body[i + 1] ?? ''); i += 1; continue; }
    if (inClass) { cur += c; if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; cur += c; continue; }
    if (c === '(') { depth += 1; cur += c; continue; }
    if (c === ')') { depth -= 1; cur += c; continue; }
    if (c === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * Classify one alternative's anchoring. `\$` is a literal dollar, not an
 * anchor, and `topLevelAlternatives` preserves the escape so this can tell.
 *
 * @param {string} alt
 * @returns {{start: boolean, end: boolean}}
 */
export function anchorsOf(alt) {
  const start = /^\^/.test(alt);
  // Trailing '$' that is NOT escaped: count preceding backslashes.
  let end = false;
  if (alt.endsWith('$')) {
    let bs = 0;
    for (let i = alt.length - 2; i >= 0 && alt[i] === '\\'; i -= 1) bs += 1;
    end = bs % 2 === 0;
  }
  return { start, end };
}

/**
 * True when a regex body mixes anchored and unanchored top-level alternatives.
 *
 * A single alternative can never mix, so it is never a hit. When EVERY
 * alternative carries some anchor the author was consistent — that includes the
 * `^_+|_+$` trim idiom, where the two alternatives are anchored at opposite
 * ends and the intent is unambiguous.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function mixesAnchors(body) {
  const alts = topLevelAlternatives(body);
  if (alts.length < 2) return false;
  const flags = alts.map(anchorsOf);
  const anchored = flags.filter((f) => f.start || f.end).length;
  return anchored > 0 && anchored < flags.length;
}

/**
 * Is this regex used as a PREDICATE on the same line? A mixed-anchor regex fed
 * to `.replace()` changes what is rewritten; fed to `.test()` it changes a
 * security DECISION. Both are bugs, but only the second has produced a leak in
 * this repo, and scoping the guard to predicates is what keeps it credible.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isPredicateUse(line) {
  return /\.test\s*\(/.test(line) || /\.match\s*\(/.test(line) || /\bnew RegExp\b/.test(line);
}

/**
 * Regex literals on a line: `/…/flags`, skipping `//` comments and division.
 *
 * THE ALTERNATIVES HERE MUST STAY MUTUALLY EXCLUSIVE. Until #3488 they were not,
 * and this line was a ReDoS (CodeQL #757/#758, js/redos, HIGH) in the guard whose
 * entire job is policing regexes:
 *
 *   outer  `[^/\\\n]` also matched `[`, so a `[` could open the bracket branch
 *          OR be swallowed by the catch-all               -> #757
 *   inner  `[^\]]`    also matched `\`, so a `\` could be taken by `\\.`
 *          OR by the catch-all                            -> #758
 *
 * Two branches that can consume the same character force the engine to try every
 * partition before it may fail, which is exponential. Measured on the shipped
 * regex, one line, Node v24.18:
 *
 *   '/' + '[]'xN     N=20 91ms   N=24 1.4s   N=26 5.3s   N=28 >20s
 *   '/[' + '\'xN     N=30 51ms   N=38 2.4s   N=42 19.1s  N=46 >20s
 *
 * A 100-character line cost 6.9s through scanSource(); four characters more ran
 * past 25s. This guard runs in loom-guardrails on every PR, so any file added
 * under SCAN could have hung the job indefinitely.
 *
 * AND THE TREE ALREADY CARRIED THE PAYLOAD. `lib/coe-library/templates-content.ts`
 * line 25 is 1878 characters of embedded escaped JSON, inside SCAN, and the old
 * regex never finished it (>120s, killed). CI stayed green only because
 * scanSource() skips a line with no `.test(` / `.match(` / `new RegExp` on it, so
 * regexLiteralsOn was never reached. Prefixing that one real line with `x.test(y);`
 * hung the guard. The margin was a substring, not a design.
 *
 * The fix removes the overlap rather than capping length or adding a timeout:
 * `[^\]]` -> `[^\]\\]` makes `\\.` the only way to consume a backslash, and
 * `[^/\\\n]` -> `[^/\\\n\[]` makes the bracket branch the only way to consume a
 * `[`. Every branch is now selected by the next character alone, so the scan is
 * deterministic. Same inputs, N=100000: 1.2ms.
 *
 * DELIBERATE SEMANTIC CHANGE. Excluding `[` from the catch-all means an
 * UNTERMINATED `[` no longer falls through to it, so `/a[b/` yields nothing where
 * it used to yield `a[b`. In a real regex literal `[` always opens a character
 * class, so a literal with an unterminated one does not parse in JS either — the
 * new behaviour is the more correct one. It only differs on text that was never a
 * regex literal, and it is pinned by a test.
 *
 * MEASURED, not assumed, over MAIN's tree at the time of the fix (corpus from
 * `git ls-files`; the count is self-referential, because this file and its test
 * now carry `[`-bearing examples that themselves differ, so the tree has to be
 * named):
 *   - the guard's VERDICT is unchanged — 4089 files / 1,045,200 lines in SCAN,
 *     0 files whose scanSource() result differs;
 *   - across 6252 files / 1,411,660 lines, regexLiteralsOn differs on 79, and a
 *     variant carrying ONLY the inner fix differs on 0 — which attributes every
 *     one of those 79 to the `[` rule above, mechanically rather than by eye.
 *     All 79 are comments or strings; none is a real regex literal.
 *
 * KNOWN LIMIT, stated rather than hidden: an unterminated `[` still scans to
 * end-of-line before failing, and every `/` is a start position, so the worst case
 * is QUADRATIC in line length (20k chars: 428ms). This fix does not change that
 * COMPLEXITY CLASS — the pre-fix regex measures the same ~4x per doubling — though
 * it does roughly double the CONSTANT on that shape (20k chars: 155ms before,
 * 428ms after), which is immaterial here: the longest line in the guard's
 * population is 4159 chars and regexLiteralsOn over all 1,045,200 of them totals
 * 97ms.
 *
 * No length cap is applied on purpose: a guard that silently skips long lines goes
 * quiet, and a quiet guard reads as a clean tree. If the quadratic ever does
 * matter, the answer already ships two files away — `_gate-consumption.mjs` has a
 * single-pass, non-backtracking regex-literal scanner (an `inClass` flag, no
 * alternation to backtrack over) doing this exact job in O(n). Swapping to it is a
 * behaviour change on its own and belongs in its own PR, not smuggled into a
 * security fix.
 */
export function regexLiteralsOn(line) {
  const out = [];
  const re = /\/((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n\[])+)\/[dgimsuvy]*/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1]);
  return out;
}

/**
 * Is this regex asking about SECRET-NESS?
 *
 * THIS IS THE LINE BETWEEN A USEFUL GUARD AND A DELETED ONE. Mixed anchoring is
 * not a defect by itself — it is frequently the correct, deliberate reading.
 * Run unrestricted, this guard finds EIGHT sites in the repo and SIX of them
 * are right:
 *
 *   dsl.ts / metricflow-spec.ts / output.ts   YAML needs quoting when it
 *       `/[:#…]|^\s|\s$|^$/`                  CONTAINS a special char, or
 *                                             STARTS with space, or IS empty.
 *   git branch-out route                      git's own ref rules: contains
 *       `/\.\.|@\{|…|\.lock$|^\./`            '..', or ENDS '.lock', or
 *                                             STARTS '.'.
 *   synthetic-data-gen.ts, import-parser.ts   same shape, same intent.
 *
 * Each alternative there means something different ON PURPOSE. Failing those
 * would teach the next author to add an ignore comment, and then the guard
 * protects nothing.
 *
 * The defect that actually leaked was narrower: a predicate deciding whether a
 * NAME denotes a credential, where the author meant "contains any of these
 * words" and the parser heard "…or ends with the last one". #2772 put
 * connection secrets into Cosmos in plaintext that way; env-config.ts and
 * honest-gate.tsx carried the same shape with two DIFFERENT word lists. So the
 * guard fires on mixed anchoring AND secret vocabulary — which is exactly the
 * set of sites that must instead call the shared rule.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function isSecretVocabulary(body) {
  return /(SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|_?PWD|TOKEN|APIKEY|_KEYS?\b|\bKEY\$|KEY\$)/i.test(body);
}

/**
 * Scan a source text. Exported so the self-test drives it with fixtures.
 * @param {string} src
 * @param {string} rel
 * @returns {{file:string,line:number,snippet:string,body:string}[]}
 */
export function scanSource(src, rel) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (!isPredicateUse(line)) return;
    for (const body of regexLiteralsOn(line)) {
      if (mixesAnchors(body) && isSecretVocabulary(body)) {
        out.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 130), body });
      }
    }
  });
  return out;
}

function walk(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMBEDDED CONTROL — proven on every run, before the repo is judged (#3488).
// ─────────────────────────────────────────────────────────────────────────────
//
// A reintroduced ambiguity in regexLiteralsOn does not make this guard WRONG, it
// makes it HANG — and a hung CI job reads as an infrastructure flake, not as a
// defect, so it can burn days before anyone looks at the regex. These controls
// convert that hang into a named failure with a bounded cost. Measured, guard
// exit 1: a single-property regression fails in 3.4-6.2s, all three at once in
// 26s (three fixtures, each retried up to 3x). Healthy: 106ms.
//
// TWO CALIBRATION FACTS, both measured rather than assumed:
//
//   1. V8 TIERS A REGEXP UP from the interpreter to compiled code once it has
//      done enough work, so a fixture that runs SECOND is measured against a
//      ~8x faster engine. The first cut of this control used '[]'x24/'\'x36 and
//      the second fixture came in at 118ms against a 200ms budget while costing
//      1193ms in a fresh process — it was passing on a BROKEN regex. So each
//      fixture warms the pattern site first and both are sized for the WARMED
//      state, which makes the verdict independent of fixture order. Measured
//      warm on the broken regex, both orders: #757 1.29-1.37s, #758 1.93-2.02s.
//
//   2. THERE ARE THREE DISJOINTNESS PROPERTIES, not two, and each fixture only
//      catches its own. The fix ADDED two exclusions — `\` from the inner
//      catch-all and `[` from the outer — but the outer catch-all also excludes
//      `\`, which was already there and is equally load-bearing: it is what
//      keeps the escape branch the only thing that can consume a top-level
//      backslash. Nothing tested that third one, and a control that cannot fail
//      for a third of what it guards is the very defect this file exists to
//      fix, rebuilt inside its own safety net.
//
//      Measured with ONLY that exclusion dropped (`[^/\\\n\[]` -> `[^/\n\[]`),
//      warm, on `/` + `\`xN. The other two fixtures do not move at all, so
//      runControls() returned [] in 0ms against an exponential regex:
//
//        Node 20.20.2  N=34 56ms   N=38 381ms   N=40 996ms   N=44 7.7s
//        Node 24.18.0  N=34 59ms   N=38 413ms   N=40 1123ms  N=44 8.5s
//
//      (~2.6x per 2 pumps on both.) Fixed, same input at N=40000: 0.34ms.
//      Fixture three closes it.
//
// Healthy cost is 0.00ms (below timer resolution) against a 200ms budget, so the
// margin is four orders of magnitude and a GC pause cannot manufacture a
// failure — the more so because a measurement over budget is retried.

/** One input per disjointness property. Each must FAIL to match — backtracking
 *  is the cost of the failing search, so a fixture with a closing `/` in it
 *  returns fast on the broken regex too and would measure nothing. */
export const REDOS_FIXTURES = [
  { why: 'CodeQL #757 — outer catch-all vs the bracket branch (`[`)', input: `/${'[]'.repeat(27)}` },
  { why: 'CodeQL #758 — inner catch-all vs the escape branch (`\\`)', input: `/[${'\\'.repeat(42)}` },
  { why: 'outer catch-all vs the escape branch (`\\`)', input: `/${'\\'.repeat(40)}` },
];

/** Extraction fixtures, so a "simplification" that silences the timing control
 *  by breaking the parser is caught in the same pass. */
export const EXTRACT_FIXTURES = [
  { why: 'plain literal', input: 'return /a|b$/i.test(k);', expect: ['a|b$'] },
  { why: 'character class containing a slash', input: 'if (/[/]x/.test(s)) f();', expect: ['[/]x'] },
  { why: 'escaped bracket outside a class', input: 'if (/\\[a\\]/.test(s)) f();', expect: ['\\[a\\]'] },
  { why: 'escaped closing bracket INSIDE a class', input: 'if (/[a\\]b]/.test(s)) f();', expect: ['[a\\]b]'] },
  // Documented #3488 behaviour change: `[` no longer falls through to the
  // catch-all, so an UNTERMINATED `[` yields nothing. `/a[b/` is not a regex
  // literal JS can parse either, so the only text this can appear in was never
  // a regex to begin with.
  { why: 'UNTERMINATED `[` yields nothing (deliberate, #3488)', input: 'if (/a[b/.test(s)) f();', expect: [] },
];

/** Milliseconds any one fixture may take. Deterministic: 0.00ms. Broken: >1.2s. */
export const REDOS_BUDGET_MS = 200;

/** Exercises the pattern site so the measurement does not depend on which
 *  fixture ran first. Benign, and shaped like the code this guard reads. */
const WARM_LINE = 'if (/^a|b$/.test(x)) f(/[a-z]+/);';

/**
 * Cost of one fixture, in ms, as the BEST of up to 3 attempts. A healthy regex
 * clears the budget on attempt 1 and never retries; only a measurement that is
 * already over budget is repeated, so a scheduler or GC spike cannot fail the
 * run on its own while a genuine regression still fails.
 */
function costMs(input) {
  let best = Infinity;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (let w = 0; w < 5; w += 1) regexLiteralsOn(WARM_LINE);
    const t0 = process.hrtime.bigint();
    regexLiteralsOn(input);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
    if (best <= REDOS_BUDGET_MS) break;
  }
  return best;
}

/** Runs the controls. Returns failure descriptions (empty = healthy). */
export function runControls() {
  const failures = [];
  for (const f of REDOS_FIXTURES) {
    const ms = costMs(f.input);
    if (ms > REDOS_BUDGET_MS) {
      failures.push(
        `ReDoS control: ${f.why} took ${ms.toFixed(0)}ms (budget ${REDOS_BUDGET_MS}ms) on ` +
          `${f.input.length} chars — the alternatives in regexLiteralsOn overlap again.`,
      );
    }
  }
  for (const f of EXTRACT_FIXTURES) {
    const got = regexLiteralsOn(f.input);
    if (JSON.stringify(got) !== JSON.stringify(f.expect)) {
      failures.push(`extraction control: ${f.why} — got ${JSON.stringify(got)}, expected ${JSON.stringify(f.expect)}`);
    }
  }
  return failures;
}

function main() {
  const controlFailures = runControls();
  if (controlFailures.length > 0) {
    console.error(
      `::error::regex-anchor: the EMBEDDED CONTROL failed (${controlFailures.length}). regexLiteralsOn no longer ` +
        'behaves as documented, so any verdict about the repo would be meaningless.',
    );
    for (const f of controlFailures) console.error(`   - ${f}`);
    process.exit(1);
  }

  if (process.argv.includes('--self-test')) {
    const n = REDOS_FIXTURES.length + EXTRACT_FIXTURES.length;
    console.log(`[regex-anchor] self-test OK — ${n} control fixture(s) behaved as documented.`);
    return;
  }

  const violations = [];
  for (const { dir, exts } of SCAN) {
    for (const file of walk(join(ROOT, dir), exts)) {
      const rel = relative(ROOT, file).split(sep).join('/');
      violations.push(...scanSource(readFileSync(file, 'utf8'), rel));
    }
  }

  if (violations.length === 0) {
    console.log('[regex-anchor] OK — no mixed-anchor alternation in a predicate.');
    process.exit(0);
  }

  console.error(`\n[regex-anchor] FAIL — ${violations.length} mixed-anchor predicate regex(es).\n`);
  for (const v of violations) {
    const alts = topLevelAlternatives(v.body);
    const anchored = alts.filter((a) => { const f = anchorsOf(a); return f.start || f.end; });
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
    console.error(`    Alternation binds looser than the anchor, so only ${anchored.map((a) => `"${a}"`).join(', ')}`);
    console.error(`    ${anchored.length === 1 ? 'is' : 'are'} anchored — the other ${alts.length - anchored.length} match anywhere in the string.\n`);
  }
  console.error('  Fix: group the alternation — /^(?:a|b|c)$/ — or drop the anchors so every');
  console.error('  alternative is treated the same. For secret-name detection prefer the');
  console.error('  word-split rule in apps/fiab-console/lib/util/secret-prop-name.ts (#2772).\n');
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('check-regex-anchor.mjs')) main();
