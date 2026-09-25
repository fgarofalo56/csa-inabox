#!/usr/bin/env node
/**
 * Parse one loom-docs freshness poll body into the seven fields
 * `reindex-loom-docs.sh` reads positionally.
 *
 * WHY THIS IS A FILE AND NOT A `node -e` BLOCK (#4498 round 6)
 * -----------------------------------------------------------
 * It used to be an inline `node -e` inside `reindex-loom-docs.sh`, and that
 * inline copy carried its OWN verbatim duplicate of every redaction regex in
 * `redact-secrets.mjs`. That made round 5's claim — "this is one module and not
 * two copies" — false at the moment it was written: there was exactly one
 * importer and one hand-copied clone, which is the drift shape the claim said
 * it was preventing. Two copies of a security control diverge silently, because
 * nothing fails when only one of them is updated.
 *
 * Extracting it buys three things the inline form could not have:
 *   - `redactSecrets` is IMPORTED, so there is one definition of what a
 *     credential looks like and SHOULD-FIX-style tightenings land everywhere.
 *   - the parser is directly unit-testable, rather than reachable only by
 *     running the whole shell script end to end.
 *   - the single-quote ban is gone. The inline block sat inside a single-quoted
 *     shell string, so one apostrophe anywhere — including in a comment — would
 *     close the quote and hand the rest of the JavaScript to bash.
 *
 * WHAT THIS IS NOT
 * ----------------
 * The redaction here is by SHAPE and is NOT a proof that the output is
 * secret-free — see the same disclaimer on `redact-secrets.mjs`. It covers the
 * credential forms this estate actually mints; an unanticipated shape passes
 * through untouched. The 300-character truncation bounds the blast radius, it
 * does not close it. The real fix is for the durable last-run record to stop
 * storing secrets, and that fix does not live in this file either.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { redactSecrets } from './redact-secrets.mjs';

/**
 * THE BOUNDARY. Every field is redacted AND stripped of the separator, not just
 * the error.
 *
 * ROUND 7 (review finding). Round 6 redacted exactly ONE of the seven fields --
 * `lastRun.error` -- and let the other six through raw, while enrolling this file
 * in `publication-surface-bypasses.test.mjs` with `parsePollFile` named as its
 * boundary. The guard went green: it checks that a write crosses a function
 * called a boundary, never that the boundary BOUNDS. Three credentials planted
 * in `job.state`, `lastRun.outcome` and `lastRun.jobId` reached stdout, and
 * `reindex-loom-docs.sh:535` prints two of those on the same line as the
 * redacted one. The reasoning in the round-6 docblock below -- "whatever string
 * the endpoint chose to store" -- was always true of every sibling field; it was
 * applied to one of them.
 *
 * REDACT PER FIELD, NOT OVER THE JOIN. Redacting `fields.join('|')` would be a
 * different bug: the rules in `redact-secrets.mjs` are bounded by `[^\s&;",]+`,
 * and `|` is INSIDE that class, so a credential at the end of field N swallows
 * the separator and eats field N+1 -- the field-shifting failure this function
 * exists to prevent. Redaction happens per value, before the join, and the
 * separator strip runs after it (`[redacted]` contains no pipe, so the order is
 * safe in that direction).
 *
 * @param {unknown} v
 * @returns {string}
 */
function clean(v) {
  return redactSecrets(String(v)).replace(/[\r\n|]+/g, ' ');
}

/**
 * @param {unknown} parsed a parsed freshness-poll body (any shape; never trusted)
 * @returns {string[]} the seven fields, in the order the shell reads them
 */
export function pollFields(parsed) {
  const j = parsed && typeof parsed === 'object' ? parsed : {};
  const f = (j.freshness && j.freshness.state) || 'unknown';
  const s = (j.job && j.job.state) || 'unknown';
  const c =
    j.freshness && Number.isFinite(j.freshness.indexedChunkCount)
      ? String(j.freshness.indexedChunkCount)
      : '';
  // The DURABLE last-run record (#4497). Written by every replica into the same
  // store as the manifest, so a failure that happened on a replica this poll
  // will never reach is still readable here.
  const lr = (j.freshness && j.freshness.lastRun) || null;
  const lo = lr && lr.outcome ? String(lr.outcome) : '';
  const lf = lr && lr.finishedAt ? String(lr.finishedAt) : '';
  const lj = lr && lr.jobId ? String(lr.jobId) : '';
  // `lr.error` is REMOTE-SUPPLIED — whatever string the freshness endpoint chose
  // to store — and the rebuild_failed branch in the shell echoes it to stdout.
  // On a `loom-roll-and-validate` run that stdout is a PUBLIC Actions log in a
  // PUBLIC repo. A backend error quoting the request URL or a connection string
  // would publish the credential inside it, and no amount of caution on THIS
  // side changes what the remote decided to put in the string.
  //
  // This field is the only one that is TRUNCATED, so it redacts here as well as
  // in `clean` — and it must, because the order matters in one direction only:
  // redact THEN slice. Slicing first can cut a credential below the rule's
  // length bound and leave a fragment that no longer matches, publishing the
  // head of a key instead of `[redacted]`. Re-redacting in `clean` is a no-op
  // (the rules are idempotent); slicing an unredacted value is not.
  const le = lr && lr.error ? redactSecrets(String(lr.error)).slice(0, 300) : '';
  return [f, s, c, lo, lf, le, lj].map(clean);
}

