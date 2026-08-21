#!/usr/bin/env node
/**
 * commit-message-parses — controls for the COLLECTION layer, which had none.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `check-commit-message-parses.mjs` shipped with 14 embedded controls, and every one of
 * them aimed at `judgeMessage` — the parser question. The layer that decides WHICH
 * commits get asked that question had no control at all. Replace the body of
 * `commitsIn()` with `return []` and the guard prints
 *
 *     scanned 0 non-merge commit(s) in <base>..<head>; 0 are changelog-bound.
 *     every changelog-bound commit message parses. Nothing will be silently dropped.
 *
 * and exits 0 — on a branch carrying a commit that will in fact be dropped. Fourteen
 * controls, all green, judging nothing. That is the shape this file exists to close.
 *
 * The second hole was the summary line, which used to read
 * `${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length}` — numerator and denominator the
 * same expression, so it prints `N/N` however many controls survive. Delete four and it
 * reads a tidy `10/10 embedded controls agree`. A ratio of an expression to itself is
 * never a witness, so the population is now asserted by `checkControlPopulation()`, and
 * THAT is what this file proves has teeth.
 *
 * WHY IT RUNS IN TWO LANES, AND WHY THE ALWAYS-ON HALF IS THE LOAD-BEARING ONE
 * ---------------------------------------------------------------------------
 * `loom-guardrails.yml` runs `node --test scripts/ci/__tests__/*.test.mjs`. That glob is
 * dynamic, so this file needs no registration — but it also means this file runs in the
 * REQUIRED `guardrails` lane, where `@conventional-commits/parser` is NOT installed
 * (only `commit-message-parses.yml` installs it, and there is no root package.json).
 *
 * So a naive `if (!parserIsAvailable()) return` at the top would make this file skip
 * everything in the one lane every PR must pass — a test suite with zero population,
 * present in the tree, executed, and asserting nothing. The split below is deliberate:
 *
 *   * the ALWAYS-ON lane covers the population floors, `parseLog`, `expectedCount` and
 *     `commitsIn` — none of which touch the parser — plus both mutation proofs.
 *     It is non-vacuous without the dependency, which is the entire point.
 *   * the PARSER-GATED lane covers `judgeMessage` / `runSelfTest` / the CLI contract, and
 *     runs in `commit-message-parses.yml` where the parser is installed. Its skips are
 *     announced, never silent.
 *
 * Importing this module must stay side-effect free for that to work at all — the parser
 * load is lazy (`getParser()`), which `guard-import-side-effects.test.mjs` independently
 * holds in place.
 *
 * Run: node --test scripts/ci/__tests__/commit-message-parses.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CONTROL_FLOOR,
  THROW_FLOOR,
  SELF_TEST_CASES,
  checkControlPopulation,
  commitsIn,
  expectedCount,
  judgeMessage,
  parseLog,
  parserIsAvailable,
  runSelfTest,
} from '../check-commit-message-parses.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.resolve(HERE, '../check-commit-message-parses.mjs');
const REPO_ROOT = path.resolve(HERE, '../../..');

const HAVE_PARSER = parserIsAvailable();
const NO_PARSER =
  '@conventional-commits/parser is not installed in this lane. The always-on tests above ' +
  'still ran; only the parser-dependent ones are skipped. This is expected under ' +
  'loom-guardrails.yml and NOT expected under commit-message-parses.yml.';
if (!HAVE_PARSER) console.log(`# NOTE: ${NO_PARSER}`);

/**
 * The record and field separators, built with fromCharCode rather than written as an
 * escape. Two reasons: a literal control byte is invisible in review and an editor or
 * line-ending pass can silently eat it, and a backslash-u escape typed into a tool call gets
 * JSON-decoded into that same invisible byte before it ever reaches disk.
 *
 * These are NOT imported from the guard, which does not export them — so if the guard's
 * separators ever changed, `parseLog` would stop splitting these fixtures and the tests
 * below would fail. The duplication IS the cross-check.
 */
const RS = String.fromCharCode(1); // U+0001, the record separator
const FS = String.fromCharCode(0); // NUL, the sha/message separator

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// ---------------------------------------------------------------------------
// ALWAYS-ON — no parser required. Must be non-vacuous on its own.
// ---------------------------------------------------------------------------

