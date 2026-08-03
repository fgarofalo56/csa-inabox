/**
 * temp-artifact-safety guard tests.
 *
 * The guard exists because the UAT harness wrote screenshots of an
 * AUTHENTICATED console session to `/tmp/loom-uat` — a fixed name in a
 * world-writable directory on a multi-user jumpbox (CodeQL
 * js/insecure-temporary-file #323 / #330).
 *
 * THE CASE THAT MATTERS MOST IS `decodeEmbeddedPayloads`. A hardened creator
 * was added for those alerts and they stayed open, because the documented
 * runner (`scripts/csa-loom/uat-runner-final.sh`) does not execute the file in
 * this tree — it `base64 -d`s an EMBEDDED COPY that predated the module and
 * called `fs.mkdirSync('/tmp/loom-uat', {recursive:true})` bare. A guard that
 * only reads what it can see would have reported this repo clean while the
 * vulnerable code ran, which is the whole failure mode being closed.
 *
 * MUTATION-PROVEN (counts in the PR body): restoring the fixed path in
 * uat-fd.mjs AND restoring the stale base64 payload in uat-runner-final.sh
 * turns the repo-wide guard RED with 2 violations naming both — including the
 * one inside the base64 blob — and 0 after restore.
 *
 * Run: node --test scripts/ci/__tests__/temp-artifact-safety.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripComments,
  scanSource,
  decodeEmbeddedPayloads,
} from '../check-temp-artifact-safety.mjs';

/* ------------------------------- comments -------------------------------- */

test('CONTROL: prose describing the bug is not the bug', () => {
  // Both fixed source files, and the guard itself, must be free to SAY
  // "/tmp/loom-uat" while not DOING it.
  const src = "// never a fixed path like /tmp/loom-uat — see _artifact-dir.mjs\n"
    + "# mkdir -p /tmp/loom-uat was the old shell line\n";
  assert.deepEqual(scanSource(src, 'a.mjs'), []);
});

test('stripComments blanks whole-line comments in both syntaxes', () => {
  assert.deepEqual(stripComments('// x\n# y\ncode()'), ['', '', 'code()']);
});

/* -------------------------------- js sinks -------------------------------- */

test('THE BUG: a fixed path under a shared temp root', () => {
  const hits = scanSource("const D = '/tmp/loom-uat';\n", 'a.mjs');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('/var/tmp and /dev/shm are shared too', () => {
  assert.equal(scanSource("const a = '/var/tmp/loom';\n", 'a.mjs').length, 1);
  assert.equal(scanSource("const b = '/dev/shm/loom';\n", 'a.mjs').length, 1);
});

test('os.tmpdir() with a constant name is the same defect wearing an API', () => {
  const hits = scanSource("const d = path.join(os.tmpdir(), 'loom-uat');\n", 'a.mjs');
  assert.equal(hits.length, 1);
});

test('CONTROL: mkdtempSync is the CORRECT API and must stay green', () => {
  const src = "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-'));\n";
  assert.deepEqual(scanSource(src, 'a.mjs'), []);
});

test('CONTROL: os.tmpdir() NOT being combined into a path is not a sink', () => {
  // This is the assertion that PROVES the default is outside the temp dir. An
  // earlier version of the heuristic flagged it, which would have meant the
  // guard reporting the code that verifies the guard's own property.
  const src = 'assert.ok(!d.startsWith(os.tmpdir() + path.sep));\n';
  assert.deepEqual(scanSource(src, 'a.test.mjs'), []);
});

test('CONTROL: the bare temp root is not flagged — only a fixed CHILD of it', () => {
  // '/tmp' alone is nearly always a base about to be combined with something
  // random; flagging it is the noise that gets a guard switched off.
  assert.deepEqual(scanSource("const base = '/tmp';\n", 'a.mjs'), []);
});

/* ------------------------------ shell sinks ------------------------------- */

test('THE BUG in shell: mkdir of a fixed path under a shared temp root', () => {
  const hits = scanSource('mkdir -p /tmp/loom-uat\n', 's.sh');
  assert.equal(hits.length, 1);
});

test('CONTROL: mkdir of a path under $HOME stays green', () => {
  assert.deepEqual(scanSource('mkdir -m 700 -p "$HOME/.loom-uat"\n', 's.sh'), []);
  assert.deepEqual(scanSource('mkdir -m 700 -p "${LOOM_UAT_ARTIFACT_DIR:-$HOME/.loom-uat}"\n', 's.sh'), []);
});

test('CONTROL: plain mktemp stays green', () => {
  assert.deepEqual(scanSource('F="$(mktemp)"\n', 's.sh'), []);
});

/* -------------------- the embedded-payload case (the point) -------------- */

/**
 * The guard only treats a quoted run of 200+ base64 chars as an embedded
 * program, so that ordinary strings, hashes and tokens are not decoded as
 * source. Fixtures therefore have to be program-sized — pad them the way a real
 * script is padded, with its own header.
 */
const HEADER = '#!/usr/bin/env node\n'
  + '// CSA Loom Console — UAT smoke test\n'
  + '// Designed to run on the UAT jumpbox (VNet-internal access to the Console).\n'
  + "import { chromium } from 'playwright';\nimport fs from 'fs';\nimport path from 'path';\n";

/** @param {string} program @returns {string} a shell line embedding it */
function embed(program) {
  return `echo '${Buffer.from(HEADER + program).toString('base64')}' | base64 -d > x.mjs\n`;
}

test('decodes a base64-embedded program out of a shell script', () => {
  const program = "const SCREENSHOT_DIR = '/tmp/loom-uat';\n";
  const payloads = decodeEmbeddedPayloads(embed(program));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].payload, HEADER + program);
});

test('THE ORIGINAL MISS: the vulnerable line is invisible to a plain scan and caught in the payload', () => {
  const program = "const SCREENSHOT_DIR = '/tmp/loom-uat';\nfs.mkdirSync(SCREENSHOT_DIR, { recursive: true });\n";
  const sh = embed(program);

  // Scanning the shell TEXT finds nothing — this is exactly how the bug shipped.
  assert.deepEqual(scanSource(sh, 'run.sh'), []);

  // Scanning the DECODED payload finds it.
  const [{ payload }] = decodeEmbeddedPayloads(sh);
  const hits = scanSource(payload, 'run.sh (base64-embedded payload)');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].snippet, "const SCREENSHOT_DIR = '/tmp/loom-uat';");
});

test('CONTROL: a safe embedded payload decodes and stays green', () => {
  const program = 'const D = process.env.LOOM_UAT_ARTIFACT_DIR;\n';
  const [{ payload }] = decodeEmbeddedPayloads(embed(program));
  assert.deepEqual(scanSource(payload, 'run.sh (payload)'), []);
});

test('CONTROL: a short quoted string is not mistaken for an embedded program', () => {
  assert.deepEqual(decodeEmbeddedPayloads("echo 'abc123' > x\n"), []);
});
