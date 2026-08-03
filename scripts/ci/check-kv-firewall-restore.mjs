#!/usr/bin/env node
/**
 * GUARDRAIL: the Key Vault firewall may only be toggled through the VERIFIED
 * helper, and anything that opens a window must close it.
 *
 * WHY THIS EXISTS (#2855)
 * -----------------------
 * Six call sites opened the Loom Key Vault's firewall for a secret write and
 * re-locked it afterwards. Not one verified that the re-lock APPLIED — every
 * one trusted `az keyvault update`'s exit code, and most discarded even that:
 *
 *   az keyvault update -n "$KV" --public-network-access Disabled ... || true
 *   az keyvault update -n "$KV" --public-network-access Disabled ... 2>/dev/null
 *   az keyvault update ... 2>/dev/null && echo ok || echo "::warning::Could not…"
 *
 * A transient ARM error therefore left the vault holding Loom's sign-in secrets
 * publicly reachable, with a GREEN workflow — and three of the six printed a
 * line claiming it had been locked. `scripts/csa-loom/kv-firewall-window.sh`
 * re-reads publicNetworkAccess + networkAcls.defaultAction + the ipRules count
 * and returns non-zero unless all three confirm; an unreadable vault is a
 * failure, never a pass.
 *
 * That verification is worth nothing if the next author writes a raw
 * `az keyvault update --public-network-access` inline again, which is exactly
 * how the class grew to six sites. Hence a chokepoint.
 *
 * THE RULES
 * ---------
 *   1. CHOKEPOINT. `az keyvault update` carrying `--public-network-access` or
 *      `--default-action`, and `az keyvault network-rule add|remove`, may appear
 *      only in SANCTIONED files (the helper itself and its fake-`az` test
 *      double). Everywhere else: call the helper.
 *   2. PAIRING. A file that RUNS `kv-firewall-window.sh open` must also RUN
 *      `kv-firewall-window.sh close`. Opening a window with no restore is the
 *      original exposure with extra steps.
 *
 * WHAT A COMMENT CANNOT DO
 * ------------------------
 * Both rules are evaluated against the COMMENT-STRIPPED body. A `#` line is
 * neither a violation (so the prose above `bash …/kv-firewall-window.sh close`
 * is free to quote the old broken command) nor a satisfaction (so a comment
 * that merely NAMES the close cannot discharge rule 2). Rule 2 additionally
 * requires an EXECUTION shape — `bash <path> close`, `sh <path> close`,
 * `./<path> close`, `source <path>` — so an `echo`/`::warning::` string that
 * mentions the script does not count. That distinction is the whole bug in
 * #2816, where a `::warning::` naming a deploy script scored as a deploy path.
 *
 * SELF-DEFENCE: this check refuses to pass vacuously. If the helper is missing,
 * if it scans no files, or if it finds no file actually calling the helper, it
 * FAILS rather than printing OK — a scanner that silently stops matching is the
 * same defect it exists to catch (the 2026-07-28 "gates that measure nothing"
 * class, and #2836 specifically).
 *
 * Usage: node scripts/ci/check-kv-firewall-restore.mjs [root]
 *   The optional root exists for scripts/ci/__tests__/kv-firewall-restore.test.mjs;
 *   CI passes nothing.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const IS_DEFAULT = !process.argv[2];

const HELPER = 'scripts/csa-loom/kv-firewall-window.sh';

/**
 * Files allowed to contain the raw `az` firewall verbs.
 *   - the helper IS the implementation
 *   - this guard has to spell the patterns out to search for them
 * Two entries, both enumerated so a reviewer can see neither is a production
 * call site — one is the chokepoint, the other is the scanner. The helper's
 * fake-`az` test double is deliberately NOT here: it dispatches on parsed
 * argv (`keyvault:update`), never on the literal command line, so it does not
 * need an exemption and does not get one.
 */
const SANCTIONED = new Set([
  HELPER,
  'scripts/ci/check-kv-firewall-restore.mjs',
]);

/** Directories scanned. Everything that can talk to Azure at deploy time. */
const SCAN_DIRS = ['.github/workflows', 'scripts'];
const SCAN_EXT = /\.(ya?ml|sh|mjs|js|ps1)$/;

/**
 * Strip comments so prose can neither violate nor satisfy a rule.
 *
 * BOTH comment syntaxes matter. The first draft of this guard handled only `#`
 * and its own `/** ... *\/` header then scored as three helper "call sites" —
 * a guard a comment could satisfy, inside a guard written to close exactly that
 * class. Caught by enumerating what the detector matched instead of trusting
 * the total.
 */
function stripComments(text, isJs) {
  let t = text;
  if (isJs) {
    t = t.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    t = t.replace(/^\s*\/\/.*$/gm, '');
  }
  return t
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*#/.test(line)) return '';
      // Trailing comment: a `#` preceded by whitespace. Deliberately conservative
      // — it will leave a `#` inside a quoted string alone only when it is not
      // whitespace-preceded, which is the common case for URLs and colour codes.
      return line.replace(/\s#(?:\s.*)?$/, '');
    })
    .join('\n');
}

