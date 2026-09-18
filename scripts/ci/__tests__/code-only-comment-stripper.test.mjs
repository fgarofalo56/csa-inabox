/**
 * Comment-stripper tests for the raw-source guards (refs #4467).
 *
 * WHY THIS FILE EXISTS
 * A guard matching a regex against RAW SOURCE is satisfied by a COMMENT. #4467
 * recorded that on check-route-toolkit: one sentence of prose in
 * app/api/copilot/orchestrate/route.ts excluded a live route from the ratchet,
 * and rewording the sentence moved the population with zero executable change.
 *
 * #4467's own fix was a LINE-PREFIX filter (drop lines whose trim() starts with
 * '//', '*' or '/*'). That closes ONE of four comment shapes. This suite is the
 * negative control that fix shipped without: it pins that prose cannot decide
 * membership, on every shape, on BOTH arms, in BOTH guards.
 *
 * ROUND 2 ADDED THE REGRESSION ARMS. The first attempt at closing the other
 * three shapes was a hand-rolled scanner that entered string mode on any quote
 * and did not track REGEX LITERALS — so a quote inside a regex character class
 * opened a phantom string and the rest was SKIPPED rather than masked, making it
 * WEAKER THAN MAIN on the very shape #4467 closed (1 file / 19 lines in the
 * route corpus; 35 / 370 in the owner-only corpus). The lexer is now #3468's
 * `maskNonCode`, hosted in _code-only.mjs and shared with
 * check-external-origin-urls, and the arms below pin both failure directions.
 *
 * THE ROUND-1 CENSUS COULD NOT HAVE CAUGHT THAT, which is why the corpus test
 * here is written the other way round: it looks for lines the stripper FAILS to
 * mask, not only for files it un-cloaks. A probe that can only find un-cloaking
 * is blind to a stripper that silently stops stripping.
 *
 * EVERY REGEX HERE IS IMPORTED, NOT TRANSCRIBED (assertion-design.md "done" #3)
 * — a typo in a transcribed copy is how a probe silently stops agreeing with
 * the implementation it claims to measure.
 *
 * WHAT VALUE WOULD MAKE EACH TEST FAIL — stated per test below. The blanket
 * answer for the whole file: restore the old line-prefix filter
 *   const codeOnly = (s) => s.split(/\r?\n/).filter(l => {
 *     const t = l.trim();
 *     return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
 *   }).join('\n');
 * and the B/C/D shape tests, the code-line-starting-with-'*' test and the
 * offset tests all go RED. Measured, not asserted — receipt in the PR body.
 *
 * Run: node --test scripts/ci/__tests__/code-only-comment-stripper.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { codeOnly, blankComments, maskNonCode } from '../_code-only.mjs';
import {
  MUTATING_EXPORT_RE,
  GET_EXPORT_RE,
  AUTH_SESSION_IMPORT_RE,
  TOOLKIT_RE,
  scanHandRolled,
} from '../check-route-toolkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'apps', 'fiab-console');

/** The guard's real verdict pipeline, over an already-stripped source. */
function verdict(code) {
  if (!MUTATING_EXPORT_RE.test(code) && !GET_EXPORT_RE.test(code)) return 'no-data-surface';
  if (!AUTH_SESSION_IMPORT_RE.test(code)) return 'not-session-based';
  if (TOOLKIT_RE.test(code)) return 'migrated';
  return 'hand-rolled';
}

/** A minimal route that IS in the population: data surface + getSession import. */
const HAND_ROLLED_BODY = [
  "import { getSession } from '@/lib/auth/session';",
  'export async function POST(req) {',
  '  const s = getSession();',
  '  if (!s) return new Response(null, { status: 401 });',
  '  return Response.json({ ok: true });',
  '}',
].join('\n');

// ───────────────────────────────────────────────────────────────────────────
// 1. THE STRIPPER ITSELF — all four comment shapes
// ───────────────────────────────────────────────────────────────────────────

test('strips a line-leading comment (the ONE shape #4467 already closed)', () => {
  // FAILS IF: codeOnly() becomes the identity function.
  assert.equal(codeOnly('const a = 1;\n// withSession(x)\n').includes('withSession'), false);
});