/**
 * The POST side of the SAME sanitizer, for the jobId the trigger response hands
 * back. It exists so `reindex-loom-docs.sh` can stop carrying its own copy.
 *
 * ROUND 9 (review finding N2). `do_post` had an inline `node -e` that applied
 * `String(j.jobId).replace(/[\r\n|]+/g, " ")` — the separator strip, WITHOUT
 * `redactSecrets` — while its own comment asserted it was "the SAME one the
 * poll's `clean()` helper applies". It was not, and the divergence was already
 * live. This is the exact drift the round-6 extraction was performed to end:
 * one importer and one hand-copied clone of a security control.
 *
 * Two things broke, both measured. A credential-shaped id (a JWT) redacts to
 * `[redacted-jwt]` on the poll side and passes through verbatim here, so
 * `[ "$LAST_JOB_ID" = "$POST_JOB_ID" ]` can never match and the durable-record
 * correlation silently stops firing — a recorded failure of OUR job reads as a
 * timeout, which is the #4497 symptom this PR exists to remove. And `:254`
 * echoes the raw value to stdout, which on a `loom-roll-and-validate` run is a
 * public Actions log, so the unredacted remote string was also being PUBLISHED.
 *
 * The existing correlation test passed only because its fixture,
 * `job|with|separators`, is the one shape where the two sides agree —
 * `redactSecrets` leaves it untouched. A credential-shaped fixture is now
 * asserted alongside it; without one, the clone would simply drift again.
 *
 * @param {string} p file holding the trigger-response body
 * @returns {string} the sanitized jobId, or '' when there is none
 */
export function postJobId(p) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    parsed = {};
  }
  const j = parsed && typeof parsed === 'object' ? parsed : {};
  return j.jobId ? clean(String(j.jobId)) : '';
}

/**
 * The trigger-response body, redacted, for the diagnostic dump in `do_post`.
 *
 * ROUND 9 (review finding N7, promoted from nit to defect by measurement).
 * `do_post` printed the raw body with `head -c 800`. That is a REMOTE-supplied
 * document on a path whose stdout is a PUBLIC Actions log on a
 * `loom-roll-and-validate` run, and it sat one line BELOW the `job=` echo that
 * N2's fix had just taught to redact. So the boundary was decorative on this
 * surface: the sanitized id was printed, and then the same value was republished
 * verbatim by the next statement. Measured, with the round-9 correlation test:
 *
 *   reindex POST … -> HTTP 202 job=job with sig=[redacted]      <- redacted
 *   {"ok":true,…,"jobId":"job|with|sig=not-a-real-secret-value"} <- raw, next line
 *
 * A reviewer had called this pre-existing and therefore out of scope. It is
 * pre-existing, and it still undoes a fix this PR makes, which is the thing that
 * decides scope.
 *
 * REDACT THEN TRUNCATE, never the reverse — the same ordering argument as
 * `lastRun.error` above. Slicing first can cut a credential below a rule's
 * length bound so it no longer matches, publishing the head of a key instead of
 * `[redacted]`.
 *
 * This is NOT a proof the dump is secret-free. It covers the shapes
 * `redact-secrets.mjs` knows; an unanticipated one passes through. The 800-char
 * bound limits the blast radius, it does not close it.
 *
 * @param {string} p file holding the trigger-response body
 * @param {number} [limit] bytes to keep after redaction
 * @returns {string}
 */
export function redactBodyFile(p, limit = 800) {
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
  return redactSecrets(raw).slice(0, limit);
}

/**
 * @param {string} path file holding the poll body; unreadable or non-JSON is an
 *   empty object, exactly as the inline parser treated it — a poll that returned
 *   no usable body must read as "unknown", never as a hard failure here, because
 *   the classifier is what decides the verdict.
 * @returns {string}
 */
export function parsePollFile(path) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    parsed = {};
  }
  return pollFields(parsed).join('|');
}

// Seven fields on stdout, pipe-joined, no trailing newline — the shell reads
// them positionally with `IFS='|' read -r`. `pathToFileURL` rather than a
// hand-built `file://` string: this runs on Windows too, where a drive letter
// does not survive naive concatenation.
//
// `--post <file>` selects the jobId sanitizer instead, `--body <file>` the
// redacted body dump. One entry point, so the shell cannot reach one of these
// helpers without the others being in the same file and the same test suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === '--post') {
    process.stdout.write(postJobId(process.argv[3]));
  } else if (process.argv[2] === '--body') {
    process.stdout.write(redactBodyFile(process.argv[3]));
  } else {
    process.stdout.write(parsePollFile(process.argv[2]));
  }
}

export default parsePollFile;
