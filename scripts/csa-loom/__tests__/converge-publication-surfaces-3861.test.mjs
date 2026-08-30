/*
 * #3861 — converge-role-assignment.mjs has ONE publication boundary, and it is
 * load-bearing end to end.
 *
 * The file used to redact PER SITE — a `redact()` around each `${…}` its author
 * was thinking about. That is the exact shape PR #3835 spent four rounds on:
 * every new write is a new opportunity to forget, and the assertion that the
 * enumeration is complete goes stale the moment someone adds a line. One already
 * had: `run()`'s parse-error branch interpolated `e.message` raw, and
 * `parseArgs` throws `unknown argument: <the argument itself>`, so a GUID handed
 * to the wrong flag reached the run log verbatim.
 *
 * WHY THIS FILE AND NOT THE PARENT'S SUITE. deploy-retry.mjs spawns this script
 * with `stdio: ['inherit', 'inherit', 'pipe']`, handing it the PARENT's stdout
 * file descriptor. The child's bytes land in the public Actions run log with no
 * `process.stdout.write` anywhere in deploy-retry's source, so no write-based
 * assertion over that file can see them. The boundary has to live on the child,
 * and so does the assertion that it exists.
 *
 * Every property below is over the WHOLE SET rather than over one row, and the
 * enumerator carries its own control — a structural guard over a clean tree has
 * a zero population by construction, and reports "no violations" identically
 * when it has stopped looking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  callCount,
  forbiddenPublishers,
  streamWrites,
  stripComments,
  unboundedWrites,
  CONTROL_SOURCE_CRLF,
} from '../../ci/__tests__/_publication-surfaces.mjs';

import { EXIT_USAGE, decide, formatStdout, run } from '../converge-role-assignment.mjs';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'converge-role-assignment.mjs');
const SRC = fs.readFileSync(SCRIPT, 'utf8');

/** The only name allowed to appear at a stream write in this file. */
const BOUNDARIES = ['formatStdout'];

/** A subscription id shaped exactly like the one this script handles. */
const SUB = '99999999-8888-7777-6666-555555555555';

test('STRUCTURAL — every write to a public stream crosses formatStdout()', () => {
  const writes = streamWrites(SRC);
  // Non-degenerate. Zero would mean the enumerator drifted, not that the file
  // stopped publishing.
  assert.ok(writes.length >= 1, `expected >=1 stream write, found ${writes.length}`);

  assert.deepEqual(
    unboundedWrites(SRC, BOUNDARIES).map((w) => `${w.line}: ${w.arg.split('\n')[0]}`),
    [],
    'a write to a PUBLIC stream bypasses the redaction boundary (#3861)',
  );

  // The surfaces that reach a stream WITHOUT `process.<stream>.write` —
  // console.*, GITHUB_STEP_SUMMARY, the actions toolkit. Any of them would be a
  // publication with no boundary to attach to.
  assert.deepEqual(forbiddenPublishers(SRC), [], 'a publication shape with no boundary to attach to');
});

