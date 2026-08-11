#!/usr/bin/env node
/**
 * check-set-e-restore.mjs
 *
 * RULE. A bare `set -e` may not appear in a script whose header never enabled
 * `-e`. In that shape it is not a RESTORE — it is a silent ENABLE, and from that
 * line onward every non-zero command aborts the script with THAT command's exit
 * code, bypassing the script's own exit contract.
 *
 * WHY (found 2026-08-11 in code I had just written, by its own self-test).
 *
 * The `set +e; CMD; RC=$?; set -e` idiom is correct ONLY when `-e` was on to
 * begin with. These scripts all start `set -uo pipefail` — deliberately, because
 * they implement multi-valued exit contracts (0 = ok, 3 = absent, 4 = unknown, …)
 * that `-e` would destroy. Writing `set -e` to "restore" therefore turns on a
 * mode the script was designed without.
 *
 * Measured on scripts/ci/check-vanity-edge-health.sh: with an unparseable route
 * JSON the script exited **5** — jq's parse-error code — instead of the
 * contracted **2** (UNKNOWN). The `if [ -z "$N_DOMAINS" ]` branch that exists
 * precisely to return 2 was never reached, because the assignment above it had
 * already aborted the script.
 *
 * The same shape was in two more places, one of them pre-existing:
 *   scripts/ci/assert-acr-image-tags.sh          4 occurrences — contract 0/2/3/4/5
 *   scripts/csa-loom/approve-cae-private-endpoints.sh  2 occurrences — contract 0/1/2/3
 *
 * `assert-acr-image-tags.sh` is the sharp one: it is the image preflight for
 * every roll, its callers BRANCH on those codes (loom-roll-and-validate reads 3
 * as "absent" and 4 as "unproven"), and an abort would hand them a code that
 * means neither.
 *
 * WHAT IS ALLOWED. `set -e` is fine when the header enabled it — then it really
 * is a restore. It is also fine inside a function that saved the flag state.
 * This rule only rejects the mismatch.
 *
 * SELF-DEFENCE. Fails if it scans no files, and fails if it finds no `set +e`
 * at all — this repo uses that idiom widely, so zero means the matcher drifted.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const ROOTS = ['scripts', '.github'];
const SKIP_DIR = /(^|[\\/])(node_modules|__fixtures__)([\\/]|$)/;

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP_DIR.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith('.sh')) out.push(p);
  }
  return out;
}

/** Does this script's `set` header turn on -e? `set -e`, `set -eu`, `set -euo pipefail`. */
function headerEnablesErrexit(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*set\s+(-[A-Za-z]+)(\s|$)/.exec(line);
    if (!m) continue;
    if (m[1].includes('e')) return true;
    // A later `set -o errexit` counts too.
  }
  return /^\s*set\s+-o\s+errexit\s*$/m.test(text);
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const violations = [];
let plusSeen = 0;

for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (!/^\s*set\s+[-+]/m.test(text)) continue;
  const rel = relative(ROOT, file).split(sep).join('/');

  const lines = text.split(/\r?\n/);
  const headerHasE = headerEnablesErrexit(
    // Only the FIRST `set` line counts as the header; a `set -e` further down is
    // exactly what this rule is about and must not license itself.
    lines.slice(0, lines.findIndex((l) => /^\s*set\s+[-+]/.test(l)) + 1).join('\n'),
  );

  // HEREDOC BODIES ARE A DIFFERENT SCRIPT.
  //
  // The first draft of this rule flagged two real files —
  // grant-synapse-rbac-invnet-job.sh and run-spark-storage-fix-invnet-job.sh —
  // whose `set -e` is the FIRST LINE of a base64-encoded script embedded via
  // `read -r -d '' X <<'EOF'` and executed inside a container. That `set -e` is
  // the header of the inner script and has nothing to do with the outer one's
  // flags. Both were false positives, and a guard that cries wolf on correct
  // code is the kind that gets switched off.
  let heredocEnd = null;

  lines.forEach((raw, i) => {
    if (heredocEnd !== null) {
      // NOTE the DOUBLED backslashes. In a TEMPLATE LITERAL `\s` is not a regex
      // escape — JS resolves it to a bare `s` before RegExp ever sees it, so the
      // first version of this line compiled to /^s*EOFs*$/ and could not match an
      // INDENTED terminator. The skip window then never closed and every `set -e`
      // after the first heredoc in that file was silently ignored — a guard that
      // goes quiet, which is worse than no guard. CodeQL caught it
      // (js/useless-regexp-character-escape, 2 high) before it shipped.
      if (new RegExp(`^\\s*${heredocEnd}\\s*$`).test(raw)) heredocEnd = null;
      return;
    }
    const hd = /<<-?\s*(?:'([A-Za-z_][\w]*)'|"([A-Za-z_][\w]*)"|([A-Za-z_][\w]*))/.exec(raw);
    if (hd) {
      heredocEnd = hd[1] || hd[2] || hd[3];
      return;
    }
    if (/^\s*#/.test(raw)) return;
    if (/^\s*set\s+\+e\s*$/.test(raw)) plusSeen++;
    if (!/^\s*set\s+-e\s*$/.test(raw)) return;
    // The header line itself is not a violation.
    if (i === lines.findIndex((l) => /^\s*set\s+[-+]/.test(l))) return;
    if (headerHasE) return; // a genuine restore
    violations.push({ file: rel, line: i + 1, text: raw.trim() });
  });
}

if (files.length === 0) {
  console.error('::error::set-e-restore: scanned ZERO shell scripts. The walker is broken — refusing to report a pass.');
  process.exit(1);
}
if (plusSeen === 0) {
  console.error(
    `::error::set-e-restore: found ZERO \`set +e\` in ${files.length} shell script(s). This repo uses that idiom ` +
      'widely to capture an exit status, so zero means the matcher has drifted off the code. Refusing to report a ' +
      'pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::set-e-restore: ${violations.length} bare \`set -e\` in script(s) whose header never enabled it. That ` +
      'is not a restore, it is a silent ENABLE — from that line on, any non-zero command aborts the script with ITS ' +
      "exit code and the script's own exit contract stops being honoured. Delete the line (the `set +e` above it is " +
      'already a no-op), or enable -e in the header if that is genuinely what the script wants.',
  );
  for (const v of violations) {
    console.error(`::error file=${v.file},line=${v.line}::${v.text}  <-- header does not enable -e`);
  }
  process.exit(1);
}

console.log(
  `set-e-restore OK — ${files.length} shell script(s) scanned, ${plusSeen} \`set +e\` capture(s), ` +
    'no bare `set -e` in a script that never enabled it.',
);
