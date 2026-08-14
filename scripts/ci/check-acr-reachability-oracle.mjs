#!/usr/bin/env node
/**
 * check-acr-reachability-oracle.mjs
 *
 * RULE. `az acr login` is a CREDENTIAL step, never a reachability verdict.
 * Its exit status may not be consumed as a decision about whether the ACR data
 * plane is open.
 *
 *   az acr login -n "$ACR" >/dev/null                       <-- ok (mint a token)
 *   bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR"     <-- ok (the probe)
 *   for i in $(seq 1 12); do az acr login … && break; done  <-- VIOLATION
 *   if az acr login …; then REACHABLE=true; fi              <-- VIOLATION
 *   az acr login … || echo "unreachable"                    <-- VIOLATION
 *
 * WHY (loom-roll-and-validate run 31454217160, 2026-08-11 — P0 roll failure).
 * `az acr login` authenticates through an ARM-mediated token exchange. It does
 * not exercise the anonymous registry endpoint that cosign, `docker pull` and
 * `az acr build`'s upload actually hit, so it returns 0 while the registry is
 * still refusing this runner by IP. Measured:
 *
 *   03:05:48.748  [acr-lease] opening ACR (Enabled, Allow) ...
 *   03:05:48.748  ACR data plane reachable after 1 attempt(s).   <-- az acr login said yes
 *   03:05:51.221  Error: POST …/oauth2/token: DENIED: client with IP … not allowed
 *
 * ACR firewall changes take 30–90s to reach the data plane. The repo had ALREADY
 * been burned by this in the RE-LOCK direction (#2980/#2982, where a stale-open
 * data plane made `az acr login` succeed after a lock) and fixed that one by
 * asking the control plane. The OPEN direction kept the same broken oracle. Then
 * eighteen more sites across the Commercial and sovereign lanes carried a
 * `for … && break` variant with no failure path at all.
 *
 * The rule is keyed to CONSUMING THE EXIT STATUS, not to the string `az acr
 * login` — banning the string would forbid the legitimate credential step and
 * would go quiet the moment a site adopted the probe. Consuming the status is
 * the thing that is always wrong.
 *
 * SELF-DEFENCE. Fails if it scans no files, and fails if it finds no `az acr
 * login` at all — this repo has many, so zero means the matcher drifted.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readLogicalLines } from './_logical-lines.mjs';

const ROOT = process.cwd();
const ROOTS = ['.github/workflows', 'scripts'];
const EXTS = ['.yml', '.yaml', '.sh'];
const SKIP_DIR = /(^|[\\/])(__tests__|__fixtures__|node_modules)([\\/]|$)/;

const LOGIN = /az\s+acr\s+login\b/;

/**
 * Is this line consuming `az acr login`'s exit status as a decision?
 *
 * Shapes seen in this repo before #3210:
 *   `if az acr login …; then`            condition
 *   `if ! az acr login …; then`          negated condition
 *   `az acr login … && break`            short-circuit
 *   `az acr login … || echo …`           short-circuit
 *   `while az acr login …; do`           loop condition
 *   `RC=$(az acr login …); [ $? -eq 0 ]` captured status
 */
function consumesStatus(line) {
  const s = line.replace(/^\s*/, '');
  if (/^(if|while|until)\s+!?\s*az\s+acr\s+login\b/.test(s)) return 'used as an if/while condition';
  if (/^(if|while|until)\b.*;\s*do\s+az\s+acr\s+login\b/.test(s)) return 'used as a loop-body decision';
  // && / || AFTER the login command (a `;` first means a new command).
  const after = s.slice(s.search(LOGIN));
  const upToTerminator = after.split(/;|\n/)[0];
  if (/&&|\|\|/.test(upToTerminator)) {
    // `|| true` / `|| exit 0` are not reachability verdicts, they are explicit
    // "ignore this" — but `|| echo unreachable` / `&& break` are.
    if (/\|\|\s*(true|:)\s*$/.test(upToTerminator.trim())) return null;
    return 'exit status short-circuited with && / ||';
  }
  if (/\bLOGIN_RC=\$\?|REACHABLE=|ok=true|reachable/i.test(s) && LOGIN.test(s)) {
    return 'exit status captured into a reachability flag';
  }
  return null;
}

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (SKIP_DIR.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const violations = [];
let loginsSeen = 0;

for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const rel = relative(ROOT, file).split(sep).join('/');

  // FOLD FIRST, THEN PRE-FILTER (#3420). `az acr \` + `login …` puts a
  // backslash between the words, so LOGIN is false for the raw file and the
  // cheap gate would skip it before the matcher ran. A pre-filter that skips a
  // file is a verdict too.
  const logical = readLogicalLines(text);
  if (!LOGIN.test(logical.map((l) => l.text).join('\n'))) continue;

  // `consumesStatus` reads what comes AFTER the login up to the next `;` — and
  // `|| echo "unreachable"` / `&& REACHABLE=1` is exactly the argument that
  // gets pushed onto a continuation:
  //
  //     az acr login --name "$ACR" \
  //       || echo "::warning::registry unreachable"
  //
  // Per physical line the `||` is on a line with no login on it, so the status
  // consumption this guard exists to detect was invisible.
  for (const { line, text: raw } of logical) {
    if (/^\s*#/.test(raw)) continue; // prose about the rule is not the rule
    if (!LOGIN.test(raw)) continue;
    loginsSeen++;
    const why = consumesStatus(raw);
    if (why) violations.push({ file: rel, line, why, text: raw.trim().slice(0, 150) });
  }
}

if (files.length === 0) {
  console.error('::error::acr-reachability-oracle: scanned ZERO files — the walker is broken. Refusing to report a pass.');
  process.exit(1);
}
if (loginsSeen === 0) {
  console.error(
    `::error::acr-reachability-oracle: found ZERO \`az acr login\` calls in ${files.length} scanned files. ` +
      'This repo builds and pulls from a firewalled ACR on every deploy path, so zero means the matcher has ' +
      'drifted off the code. Refusing to report a pass on an empty population.',
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `::error::acr-reachability-oracle: ${violations.length} site(s) consume \`az acr login\`'s exit status as a ` +
      'data-plane reachability verdict. It is not one — it authenticates via an ARM-mediated token exchange and ' +
      'returns 0 while the registry still refuses this runner by IP (roll 31454217160). Use ' +
      '`bash scripts/ci/acr-dataplane-ready.sh --acr "$ACR"` for reachability, then `az acr login` purely to mint ' +
      'the token.',
  );
  for (const v of violations) {
    console.error(`::error file=${v.file},line=${v.line}::${v.why} | ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `acr-reachability-oracle OK — ${files.length} files scanned, ${loginsSeen} \`az acr login\` call(s), ` +
    'none consumed as a reachability verdict.',
);
