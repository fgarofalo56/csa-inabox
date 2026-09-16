import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pollFields, parsePollFile, redactBodyFile } from '../parse-reindex-poll.mjs';

/**
 * #4498 round 6. These cover `parse-reindex-poll.mjs`, which was an inline
 * `node -e` block inside `reindex-loom-docs.sh` until this round. That inline
 * form was unreachable from a unit test — the only way to exercise it was to run
 * the whole shell script — and it carried its own hand-copied duplicate of every
 * redaction rule in `redact-secrets.mjs`.
 */

function writeBody(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reindex-poll-')), 'body.json');
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

test('parser: the seven fields come back in the order the shell reads positionally', () => {
  const fields = pollFields({
    ok: true,
    job: { state: 'running' },
    freshness: {
      state: 'stale',
      indexedChunkCount: 51079,
      lastRun: { outcome: 'failed', finishedAt: '2026-09-14T00:00:00Z', jobId: 'j-1', error: 'boom' },
    },
  });
  assert.equal(fields.length, 7);
  assert.deepEqual(fields, ['stale', 'running', '51079', 'failed', '2026-09-14T00:00:00Z', 'boom', 'j-1']);
});

/**
 * MUTATION-PROOF, and the reason this file exists. Swap `redactSecrets` in
 * `parse-reindex-poll.mjs` for an identity function — or re-inline a private
 * copy that drifts — and this goes RED. Before round 6 there was no test that
 * could: the shell's copy of the rules was reachable only end-to-end.
 *
 * Two-sided. The operator still has to be able to act on the error, so the host,
 * the path and the status all have to survive the redaction.
 */
test('parser: a credential in the remote error is redacted through the SHARED module, and the diagnosis survives', () => {
  // The allowlisted #4498 fixtures — each decodes to an English sentence saying
  // it must not be published. Same literals as the classifier tests, so no new
  // `.gitleaks.toml` entry is needed.
  const sig = 'Zm9yYmlkZGVuLXNpZ25hdHVyZS12YWx1ZS1kby1ub3QtcHVibGlzaA';
  const key = 'QWNjb3VudEtleVRoYXRNdXN0Tm90UmVhY2hUaGVMb2c9PQ';
  const [, , , , , le] = pollFields({
    freshness: {
      state: 'stale',
      lastRun: {
        error: `manifest PUT to https://loomstg.blob.core.windows.net/corpus/manifest.json?sig=${sig} failed: 403 Forbidden (AccountKey=${key})`,
      },
    },
  });

  assert.ok(!le.includes(sig), `SAS signature reached the shell field: ${le}`);
  assert.ok(!le.includes(key), `account key reached the shell field: ${le}`);
  assert.match(le, /sig=\[redacted\]/);
  assert.match(le, /AccountKey=\[redacted\]/);
  assert.ok(le.includes('https://loomstg.blob.core.windows.net/corpus/manifest.json'), le);
  assert.match(le, /403 Forbidden/);
  assert.match(le, /manifest PUT/);
});

/**
 * The SHOULD-FIX-4 anchor, pinned from the consumer side. `errorcode=` /
 * `statuscode=` end in the four characters `code=`, so the unanchored rule ate
 * any long diagnostic token following one of them. Revert the `[?&]` anchor in
 * `redact-secrets.mjs` and this goes RED.
 */
test('parser: a long token after `errorcode=` is a DIAGNOSTIC, not a Functions key', () => {
  const [, , , , , le] = pollFields({
    freshness: {
      lastRun: { error: 'rebuild refused errorcode=RequestDisallowedByPolicyLongEnough statuscode=403' },
    },
  });
  assert.match(le, /errorcode=RequestDisallowedByPolicyLongEnough/);
  assert.match(le, /statuscode=403/);
  assert.ok(!le.includes('[redacted]'), le);
});

test('parser: EVERY field is stripped of the pipe separator, not just the error', () => {
  // A pipe anywhere shifts every later field by one in the shell's positional
  // read, and these values come from a remote service.
  const fields = pollFields({
    job: { state: 'a|b' },
    freshness: { state: 'c|d', lastRun: { outcome: 'e|f', jobId: 'g|h', error: 'i|j' } },
  });
  for (const f of fields) assert.ok(!f.includes('|'), `field kept a separator: ${JSON.stringify(f)}`);
});

test('parser: a newline in a remote field cannot forge extra output lines', () => {
  const [state] = pollFields({ freshness: { state: 'stale\nfresh' } });
  assert.ok(!state.includes('\n'), state);
});

test('parser: the remote error is truncated to 300 characters', () => {
  const [, , , , , le] = pollFields({ freshness: { lastRun: { error: 'x'.repeat(1000) } } });
  assert.equal(le.length, 300);
});

test('parser: an absent lastRun yields empty strings, never the literal "undefined"', () => {
  const fields = pollFields({ freshness: { state: 'fresh' }, job: { state: 'idle' } });
  assert.deepEqual(fields, ['fresh', 'idle', '', '', '', '', '']);
});

test('parser: a non-integer indexedChunkCount is dropped rather than echoed', () => {
  const [, , c] = pollFields({ freshness: { indexedChunkCount: 'lots' } });
  assert.equal(c, '');
});

/**
 * A poll that returned no usable body must read as `unknown`, never as a hard
 * failure here: the classifier is what decides the verdict, and a parser that
 * exits non-zero would take that decision away from it.
 */
test('parser: unreadable and non-JSON bodies read as unknown, not as an error', () => {
  // The missing path is built under a mkdtempSync dir rather than as a constant
  // name under os.tmpdir(): `check-temp-artifact-safety.mjs` rejects the latter
  // (two concurrent runs would collide on it), and it is a required context, so
  // the constant-name form failed `guardrails` when this file was added. The dir
  // exists; only the file inside it does not, which is what the test needs.
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reindex-poll-'));
  const missing = parsePollFile(path.join(missingDir, 'no-such-reindex-body-4498.json'));
  assert.equal(missing, 'unknown|unknown|||||');

  const garbage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reindex-poll-')), 'body.json');
  fs.writeFileSync(garbage, '<html>504 Gateway Timeout</html>', 'utf8');
  assert.equal(parsePollFile(garbage), 'unknown|unknown|||||');
});

test('parser: a JSON body that is not an object is not trusted for property reads', () => {
  const p = writeBody('just a string');
  assert.equal(parsePollFile(p), 'unknown|unknown|||||');
});

/**
 * REDACT BEFORE TRUNCATE — PINNED HERE, WHERE THE PROPERTY IS DECLARED.
 *
 * `redactBodyFile`'s own docblock calls this ordering load-bearing, and until
 * now NOTHING in this file tested it — the function was not even imported. A
 * reviewer measured the consequence across four passes: two order-inverting
 * mutants (`redactSecrets(raw.slice(0, limit))` instead of
 * `redactSecrets(raw).slice(0, limit)`) SURVIVED every time.
 *
 * The asymmetry is what makes it worth closing: the sibling classifier has that
 * ordering pinned three times over after #4498's B1 work, while the module whose
 * comment declares the rule had zero coverage of it. The place a property is
 * WRITTEN DOWN and the place it is ENFORCED drifting apart is how B1 shipped in
 * the first place.
 */
/**
 * A file written VERBATIM, not through `JSON.stringify`.
 *
 * The ordering tests below depend on an exact byte offset, and `writeBody`
 * wraps its argument in quotes — which shifts everything by one and silently
 * moved the straddle by a character. Measured the hard way: the first version
 * of the test below used `writeBody`, so 17 credential characters survived the
 * cut while the assertion looked for 18, and the order-inverted mutant PASSED.
 * The leak was real and the assertion was aimed one character past it.
 */
function writeRaw(text) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reindex-raw-')), 'body.json');
  fs.writeFileSync(p, text, 'utf8');
  return p;
}