test('the control population meets its own floors, and the floors are not decorative', () => {
  // A floor of 0 would pass every population including an empty one. Pin the floors
  // themselves, not merely the population against them.
  assert.ok(CONTROL_FLOOR >= 14, `CONTROL_FLOOR fell to ${CONTROL_FLOOR}`);
  assert.ok(THROW_FLOOR >= 4, `THROW_FLOOR fell to ${THROW_FLOOR}`);

  const mustThrow = SELF_TEST_CASES.filter((c) => c.expect !== null).length;
  assert.ok(
    SELF_TEST_CASES.length >= CONTROL_FLOOR,
    `${SELF_TEST_CASES.length} controls against a floor of ${CONTROL_FLOOR}`,
  );
  assert.ok(mustThrow >= THROW_FLOOR, `${mustThrow} must-throw controls against ${THROW_FLOOR}`);

  // The real suite is the clean case for checkControlPopulation.
  assert.deepEqual(checkControlPopulation(), []);
});

test('checkControlPopulation catches deletion AND catches padding', () => {
  const gutted = checkControlPopulation(SELF_TEST_CASES.slice(0, 3));
  assert.ok(
    gutted.some((p) => /only 3 embedded control/.test(p)),
    `expected a control-floor problem, got ${JSON.stringify(gutted)}`,
  );

  // The attack the separate THROW_FLOOR exists for: keep the TOTAL intact by padding with
  // trivial must-parse cases after gutting the must-throw half. A total-only floor is
  // satisfied by this; the split floor is not.
  const padded = SELF_TEST_CASES.filter((c) => c.expect === null);
  while (padded.length < CONTROL_FLOOR) padded.push({ name: 'filler', text: 'x', expect: null });
  assert.equal(padded.length, CONTROL_FLOOR, 'the padded suite must clear the TOTAL floor');
  const thin = checkControlPopulation(padded);
  assert.ok(
    thin.some((p) => /exact throw coordinates/.test(p)),
    `padding cleared the total but must still fail the throw floor; got ${JSON.stringify(thin)}`,
  );
  assert.ok(
    !thin.some((p) => /embedded control\(s\) remain/.test(p)),
    'the padded suite must NOT trip the total floor, or this proves nothing about the split',
  );
});

test('parseLog splits a clean payload into whole records', () => {
  const payload =
    `${SHA_A}${FS}fix(a): one\n\nbody one\n${RS}` + `${SHA_B}${FS}fix(b): two\n${RS}`;
  const records = parseLog(payload);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((r) => r.sha),
    [SHA_A, SHA_B],
  );
  assert.match(records[0].message, /^fix\(a\): one/);
  assert.match(records[1].message, /^fix\(b\): two/);
});

test('parseLog KEEPS a NUL-less record rather than dropping it — that record is the evidence', () => {
  // U+0001 is legal in a git commit message and nothing in git filters it. A body carrying
  // one splits a single commit in two, and the orphan half has no NUL. Dropping it here
  // would restore the record count to its expected value and hide the very discrepancy the
  // cross-check in commitsIn() exists to catch.
  const payload =
    `${SHA_A}${FS}fix(a): one\n\nbody with ${RS}a stray fragment\n${RS}` +
    `${SHA_B}${FS}fix(b): two\n${RS}`;
  const records = parseLog(payload);

  assert.equal(records.length, 3, 'the stray separator must produce an EXTRA record');
  const orphans = records.filter((r) => r.sha === null);
  assert.equal(orphans.length, 1, 'exactly one record should lack a sha');
  assert.equal(orphans[0].message, 'a stray fragment');

  // And the count is now provably wrong against git's 2 — which is what commitsIn throws on.
  assert.notEqual(records.length, 2);
});

test('commitsIn REFUSES a degenerate range instead of reporting a clean scan of nothing', () => {
  // The core of it. A zero-length range cannot be judged by count agreement alone: when
  // BASE_SHA is wrong, git's own count is ALSO 0, so the cross-check agrees with itself.
  // Counting WITH merges is what separates "clean branch" from "wrong base".
  assert.throws(
    () => commitsIn('HEAD', 'HEAD'),
    /contains no commits at all, not even merges/,
    'HEAD..HEAD must throw, not return []',
  );
});

