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
 * line-count test all go RED. Measured, not asserted — receipt in the PR body.
 *
 * Run: node --test scripts/ci/__tests__/code-only-comment-stripper.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { codeOnly, blankComments } from '../_code-only.mjs';
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

test('CRLF input is normalised, so a line rule cannot be defeated by a stray CR', () => {
  // FAILS IF: the \r\n normalisation is dropped — out would contain '\r'.
  const out = codeOnly('const a = 1;\r\n// withSession(x)\r\nconst b = 2;\r\n');
  assert.equal(out.includes('\r'), false);
  assert.equal(out.includes('const b = 2;'), true); // paired positive
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

// ───────────────────────────────────────────────────────────────────────────
// 6. THE SIBLING GUARD CONSUMES THE SAME HELPER — so the fix cannot be applied
//    to one side of the symmetry and left off the other (#4467 acceptance box).
// ───────────────────────────────────────────────────────────────────────────

test('both raw-source guards import the SHARED stripper, not a local copy', () => {
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
