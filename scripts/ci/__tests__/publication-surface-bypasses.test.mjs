/*
 * #3876 — the publication-surface enumerator's FOUR MEASURED BYPASSES, in tree.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE FOUR CONSUMER SUITES
 *
 *   The consumers each assert a property of ONE script and then re-prove the
 *   shared enumerator against the shared control. That makes the control's
 *   counts load-bearing four times over, which is good, and it makes the
 *   individual bypass shapes assertable only through those counts, which is not:
 *   a count moving tells you something changed, not WHICH access path was lost.
 *
 *   Three of the four bypasses are the dangerous kind — they do not mis-classify
 *   a write, they stop it being COUNTED. The checker then reports "no unbounded
 *   writes" because its population is zero, which is byte-identical to the
 *   report it produces on a genuinely clean file
 *   (guard_with_zero_population_needs_embedded_control). So each shape is
 *   asserted here BY ITSELF, both directions: the enumerator sees it, and the
 *   two legitimate shapes beside it stay clean.
 *
 * THE RATCHET
 *
 *   Narrowing `streamWrites` back to the literal dotted member expression, or
 *   `unboundedWrites` back to `arg.startsWith(`${fn}(`)`, fails a NAMED test
 *   here rather than moving a number in four other files. Every assertion below
 *   is over a synthetic source, so none of it can be satisfied by editing the
 *   real scripts.
 *
 * CRLF ON PURPOSE. Every fixture string in this file is joined with `\r\n` — the
 * line ending these files carry in a Windows working tree — so a `\n`-anchored
 * regression fails here rather than being silently green in CI
 * (csa_loom_crlf_makes_mutation_needles_silently_noop).
 *
 * Run: node --test scripts/ci/__tests__/publication-surface-bypasses.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  closingParen,
  forbiddenPublishers,
  inheritedStreamSpawns,
  streamBindings,
  streamWrites,
  stripComments,
  unboundedWrites,
  whollyBounded,
  CONTROL_SOURCE_CRLF,
  CONTROL_WRITE_COUNT,
  CONTROL_VIOLATION_COUNT,
} from './_publication-surfaces.mjs';

/** The control's own vocabulary: its boundaries plus the disclosed-exception marker. */
const ALLOWED = ['formatStdout', 'formatStderr', 'unredactedByDesign'];

const crlf = (...lines) => lines.join('\r\n');

// ── BYPASS 1 — the PREFIX-ONLY classifier ────────────────────────────────────

test('#3876 bypass 1 — a boundary call is not enough; it must consume the WHOLE argument', () => {
  // The shape the old classifier passed verbatim. `raw` was never examined.
  const src = crlf("function f(t, raw) { process.stdout.write(formatStdout(t) + raw); }", '');
  const found = unboundedWrites(src, ALLOWED);
  assert.equal(found.length, 1, 'a boundary call concatenated with a raw value was accepted');
  assert.equal(found[0].arg, 'formatStdout(t) + raw', 'the whole argument was not captured');

  // Every trailing shape, not just `+`. Enumerating operators would be the same
  // narrowing again, so the rule is stated as "nothing may follow the call".
  assert.equal(whollyBounded('formatStdout(a)', ALLOWED), true);
  assert.equal(whollyBounded('  formatStdout(a)  ', ALLOWED), true, 'surrounding whitespace is not a violation');
  assert.equal(whollyBounded('formatStdout(a) + raw', ALLOWED), false);
  assert.equal(whollyBounded('formatStdout(a) ?? raw', ALLOWED), false);
  assert.equal(whollyBounded("formatStdout(a), 'utf8'", ALLOWED), false, 'a second write() argument is a second surface');
  assert.equal(whollyBounded('formatStdout(a).slice(0, 80)', ALLOWED), false);
  assert.equal(whollyBounded('raw + formatStdout(a)', ALLOWED), false, 'a boundary in the TAIL is not a boundary');

  // …and the nesting the balanced slice exists for: a `)` inside a literal must
  // not close the call early, or a legitimate write would read as a violation
  // and the guard would be silenced rather than obeyed.
  assert.equal(whollyBounded('formatStdout(`a) b`)', ALLOWED), true, 'a paren inside a template literal closed the call');
  assert.equal(whollyBounded("formatStdout(f(g(x)))", ALLOWED), true, 'nested calls broke the balanced slice');
  assert.equal(whollyBounded('formatStdout({ a: 1 })', ALLOWED), true, 'an object literal broke the balanced slice');
  assert.equal(whollyBounded('formatStdout(`${f(x)}`)', ALLOWED), true, 'an interpolation broke the balanced slice');
});

