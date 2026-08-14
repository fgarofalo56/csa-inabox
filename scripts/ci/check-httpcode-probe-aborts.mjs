#!/usr/bin/env node
/**
 * check-httpcode-probe-aborts.mjs
 *
 * RULE. In a script that enables `set -e`, a capture of `%{http_code}` must
 * guard its own exit status (`|| true` / `|| :`).
 *
 * WHY. You capture an HTTP status code precisely so you can BRANCH on a failure.
 * But curl exits non-zero on a connection failure — and, with `-f`, on any 4xx/
 * 5xx — so under `set -e` the script dies at the assignment, before reaching the
 * branch that exists to handle exactly that case. The probe deletes itself at
 * the moment it would have been useful.
 *
 * MEASURED, and self-inflicted. #3246 removed `|| echo 000` from loom-unity's
 * anonymous-read probe (correctly: `|| echo` CONCATENATES onto the value curl
 * already printed, producing "000000"). But `|| echo` was ALSO the thing making
 * curl's non-zero exit survive `set -eu` (loom-entrypoint.sh:29). Removing it
 * turned a wrong-but-present marker into no marker at all —
 * gov-uc-purview-wire run 31513755240:
 *
 *     ##[error]No ANON-READ marker from loom-unity revision loom-unity--0000007
 *     — whether authorization is enforced is UNVERIFIED. Refusing to report
 *     success.
 *
 * Reproduced locally against a dead port under `set -eu`: the loop exits 28 with
 * nothing printed. With `|| true` on the assignment it prints `ANON-READ: 000`
 * and exits 0.
 *
 * `|| true` and `|| echo` are NOT interchangeable and the difference is the
 * whole point: `|| true` fixes the exit STATUS and leaves stdout alone;
 * `|| echo` appends to stdout and corrupts the value. A correct script needs the
 * first and must not have the second. check-curl-httpcode-fallback.mjs enforces
 * the second half; this rule enforces the first.
 *
 * NARROW BY DESIGN. Only `%{http_code}` captures are judged. A `TOKEN="$(curl
 * …)"` that aborts on failure is CORRECT — there is nothing to observe and
 * continuing without a token is worse. 37 curl assignments in `set -e` scripts
 * exist here; only the 18 that capture a status code are this bug.
 *
 * RATCHET, not a cliff. Nine sites in scripts/csa-loom/ predate this rule and are
 * operator-run tools rather than CI paths. Failing them all today would make
 * guardrails red for everyone; the baseline records them where they can be seen
 * and can only SHRINK.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';

const ROOT = process.cwd();
const BASELINE_FILE = new URL('./httpcode-probe-baseline.json', import.meta.url);

function tracked() {
  try {
    return execFileSync('git', ['ls-files', '--', '*.sh'], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (e) {
    console.error(
      `::error::httpcode-probe-aborts: could not ask git for tracked files (${(e.message || '').slice(0, 160)}). ` +
        'Refusing to fall back to a filesystem walk.',
    );
    process.exit(1);
  }
}

/**
 * EMPTY BY DESIGN, and asserted below. The previous entry named this guard's own
 * `.mjs` path while `tracked()` globs `*.sh` only, so it could never apply — a
 * line of protection that read as protection and was not one (#3420). Any entry
 * added here must be a file this guard actually scans; the assertion after the
 * scan fails if it is not.
 */
const EXEMPT = new Set([]);

/**
 * Does the script's header enable errexit?
 *
 * `-[A-Za-z]*e` and NOT `-[a-z]*e`: the lowercase-only class could not match
 * `set -Eeuo pipefail`, because the uppercase `E` (ERR-trap inheritance, and a
 * common companion to `-e`) precedes the lowercase `e` and the class rejected
 * it. That was latent rather than live — no such file exists in this tree today
 * — but a latent hole in a matcher is how the population silently shrinks the
 * day someone writes the idiom (#3420).
 */
const SET_E = /^\s*set\s+-[A-Za-z]*e|^\s*set\s+-o\s+errexit\b/m;
const ASSIGN_CURL = /^\s*\w+="?\$\(\s*curl\b/;
const GUARDED = /\|\|\s*(true|:)\s*$/;