test('strips a TRAILING comment on a code line — shape B, cloaked before this fix', () => {
  // FAILS IF: the line-prefix filter is restored (the line does not START with
  // '//', so it survived and TOOLKIT_RE matched the prose). Measured cloaked at
  // origin/main a77ba98.
  const out = codeOnly('const a = 1; // not withSession(x) here\n');
  assert.equal(out.includes('withSession'), false);
  // PAIRED POSITIVE: the CODE on that line must survive, or "strip everything"
  // would satisfy the assertion above.
  assert.equal(out.includes('const a = 1;'), true);
});

test('strips a block-comment body line with no leading asterisk — shape C', () => {
  // FAILS IF: the line-prefix filter is restored ('withSession(x)' on its own
  // line starts with none of '//', '*', '/*', so it survived).
  const out = codeOnly('const a = 1;\n/*\nwithSession(x)\n*/\nconst b = 2;\n');
  assert.equal(out.includes('withSession'), false);
  assert.equal(out.includes('const b = 2;'), true); // paired positive
});

test('strips a block comment opened mid-line — shape D', () => {
  // FAILS IF: the line-prefix filter is restored.
  const out = codeOnly('const a = 1; /* withSession(x) */ const b = 2;\n');
  assert.equal(out.includes('withSession'), false);
  assert.equal(out.includes('const b = 2;'), true); // paired positive
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE STRIPPER MUST NOT EAT CODE — the fail-open direction of the same bug
// ───────────────────────────────────────────────────────────────────────────

test('a URL inside a string literal is NOT treated as a line comment', () => {
  // FAILS IF: codeOnly() cuts at the first '//' without string tracking — the
  // literal would become "const u = 'https: and the assertion goes red.
  const out = codeOnly("const u = 'https://example.com/a';\n");
  assert.equal(out.includes("'https://example.com/a'"), true);
});

test("a code line BEGINNING with '*' survives — the old filter deleted it", () => {
  // This is the sibling guard's fail-open direction: check-owner-only-workspace
  // -guard counts PER LINE, and the old filter dropped any line whose trim()
  // starts with '*' — including a genuine expression continuation.
  // FAILS IF: the line-prefix filter is restored.
  const out = codeOnly('const x = a\n  * assertOwner(b);\n');
  assert.equal(out.includes('assertOwner(b)'), true);
});

test('line COUNT is preserved, so a line-indexed consumer stays aligned', () => {
  // The sibling guard zips regex hits against its line array. A stripper that
  // DROPS lines silently shifts every downstream line number.
  // FAILS IF: codeOnly() filters lines out instead of blanking them.
  const src = 'a;\n/*\nb\nc\n*/\nd;\n';
  assert.equal(src.split('\n').length, 7); // fixture arithmetic asserted inline
  assert.equal(codeOnly(src).split('\n').length, 7);
});

test('OFFSETS are preserved — same length, same columns as the LF input', () => {
  // Stronger than line count, and the semantic the five private blankComments
  // copies in scripts/ci already use, so they can converge on this module.
  // FAILS IF: comment text is deleted rather than replaced with spaces.
  const src = "const u = 'https://x'; /* gone */ const b = 2; // gone too\nconst c = 3;\n";
  const out = codeOnly(src);
  assert.equal(out.length, src.length, 'length must be preserved');
  // Columns hold: `const b = 2;` must start at the same index in both.
  assert.equal(out.indexOf('const b = 2;'), src.indexOf('const b = 2;'));
  assert.equal(out.includes('gone'), false); // the comments really did go
});

test('blankComments and codeOnly are the SAME function, not two dialects', () => {
  // The divergence _logical-lines.mjs warns about starts with two names.
  // FAILS IF: someone re-implements one of them separately.
  assert.equal(blankComments, codeOnly);
});

test('CRLF input keeps its offsets AND still has its comments masked', () => {
  // codeOnly no longer NORMALISES line endings — it preserves offsets exactly,
  // which is what check-external-origin-urls needs for its `line=` annotations.
  // FAILS IF: the stripper rewrites \r\n (length changes), or misses the comment.
  const src = 'const a = 1;\r\n// withSession(x)\r\nconst b = 2;\r\n';
  const out = codeOnly(src);
  assert.equal(out.length, src.length, 'offsets must survive CRLF');
  assert.equal(out.includes('withSession'), false);
  assert.equal(out.includes('const b = 2;'), true); // paired positive
});

// ───────────────────────────────────────────────────────────────────────────
// 2b. REGEX LITERALS — the round-2 regression, in BOTH directions.
//     A hand-rolled scanner that enters string mode on any quote desyncs on a
//     regex character class and SKIPS (rather than masks) what follows. That is
//     fail-OPEN: the #4467 defect reintroduced by its own fix.
// ───────────────────────────────────────────────────────────────────────────

test('a QUOTE inside a regex character class does not cloak a following comment', () => {
  // THE ROUND-2 REGRESSION. FAILS IF: regex-literal tracking is removed — the
  // `"` opens a phantom string, the scanner runs to EOL/EOF in string mode, and
  // the comment survives verbatim. Measured live at
  // app/api/items/report/[id]/visual-data/route.ts:311 -> :332.
  const out = codeOnly('const re = /["]/; // withSession(x)\n');
  assert.equal(out.includes('withSession'), false);
  assert.equal(out.includes('const re ='), true); // paired positive
});

test("an APOSTROPHE inside a regex body does not cloak a later comment", () => {
  // FAILS IF: regex-literal tracking is removed.
  const out = codeOnly("const re = /it's/;\n// withSession(x)\n");
  assert.equal(out.includes('withSession'), false);
  assert.equal(out.includes('const re ='), true); // paired positive
});

test('a regex character class holding // does not EAT the code after it', () => {
  // The other direction: the round-2 scanner read `/[//]/` as a line comment and
  // blanked the rest of the line, deleting a real data surface — which removes a
  // file from the population for the opposite wrong reason.
  // FAILS IF: regex-literal tracking is removed.
  const out = codeOnly('const re = /[//]/; export async function POST(req) {}\n');
  assert.match(out, MUTATING_EXPORT_RE);
});

test('a pure line comment is masked even when the PREVIOUS line ends in a colon', () => {
  // #3468's `://` exemption keyed on the last SIGNIFICANT character, which
  // survives newlines, so a comment line ending in ':' protected the next line.
  // Measured at this head before narrowing it: 6 files / 12 lines in the route
  // corpus, e.g. app/api/azure/connectables/route.ts:78-81.
  // FAILS IF: the adjacency narrowing (`s[i-1] !== ':'`) is reverted to `prev`.
  const out = codeOnly('// proven reliable here:\n//   GET {ARM}/subscriptions\n');
  assert.equal(out.trim(), '');
});

test('a real https:// URL outside a string is still NOT read as a comment', () => {
  // The case the `://` exemption exists for — narrowing it must not break it.
  // FAILS IF: the exemption is deleted outright.
  assert.equal(codeOnly('<a>https://example.com/x</a>\n').includes('example.com'), true);
});

// ───────────────────────────────────────────────────────────────────────────
// 3. THE NEGATIVE CONTROL #4467 ASKED FOR, at the guard's real predicates:
//    a route whose ONLY wrapper mention is a comment is NON-COMPLIANT.
// ───────────────────────────────────────────────────────────────────────────

const CLOAK_SHAPES = {
  'A line-leading': `// This route is deliberately not withSession(...)\n${HAND_ROLLED_BODY}`,
  'B trailing': `${HAND_ROLLED_BODY}\nconst x = 1; // unlike its siblings, not withSession(...)\n`,
  'C block body': `${HAND_ROLLED_BODY}\n/*\nnot withSession(...) here\n*/\n`,
  'D mid-line block': `${HAND_ROLLED_BODY}\nconst x = 1; /* not withSession(...) */\n`,
};

for (const [shape, src] of Object.entries(CLOAK_SHAPES)) {
  test(`NEGATIVE CONTROL ${shape}: a comment-only wrapper mention stays hand-rolled`, () => {
    // FAILS IF: the predicates are applied to raw source, or codeOnly() misses
    // this shape — the verdict flips to 'migrated' and the route silently
    // leaves the ratchet. That flip is exactly the #4467 defect.
    assert.equal(verdict(codeOnly(src)), 'hand-rolled');
  });
}

test('PAIRED POSITIVE: a REAL withSession() call does exclude the route', () => {
  // Without this, deleting TOOLKIT_RE entirely would satisfy all four negative
  // controls above (absence-only assertions are satisfied by removing the
  // feature — assertion-design.md "done" #4).
  // FAILS IF: TOOLKIT_RE is deleted/broken, or codeOnly() eats real code.
  const migrated = `import { getSession } from '@/lib/auth/session';\nexport const POST = withSession(async (req, s) => Response.json({ ok: true }));\n`;
  assert.equal(verdict(codeOnly(migrated)), 'migrated');
});

// ───────────────────────────────────────────────────────────────────────────
// 4. SYMMETRY — the INCLUDE arms must not be satisfiable by prose EITHER.
//    A comment-satisfied include arm puts a file INTO the ratchet that has no
//    data surface: the same error pointed the other way.
// ───────────────────────────────────────────────────────────────────────────

test('INCLUDE arm: an exported handler mentioned only in a comment is not a data surface', () => {
  // FAILS IF: MUTATING_EXPORT_RE/GET_EXPORT_RE are applied to raw source — the
  // file would be admitted to the population on prose alone.
  const src = `import { getSession } from '@/lib/auth/session';\n// export async function POST(req) {}  <- historical, removed\nconst noop = 1;\n`;
  assert.equal(verdict(codeOnly(src)), 'no-data-surface');
});

test('INCLUDE arm: a getSession import mentioned only in a comment is not session-based', () => {
  // FAILS IF: AUTH_SESSION_IMPORT_RE is applied to raw source.
  const src = `export async function POST(req) { return Response.json({}); }\n// we used to import { getSession } from '@/lib/auth/session';\n`;
  assert.equal(verdict(codeOnly(src)), 'not-session-based');
});

test('PAIRED POSITIVE for both include arms: real code IS admitted', () => {
  // Without this, a codeOnly() that returned '' would satisfy both tests above.
  // FAILS IF: codeOnly() strips real code, or either include regex breaks.
  assert.equal(verdict(codeOnly(HAND_ROLLED_BODY)), 'hand-rolled');
});

// ───────────────────────────────────────────────────────────────────────────
// 5. REAL-CORPUS ANCHOR — the stripper is load-bearing, not decorative.
// ───────────────────────────────────────────────────────────────────────────

test('the ORIGINAL #4467 witness is still cloaked under raw-source scanning', () => {
  // On the real corpus, exactly ONE route file is excluded by TOOLKIT_RE only
  // via a comment: app/api/copilot/orchestrate/route.ts, whose sole wrapper
  // mention is the sentence "Unlike almost every sibling route this one is a
  // bare handler, not `withSession(...)`".
  //
  // Asserting the ROW SET, never a bare count: a count-only assertion passes if
  // a DIFFERENT file starts cloaking while this one is fixed.
  //
  // FAILS IF: codeOnly() becomes the identity (the set empties — the stripper
  // would be decorative), or that route's prose changes and no real corpus file
  // exercises the stripper any more (in which case this anchor must be re-aimed
  // at whatever does, not deleted).
  const files = execSync('git ls-files "app/api/**/route.ts"', { cwd: APP_ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

  const cloaked = files.filter((f) => {
    const raw = fs.readFileSync(path.join(APP_ROOT, f), 'utf8');
    return verdict(raw) !== 'hand-rolled' && verdict(codeOnly(raw)) === 'hand-rolled';
  });

  assert.deepEqual(cloaked, ['app/api/copilot/orchestrate/route.ts']);
});

test('that witness is actually IN the shipped population (the guard consumes the fix)', () => {
  // The test above measures the predicates. This one measures the exported
  // scanHandRolled() the ratchet really runs, so a fix that lands in the
  // helpers but never reaches the guard cannot pass.
  // FAILS IF: scanHandRolled() stops applying codeOnly() to `raw`.
  assert.equal(
    'apps/fiab-console/app/api/copilot/orchestrate/route.ts' in scanHandRolled(),
    true,
  );
});

test('THE ROUND-2 LIVE WITNESS: a real file whose regex char class desynced the scanner', () => {
  // app/api/items/report/[id]/visual-data/route.ts:311 holds a regex character
  // class containing `"`. The round-2 hand-rolled scanner desynced there and ran
  // in string mode for ~28 lines, so the pure line comment at :332 came out
  // BYTE-IDENTICAL — i.e. the stripper was WEAKER THAN MAIN on the one shape
  // #4467 closed. This anchors the real file, not a synthetic reconstruction.
  // FAILS IF: regex-literal tracking is removed from the lexer.
  const raw = fs.readFileSync(
    path.join(APP_ROOT, 'app/api/items/report/[id]/visual-data/route.ts'), 'utf8');
  const out = codeOnly(raw);
  assert.equal(raw.includes('// Power BI export row caps'), true,
    'fixture drifted: the witness comment is no longer in the file — re-aim this anchor');
  assert.equal(out.includes('// Power BI export row caps'), false,
    'the comment survived codeOnly() — the scanner desynced on the regex at :311');
});

test('NO pure line-comment line survives codeOnly() anywhere in the route corpus', () => {
  // The class reviewer 2 measured, as a standing regression guard rather than a
  // one-off count. A line whose trim() starts with `//` and is NOT string or
  // template data must be masked. Asserts the ROW SET, not a bare count.
  // FAILS IF: any lexer desync returns (measured 1 file / 19 lines before the
  // regex fix, and 6 files / 12 lines before the `://` adjacency narrowing).
  const files = execSync('git ls-files "app/api/**/route.ts"', { cwd: APP_ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const survivors = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(APP_ROOT, f), 'utf8');
    const kept = codeOnly(raw).split(/\r?\n/);
    // masked WITH strings: blank there => the text was string/template DATA,
    // which keepStrings is supposed to preserve. Only real comments count.
    const full = maskNonCode(raw).split(/\r?\n/);
    kept.forEach((l, i) => {
      if (l.trim().startsWith('//') && full[i] !== undefined && full[i].trim() !== '') {
        survivors.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(survivors, []);
});

test('keepStrings is REQUIRED, not a preference — without it the population is ZERO', () => {
  // This is the measurement that decides the design. check-route-toolkit's
  // include arm matches a MODULE PATH INSIDE A STRING:
  //   import { getSession } from '@/lib/auth/session'
  // so masking string bodies (maskNonCode's default, correct for
  // check-external-origin-urls) takes the population from 1002 to 0 — a
  // merge-blocking ratchet reporting green over an empty set.
  // FAILS IF: codeOnly stops passing keepStrings, or the arms stop needing it.
  const sample = "import { getSession } from '@/lib/auth/session';\nexport async function POST(req) {}\n";
  assert.match(codeOnly(sample), AUTH_SESSION_IMPORT_RE);
  assert.doesNotMatch(maskNonCode(sample), AUTH_SESSION_IMPORT_RE);
});

// ───────────────────────────────────────────────────────────────────────────
// 6. THE SIBLING GUARD CONSUMES THE SAME HELPER — so the fix cannot be applied
//    to one side of the symmetry and left off the other (#4467 acceptance box).
// ───────────────────────────────────────────────────────────────────────────

test('both ratchet guards import the SHARED stripper, not a local copy', () => {
  // The #4467 body asked for a sibling sweep rather than a one-guard fix. This
  // pins the outcome of that sweep mechanically.
  // FAILS IF: either guard re-inlines its own isComment/isCommentLine filter,
  // which is precisely how the two copies drifted apart in the first place.
  for (const g of ['check-route-toolkit.mjs', 'check-owner-only-workspace-guard.mjs']) {
    const src = fs.readFileSync(path.join(HERE, '..', g), 'utf8');
    assert.match(src, /import \{ codeOnly \} from '\.\/_code-only\.mjs'/, `${g} must use the shared stripper`);
    assert.doesNotMatch(src, /const is[Cc]omment(Line)? = /, `${g} must not re-inline a local comment filter`);
  }
});

test('check-external-origin-urls has NO second copy of the lexer', () => {
  // #3468's `maskNonCode` now lives in _code-only.mjs and this guard imports it.
  // Two implementations of one idea is how the line-prefix filters diverged, and
  // how a WEAKER maskNonCode (check-bff-errors.mjs:176, no regex-literal or
  // template tracking) already exists alongside the strong one.
  // FAILS IF: someone re-inlines the lexer body here.
  const src = fs.readFileSync(path.join(HERE, '..', 'check-external-origin-urls.mjs'), 'utf8');
  assert.match(src, /import \{ maskNonCode as maskNonCodeShared \} from '\.\/_code-only\.mjs'/);
  assert.doesNotMatch(src, /const canEndExpression = /, 'the lexer body was re-inlined here');
  // PAIRED POSITIVE: it must still EXPORT maskNonCode — its tests and callers
  // import it by that name, so deleting the export would satisfy the absence
  // assertion above while breaking the guard.
  assert.match(src, /export function maskNonCode\(src\)/);
});

