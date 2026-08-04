/**
 * Regression suite for the `az()` failure path in `_drill-lib.mjs`
 * (CodeQL js/clear-text-logging #664).
 *
 * THE DEFECT. `validate-kv-recovery.mjs` runs
 *
 *     az(['keyvault','secret','set','--vault-name',V,'--name',C,'--value',secret,
 *         '--subscription', process.env.VAULT_SUB])
 *
 * and the old failure path printed `args.join(' ')` plus `err.message`. This
 * repository is PUBLIC, and so are its Actions logs.
 *
 * THREE CHANNELS, and a test that only covered the log line would have left two
 * open. They are asserted separately below:
 *   1. the `console.error` line,
 *   2. the thrown error's `.message` — which `makeReport().check` copies into
 *      `checks[].detail`, i.e. into the report JSON uploaded as an artifact,
 *   3. that same `.message` again via the validators' top-level `console.error(err)`.
 *
 * FIXTURES MODEL REALITY. The premise of the whole fix is that node's
 * `execFileSync` error message contains the argv. That is not asserted from
 * memory — `realExecFileFailure()` runs a real failing child with a real
 * secret-shaped argument and the suite asserts the leak IS present before
 * asserting the scrub removes it. If node ever stops embedding the argv, the
 * premise test goes red rather than the fix quietly becoming decorative.
 *
 * Run: node --test scripts/csa-loom/dr/__tests__/drill-lib-redaction.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  az,
  secretValuesIn,
  redactAzArgs,
  scrubSecrets,
  azError,
} from '../_drill-lib.mjs';

// Deliberately LOW-entropy so gitleaks' generic-api-key rule cannot fire on a
// redaction test's own fixture. Length and shape still match the randomBytes(24)
// canary this exercises; the value's only job is to be findable in the output.
const SECRET = 'AAAAAAAABBBBBBBBCCCCCCCC';               // shaped like the randomBytes(24) canary
const SUB = '11111111-2222-3333-4444-555555555555';         // shaped like a subscription id
const VAULT = 'kv-loom-example';
const CANARY = 'drdrill-canary-local-1';

/** The exact argv shape validate-kv-recovery.mjs passes to `az()`. */
const KV_SET_ARGS = [
  'keyvault', 'secret', 'set',
  '--vault-name', VAULT,
  '--name', CANARY,
  '--value', SECRET,
  '--subscription', SUB,
];

/**
 * A REAL execFileSync failure carrying the same sensitive arguments, so the
 * suite works against node's actual error shape rather than a guess at it.
 */
