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
 * EVERY field is stripped of the separator and of newlines, not just the error.
 * A pipe anywhere in any of them shifts every later field by one, and these
 * values come from a remote service — so "this field cannot contain a pipe" is
 * an assumption about data we do not control.
 *
 * @param {unknown} v
 * @returns {string}
 */
function clean(v) {
  return String(v).replace(/[\r\n|]+/g, ' ');
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
  const le = lr && lr.error ? clean(redactSecrets(lr.error)).slice(0, 300) : '';
  return [f, s, c, lo, lf, le, lj].map(clean);
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(parsePollFile(process.argv[2]));
}

export default parsePollFile;
