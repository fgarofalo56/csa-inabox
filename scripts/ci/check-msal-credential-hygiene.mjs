#!/usr/bin/env node
/**
 * GUARDRAIL: msal-credential-hygiene  (merge-blocker — #3335)
 * ---------------------------------------------------------------------------
 * MEASURED 2026-08-13 on the live Commercial app registration
 * 5c59f3f3-e26d-4122-a707-a04e21ff5255: NINE live password credentials, five of
 * them minted that day (05:26, 07:06, 08:27, 09:44, 12:50Z), each `--years 2`.
 *
 * Cause: `scripts/csa-loom/bootstrap-msal-app-reg.sh` ran
 * `az ad app credential reset --append --years 2` UNCONDITIONALLY on every
 * invocation and nothing ever removed one. The mint rate follows the DEPLOY
 * rate — `deploy-fiab-commercial` ran 11 times that day and reaches the script
 * through `csa-loom-post-deploy-bootstrap`'s `workflow_call` — so every green
 * deploy left another two-year live credential behind. That is a security
 * posture defect (unbounded standing credentials) even while sign-in works.
 *
 * A second, opposite defect was found in the sibling: the in-bicep
 * deploymentScript used a BARE `az ad app credential reset` with no `--append`.
 * Per the az help that "clears all passwords and keys" — it DELETES the
 * credential the running console is still serving. It is latent today only
 * because the script is gated on a `scriptIdentityId` no param supplies.
 *
 * WHY A STATIC GUARD IN ADDITION TO THE LIVE CEILING. The live ceiling
 * (asserted inside the bootstrap script, on the real credential count) can only
 * fail once a regression has already reached an estate. This one fails at
 * review time, on every PR, and cannot be skipped — the two are complements,
 * not duplicates.
 *
 * THE RULES (each mutation-proved by --self-test):
 *   R0  LIVENESS. The mint statement must be FOUND in the bootstrap script. If
 *       the structure this guard reads has moved, it says it cannot see the
 *       subject and FAILS. A guard matching nothing measures nothing — this
 *       repo has shipped several of those.
 *   R1  No `az ad app credential reset` anywhere in the subjects may omit
 *       `--append`. A bare reset is a credential wipe.
 *   R2  The bootstrap's mint must be CONDITIONAL — reachable only under a
 *       reuse gate. An unconditional mint is the #3335 defect verbatim.
 *   R3  The bootstrap must assert a credential CEILING on a real count, and
 *       that assertion must be able to fail: no `|| true`, `|| :`, `|| echo`,
 *       `2>/dev/null`, or `set +e` on the line that evaluates it.
 *   R4  The bootstrap must offer a DRY RUN: a prune that deletes by default,
 *       with no operator opt-in, is exactly the blind delete-then-create this
 *       change exists to prevent.
 *   R5  No line may print a credential VALUE. Concretely: the variable holding
 *       `--query password` output must never appear in an `echo`/`printf`
 *       format position, and `credential list` must never be asked for a
 *       password field. Key ids and dates are not secrets and are allowed.
 *   R6  The prune must delete by KEY ID (`credential delete --key-id`), never
 *       by a bare `credential reset` used as a clear-all.
 *
 * DELIBERATELY OUT OF SCOPE (stated, not implied):
 *   - This is a TEXT guard. It proves the shapes are present; it does not
 *     prove the runtime behaviour. That is what
 *     scripts/ci/__tests__/msal-credential-lifecycle.test.mjs does, by driving
 *     the real script against a stub `az`.
 *   - `az ad app credential reset` in OTHER scripts (gov-dataverse.yml,
 *     provision-scc-labels-sidecar.sh) governs different app registrations with
 *     different lifecycles and is not judged here.
 *
 * MODES
 *   node scripts/ci/check-msal-credential-hygiene.mjs              # CHECK
 *   node scripts/ci/check-msal-credential-hygiene.mjs --self-test  # prove it can fail
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'scripts', 'csa-loom', 'bootstrap-msal-app-reg.sh');
const BICEP = join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'entra-app-registration.bicep');

const RESET = /az\s+ad\s+app\s+credential\s+reset\b/;
const DISCARDS = /\|\|\s*(true|:|echo)\b|2>\s*\/dev\/null|set\s+\+e/;

/** Join backslash-continued lines into logical commands, keeping 1-based start
 *  lines. Without this a `--append` on a continuation line reads as absent —
 *  the guard would flag the FIXED shape and stay quiet on the broken one. */
