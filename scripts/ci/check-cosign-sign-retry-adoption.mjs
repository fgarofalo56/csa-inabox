#!/usr/bin/env node
/**
 * check-cosign-sign-retry-adoption.mjs
 *
 * RULE. `cosign sign` in a workflow goes through scripts/ci/cosign-sign-retry.sh.
 *
 * WHY. cosign's OWN internal retry can outlive the OIDC token it is holding, and
 * when it does, the terminal error class MUTATES. Measured on run 31496454872
 * (Commercial image producer, loom-mcp-bridge):
 *
 *   13:36:32  error fetching GitHub OIDC token (will retry):
 *             … net/http: TLS handshake timeout          <- the real cause
 *   13:41:35  Error: … getting key from Fulcio: retrieving cert:
 *             error obtaining token: expired_token       <- what was reported
 *
 * Five minutes of in-process retrying converted a network timeout into something
 * that reads like a credential fault. That mutation is the dangerous part: it
 * sends the reader to the service principal, which was fine.
 *
 * Only a FRESH `cosign sign` process re-requests a token from
 * ACTIONS_ID_TOKEN_REQUEST_URL. So the retry must live outside cosign — the
 * wrapper is not tidiness, it is the only shape that helps.
 *
 * EVERY BOUNDARY (cloud-parity.md). The identical shape existed at four sites:
 * the Commercial producer, full-app-deploy-commercial, and BOTH Gov producers
 * (gov-build-images, gov-console-roll). gov-build-images had no retry AND no
 * message — a bare `cosign sign --yes` under `set -e`, so a Sigstore transient
 * exited non-zero with nothing naming the cause. Fixing only Commercial would
 * have left the sovereign estates with exactly the failure being removed.
 *
 * KEYED TO THE MISMATCH. Counts `cosign sign` invocations NOT on a helper line —
 * never "the absence of the helper", because adopting it REMOVES the `cosign
 * sign` token and a rule keyed that way would go quiet on the fixed files
 * (`guard_keyed_to_the_unsafe_pattern`).
 *
 * `cosign verify` is deliberately NOT matched: it reads an existing signature,
 * takes no OIDC token, and has no equivalent failure mode.
 *
 * SELF-DEFENCE. Fails on an empty population and on zero helper references.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const HELPER = 'cosign-sign-retry.sh';

function tracked() {
  try {
    return execFileSync('git', ['ls-files', '--', '*.yml', '*.yaml', '*.sh'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::cosign-sign-retry-adoption: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

const EXEMPT = new Set([
  'scripts/ci/cosign-sign-retry.sh',
  'scripts/ci/test-cosign-sign-retry.sh',
  'scripts/ci/check-cosign-sign-retry-adoption.mjs',
]);

const files = tracked();
const violations = [];
let helperRefs = 0;

for (const rel of files) {
  if (EXEMPT.has(rel)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (text.includes(HELPER)) helperRefs++;
  if (!/cosign\s+sign\b/.test(text)) continue;

  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return; // leading comment
    if (/^\s*-?\s*(name|description|title|summary):/.test(raw)) return; // YAML key
    if (/^\s*echo\b/.test(raw)) return; // a message
    if (/::(error|warning|notice)::/.test(raw)) return; // an annotation
    if (!/\bcosign\s+sign\b/.test(raw)) return;
    if (raw.includes(HELPER)) return; // this IS the adoption
    violations.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 140) });
  });
}

if (files.length === 0) {
  console.error('::error::cosign-sign-retry-adoption: scanned ZERO tracked files. Refusing to report a pass.');
  process.exit(1);
}
if (helperRefs === 0) {
  console.error(
    `::error::cosign-sign-retry-adoption: found ZERO references to ${HELPER} in ${files.length} tracked files. ` +
      'Every image producer in this repo signs keylessly, so zero means the matcher has drifted off the code. ' +
      'Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::cosign-sign-retry-adoption: ${violations.length} bare \`cosign sign\` invocation(s) bypass ${HELPER}. ` +
      "cosign's internal retry holds one OIDC token, so on a Sigstore/OIDC hiccup it retries until the token " +
      'EXPIRES and reports `expired_token` — a network transient dressed as a credential fault (run 31496454872). ' +
      'Only a fresh invocation re-mints the token. Use: ' +
      'bash scripts/ci/cosign-sign-retry.sh --ref "$REF"',
  );
  for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  process.exit(1);
}

console.log(
  `cosign-sign-retry-adoption OK — ${files.length} tracked file(s) scanned, ${helperRefs} reference ${HELPER}, ` +
    '0 bare `cosign sign`.',
);