test('#3876 — an UNBALANCED argument fails CLOSED', () => {
  // "I could not tell" must never render as "safe" (deploy-integrity R7).
  assert.equal(closingParen('formatStdout(a', 12), -1, 'an unbalanced call reported a close');
  const src = crlf('function f(t) { process.stdout.write(formatStdout(t', '');
  const found = unboundedWrites(src, ALLOWED);
  assert.equal(found.length, 1, 'a write whose argument could not be balanced was treated as bounded');
  assert.equal(found[0].balanced, false);
});

// ── BYPASSES 2-4 — the ACCESS PATHS, each a zero-population bypass ────────────

test('#3876 bypass 2 — `const out = process.stdout; out.write(raw)` is enumerated', () => {
  const src = crlf('function f(id) { const out = process.stdout; out.write(`raw ${id}`); }', '');
  assert.deepEqual([...streamBindings(src)], [['out', 'stdout']], 'the alias binding was not resolved');
  const writes = streamWrites(src);
  assert.equal(writes.length, 1, 'the write count was driven to ZERO by an alias — clean because nothing was counted');
  assert.equal(writes[0].stream, 'stdout');
  assert.equal(writes[0].accessPath, 'alias');
  assert.equal(unboundedWrites(src, ALLOWED).length, 1);

  // The same binding through bracket access on the right-hand side.
  const bracketBound = crlf("const e = process['stderr'];", 'e.write(raw);', '');
  assert.deepEqual([...streamBindings(bracketBound)], [['e', 'stderr']]);
  assert.equal(streamWrites(bracketBound)[0].stream, 'stderr');
});

test('#3876 bypass 3 — `const { stderr } = process; stderr.write(raw)` is enumerated', () => {
  const src = crlf('function f(id) { const { stderr } = process; stderr.write(`raw ${id}`); }', '');
  assert.deepEqual([...streamBindings(src)], [['stderr', 'stderr']], 'the destructured binding was not resolved');
  const writes = streamWrites(src);
  assert.equal(writes.length, 1, 'the write count was driven to ZERO by destructuring');
  assert.equal(writes[0].stream, 'stderr');
  assert.equal(writes[0].accessPath, 'alias');

  // Renamed, and alongside a sibling this module must ignore.
  const renamed = crlf('const { argv, stdout: emit, stderr: warn } = process;', 'emit.write(a);', 'warn.write(b);', '');
  assert.deepEqual(
    [...streamBindings(renamed)].sort(),
    [['emit', 'stdout'], ['warn', 'stderr']],
    'a renamed destructured stream was lost, or `argv` was mistaken for one',
  );
  assert.deepEqual(streamWrites(renamed).map((w) => w.stream), ['stdout', 'stderr']);

  // NON-DEGENERATE, the other direction: a destructure of something that is NOT
  // `process` must not manufacture a stream. `spawnSync` returns `{stdout,stderr}`
  // as BUFFERS, and counting `.write` on one would be noise the next author
  // silences — which is how a guard stops being obeyed.
  const notProcess = crlf('const { stdout, stderr } = spawnSync(cmd, args);', 'sink.write(stdout);', '');
  assert.equal(streamBindings(notProcess).size, 0, 'a non-process destructure manufactured a stream binding');
  assert.equal(streamWrites(notProcess).length, 0);
});

test('#3876 bypass 4 — `process[\'stdout\'].write(raw)` is enumerated', () => {
  const src = crlf("function f(id) { process['stdout'].write(`raw ${id}`); }", '');
  const writes = streamWrites(src);
  assert.equal(writes.length, 1, 'the write count was driven to ZERO by bracket access');
  assert.equal(writes[0].stream, 'stdout');
  assert.equal(writes[0].accessPath, 'bracket');
  assert.equal(unboundedWrites(src, ALLOWED).length, 1);

  // All three quote characters, since picking one would be an enumeration again.
  for (const q of ['\'', '"', '`']) {
    const s = `process[${q}stderr${q}].write(raw);`;
    assert.equal(streamWrites(s).length, 1, `bracket access with ${q} quoting was missed`);
    assert.equal(streamWrites(s)[0].stream, 'stderr');
  }
});

