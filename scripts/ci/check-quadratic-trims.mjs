#!/usr/bin/env node
/**
 * check-quadratic-trims — zero-tolerance for the TWO trailing-run trim shapes
 * that PR #2677 closed to zero in production code, in EVERY spelling.
 *
 * WHAT THIS GUARD CLAIMS (and nothing more)
 * -----------------------------------------
 * Exactly two regex shapes are forbidden:
 *
 *   A. a quantified `;` run before an end anchor   — `/;+\s*$/`, `/;+$/`,
 *      `/[;]+\s*$/`, `/;{1,}\s*$/`, `new RegExp(';+\\s*$')`, …
 *   B. the two-sided slash trim                    — `/^\/+|\/+$/g`,
 *      `/\/+$|^\/+/g`, `/^[/]+|[/]+$/g`, `new RegExp('^/+|/+$', 'g')`, …
 *
 * Both were measured quadratic on request-reachable input (`/;+\s*$/`: 118 ms
 * at n=8 000 → 13 356 ms at n=64 000; the linear scan is 0 ms at every n) and
 * both are now at ZERO occurrences outside the documented exemptions, so a
 * zero-tolerance rule is honest here.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 * -----------------------------------
 * It does NOT claim the whole js/polynomial-redos class is closed. ~250 other
 * end-anchored run regexes remain in the tree (mostly `endpoint.replace(/\/+$/,
 * '')` on deployment-config values). Those are triaged per site in the PR, not
 * gated here — a guard that pretended to cover them would be false assurance.
 *
 * The replacements live in `apps/fiab-console/lib/util/trim.ts`:
 *   stripTrailingSemicolons(sql) · trimSlashes(s) · trimEdges(s, chars)
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/** Files allowed to contain a forbidden shape, each with a written reason. */
const EXEMPT = new Map([
  [
    'apps/fiab-console/lib/azure/__tests__/redos-class-siblings.test.ts',
    'holds `/;+\\s*$/` as a PARITY ORACLE (data, on 9 short constants) so the ' +
      'linear helper is proven output-identical to the regex it replaced',
  ],
  [
    'apps/fiab-console/lib/util/__tests__/trim.test.ts',
    'same: the two-sided slash regex is the oracle trimSlashes() is compared against',
  ],
  ['scripts/ci/check-quadratic-trims.mjs', 'this guard describes the shapes it forbids'],
]);

/**
 * Shape A — a quantified `;` run terminated by `$` (any spelling).
 * The class form must NOT be negated: `[^;]+…$` is a different (linear)
 * pattern and matching it was a false positive on kusto-client.ts.
 */
const SEMI = [
  /;(?:\+|\*|\{\d+,\d*\})(?:\\s|\s|\[[^\]]*\])*[*+?]?\$/,
  /\[(?!\^)[^\]]*;[^\]]*\](?:\+|\*|\{\d+,\d*\})(?:\\s|\s|\[[^\]]*\])*[*+?]?\$/,
];

/** Shape B — leading AND trailing `/` runs trimmed in one regex (any spelling). */
const SLASH = [
  /\^\\?\/\+\|\\?\/\+\$/,
  /\\?\/\+\$\|\^\\?\/\+/,
  /\^\[\\?\/\]\+\|\[\\?\/\]\+\$/,
  /\^\/\+\|\/\+\$/,
];

// `--others --exclude-standard` as well as `--cached`: a plain `git ls-files`
// misses a NEW file that is not staged yet, so running this locally before
// `git add` would report a clean tree while the violation sits on disk. (That
// blind spot was found by temp/guard-spellings.mjs, which writes each spelling
// to a scratch file — every one of the 18 was "caught: no" until this changed.)
const files = execSync('git ls-files --cached --others --exclude-standard apps scripts tools packages', {
  encoding: 'utf8',
  maxBuffer: 1 << 28,
})
  .split(/\r?\n/)
  .filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f));

const hits = [];
let scanned = 0;
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  scanned++;
  if (EXEMPT.has(f)) continue;
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // Drop comments — the shapes are quoted in several doc blocks explaining
    // WHY they are banned, and banning the explanation is silly. Both the
    // whole-line form and a trailing ` // …` (which is how sql-guard.ts records
    // the regex it replaced) have to go.
    const raw = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) continue;
    const line = raw.replace(/\s\/\/\s.*$/, '');
    if (!line.includes('$')) continue;
    // Also scan a backslash-unescaped copy so the `new RegExp(';+\\s*$')`
    // spelling — where the pattern lives in a STRING and every backslash is
    // doubled — is matched by the same rules as a regex literal. Without this
    // the guard caught 17 of 18 spellings, i.e. it was exactly the
    // "one-syntax guard" that gives false assurance.
    const variants = [line, line.replace(/\\\\/g, '\\')];
    for (const re of SEMI) {
      if (variants.some((v) => re.test(v)))
        hits.push([f, i + 1, 'A: quantified `;` run before `$`', line.trim().slice(0, 160)]);
    }
    for (const re of SLASH) {
      if (variants.some((v) => re.test(v)))
        hits.push([f, i + 1, 'B: two-sided `/` run trim', line.trim().slice(0, 160)]);
    }
  }
}

// A sweep that silently parses nothing is worse than no sweep (this repo has
// shipped three of those). Fail loudly instead.
if (scanned < 500) {
  console.error(`[quadratic-trims] FATAL — only ${scanned} files scanned; the file list is broken.`);
  process.exit(2);
}

if (hits.length === 0) {
  console.log(`[quadratic-trims] PASS — 0 occurrences of shape A or B across ${scanned} files.`);
  console.log(`[quadratic-trims] exemptions (${EXEMPT.size}):`);
  for (const [f, why] of EXEMPT) console.log(`  - ${f}\n      ${why}`);
  process.exit(0);
}

console.error(`[quadratic-trims] FAIL — ${hits.length} quadratic trailing-run trim(s):`);
for (const [f, line, shape, text] of hits) {
  console.error(`  ${f}:${line}  [${shape}]`);
  console.error(`     ${text}`);
}
console.error('');
console.error('Use the linear helpers in apps/fiab-console/lib/util/trim.ts:');
console.error("  stripTrailingSemicolons(sql)   // instead of sql.trim().replace(/;+\\s*$/, '')");
console.error("  trimSlashes(s)                 // instead of s.replace(/^\\/+|\\/+$/g, '')");
console.error("  trimEdges(s, '-')              // instead of s.replace(/^-+|-+$/g, '')");
process.exit(1);
