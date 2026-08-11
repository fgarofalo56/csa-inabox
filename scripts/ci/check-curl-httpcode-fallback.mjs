#!/usr/bin/env node
/**
 * check-curl-httpcode-fallback.mjs
 *
 * RULE. A `curl -w '%{http_code}'` capture must not carry an `|| echo <default>`
 * fallback. Default an EMPTY capture instead.
 *
 * WHY — measured with real curl, not reasoned about:
 *
 *   connection failure : curl PRINTS `000` and exits non-zero  ->  "000000"
 *   HTTP 401 with -f   : curl PRINTS `401` and exits 22        ->  "401000"
 *
 * curl already writes the `-w` value on BOTH paths, so `||` can only CONCATENATE
 * onto what it printed. The result is a string that is not a status code, and
 * every comparison against one silently fails.
 *
 * TWO REAL INCIDENTS, both found 2026-08-11:
 *
 * 1. apps/loom-unity/bin/loom-entrypoint.sh — the anonymous-read enforcement
 *    probe. `000000 != "000"` is TRUE, so the 60-attempt wait-for-server loop
 *    broke on attempt 1, before the server was listening, and gov-uc-purview-wire
 *    (run 31503926181) refused to wire the Gov Console:
 *        [loom-unity] ANON-READ: 000000
 *        ##[error]anonymous read answered 000, which is neither a refusal
 *        (401/403) nor a success (200)
 *    The gate was right to fail closed. It was fed a code that is not a code.
 *
 * 2. .github/scripts/fiab-smoke-test.sh Test 2 — asserts /api/workspaces REFUSES
 *    an unauthenticated caller, i.e. 401 is the SUCCESS case. `-f` makes curl
 *    exit non-zero on exactly that, so the fallback concatenated. Verified live:
 *        old shape -> RESPONSE='401000'  (matches neither 401 nor 403)
 *        new shape -> RESPONSE='401'     (matches)
 *    The test failed when auth WORKED, and also failed when it was broken (200
 *    matches neither). It could not pass — in all three deploy paths — and
 *    nobody noticed because the step ran under `continue-on-error: true`.
 *
 * That pairing is the thing to remember: a check that cannot pass, wired so it
 * cannot fail. Either defect alone would have been caught by the other.
 *
 * THE SAFE SHAPE:
 *     CODE="$(curl -sS -o /dev/null -w '%{http_code}' … 2>/dev/null)"
 *     [ -n "$CODE" ] || CODE="000"
 *
 * Also flag `-f`/`--fail` on a probe that reads http_code: with `-f` curl
 * suppresses the body and exits non-zero on 4xx/5xx, but a probe whose PURPOSE
 * is to observe the status treats 4xx/5xx as answers, not errors.
 *
 * SELF-DEFENCE. Fails if it scans no files, and fails if it finds no
 * `%{http_code}` usage at all — this repo probes constantly, so zero means the
 * matcher drifted.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();

function tracked() {
  try {
    return execFileSync('git', ['ls-files', '--', '*.sh', '*.yml', '*.yaml', '*.bash'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::curl-httpcode-fallback: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

// This guard and its own documentation legitimately contain the bad shape.
const EXEMPT = new Set(['scripts/ci/check-curl-httpcode-fallback.mjs']);

const HTTP_CODE = /%\{http_code\}/;
const BAD_FALLBACK = /\|\|\s*echo\b/;

const files = tracked();
const violations = [];
let probeLines = 0;

for (const rel of files) {
  if (EXEMPT.has(rel)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (!HTTP_CODE.test(text)) continue;

  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return; // prose about the rule is not the rule
    if (!HTTP_CODE.test(raw)) return;
    probeLines++;
    if (!BAD_FALLBACK.test(raw)) return;
    violations.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 150) });
  });
}

if (files.length === 0) {
  console.error('::error::curl-httpcode-fallback: scanned ZERO tracked files. Refusing to report a pass.');
  process.exit(1);
}
if (probeLines === 0) {
  console.error(
    `::error::curl-httpcode-fallback: found ZERO \`%{http_code}\` probes in ${files.length} tracked files. ` +
      'This repo probes constantly, so zero means the matcher has drifted off the code. ' +
      'Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::curl-httpcode-fallback: ${violations.length} \`%{http_code}\` capture(s) use an \`|| echo\` fallback. ` +
      'curl PRINTS the value on both failure paths and ALSO exits non-zero, so the fallback CONCATENATES: a ' +
      'connection failure becomes "000000" and an HTTP 401 under -f becomes "401000". Neither is a status code, ' +
      'so every comparison against one fails silently. Use: ' +
      'CODE="$(curl -sS -w \'%{http_code}\' … 2>/dev/null)"; [ -n "$CODE" ] || CODE="000"',
  );
  for (const v of violations) console.error(`::error file=${v.file},line=${v.line}::${v.text}`);
  process.exit(1);
}

console.log(
  `curl-httpcode-fallback OK — ${files.length} tracked file(s) scanned, ${probeLines} \`%{http_code}\` probe line(s), ` +
    '0 concatenating fallbacks.',
);
