/**
 * The randomness ratchet must count CODE, not prose.
 *
 * Found live: PR #2613 wrote the right thing —
 *
 *     // CSPRNG id (never Math.random — CodeQL js/insecure-randomness, and an
 *     // audit record id must not be guessable/forgeable).
 *     id: `ucgov-${randomUUID()}`,
 *
 * — and the guard failed it, because "Math.random" appears in the comment
 * EXPLAINING why Math.random was not used. The cheapest way to go green would
 * have been to DELETE that comment, so the guard was pushing toward
 * less-documented code. Stripping comments dropped the repo-wide count 178 -> 168:
 * ten of the counted "violations" were never code at all.
 *
 * Run: node --test scripts/ci/__tests__/insecure-randomness-comments.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'check-insecure-randomness.mjs',
);

/** Re-create the guard's stripper from its source — it is not exported. */
function loadStripComments() {
  const src = fs.readFileSync(GUARD, 'utf8');
  const m = src.match(/function stripComments\(src\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'stripComments() not found in the guard — did it get renamed?');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}; return stripComments;`)();
}

const stripComments = loadStripComments();
const count = (s) => (stripComments(s).match(/Math\.random/g) || []).length;

test('a line comment mentioning Math.random is NOT counted', () => {
  assert.equal(count('// never Math.random — use randomUUID()\nconst id = randomUUID();'), 0);
});

test('a block comment mentioning Math.random is NOT counted', () => {
  assert.equal(count('/*\n * Do not use Math.random here.\n */\nconst id = randomUUID();'), 0);
});

test('the exact #2613 shape is NOT counted', () => {
  const real = [
    '      // CSPRNG id (never Math.random — CodeQL js/insecure-randomness, and an',
    '      // audit record id must not be guessable/forgeable).',
    '      id: `ucgov-${randomUUID()}`,',
  ].join('\n');
  assert.equal(count(real), 0);
});

test('REAL code IS still counted — the guard must not go blind', () => {
  assert.equal(count('const x = Math.random();'), 1);
  assert.equal(count('const a = Math.random(), b = Math.random();'), 2);
});

test('code on the same line as a trailing comment is still counted', () => {
  assert.equal(count('const x = Math.random(); // jitter'), 1);
});

test('a URL is not mistaken for a line comment', () => {
  // The `//` in https:// must not swallow the rest of the line.
  assert.equal(count('const u = "https://x.test"; const y = Math.random();'), 1);
});