/** Raw firewall mutations that must live behind the helper. */
const RAW_MUTATION = [
  {
    id: 'az keyvault update --public-network-access',
    re: /az\s+keyvault\s+update\b[^\n]*--public-network-access\b/,
  },
  {
    id: 'az keyvault update --default-action',
    re: /az\s+keyvault\s+update\b[^\n]*--default-action\b/,
  },
  {
    id: 'az keyvault network-rule add|remove',
    re: /az\s+keyvault\s+network-rule\s+(?:add|remove)\b/,
  },
];

/** Does `line` EXECUTE the helper with `verb`? Not an echo, not a mention. */
function isHelperCall(line, verb) {
  if (/::(?:warning|notice|error|debug)::/.test(line)) return false;
  if (/^\s*(?:echo|printf)\b/.test(line)) return false;
  const path = 'kv-firewall-window\\.sh';
  const shapes = [
    new RegExp(`(?:^|[;&|(]|\\s)(?:ba)?sh\\s+[^\\n]*${path}["']?\\s+${verb}\\b`),
    new RegExp(`(?:^|[;&|(]|\\s)\\.?/?[^\\s"']*${path}["']?\\s+${verb}\\b`),
  ];
  return shapes.some((re) => re.test(line));
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      // scripts/ci/__tests__ holds SYNTHETIC violating fixtures on purpose —
      // this guard's own self-test writes the pre-#2855 `az keyvault update
      // … || true` into a temp dir to prove the detector fires. Those are
      // strings inside a node:test file; nothing there ever reaches Azure.
      // Scanning them would make every guard's self-test unwritable.
      if (e.name === '__tests__') continue;
      walk(p, out);
    } else if (SCAN_EXT.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const files = [];
for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  if (existsSync(abs) && statSync(abs).isDirectory()) walk(abs, files);
}

const violations = [];
let scanned = 0;
let helperCallSites = 0;

for (const abs of files) {
  const rel = relative(ROOT, abs).split(sep).join('/');
  scanned++;
  // The chokepoint and the scanner are the implementation, not call sites.
  // Skipping them keeps the helperCallSites counter a measure of PRODUCTION
  // adoption, so the self-check below cannot be satisfied by this file's own
  // strings.
  if (SANCTIONED.has(rel)) continue;

  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw, /\.(mjs|js)$/.test(rel));
  const codeLines = code.split('\n');

  // Rule 1 — chokepoint.
  for (const { id, re } of RAW_MUTATION) {
    codeLines.forEach((line, i) => {
      if (!re.test(line)) return;
      violations.push({
        rel,
        line: i + 1,
        msg: `raw \`${id}\` — the Key Vault firewall must be toggled through ${HELPER}, whose \`close\` VERIFIES the lock applied. An inline mutation is unverified by construction (#2855).`,
      });
    });
  }

  // Rule 2 — pairing.
  const opens = codeLines.filter((l) => isHelperCall(l, 'open')).length;
  const closes = codeLines.filter((l) => isHelperCall(l, 'close')).length;
  helperCallSites += opens + closes + codeLines.filter((l) => isHelperCall(l, 'verify')).length;
  if (opens > 0 && closes === 0) {
    violations.push({
      rel,
      line: codeLines.findIndex((l) => isHelperCall(l, 'open')) + 1,
      msg: `opens a Key Vault firewall window (${opens}x) and never runs \`kv-firewall-window.sh close\`. A window with no verified restore leaves the secret vault publicly reachable (#2855). A comment naming the close does not count — it must be executed.`,
    });
  }
}

// --- self-defence ------------------------------------------------------------
const problems = [];
if (IS_DEFAULT && !existsSync(join(ROOT, HELPER))) {
  problems.push(`${HELPER} is missing — the chokepoint this guard enforces does not exist.`);
}
if (scanned === 0) {
  problems.push(`scanned 0 files under ${SCAN_DIRS.join(', ')} — the guard is not looking at anything.`);
}
if (IS_DEFAULT && helperCallSites === 0) {
  problems.push(
    'found 0 executions of kv-firewall-window.sh anywhere — either every caller was reverted to an unverified inline mutation, or the detector stopped matching. Refusing to report OK.',
  );
}
if (problems.length > 0) {
  console.error('kv-firewall-restore: GUARD SELF-CHECK FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`kv-firewall-restore: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v.rel}:${v.line}\n    ${v.msg}\n`);
  console.error(`Fix: replace the inline \`az\` with\n`);
  console.error(`  bash ${HELPER} open  --vault "$KV_NAME"   # single-IP write window`);
  console.error(`  bash ${HELPER} close --vault "$KV_NAME"   # VERIFIED re-lock, non-zero if it did not apply\n`);
  process.exit(1);
}

console.log(
  `kv-firewall-restore: OK — ${scanned} files scanned, ${helperCallSites} verified helper call site(s), 0 raw Key Vault firewall mutations outside ${[...SANCTIONED].join(' + ')}.`,
);