test('commitsIn returns attributable records for a real range', (t) => {
  const reachable = Number(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
  );
  if (!Number.isInteger(reachable) || reachable < 6) {
    t.skip(`only ${reachable} commits reachable (shallow clone?); no multi-commit range to scan`);
    return;
  }

  const commits = commitsIn('HEAD~5', 'HEAD');
  assert.ok(commits.length > 0, 'a five-commit range must not come back empty');
  for (const c of commits) {
    assert.match(c.sha, /^[0-9a-f]{40}$/, `record has no git object name: ${JSON.stringify(c.sha)}`);
    assert.ok(c.message.length > 0, `${c.sha} came back with an empty message`);
  }

  // A THIRD method, deliberately different from both the guard's `git log --format=...`
  // and its `git rev-list --count` cross-check. A count taken from the same command's
  // output would confirm the method, never the answer.
  const oneline = execFileSync('git', ['log', '--no-merges', '--oneline', 'HEAD~5..HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
  assert.equal(commits.length, oneline, 'record count disagrees with an independent git count');
});

test('expectedCount counts merges only when asked', () => {
  const without = expectedCount('HEAD~5', 'HEAD');
  const with_ = expectedCount('HEAD~5', 'HEAD', { withMerges: true });
  assert.ok(Number.isInteger(without) && without >= 0);
  assert.ok(with_ >= without, 'including merges cannot lower the count');
  assert.equal(expectedCount('HEAD', 'HEAD', { withMerges: true }), 0);
});

// ---------------------------------------------------------------------------
// MUTATION PROOFS — two-sided, against a COPY of the guard.
//
// A test that only ever sees the correct source cannot tell a load-bearing line from a
// decorative one. Each proof asserts the mutation APPLIED (exactly one substitution — a
// needle that silently matched nothing would leave the source untouched and turn the whole
// comparison into a tautology), asserts the mutated verdict, then asserts the REAL module
// still gives the opposite one.
//
// WHY A COPY AND NOT THE TRACKED FILE
// `node --test` runs test FILES concurrently, each in its own process. An in-place mutate/
// restore is unsafe there in two ways that have nothing to do with which sibling collides:
// the window transiently dirties a tracked file that any concurrent working-tree-cleanliness
// check would see, and a killed process (CI cancel, timeout, OOM) leaves `CONTROL_FLOOR = 0`
// or a neutered range check on disk PERMANENTLY. That is precisely the silently-neutered-
// guard defect class this PR exists to close; a test for it must not be able to cause it.
// `guard-import-side-effects.test.mjs` does mutate in place, but it has to — its checker
// enumerates scripts/ci/ as a subprocess, so the real path is load-bearing there. Here the
// module is imported directly, so the path is a free choice and the safe one is free.
//
// The copy is not a weaker proof. The needle is still matched against the REAL guard source
// (so it stays pinned to real code), and the unmutated side is now the statically-imported
// production module every other test in this file already exercises — more direct than a
// re-import of a restored file, with no restore step, no window and no race.
//
// Driven through an import rather than the CLI so these run in the guardrails lane too:
// main() self-tests first and would need the parser, but commitsIn, parseLog and
// checkControlPopulation never touch it.
// ---------------------------------------------------------------------------

const GUARD_SRC = readFileSync(GUARD, 'utf8');
let mutationSeq = 0;

/** Write a mutated copy of the guard to a temp dir and import it. The guard's only
 *  top-level imports are node:child_process and node:module — both builtins — so a copy
 *  outside the repo resolves identically. */
async function importMutant(needle, replacement) {
  const occurrences = GUARD_SRC.split(needle).length - 1;
  assert.equal(
    occurrences,
    1,
    `mutation needle must match exactly once, matched ${occurrences}: ${JSON.stringify(needle)}`,
  );
  const mutated = GUARD_SRC.replace(needle, replacement);
  assert.notEqual(mutated, GUARD_SRC, 'the mutation did not change the source');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'loom-cmp-mut-'));
  const file = path.join(dir, `check-commit-message-parses.mut${++mutationSeq}.mjs`);
  writeFileSync(file, mutated, 'utf8');
  assert.equal(readFileSync(file, 'utf8'), mutated, 'the mutant did not reach disk');

  const mod = await import(pathToFileURL(file).href);
  // Safe to remove now: `import` resolves only after the module has been fully evaluated
  // and cached in the ESM registry, so the namespace below reads nothing further from disk.
  // Without this every run leaks a temp directory.
  rmSync(dir, { recursive: true, force: true });
  return mod;
}