// ── THE NEGATIVE CONTROLS ────────────────────────────────────────────────────

test('#3876 — the legitimate shapes stay clean, or the guard gets silenced instead of obeyed', () => {
  const clean = crlf(
    'function bounded(t) { process.stdout.write(formatStdout(t)); }',
    'function alsoBounded(t) { process.stderr.write(formatStderr(t)); }',
    'function exempt(c) { process.stdout.write(unredactedByDesign(c)); }',
    '',
  );
  assert.equal(streamWrites(clean).length, 3, 'the enumerator lost a legitimate write');
  assert.deepEqual(unboundedWrites(clean, ALLOWED), [], 'a bounded write was reported as a violation');

  // A member named `stdout` on something that is not `process`, with no binding
  // anywhere, is not a publication surface.
  const foreign = crlf('logger.stdout.write(raw);', '');
  assert.equal(streamWrites(foreign).length, 0, 'a foreign `.stdout.write` was counted as a process stream');

  // Comments still do not count, in both directions.
  const commented = crlf('// process.stdout.write(`raw ${id}`)', 'process.stdout.write(formatStdout(t));', '');
  assert.equal(streamWrites(commented).length, 1, 'a write inside a comment was counted');
  assert.match(stripComments(commented), /process\.stdout\.write\(formatStdout/, 'the stripper ate real code');
});

// ── THE SHARED CONTROL, AND THE REAL ESTATE ──────────────────────────────────

test('#3876 — the shared control carries all four bypasses and its counts are pinned', () => {
  const writes = streamWrites(CONTROL_SOURCE_CRLF);
  assert.equal(writes.length, CONTROL_WRITE_COUNT, 'the control lost a write to a narrowed enumerator');
  assert.deepEqual(
    [...new Set(writes.map((w) => w.accessPath))].sort(),
    ['alias', 'bracket', 'dotted'],
    'the control no longer exercises every access path — three of the four bypasses would go undetected',
  );
  const found = unboundedWrites(CONTROL_SOURCE_CRLF, ALLOWED);
  assert.equal(found.length, CONTROL_VIOLATION_COUNT);
  assert.ok(
    found.some((w) => w.arg.startsWith('formatStdout(') && w.arg.includes('+')),
    'the control no longer carries the prefix-only bypass',
  );
});

test('#3876 — the six real publication scripts are clean under the WIDENED enumerator', () => {
  // The point of widening a guard is the estate it now covers. Asserting the
  // control alone would prove the matcher works and say nothing about whether
  // the files it guards pass it.
  //
  // #4498 round 6 added the last two rows, and the classifier could not simply
  // be listed: run over it beforehand this loop reported `unboundedWrites: 0`
  // AND `streamWrites: 0`. The zero was a POPULATION, not a verdict — both of
  // its publications were `console.log`, which no `process.stdout.write`
  // matcher can see. Enrolling it took converting those two calls into one
  // bounded `process.stdout.write(formatAnnotation(...))`. That is why the
  // `>= 1` and the forbidden-publisher assertions below are both here: either
  // one alone lets a file join this list while publishing invisibly.
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  //
  // The third column is the DECLARED set of inherited-stream spawns — see the
  // assertion at the bottom of the loop for why it is a declared set and not a
  // demand for zero.
  const subjects = [
    ['scripts/ci/deploy-arm-errors.mjs', ['formatStdout', 'formatStderr', 'unredactedByDesign'], []],
    [
      'scripts/ci/deploy-retry.mjs',
      ['formatAnnotation', 'formatStderr', 'unredactedByDesign'],
      ["stdio: ['inherit', 'inherit', 'pipe'] -> stdout"],
    ],
    ['.github/scripts/deploy-notify-failure.mjs', ['formatStdout', 'formatStderr'], []],
    ['scripts/csa-loom/converge-role-assignment.mjs', ['formatStdout'], []],
    ['scripts/ci/classify-reindex-result.mjs', ['formatAnnotation'], []],
    // Round 9 gave this module two more CLI modes, each with its own stdout
    // write, and round 10 caught that this column was not updated with them —
    // so the guard THIS PR built went red on a file THIS PR owns, in the one
    // suite that exists to notice a new unbounded publication surface. Both new
    // names are genuine redacting boundaries (`postJobId` and `redactBodyFile`
    // each route through `redact-secrets.mjs`), so enrolling them records a
    // fact rather than silencing a complaint.
    ['scripts/ci/parse-reindex-poll.mjs', ['parsePollFile', 'postJobId', 'redactBodyFile'], []],
  ];
  let total = 0;
  for (const [rel, boundaries, declaredInherited] of subjects) {
    const file = path.resolve(root, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing — the sum below would be a silent zero`);
    const src = fs.readFileSync(file, 'utf8');
    const writes = streamWrites(src);
    total += writes.length;
    assert.ok(writes.length >= 1, `${rel} enumerated ZERO writes — the matcher drifted, it did not stop publishing`);
    assert.deepEqual(
      forbiddenPublishers(src).map((f) => `${f.line}: ${f.hit} (${f.why})`),
      [],
      `${rel} publishes through a shape this lane's structural assertions cannot see`,
    );
    assert.deepEqual(
      unboundedWrites(src, boundaries).map((w) => `${w.line}: ${w.accessPath}: ${w.arg.split('\n')[0]}`),
      [],
      `${rel} publishes to a stream without the whole expression crossing a boundary (#3876)`,
    );
    // #4498 round 7 (review finding). The three assertions above are all
    // WRITE-based, and `_publication-surfaces.mjs:401` documents the spawn that
    // hands a child this process's stdout as "THE SURFACE NO WRITE-BASED
    // ENUMERATOR CAN SEE". Three other suites in this lane assert it per-script;
    // this loop did not, so a file could join the list, inherit its log to a
    // child, and read clean on every check here.
    //
    // CORRECTED BEFORE IT MERGED. This assertion was first written as a demand
    // for ZERO, justified in prose as "zero for all six today". That was
    // ASSERTED, NOT MEASURED, and it was false: `deploy-retry.mjs:826` spawns
    // its remediation child with `['inherit','inherit','pipe']`, deliberately
    // and with ~30 lines of disclosure at `:800-824`. The boundary for those
    // bytes belongs to the CHILD (`converge-role-assignment.mjs`, whose own
    // `formatStdout()` is pinned by its own suite), and `az provider register`
    // is a Microsoft tool printing its own output. A demand for zero would have
    // forced deleting a correct, documented design -- or deleting this check.
    //
    // So the expectation is DECLARED PER SUBJECT, the same shape as the
    // `boundaries` column: five declare none, one declares the surface it owns.
    // A NEW inherited spawn on any of the six still fails here. The line number
    // is deliberately NOT pinned -- `deploy-retry.mjs` is not in this PR's
    // declared files, and #4504 records line-based ids drifting under unrelated
    // edits; the SHAPE and the inherited slots are what carry the meaning.
    assert.deepEqual(
      inheritedStreamSpawns(src).map((s) => `${s.stdio} -> ${s.inherits.join(',')}`),
      declaredInherited,
      `${rel}: the set of spawns handing a child this process's public log CHANGED. ` +
        'Adding one is a decision, not a detail — declare it above with its disclosure, or remove it',
    );
  }
  // A coarse backstop against a matcher that stops counting across the board;
  // the per-file `>= 1` above is the sharp instrument. Round 7 tightened this
  // from 12: measured 17 at `e4cbca4970a` (6/6/2/1/1/1 per file), and since the
  // per-file floor already guarantees 6, a floor of 12 only had power over the
  // band [6,11] -- close to decorative, which is how a guard stops being obeyed.
  // 15 keeps the deliberate slack a pinned count would lose (a count is only a
  // fact with the commit it was taken at attached) without being free.
  assert.ok(total >= 15, `expected >=15 real stream writes across the six scripts, found ${total}`);
});
