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
 * Usage: node scripts/ci/check-regex-anchor.mjs
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

/** Regex literals on a line: `/…/flags`, skipping `//` comments and division. */
export function regexLiteralsOn(line) {
  const out = [];
  const re = /\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+)\/[dgimsuvy]*/g;
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

function main() {
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
