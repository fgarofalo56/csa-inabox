/**
 * Mutation proof for scripts/ci/check-fitness-messages.mjs.
 *
 * Each test breaks the property the guard protects and requires RED, plus a
 * baseline GREEN so the suite cannot pass by always failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecks, loadSource, extractCheckLiterals } from '../check-fitness-messages.mjs';

const BASE = loadSource();

function mutate(from, to) {
  assert.ok(BASE.includes(from), `mutation setup: source does not contain ${JSON.stringify(from.slice(0, 90))}`);
  const mutated = BASE.split(from).join(to);
  assert.notEqual(mutated, BASE, 'mutation setup: nothing changed');
  return runChecks(mutated);
}

test('baseline: fitness.ts is GREEN and the extractor finds the real checks', () => {
  const { problems, literalCount } = runChecks(BASE);
  assert.deepEqual(problems, [], `unmutated source must be clean, got:\n${problems.join('\n')}`);
  assert.ok(literalCount >= 35, `expected >= 35 check literals, extracted ${literalCount}`);
});

test('the extractor does NOT collapse a whole function body into one literal', () => {
  // The first implementation scanned forward from every `{` and grabbed the
  // enclosing arrow-function body, reporting 11 checks where there are 40.
  const lits = extractCheckLiterals(BASE);
  assert.ok(lits.length >= 35, `extractor regressed: ${lits.length} literals`);
  // No literal may contain another literal's `id:` twice — that is the signature
  // of having swallowed a function body containing several checks.
  const swallowed = lits.filter((l) => (l.text.match(/\bid:/g) ?? []).length > 1);
  assert.deepEqual(
    swallowed.map((l) => l.text.slice(0, 60)),
    [],
    'a literal contains more than one `id:` — the extractor swallowed sibling checks',
  );
});

test('MUTATION: dropping `established` from a check goes RED', () => {
  const { problems } = mutate(
    "      established: `properties.isHnsEnabled=${JSON.stringify(v)} from Microsoft.Storage/storageAccounts`,\n",
    '',
  );
  assert.ok(
    problems.some((p) => p.includes('has no `established`')),
    `expected the established check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: an unknown verdict that claims non-existence goes RED', () => {
  // This is the 2026-08-05 roll message defect, transplanted into adoption
  // validation: "could not read" reported as "does not exist".
  const { problems } = mutate(
    "    what: `Loom could not read ${propName} on ${label} \"${name}\"`,",
    "    what: `${propName} does not exist on ${label} \"${name}\"`,",
  );
  assert.ok(
    problems.some((p) => p.includes('does not exist') && p.includes('different facts')),
    `expected the non-existence-claim check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: letting the blocking gate ignore `unknown` goes RED', () => {
  const { problems } = mutate(
    "r.fitness.verdict === 'unusable' || r.fitness.verdict === 'unknown'",
    "r.fitness.verdict === 'unusable'",
  );
  assert.ok(
    problems.some((p) => p.includes('must block on BOTH')),
    `expected the blocking-gate check to fail, got:\n${problems.join('\n')}`,
  );
});

test('MUTATION: deleting most of the checks goes RED on the floor', () => {
  const gutted = BASE.slice(0, BASE.indexOf('const FAMILY_CHECKS'));
  const { problems } = runChecks(gutted);
  assert.ok(
    problems.some((p) => p.includes('fitness-check literals were found')),
    `expected the count floor to fail, got:\n${problems.join('\n')}`,
  );
});