test('MUTATION: neutering the degenerate-range check makes HEAD..HEAD read as clean', async () => {
  const mut = await importMutant('if (total === 0) {', 'if (total === -1) {');

  // The mutated guard no longer refuses. It returns an empty array — precisely the
  // "clean scan of nothing" the real code exists to prevent.
  const out = mut.commitsIn('HEAD', 'HEAD');
  assert.deepEqual(out, [], 'expected the mutated guard to hand back an empty, unremarked scan');

  // The real module, unmutated, refuses the same range. Without this half the proof is
  // one-sided: a mutation that flips nothing looks identical to one that flips something.
  assert.throws(() => commitsIn('HEAD', 'HEAD'), /no commits at all/);
});

test('MUTATION: dropping CONTROL_FLOOR to zero lets a gutted control suite pass', async () => {
  const mut = await importMutant(
    'export const CONTROL_FLOOR = 14;',
    'export const CONTROL_FLOOR = 0;',
  );

  const underMutant = mut.checkControlPopulation(SELF_TEST_CASES.slice(0, 1));
  assert.ok(
    !underMutant.some((p) => /embedded control\(s\) remain/.test(p)),
    `a zeroed floor must stop reporting deletions; got ${JSON.stringify(underMutant)}`,
  );

  const underReal = checkControlPopulation(SELF_TEST_CASES.slice(0, 1));
  assert.ok(
    underReal.some((p) => /embedded control\(s\) remain/.test(p)),
    `the real floor must still report the deletion; got ${JSON.stringify(underReal)}`,
  );
});

// ---------------------------------------------------------------------------
// PARSER-GATED — runs under commit-message-parses.yml, skipped (audibly) elsewhere.
// ---------------------------------------------------------------------------

test('the embedded controls agree with the installed parser', { skip: !HAVE_PARSER && NO_PARSER }, () => {
  const disagreements = runSelfTest();
  assert.deepEqual(
    disagreements,
    [],
    `controls disagree with the installed parser: ${JSON.stringify(disagreements)}`,
  );
});

test('judgeMessage scopes on the SUBJECT, not the body', { skip: !HAVE_PARSER && NO_PARSER }, () => {
  const trap = 'withAudit(async (req) => handler(req)) wraps the route.';

  // Non-conventional subject: out of scope even though the body throws.
  const reverted = judgeMessage(`Revert "fix(x): something"\n\n${trap}\n`);
  assert.equal(reverted.changelogBound, false);
  assert.equal(reverted.ok, true);

  // Conventional subject, same body: in scope, and it fails at a pinned coordinate.
  const bound = judgeMessage(`fix(scope): a normal subject line\n\n${trap}\n`);
  assert.equal(bound.changelogBound, true);
  assert.equal(bound.ok, false);
  assert.equal(bound.failure.line, 3);
  assert.equal(bound.failure.col, 17);
  assert.equal(bound.failure.offendingLine, trap);

  // The remedy the guard PRINTS. If this stops holding, the advice is wrong and the guard
  // must stop giving it.
  const fixed = judgeMessage(`fix(scope): a normal subject line\n\n  ${trap}\n`);
  assert.equal(fixed.ok, true);
});

test(
  'the CLI converts a refusal into an ::error:: annotation, not a stack trace',
  { skip: !HAVE_PARSER && NO_PARSER },
  () => {
    // main() catches what commitsIn throws so that CI behaviour is byte-identical to the
    // inline process.exit it replaced. Without the catch this same run prints an uncaught
    // exception — which GitHub renders as a wall of frames and no annotation at all.
    const env = { ...process.env };
    delete env.BASE_SHA;
    delete env.HEAD_SHA;
    const run = spawnSync(process.execPath, [GUARD, 'HEAD', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env,
    });

    assert.equal(run.status, 1, `expected exit 1, got ${run.status}\n${run.stderr}`);
    assert.match(run.stderr, /::error::check-commit-message-parses: /);
    assert.match(run.stderr, /no commits at all, not even merges/);
    assert.doesNotMatch(
      run.stderr,
      /^\s+at .+:\d+:\d+/m,
      `the throw escaped main()'s catch and printed a stack:\n${run.stderr}`,
    );
  },
);