test('parser: redactBodyFile redacts BEFORE it truncates — a credential straddling the bound does not survive', () => {
  // Positioned arithmetically, because the defect is an off-by-boundary:
  //
  //   indices    0..775  padding                 (776 chars)
  //   index         776  a SPACE                 (1 char)
  //   indices  777..781  "code="                 (5 chars)
  //   indices  782..819  the 38-char credential
  //   slice(0, 800) keeps 0..799 -> 782..799 = 18 credential characters
  //
  // 18 is below the `code=` rule's {20,} floor, so truncate-then-redact leaves
  // those characters unmatched and publishes them.
  //
  // THE SPACE AT 776 IS LOAD-BEARING: the rule is `(?<![A-Za-z0-9_])(code=)`,
  // a deliberate negative lookbehind so `errorcode=` is not read as a key. With
  // `x` padding butted against it, `xcode=` never matches and the fixture tests
  // nothing.
  const SECRET = 'Zq7Rt2Wm9Xk4Lp6Vn8Jd3Hs5Fg1Ba0CeYuIoPw';
  const body = `${'x'.repeat(776)} code=${SECRET}`;
  assert.equal(body.indexOf(SECRET), 782, 'the credential must start at 782');
  assert.equal(SECRET.length, 38, 'the credential must outlast the bound');

  const out = redactBodyFile(writeRaw(body));

  assert.doesNotMatch(
    out,
    new RegExp(SECRET.slice(0, 18)),
    'a credential fragment survived the 800-char truncation — this is redact-AFTER-truncate',
  );
  assert.doesNotMatch(out, new RegExp(SECRET), 'the whole credential must not appear either');
});

test('parser: redactBodyFile still TRUNCATES — redacting first must not remove the bound', () => {
  // The order test above is satisfied by a function that never truncates at
  // all, so the bound is pinned separately. Otherwise "fix the ordering" and
  // "delete the limit" are indistinguishable to this suite — which is the same
  // absence-only trap the classifier's sibling test fell into.
  const out = redactBodyFile(writeRaw('y'.repeat(5000)));
  assert.equal(out.length, 800, 'the 800-char bound must still apply after redaction');
});


