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

test('#3876 — the four real publication scripts are clean under the WIDENED enumerator', () => {
  // The point of widening a guard is the estate it now covers. Asserting the
  // control alone would prove the matcher works and say nothing about whether
  // the files it guards pass it.
  const root = path.resolve(import.meta.dirname, '..', '..', '..');
  const subjects = [
    ['scripts/ci/deploy-arm-errors.mjs', ['formatStdout', 'formatStderr', 'unredactedByDesign']],
    ['scripts/ci/deploy-retry.mjs', ['formatAnnotation', 'formatStderr', 'unredactedByDesign']],
    ['.github/scripts/deploy-notify-failure.mjs', ['formatStdout', 'formatStderr']],
    ['scripts/csa-loom/converge-role-assignment.mjs', ['formatStdout']],
  ];
  let total = 0;
  for (const [rel, boundaries] of subjects) {
    const file = path.resolve(root, rel);
    assert.ok(fs.existsSync(file), `${rel} is missing — the sum below would be a silent zero`);
    const src = fs.readFileSync(file, 'utf8');
    const writes = streamWrites(src);
    total += writes.length;
    assert.ok(writes.length >= 1, `${rel} enumerated ZERO writes — the matcher drifted, it did not stop publishing`);
    assert.deepEqual(
      unboundedWrites(src, boundaries).map((w) => `${w.line}: ${w.accessPath}: ${w.arg.split('\n')[0]}`),
      [],
      `${rel} publishes to a stream without the whole expression crossing a boundary (#3876)`,
    );
  }
  assert.ok(total >= 10, `expected >=10 real stream writes across the four scripts, found ${total}`);
});