test('STRUCTURAL — the PER-SITE redaction is gone, so the boundary is load-bearing', () => {
  const code = stripComments(SRC);
  // A boundary with a bypass beside it is decorative. `redact(` must not appear
  // in the executable source at all; the file reaches redaction only through
  // `redactedLine`, and only from inside formatStdout().
  assert.equal(callCount(SRC, 'redact'), 0, 'a per-site redact() call survives beside the boundary');
  assert.equal(
    callCount(SRC, 'redactedLine'),
    1,
    'redactedLine is called from somewhere other than the single boundary',
  );
  assert.match(code, /function formatStdout\(text\) \{\s*return redactedLine\(text\);/,
    'formatStdout no longer delegates to the shared primitive');

  // No disclosed exceptions in this file. If one is ever needed it must be named
  // with unredactedByDesign() so it is COUNTED, and this number must move.
  assert.equal(callCount(SRC, 'unredactedByDesign'), 0, 'an unredacted publication appeared');
});

test('STRUCTURAL — decide() has exactly ONE return, so no verdict can skip the boundary', () => {
  const code = stripComments(SRC);
  const start = code.indexOf('export function decide(io)');
  assert.ok(start > 0, 'decide() was renamed or removed — this assertion lost its subject');
  const end = code.indexOf('function decideBranches(', start);
  assert.ok(end > start, 'decideBranches() was renamed — the boundary may no longer wrap the branches');
  const body = code.slice(start, end);
  assert.equal(
    (body.match(/\breturn\b/g) ?? []).length,
    1,
    'decide() grew a second return; a verdict can now reach a caller without crossing formatStdout()',
  );
  assert.match(body, /reason: formatStdout\(v\.reason\)/, 'the verdict no longer crosses the boundary');
});

test('SELF-DEFENCE — the enumerator can actually detect an unbounded write', () => {
  // Over the shared control source, which is CRLF on purpose: a newline-sensitive
  // regression must fail HERE rather than be silently green in CI.
  // The control's own vocabulary: its boundaries plus the disclosed-exception
  // marker. This file has no exceptions of its own (asserted above); the marker
  // is allowed HERE only so the control's 2 deliberate violations are the only
  // hits, and the count below stays a statement about those two.
  const found = unboundedWrites(
    CONTROL_SOURCE_CRLF,
    BOUNDARIES.concat('formatStderr', 'unredactedByDesign'),
  );
  assert.equal(found.length, 2, `expected the control's 2 violations, found ${found.length}`);
  assert.ok(found.some((w) => w.arg.startsWith('`deploy:')), 'a bare template-literal write was not detected');
  assert.ok(
    found.some((w) => w.arg.startsWith('redact(')),
    'a PER-SITE redact() at a write was not detected — that is the #3861 shape itself',
  );
  assert.equal(streamWrites(CONTROL_SOURCE_CRLF).length, 5, 'the control source lost a write to CRLF handling');

  // The comment stripper is load-bearing here too: this file's own header names
  // `process.stdout.write` in prose, and counting that would inflate every
  // number above. Both directions, or it is not a control.
  assert.equal(
    stripComments(SRC).split('stdio: [').length - 1,
    0,
    'the stripper left header prose in the executable source — every count above is inflated',
  );
  assert.match(stripComments(SRC), /process\.stdout\.write\(formatStdout\(/, 'the stripper ate real code');
});

test("BEHAVIOURAL — a GUID reaching e.message on the parse-error path is redacted", () => {
  // The exact defect #3861 named. `parseArgs` throws `unknown argument: <arg>`,
  // so the GUID below is the argument itself.
  const lines = [];
  const rc = run([`--subscription=${SUB}`], {
    az: () => assert.fail('az must not run on a usage error'),
    log: (s) => lines.push(s),
  });
  assert.equal(rc, EXIT_USAGE);
  const out = lines.join('\n');
  // Non-degenerate: the message really did carry the argument, so the assertion
  // below is about redaction and not about an empty string.
  assert.match(out, /unknown argument/, 'the parse error no longer reports the argument at all');
  assert.doesNotMatch(out, new RegExp(SUB), 'the subscription id reached the log verbatim');
  assert.match(out, /<guid>/, 'the id was dropped rather than redacted — the message must stay diagnostic');
});

test('BEHAVIOURAL — the REAL default sink redacts, not merely the injected test seam', () => {
  // The production path: no `deps.log`, so `process.stdout.write` is reached.
  // A boundary only present on the seam is not a boundary.
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  let rc;
  try {
    rc = run([`--subscription=${SUB}`], { az: () => assert.fail('az must not run on a usage error') });
  } finally {
    process.stdout.write = original;
  }
  assert.equal(rc, EXIT_USAGE);
  const out = written.join('');
  assert.ok(out.length > 0, 'nothing was written — this control has no population');
  assert.doesNotMatch(out, new RegExp(SUB));
  assert.match(out, /<guid>/);
  assert.ok(out.endsWith('\n'), 'the boundary dropped the line terminator');
});

test('BEHAVIOURAL — a verdict reason is redacted even when nothing publishes it', () => {
  // decide() is exported and unit-tested; a caller that logs `verdict.reason`
  // directly must not be the hole. Idempotence is what makes this safe to stack:
  // the string is redacted here and again at the write.
  const v = decide({
    assignmentName: '0a2b7dc58eb449709418694f83a6c164',
    listAssignments: () => ({ status: 1, assignments: null, error: `read failed on /subscriptions/${SUB}` }),
  });
  assert.doesNotMatch(v.reason, new RegExp(SUB));
  assert.match(v.reason, /<redacted>/);
  assert.equal(formatStdout(v.reason), v.reason, 'redaction is not idempotent — stacking the boundary is unsafe');
});
