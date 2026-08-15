/**
 * safe-error.mjs — log-injection defence (CodeQL js/log-injection #762).
 *
 * WHAT THIS SUITE IS FOR. `publicErrorMessage` concentrates every failure in the
 * bridge into ONE `console.error`, which concentrated the SINK too: CodeQL
 * traced `readBody(req)` -> `parsed` -> `client.rpc(parsed)` -> `message.method`
 * -> `new Error(`timeout after ...ms calling ${method}`)` -> that log line. A
 * caller who names their JSON-RPC method with an embedded CR/LF forges records.
 *
 * TWO KINDS OF ASSERTION, deliberately, because either alone is a hole:
 *
 *   BEHAVIOUR — the emitted record is one line, whatever the caught value.
 *     This is the property that actually matters, and it held even while #762
 *     was open: the pre-fix `/[\r\n]+/g -> ' '` does strip. A suite carrying
 *     only these tests would have been green for the entire time the alert was
 *     live, which is why it cannot be the whole receipt.
 *
 *   SHAPE — the newline strip CodeQL actually models is present in the source.
 *     This is the half that was missing, and the half that fails if the fix is
 *     reverted. `StringReplaceSanitizer` in LogInjectionQuery.qll is exactly
 *     `replaces(s, "") and s.regexpMatch("\\n")`: the replaced string must be
 *     "\n" AND the replacement must be the EMPTY string. Replacing with a SPACE
 *     matches neither half, so the whole helper was invisible to the scanner and
 *     every call site stayed flagged. Mirrors RULE 1 of
 *     scripts/ci/check-log-injection.mjs, which guards the console's copy of
 *     this helper the same way.
 *
 * The shape assertion carries its own CONTROL: the detector is proved to REJECT
 * the pre-fix space-replacement form. A detector that matched both shapes would
 * report success while measuring nothing.
 *
 * Run: node --test apps/fiab-mcp-bridge/tests/safe-error.test.mjs
 * (also discovered automatically by scripts/ci/check-node-test-suites.mjs)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { logSafe, publicErrorMessage, publicRpcError } from '../src/safe-error.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'safe-error.mjs');

/**
 * The construct CodeQL models: a newline replaced by the EMPTY string, via
 * `.replaceAll('\n', '')` or `.replace(/\n/g, '')`. The same pair of patterns
 * scripts/ci/check-log-injection.mjs uses on the console helper.
 */
const MODELLED_STRIP = [
  /\.replaceAll\(\s*(['"])\\n\1\s*,\s*(['"])\2\s*\)/,
  /\.replace\(\s*\/\\n\/g\s*,\s*(['"])\1\s*\)/,
];

const matchesModelled = (src) => MODELLED_STRIP.some((re) => re.test(src));

// ── SHAPE: the half that was missing, and the half a revert breaks ──────────

test('the newline strip CodeQL models is present in safe-error.mjs', () => {
  const src = readFileSync(SRC, 'utf8');
  assert.ok(
    matchesModelled(src),
    'logSafe() no longer contains the newline strip CodeQL recognises.\n' +
      "Required (the replacement must be the EMPTY string):  .replaceAll('\\n', '')\n" +
      'Without it the scanner sees NO sanitizer and every console.* call site in\n' +
      'this package is re-flagged — which is exactly what js/log-injection #762\n' +
      'was, raised two days AFTER #2849 believed it had fixed this file.',
  );
});

test('CONTROL — the detector rejects the pre-fix space-replacement form', () => {
  // Without this control the assertion above could be passing on any source at
  // all. These are the two shapes this file actually shipped while #762 was open.
  assert.equal(matchesModelled("raw.replace(LINE_BREAKS, ' ')"), false);
  assert.equal(matchesModelled("raw.replace(/[\\r\\n]+/g, ' ')"), false);
  // ... and it accepts the fixed shape, so it is not simply always-false.
  assert.equal(matchesModelled("flat.replaceAll('\\n', '')"), true);
});

test('control characters are spelled as escapes, never as raw bytes', () => {
  // A literal control byte is invisible in every editor and diff, so one
  // reformat silently neuters the strip while the file still compiles.
  const src = readFileSync(SRC, 'utf8');
  const raw = [...src].filter((c) => {
    const n = c.charCodeAt(0);
    return (n < 0x20 && c !== '\n' && c !== '\r' && c !== '\t') || n === 0x7f;
  });
  assert.deepEqual(raw, []);
});

// ── BEHAVIOUR: the property the shape assertion exists to protect ───────────

test('logSafe strips CR/LF so a value cannot frame a second record', () => {
  const forged = logSafe('timeout calling tools/list\n[mcp-bridge] FORGED admin=true');
  assert.ok(!forged.includes('\n'), forged);
  assert.ok(!forged.includes('\r'), forged);
  assert.ok(
    forged.includes('FORGED admin=true'),
    'the text is kept — this flattens, it does not redact',
  );
});

test('logSafe strips the remaining C0 controls and DEL', () => {
  // Built with String.fromCharCode, never literal bytes and never escapes a
  // reformat can mangle -- a raw control character in a fixture is as invisible
  // in review as one in the source it is testing.
  const NUL = String.fromCharCode(0x00);
  const ESC = String.fromCharCode(0x1b);
  const DEL = String.fromCharCode(0x7f);
  const out = logSafe('a' + NUL + 'b' + ESC + 'c' + DEL + 'd');
  for (const ch of [NUL, ESC, DEL]) {
    assert.ok(!out.includes(ch), JSON.stringify(out));
  }
  assert.equal(out, 'a b c d');
});

test('logSafe bounds length so one field cannot flood a record', () => {
  const out = logSafe('x'.repeat(5000));
  assert.ok(out.length <= 2000 + 3, out.length);
  assert.ok(out.endsWith('...'));
});

test('logSafe returns a plain string for null/undefined', () => {
  assert.equal(logSafe(null), '');
  assert.equal(logSafe(undefined), '');
});

test('publicErrorMessage emits exactly ONE log record for a CR/LF-bearing error', () => {
  const seen = [];
  const original = console.error;
  console.error = (...args) => seen.push(args.map(String).join(' '));
  try {
    publicErrorMessage(
      new Error('boom\r\n[mcp-bridge] FORGED ref=deadbeef'),
      'MCP server call failed',
    );
  } finally {
    console.error = original;
  }
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].includes('\n'), JSON.stringify(seen[0]));
  assert.ok(!seen[0].includes('\r'), JSON.stringify(seen[0]));
});

test('the caught value never reaches the client-visible message', () => {
  const original = console.error;
  console.error = () => {};
  let msg;
  let rpc;
  try {
    const e = new Error('/root/.npm/_npx/abc123/node_modules/foo: ENOENT');
    msg = publicErrorMessage(e, 'MCP server call failed');
    rpc = publicRpcError(e, 'MCP server call failed');
  } finally {
    console.error = original;
  }
  assert.ok(!msg.includes('ENOENT'));
  assert.ok(!msg.includes('/root/.npm'));
  assert.match(msg, /^MCP server call failed \(ref: [0-9a-f]{8}\)$/);
  assert.equal(rpc.code, -32000);
  assert.ok(!rpc.message.includes('ENOENT'));
  assert.match(rpc.message, /^MCP server call failed \(ref: [0-9a-f]{8}\)$/);
});