export function logicalCommands(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf === '') start = i + 1;
    if (/\\\s*$/.test(line)) {
      buf += `${line.replace(/\\\s*$/, ' ')}`;
      continue;
    }
    buf += line;
    if (buf.trim() !== '') out.push({ text: buf, line: start });
    buf = '';
  }
  if (buf.trim() !== '') out.push({ text: buf, line: start });
  return out;
}

/** Commands only — comment lines and `echo` output lines are prose, not writes.
 *  Judging an `echo` as a command is the R7 error inside the guard itself. */
export function executableCommands(text) {
  return logicalCommands(text).filter((c) => !/^\s*#/.test(c.text) && !/^\s*echo\b/.test(c.text));
}

/** Is `line` inside a conditional block? Walks the preceding executable lines
 *  tracking if/fi depth, so "the mint is gated" is judged structurally rather
 *  than by looking for a magic word near it. */
export function insideConditional(text, targetLine) {
  const lines = text.split(/\r?\n/);
  let depth = 0;
  for (let i = 0; i < targetLine - 1 && i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*#/.test(l)) continue;
    if (/^\s*if\s/.test(l)) depth++;
    if (/^\s*fi\b/.test(l)) depth--;
  }
  return depth > 0;
}

export function analyzeBootstrap(text) {
  const findings = [];
  const cmds = executableCommands(text);

  // R0 — liveness. Everything below is relative to the mint statement.
  const resets = cmds.filter((c) => RESET.test(c.text));
  if (resets.length === 0) {
    findings.push({
      rule: 'R0',
      line: 0,
      msg:
        'no `az ad app credential reset` found in the MSAL bootstrap. This guard reads that statement ' +
        'to judge whether the mint is appended, conditional, and bounded; with the subject gone it can ' +
        'only report that it does not know. If minting moved, re-point this guard at its new home.',
    });
    return findings;
  }

  for (const c of resets) {
    // R1 — a bare reset clears ALL passwords and keys (az help, verbatim).
    if (!/--append\b/.test(c.text)) {
      findings.push({
        rule: 'R1',
        line: c.line,
        msg:
          '`az ad app credential reset` without `--append`. Per the az help this "clears all passwords ' +
          'and keys", so it DELETES the credential the running console is still serving — AADSTS7000215 ' +
          'on every sign-in from that instant until the next revision roll. Add --append.',
      });
    }
    // R2 — an unconditional mint is the #3335 defect.
    if (!insideConditional(text, c.line)) {
      findings.push({
        rule: 'R2',
        line: c.line,
        msg:
          'the credential mint is UNCONDITIONAL — it runs on every invocation. That is the #3335 defect ' +
          'verbatim: measured 9 live credentials on the Commercial app registration, 5 minted in one ' +
          'day, because the mint rate follows the deploy rate. Gate it behind a reuse check that ' +
          'mints only when Key Vault records no healthy credential.',
      });
    }
  }

  // R3 — a ceiling that is asserted, and that can fail.
  const ceiling = cmds.filter((c) => /CREDENTIAL_CEILING/.test(c.text) && /-gt|-ge/.test(c.text));
  if (ceiling.length === 0) {
    findings.push({
      rule: 'R3',
      line: 0,
      msg:
        'no credential-count ceiling is asserted. Without it a reuse regression is invisible until ' +
        'someone reads the app registration by hand — which is how 9 credentials accumulated unnoticed. ' +
        'Compare the live count from `az ad app credential list` against a ceiling and exit non-zero.',
    });
  }
  for (const c of ceiling) {
    if (DISCARDS.test(c.text)) {
      findings.push({
        rule: 'R3',
        line: c.line,
        msg:
          'the ceiling assertion discards its own result (`|| true` / `|| :` / `|| echo` / `2>/dev/null` ' +
          '/ `set +e`). A check that cannot fail measures nothing.',
      });
    }
  }

  // R4 — the prune must be reviewable before it is destructive.
  if (/credential\s+delete\b/.test(text) && !/LOOM_MSAL_PRUNE\b/.test(text)) {
    findings.push({
      rule: 'R4',
      line: 0,
      msg:
        'credentials are deleted with no dry-run/opt-in control (LOOM_MSAL_PRUNE). A prune that deletes ' +
        'by default gives the operator no chance to review which key ids would go, which is the blind ' +
        'delete-then-create that strands a running app.',
    });
  }

  // R5 — nothing may print a credential value.
  for (const c of logicalCommands(text)) {
    if (/credential\s+list\b/.test(c.text) && /\bpassword\b/.test(c.text)) {
      findings.push({
        rule: 'R5',
        line: c.line,
        msg: '`credential list` asked for a password field. Credential metadata (keyId, dates, displayName) is safe; values are not.',
      });
    }
    // The variable holding `--query password` output, used as output.
    if (/^\s*(echo|printf)\b/.test(c.text) && /\$\{?SECRET\b/.test(c.text)) {
      findings.push({
        rule: 'R5',
        line: c.line,
        msg: 'this line prints ${SECRET} — the value returned by `credential reset --query password`. A secret value must never be echoed, logged, or committed.',
      });
    }
  }

  // R6 — deletion is by key id, never a clear-all masquerading as cleanup.
  const deletes = executableCommands(text).filter((c) => /credential\s+delete\b/.test(c.text));
  for (const c of deletes) {
    if (!/--key-id\b/.test(c.text)) {
      findings.push({
        rule: 'R6',
        line: c.line,
        msg: '`credential delete` without `--key-id` — a prune must remove exactly the credential it evaluated, never a broad clear.',
      });
    }
  }

  return findings;
}

/** The bicep sibling: same R1/R5 rules. R2 is judged too — an unconditional
 *  mint in a deploymentScript that reruns on every `az deployment sub create`
 *  is the same unbounded growth. R3/R4/R6 are deliberately NOT required there:
 *  the prune belongs in the bootstrap, where the console binding can be proven. */
export function analyzeBicep(text) {
  const findings = [];
  const cmds = executableCommands(text);
  const resets = cmds.filter((c) => RESET.test(c.text));
  if (resets.length === 0) {
    findings.push({
      rule: 'R0',
      line: 0,
      msg:
        'no `az ad app credential reset` found in the in-bicep app-registration deploymentScript. If ' +
        'the mint moved, re-point this guard; if it was removed, delete this subject from the guard ' +
        'deliberately rather than leaving a rule that watches nothing.',
    });
    return findings;
  }
  for (const c of resets) {
    if (!/--append\b/.test(c.text)) {
      findings.push({
        rule: 'R1',
        line: c.line,
        msg:
          '`az ad app credential reset` without `--append` in the bicep deploymentScript. This is the ' +
          'credential-WIPE defect: it deletes every existing credential, including the one the running ' +
          'console is serving. The sibling shell script has carried --append since 2026-06; this copy ' +
          'drifted. Both provisioning homes must agree.',
      });
    }
    if (!insideConditional(text, c.line)) {
      findings.push({
        rule: 'R2',
        line: c.line,
        msg:
          'the mint in the bicep deploymentScript is UNCONDITIONAL. The script re-runs on every ' +
          '`az deployment sub create` (forceUpdateTag defaults to utcNow()), so this grows the ' +
          'credential list once per deploy — the #3335 defect in the other provisioning home.',
      });
    }
  }
  for (const c of logicalCommands(text)) {
    if (/credential\s+list\b/.test(c.text) && /\bpassword\b/.test(c.text)) {
      findings.push({ rule: 'R5', line: c.line, msg: '`credential list` asked for a password field.' });
    }
    if (/^\s*(echo|printf)\b/.test(c.text) && /\$\{?SECRET\b/.test(c.text)) {
      findings.push({ rule: 'R5', line: c.line, msg: 'this line prints ${SECRET} — a credential value must never be echoed.' });
    }
  }
  return findings;
}

// ── self-test fixtures ──────────────────────────────────────────────────────
const FIX_CLEAN = `#!/usr/bin/env bash
set -euo pipefail
if [ -n "\${IN_USE_KEY_ID}" ]; then
  REUSED=1
fi
if [ "\${REUSED}" -ne 1 ]; then
  SECRET="$(az ad app credential reset --id "\${APP_ID}" --append --years "\${SECRET_YEARS}" \\
    --display-name "\${CRED_LABEL}" --query password -o tsv)"
fi
if [ "\${PRUNE_ENABLED}" -ne 1 ]; then
  echo "DRY RUN — LOOM_MSAL_PRUNE=1 to authorize"
else
  az ad app credential delete --id "\${APP_ID}" --key-id "\${_k}"
fi
if [ "\${FINAL_COUNT}" -gt "\${CREDENTIAL_CEILING}" ]; then
  exit 1
fi
`;
const FIX_BARE_RESET = FIX_CLEAN.replace('--append --years', '--years');
const FIX_UNCONDITIONAL = `#!/usr/bin/env bash
set -euo pipefail
SECRET="$(az ad app credential reset --id "\${APP_ID}" --append --years 2 --query password -o tsv)"
if [ "\${FINAL_COUNT}" -gt "\${CREDENTIAL_CEILING}" ]; then
  exit 1
fi
`;
const FIX_NO_CEILING = FIX_CLEAN.replace(
  /if \[ "\$\{FINAL_COUNT\}" -gt "\$\{CREDENTIAL_CEILING\}" \]; then\n  exit 1\nfi\n/,
  '',
);
const FIX_CEILING_DISCARDED = FIX_CLEAN.replace(
  'if [ "${FINAL_COUNT}" -gt "${CREDENTIAL_CEILING}" ]; then',
  'if [ "${FINAL_COUNT}" -gt "${CREDENTIAL_CEILING}" ] 2>/dev/null; then',
);
const FIX_NO_DRYRUN = FIX_CLEAN.replace(/if \[ "\$\{PRUNE_ENABLED\}" -ne 1 \]; then\n.*\nelse\n/, 'if true; then\n');
const FIX_PRINTS_SECRET = `${FIX_CLEAN}
echo "minted \${SECRET}"
`;
const FIX_DELETE_NO_KEYID = FIX_CLEAN.replace('--key-id "${_k}"', '');
const FIX_NO_RESET = '#!/usr/bin/env bash\nset -euo pipefail\necho "nothing here"\n';
// The --append on a CONTINUATION line: reads as absent to a line-at-a-time
// matcher, which would flag the fixed shape and stay quiet on the broken one.
const FIX_APPEND_CONTINUED = `#!/usr/bin/env bash
if [ "\${REUSED}" -ne 1 ]; then
  SECRET="$(az ad app credential reset --id "\${APP_ID}" \\
    --append \\
    --years 2 --query password -o tsv)"
fi
if [ "\${FINAL_COUNT}" -gt "\${CREDENTIAL_CEILING}" ]; then
  exit 1
fi
`;

function selfTest() {
  let ok = true;
  const say = (pass, msg) => {
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!pass) ok = false;
  };
  const rules = (f) => f.map((x) => x.rule).join(',') || 'none';
  console.log('[msal-credential-hygiene] self-test — the guard must FAIL on the real defects');

  const clean = analyzeBootstrap(FIX_CLEAN);
  say(clean.length === 0, `the compliant shape is silent (got ${rules(clean)})`);

  const continued = analyzeBootstrap(FIX_APPEND_CONTINUED);
  say(
    continued.length === 0,
    `--append on a CONTINUATION line is recognised, not flagged (got ${rules(continued)})`,
  );

  const bare = analyzeBootstrap(FIX_BARE_RESET);
  say(bare.some((f) => f.rule === 'R1' && f.line > 0), 'a bare `credential reset` (the credential WIPE) is detected');
  say(bare.some((f) => /clears all passwords/.test(f.msg)), 'the R1 finding names the actual consequence');

  const uncond = analyzeBootstrap(FIX_UNCONDITIONAL);
  say(uncond.some((f) => f.rule === 'R2' && f.line > 0), 'an UNCONDITIONAL mint (the #3335 defect verbatim) is detected');

  const noCeiling = analyzeBootstrap(FIX_NO_CEILING);
  say(noCeiling.some((f) => f.rule === 'R3'), 'a missing credential ceiling is detected');

  const deadCeiling = analyzeBootstrap(FIX_CEILING_DISCARDED);
  say(deadCeiling.some((f) => f.rule === 'R3' && f.line > 0), 'a ceiling whose result is discarded is detected');

  const noDry = analyzeBootstrap(FIX_NO_DRYRUN);
  say(noDry.some((f) => f.rule === 'R4'), 'a prune with no dry-run/opt-in control is detected');

  const leaks = analyzeBootstrap(FIX_PRINTS_SECRET);
  say(leaks.some((f) => f.rule === 'R5' && f.line > 0), 'a line echoing ${SECRET} is detected');

  const badDelete = analyzeBootstrap(FIX_DELETE_NO_KEYID);
  say(badDelete.some((f) => f.rule === 'R6'), 'a `credential delete` with no --key-id is detected');

  const gone = analyzeBootstrap(FIX_NO_RESET);
  say(
    gone.some((f) => f.rule === 'R0'),
    'a subject with NO mint statement fails as UNKNOWN rather than passing vacuously',
  );

  const bicepBare = analyzeBicep(FIX_BARE_RESET);
  say(bicepBare.some((f) => f.rule === 'R1'), 'the bicep analyzer detects the same bare-reset wipe');
  const bicepClean = analyzeBicep(FIX_CLEAN);
  say(bicepClean.length === 0, `the bicep analyzer is silent on a compliant shape (got ${rules(bicepClean)})`);

  console.log(ok ? '[msal-credential-hygiene] self-test OK' : '[msal-credential-hygiene] self-test FAILED');
  return ok ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  if (process.argv.slice(2).includes('--self-test')) return selfTest();
  let failed = false;
  for (const [file, analyze] of [
    [BOOTSTRAP, analyzeBootstrap],
    [BICEP, analyzeBicep],
  ]) {
    if (!existsSync(file)) {
      console.error(`[msal-credential-hygiene] FAIL — subject missing: ${file}`);
      console.error('   If it moved, re-point this guard; a guard whose subject vanished measures nothing.');
      failed = true;
      continue;
    }
    for (const f of analyze(readFileSync(file, 'utf8'))) {
      console.error(`[msal-credential-hygiene] FAIL ${f.rule} — ${file.replace(/\\/g, '/')}:${f.line}`);
      console.error(`   ${f.msg}`);
      failed = true;
    }
  }
  if (failed) return 1;
  console.log(
    '[msal-credential-hygiene] OK — every MSAL credential mint is appended (never a wipe) and gated ' +
      'behind a reuse check, the bootstrap asserts a credential ceiling that can fail, the prune is ' +
      'dry-run-able and deletes by key id, and no path prints a credential value.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