function realExecFileFailure(args) {
  try {
    execFileSync(process.execPath, ['-e', 'process.exit(3)', ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return err;
  }
  throw new Error('expected the child to fail — the premise of this suite is broken');
}

// ── secretValuesIn ─────────────────────────────────────────────────────────

test('secretValuesIn finds the space-separated form', () => {
  assert.deepEqual(secretValuesIn(KV_SET_ARGS).sort(), [SECRET, SUB].sort());
});

test('secretValuesIn finds the --flag=value form', () => {
  assert.deepEqual(secretValuesIn([`--value=${SECRET}`, `--subscription=${SUB}`]).sort(),
    [SECRET, SUB].sort());
});

test('secretValuesIn ignores values shorter than 4 chars (a 1-char needle would shred prose)', () => {
  assert.deepEqual(secretValuesIn(['--value', 'ab']), []);
});

test('secretValuesIn ignores a trailing sensitive flag with no value', () => {
  assert.deepEqual(secretValuesIn(['keyvault', 'secret', 'set', '--value']), []);
});

// ── redactAzArgs ───────────────────────────────────────────────────────────

test('redactAzArgs replaces the values and keeps the command shape', () => {
  assert.deepEqual(redactAzArgs(KV_SET_ARGS), [
    'keyvault', 'secret', 'set',
    '--vault-name', VAULT,
    '--name', CANARY,
    '--value', '***',
    '--subscription', '***',
  ]);
});

test('redactAzArgs handles the --flag=value spelling', () => {
  assert.deepEqual(redactAzArgs([`--value=${SECRET}`]), ['--value=***']);
});

// CONTROL — must hold both before and after the fix. A redactor that returned
// '***' for everything would pass every assertion above and be useless.
test('CONTROL: non-sensitive arguments survive redaction verbatim', () => {
  const args = ['keyvault', 'show', '-n', VAULT, '-o', 'json'];
  assert.deepEqual(redactAzArgs(args), args);
});

test('CONTROL: scrubSecrets leaves text with no secrets in it unchanged', () => {
  const text = 'ERROR: (VaultNotFound) Vault not found. CorrelationId: 9f0c2c1e-dead-beef-0000-123456789abc';
  assert.equal(scrubSecrets(text, KV_SET_ARGS), text);
});

test('CONTROL: an Azure correlation GUID survives — the scrub is not a GUID dragnet', () => {
  const text = `activity-id 9f0c2c1e-dead-beef-0000-123456789abc for subscription ${SUB}`;
  assert.ok(scrubSecrets(text, KV_SET_ARGS).includes('9f0c2c1e-dead-beef-0000-123456789abc'),
    'correlation ids are the only handle on a failed drill and must survive');
});

test('the argv subscription IS removed from free text', () => {
  const text = `activity-id 9f0c2c1e-dead-beef-0000-123456789abc for subscription ${SUB}`;
  assert.ok(!scrubSecrets(text, KV_SET_ARGS).includes(SUB));
});

// ── the three leak channels, driven through the real `az()` catch block ────
//
// These call `az()` with the `_exec` seam so the ACTUAL failure path runs on a
// machine with no `az` on PATH. Driving `azError` directly was tried first and
// was WORSE THAN USELESS: node's error carries stderr as well as the argv, and
// `azError` prefers stderr, so those assertions passed with the redaction
// removed. The mutation caught it; reading the test did not. Anything that
// exercises less than `az()` cannot see the defect, which was `throw err`.

/** Run `az()` against a real execFileSync error, capturing what it logs. */
function runAzFailure(args, { allowFail = false } = {}) {
  const realErr = realExecFileFailure(['--value', SECRET, '--subscription', SUB]);
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  let thrown;
  try {
    az(args, { allowFail, _exec: () => { throw realErr; } });
  } catch (e) {
    thrown = e;
  } finally {
    console.error = original;
  }
  return { thrown, logged: logged.join('\n'), realErr };
}

test('PREMISE: the error `az` catches carries the argv — so re-throwing it leaks', () => {
  const { realErr } = runAzFailure(KV_SET_ARGS);
  assert.ok(realErr.message.includes(SECRET), 'premise gone: node no longer embeds the argv');
});

test('CHANNEL 1: the console.error line carries neither the secret nor the subscription', () => {
  const { logged } = runAzFailure(KV_SET_ARGS);
  assert.ok(logged.length > 0, 'the failure was not logged at all');
  assert.ok(!logged.includes(SECRET), logged);
  assert.ok(!logged.includes(SUB), logged);
  // …and it is still a useful diagnostic.
  assert.ok(logged.includes('keyvault secret set'));
  assert.ok(logged.includes(CANARY));
});

test('CHANNEL 2: the THROWN error .message (→ report JSON detail) is scrubbed', () => {
  const { thrown } = runAzFailure(KV_SET_ARGS);
  assert.ok(thrown, 'az() must still throw');
  assert.ok(!thrown.message.includes(SECRET), thrown.message);
  assert.ok(!thrown.message.includes(SUB), thrown.message);
});

test('CHANNEL 3: the thrown error .stack (what console.error(err) prints) is scrubbed', () => {
  const { thrown } = runAzFailure(KV_SET_ARGS);
  assert.ok(!String(thrown.stack).includes(SECRET));
  assert.ok(!String(thrown.stack).includes(SUB));
});

test('allowFail: still throws, still scrubbed, and stays SILENT', () => {
  const { thrown, logged } = runAzFailure(KV_SET_ARGS, { allowFail: true });
  assert.ok(thrown && thrown.failed === true);
  assert.ok(!thrown.message.includes(SECRET));
  assert.equal(logged, '', 'allowFail must not print — callers poll with it');
});

test('az() preserves the fields callers branch on', () => {
  const { thrown } = runAzFailure(KV_SET_ARGS);
  assert.equal(thrown.failed, true);
  assert.equal(typeof thrown.status, 'number');
  assert.equal(typeof thrown.stderr, 'string');
});

test('azError prefers stderr over message, matching the pre-fix contract', () => {
  const e = azError({ stderr: 'ERROR: purge protection is enabled', message: 'Command failed: az …' }, []);
  assert.equal(e.message, 'ERROR: purge protection is enabled');
  assert.equal(e.stderr, 'ERROR: purge protection is enabled');
});

test('a subscription id echoed by az\'s OWN stderr is scrubbed too', () => {
  // Real az text: "The subscription '<guid>' could not be found." — the id
  // reaches the log through stderr, not through the argv, so preferring stderr
  // is not by itself a fix.
  const e = azError(
    { stderr: `ERROR: The subscription '${SUB}' could not be found.`, status: 1 },
    ['keyvault', 'show', '-n', VAULT, '--subscription', SUB],
  );
  assert.ok(!e.message.includes(SUB), e.message);
  assert.ok(!e.stderr.includes(SUB), e.stderr);
  assert.ok(e.message.includes('could not be found'), 'the diagnosis must survive');
});

test('validate-kv-recovery still sees a purge-protection error through the scrub', () => {
  // Line 102 of validate-kv-recovery.mjs regex-tests `err.stderr || err.message`.
  const e = azError(
    { stderr: '(ForbiddenByPolicy) Operation "purge" is not permitted on this vault.', status: 1 },
    ['keyvault', 'secret', 'purge', '--vault-name', VAULT, '--subscription', SUB],
  );
  const msg = String(e.stderr || e.message);
  assert.match(msg, /purge.*(protect|disabled|not allowed)|ForbiddenByPolicy|Operation.*not permitted/i);
  assert.ok(!msg.includes(SUB));
});