const files = tracked();
const violations = [];
let probes = 0;

for (const rel of files) {
  if (EXEMPT.has(rel)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  if (!SET_E.test(text)) continue; // no -e, no abort

  // A command substitution can span backslash continuations; judge the whole.
  // Folding is shared with check-curl-httpcode-fallback.mjs rather than
  // reimplemented — two private copies of this idea is exactly how the two
  // guards over this construct came to disagree for their entire lives (#3420).
  for (const { line, text: block } of readLogicalLines(text)) {
    if (/^\s*#/.test(block)) continue;
    if (!ASSIGN_CURL.test(block)) continue;
    if (!block.includes('%{http_code}')) continue;
    probes++;
    if (!GUARDED.test(block.trim())) violations.push({ file: rel, line });
  }
}

if (files.length === 0) {
  console.error('::error::httpcode-probe-aborts: scanned ZERO tracked shell scripts. Refusing to report a pass.');
  process.exit(1);
}
// An exemption for a file this guard never scans is not protection — it reads
// as protection while doing nothing. Fail on one rather than carry it (#3420).
const unreachableExempt = [...EXEMPT].filter((e) => !files.includes(e));
if (unreachableExempt.length > 0) {
  console.error(
    `::error::httpcode-probe-aborts: ${unreachableExempt.length} EXEMPT entr(ies) name a file this guard never ` +
      'scans, so the exemption can never apply. Remove it, or widen the glob if the file really should be judged: ' +
      unreachableExempt.join(', '),
  );
  process.exit(1);
}
if (probes === 0) {
  console.error(
    `::error::httpcode-probe-aborts: found ZERO \`%{http_code}\` captures in ${files.length} tracked scripts with ` +
      '`set -e`. This repo probes constantly, so zero means the matcher has drifted off the code. ' +
      'Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).entries || {};
} catch {
  console.error(
    '::error::httpcode-probe-aborts: could not read httpcode-probe-baseline.json. Refusing to run without the ' +
      'recorded debt — without it every pre-existing site reads as new and the rule is unusable.',
  );
  process.exit(1);
}

const byFile = {};
for (const v of violations) byFile[v.file] = (byFile[v.file] || 0) + 1;

const grew = [];
const shrank = [];
for (const [f, n] of Object.entries(byFile)) {
  const allowed = baseline[f] || 0;
  if (n > allowed) grew.push({ file: f, n, allowed });
}
for (const [f, allowed] of Object.entries(baseline)) {
  const n = byFile[f] || 0;
  if (n < allowed) shrank.push({ file: f, n, allowed });
}

if (shrank.length > 0) {
  console.error(
    '::error::httpcode-probe-aborts: the baseline is STALE (it must only shrink). Sites were fixed without ' +
      'updating httpcode-probe-baseline.json, so the recorded debt overstates reality and would tolerate a NEW ' +
      'unguarded probe in its place.',
  );
  for (const s of shrank) console.error(`   - ${s.file}: baseline records ${s.allowed}, only ${s.n} remain`);
  process.exit(1);
}

if (grew.length > 0) {
  console.error(
    `::error::httpcode-probe-aborts: ${grew.reduce((a, g) => a + (g.n - g.allowed), 0)} NEW \`%{http_code}\` ` +
      'capture(s) abort their own script. curl exits non-zero on a connection failure (and on 4xx/5xx under -f), ' +
      'so under `set -e` the script dies AT THE ASSIGNMENT — before the branch that exists to handle exactly that ' +
      'case. Append `|| true` to the assignment. NOT `|| echo`, which appends to stdout and corrupts the value ' +
      '(check-curl-httpcode-fallback.mjs).',
  );
  for (const g of grew) {
    for (const v of violations.filter((x) => x.file === g.file)) {
      console.error(`::error file=${v.file},line=${v.line}::unguarded %{http_code} capture in a \`set -e\` script`);
    }
  }
  process.exit(1);
}

console.log(
  `httpcode-probe-aborts OK — ${probes} \`%{http_code}\` capture(s) in \`set -e\` scripts; ` +
    `${violations.length} recorded pre-existing, 0 new.`,
);
