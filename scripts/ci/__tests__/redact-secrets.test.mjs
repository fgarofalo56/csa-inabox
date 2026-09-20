/*
 * #4498 round 7 — the redaction module had NO test file at all.
 *
 * WHY THIS EXISTS. Round 6 narrowed the Azure Functions-key rule from `(code=)`
 * to `([?&]code=)` to stop it eating the tail of `errorcode=`/`statuscode=`.
 * That fixed a real false positive and silently opened a real hole: `code=KEY`,
 * ` code=KEY`, `(code=KEY)` and `AZURE_FUNC code=KEY` all stopped being
 * redacted, on a path whose stdout is a PUBLIC Actions log in a PUBLIC repo.
 *
 * Nothing caught it, because `find . -name "*redact*"` returned no test file and
 * the only `code=` assertions in the lane (`parse-reindex-poll.test.mjs:82-83`)
 * were on the PERMISSIVE side. A rule with one-directional coverage can always
 * be "fixed" by loosening it: every test still passes. So every rule below is
 * pinned in BOTH directions -- what it must catch, and what it must leave
 * readable -- and the two are asserted together, per rule.
 *
 * Run: node --test scripts/ci/__tests__/redact-secrets.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets } from '../redact-secrets.mjs';

/** A key-shaped value: long enough to clear every length bound in the module. */
const K = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345==';

/** Asserts the value is gone AND a marker replaced it — not merely absent. */
function assertRedacted(input, why) {
  const out = redactSecrets(input);
  assert.ok(!out.includes(K), `${why}: the raw value survived -> ${out}`);
  assert.match(out, /\[redacted(-jwt)?\]/, `${why}: nothing was substituted -> ${out}`);
  return out;
}

function assertUntouched(input, why) {
  assert.equal(redactSecrets(input), input, `${why}: a benign string was altered`);
}

// ── THE FUNCTIONS KEY — the round-6 regression, both directions ───────────────

test('#4498 round 7 — `code=` is caught in EVERY position, not only query-string', () => {
  // These four are exactly what round 6's `[?&]` anchor dropped. A remote
  // service composes its own error strings; it is not obliged to quote a URL.
  assertRedacted(`code=${K}`, 'bare, at start of string');
  assertRedacted(` code=${K}`, 'space-separated');
  assertRedacted(`(code=${K})`, 'parenthesized — the shape this lane fixtures elsewhere');
  assertRedacted(`AZURE_FUNC code=${K}`, 'after an identifier and a space');
  // …and the anchored shapes must not regress while fixing the unanchored ones.
  assertRedacted(`https://f.azurewebsites.net/api/x?code=${K}`, 'first query param');
  assertRedacted(`https://f.azurewebsites.net/api/x?a=1&code=${K}`, 'later query param');
});

test('#4498 round 7 — the false positives the anchor was introduced to fix stay readable', () => {
  // This is the half round 6 got RIGHT. Losing it would be the opposite
  // regression: a diagnostic token eaten as if it were a credential, which costs
  // diagnosis and buys nothing.
  for (const name of ['errorcode', 'statuscode', 'exitcode', 'statusCode', 'ERRORCODE']) {
    assertUntouched(`${name}=${K}`, `${name} is not a Functions key`);
  }
  // Length bound: an ordinary HTTP status must survive in every position.
  assertUntouched('code=404', 'a short code is a status, not a key');
  assertUntouched('request failed with code=500 after 3 attempts', 'a status mid-sentence');
});

test('#4498 round 7 — the boundary is the LEFT edge, not a required prefix', () => {
  // The distinguishing fact between `code=` and `errorcode=` is the character
  // BEFORE it, so that is what the rule keys on. Underscores and digits count as
  // identifier characters; punctuation does not.
  assertUntouched(`my_code=${K}`, 'an underscore makes it part of a longer identifier');
  assertUntouched(`x9code=${K}`, 'a digit does too');
  assertRedacted(`[code=${K}]`, 'a bracket is not an identifier character');
  assertRedacted(`"code=${K}"`, 'neither is a quote');
  assertRedacted(`\tcode=${K}`, 'neither is a tab');
});

// ── THE OTHER FOUR RULES, each both ways ─────────────────────────────────────

test('#4498 round 7 — SAS/account/password values are eaten, their key names survive', () => {
  for (const name of ['sig', 'AccountKey', 'SharedAccessKey', 'password', 'pwd']) {
    const out = assertRedacted(`https://h/p?${name}=${K}&next=keep`, `${name} value`);
    assert.ok(out.includes(`${name}=[redacted]`), `${name}: the key NAME was eaten too -> ${out}`);
    assert.ok(out.includes('next=keep'), `${name}: the redaction ran past its separator -> ${out}`);
  }
});

test('#4498 round 7 — a newline terminates a credential value, which is what lets redaction run first', () => {
  // The whole redact-BEFORE-escape ordering in `classify-reindex-result.mjs`
  // rests on this: `[^\s&;",]+` excludes whitespace, so `\n` ends the match and
  // the tail survives to be escaped afterwards. If this ever stopped being true,
  // that boundary would start destroying the rest of the message instead.
  const out = redactSecrets(`AccountKey=${K}\n::error::FORGED`);
  assert.equal(out, 'AccountKey=[redacted]\n::error::FORGED');
});

test('#4498 round 7 — Bearer tokens and bare JWTs', () => {
  const out = redactSecrets(`Authorization: Bearer ${K}`);
  assert.equal(out, 'Authorization: Bearer [redacted]');
  // A JWT in ANY position, including one no `Bearer` introduces.
  const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM';
  assert.equal(redactSecrets(`token ${jwt} end`), 'token [redacted-jwt] end');
  assertUntouched('Bearer 1234567', 'below the length bound, so not a token');
});

// ── PROPERTIES THE CALLERS DEPEND ON ─────────────────────────────────────────

test('#4498 round 7 — redaction is IDEMPOTENT, because two callers now apply it twice', () => {
  // `parse-reindex-poll.mjs` redacts `lastRun.error` before truncating it and
  // again in `clean()`. That is only safe if a second pass is a no-op.
  for (const s of [`sig=${K}`, `code=${K}`, `Bearer ${K}`, 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM']) {
    const once = redactSecrets(s);
    assert.equal(redactSecrets(once), once, `not idempotent for ${s}`);
  }
});

test('#4498 round 7 — non-string input never throws and never yields "undefined"', () => {
  // `redactSecrets` coerces with `?? ''`, which is exactly why
  // `formatAnnotation` must call `String()` ITSELF before handing over: these
  // collapse to empty here, and a blank `::error::` is worse than a wrong one.
  assert.equal(redactSecrets(null), '');
  assert.equal(redactSecrets(undefined), '');
  assert.equal(redactSecrets(0), '0');
  assert.equal(redactSecrets(false), 'false');
});

test('#4498 round 7 — a benign operational message is not damaged', () => {
  // Whole-message redaction is only acceptable if it costs nothing on the
  // ordinary path. These are real shapes from the reindex classifier.
  for (const s of [
    'loom-docs reindex ACCEPTED (HTTP 202, job=46b94165-abad-4d8e-ba87-66238b118e3a)',
    'poll: freshness=stale job=idle indexedChunks=51079',
    'reindex did not converge after 55 polls (912s)',
    'freshness=never-indexed job=idle',
  ]) {
    assertUntouched(s, 'an ordinary diagnostic');
  }
});
