#!/usr/bin/env node
/**
 * GUARDRAIL: msal-rotation-consistency  (merge-blocker — #3025)
 * ---------------------------------------------------------------------------
 * Two rotation traps were found live on 2026-08-06 while verifying the MSAL
 * credential state (#3025):
 *
 *   1. The console carried `LOOM_MSAL_SECRET_ROTATED=2026-07-19…` while the
 *      inline secret was the 2026-08-03 credential — the marker was TWO
 *      rotations stale, because the hand that wrote the secret never wrote
 *      the marker. A stale marker is read at exactly the worst moment
 *      (AADSTS7000215 triage) and sends the triage down the wrong path.
 *   2. The rotation RUNBOOK told operators `identityref:system`, while bicep
 *      and the live app resolve Key Vault references with the USER-ASSIGNED
 *      console UAMI. A recovery doc pointing at an identity the app does not
 *      use is a defect with teeth (deploy-integrity.md R8) — it is read when
 *      sign-in is already broken.
 *
 * THE RULES (each is mutation-proved by --self-test):
 *   R1  In scripts/csa-loom/bootstrap-msal-app-reg.sh, every
 *       `az containerapp update` that wires LOOM_MSAL_CLIENT_SECRET must set
 *       LOOM_MSAL_SECRET_ROTATED in the SAME command — the marker is written
 *       by the same hand that writes the secret, or it drifts. At least one
 *       such command must exist (a guard that matches nothing measures
 *       nothing and refuses to pass).
 *   R2  docs/fiab/runbooks/secret-rotation.md must stamp
 *       LOOM_MSAL_SECRET_ROTATED in an `az containerapp update` command, and
 *       must NOT use the old marker-less LOOM_ROTATION_STAMP roll idiom.
 *   R3  `identityref:system` is forbidden in both subjects — every console
 *       Key Vault secret reference resolves via the user-assigned UAMI.
 *   R4  In the runbook, no `az containerapp secret set` command may discard
 *       its result (`|| true`, `2>/dev/null`) — deploy-integrity.md R7: a
 *       recovery step that cannot fail reports a rotation that did not
 *       happen.
 *
 * SCOPE — deliberately NOT folded in here: #3056 (loom-internal-token
 * rotation stranding stale copies across jobs/Actions secrets, and the
 * admin-plane bicep guid overwriting rotated values). That is a different
 * secret with a different fix class (transactional multi-holder rotation +
 * explicit bicep-vs-rotation ownership), owned by the E1 lane (#3053).
 *
 * MODES
 *   node scripts/ci/check-msal-rotation-consistency.mjs              # CHECK
 *   node scripts/ci/check-msal-rotation-consistency.mjs --self-test  # prove it can fail
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'scripts', 'csa-loom', 'bootstrap-msal-app-reg.sh');
const RUNBOOK = join(REPO_ROOT, 'docs', 'fiab', 'runbooks', 'secret-rotation.md');

/** Join backslash-continued lines into logical commands, keeping 1-based
 *  start lines so findings can name a real position. */
export function logicalCommands(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (buf === '') start = i + 1;
    if (/\\\s*$/.test(line)) {
      buf += line.replace(/\\\s*$/, ' ');
      continue;
    }
    buf += line;
    if (buf.trim() !== '') out.push({ text: buf, line: start });
    buf = '';
  }
  if (buf.trim() !== '') out.push({ text: buf, line: start });
  return out;
}

/** R1 — every secret-wiring `az containerapp update` also stamps the marker. */
export function analyzeBootstrap(text) {
  const findings = [];
  const cmds = logicalCommands(text);
  const rolls = cmds.filter(
    (c) => /az\s+containerapp\s+update\b/.test(c.text) && /LOOM_MSAL_CLIENT_SECRET=/.test(c.text),
  );
  if (rolls.length === 0) {
    findings.push({
      rule: 'R1',
      line: 0,
      msg:
        'no `az containerapp update` wiring LOOM_MSAL_CLIENT_SECRET found — the structure this ' +
        'guard watches has changed. Re-point the guard at the new secret-rotation roll; a guard ' +
        'matching nothing measures nothing.',
    });
  }
  for (const c of rolls) {
    if (!/LOOM_MSAL_SECRET_ROTATED=/.test(c.text)) {
      findings.push({
        rule: 'R1',
        line: c.line,
        msg:
          'this `az containerapp update` wires the MSAL secret but does NOT stamp ' +
          'LOOM_MSAL_SECRET_ROTATED in the same command — the marker will drift from the secret ' +
          '(#3025: measured two rotations stale in production).',
      });
    }
  }
  for (const c of cmds) {
    if (/identityref:system\b/.test(c.text)) {
      findings.push({
        rule: 'R3',
        line: c.line,
        msg: '`identityref:system` — console KV references resolve via the user-assigned UAMI, never the system identity.',
      });
    }
  }
  return findings;
}

/** R2/R3/R4 — the runbook stamps the marker, names the right identity, and
 *  its rotation commands are allowed to fail. */
export function analyzeRunbook(text) {
  const findings = [];
  const cmds = logicalCommands(text);

  const stamps = cmds.some(
    (c) => /az\s+containerapp\s+update\b/.test(c.text) && /LOOM_MSAL_SECRET_ROTATED=/.test(c.text),
  );
  if (!stamps) {
    findings.push({
      rule: 'R2',
      line: 0,
      msg:
        'the rotation runbook has no `az containerapp update` stamping LOOM_MSAL_SECRET_ROTATED — ' +
        'the revision roll and the marker write must be the SAME command (#3025).',
    });
  }
  for (const c of cmds) {
    if (/LOOM_ROTATION_STAMP=/.test(c.text)) {
      findings.push({
        rule: 'R2',
        line: c.line,
        msg:
          'the old marker-less roll idiom (LOOM_ROTATION_STAMP) — roll the revision by stamping ' +
          'LOOM_MSAL_SECRET_ROTATED instead, so the marker cannot drift.',
      });
    }
    if (/identityref:system\b/.test(c.text)) {
      findings.push({
        rule: 'R3',
        line: c.line,
        msg:
          '`identityref:system` — bicep and the live app use the USER-ASSIGNED console UAMI; a ' +
          'system reference never resolves, and this is a RECOVERY document (deploy-integrity.md R8).',
      });
    }
    if (/az\s+containerapp\s+secret\s+set\b/.test(c.text) && /(\|\|\s*true|2>\/dev\/null)/.test(c.text)) {
      findings.push({
        rule: 'R4',
        line: c.line,
        msg:
          'the rotation `az containerapp secret set` discards its result (`|| true` / `2>/dev/null`) — ' +
          'a recovery step that cannot fail reports a rotation that did not happen (R7).',
      });
    }
  }
  return findings;
}

// ── self-test: the guard must be observed FAILING on each defect ────────────
const FIX_BOOT_CLEAN = `
az containerapp secret set -n app -g rg --secrets \\
  "loom-msal-client-secret=keyvaultref:https://kv/secrets/s,identityref:/subscriptions/x/uami" -o none
az containerapp update -n app -g rg \\
  --set-env-vars "LOOM_MSAL_CLIENT_ID=id" "LOOM_MSAL_CLIENT_SECRET=secretref:s" "LOOM_MSAL_SECRET_ROTATED=2026-08-06T0000Z" -o none
`;
const FIX_BOOT_STALE_MARKER = `
az containerapp update -n app -g rg \\
  --set-env-vars "LOOM_MSAL_CLIENT_ID=id" "LOOM_MSAL_CLIENT_SECRET=secretref:s" -o none
`;
const FIX_RB_CLEAN = `
UAMI_ID=$(az containerapp show -n app -g rg --query "keys(identity.userAssignedIdentities)[0]" -o tsv)
az containerapp secret set -n app -g rg \\
  --secrets "loom-msal-client-secret=keyvaultref:https://kv/secrets/s,identityref:$UAMI_ID"
az containerapp update -n app -g rg \\
  --set-env-vars "LOOM_MSAL_SECRET_ROTATED=$(date -u +%Y-%m-%dT%H%MZ)"
`;
const FIX_RB_WRONG_IDENTITY_SWALLOWED = `
az containerapp secret set -n app -g rg \\
  --secrets "loom-msal-client-secret=keyvaultref:https://kv/secrets/s,identityref:system" 2>/dev/null || true
az containerapp update -n app -g rg \\
  --set-env-vars "LOOM_ROTATION_STAMP=$(date +%s)"
`;

function selfTest() {
  let ok = true;
  const say = (pass, msg) => {
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!pass) ok = false;
  };
  console.log('[msal-rotation-consistency] self-test — the guard must FAIL on the real defects');

  const clean = analyzeBootstrap(FIX_BOOT_CLEAN);
  say(clean.length === 0, `clean bootstrap shape is silent (got ${clean.length}: ${clean.map((f) => f.rule).join(',')})`);

  const stale = analyzeBootstrap(FIX_BOOT_STALE_MARKER);
  say(
    stale.some((f) => f.rule === 'R1' && f.line > 0),
    'a secret-wiring roll WITHOUT the marker stamp is detected (the #3025 drift)',
  );

  const rbClean = analyzeRunbook(FIX_RB_CLEAN);
  say(rbClean.length === 0, `clean runbook shape is silent (got ${rbClean.length}: ${rbClean.map((f) => f.rule).join(',')})`);

  const rbBad = analyzeRunbook(FIX_RB_WRONG_IDENTITY_SWALLOWED);
  say(rbBad.some((f) => f.rule === 'R3'), 'identityref:system in the runbook is detected');
  say(rbBad.some((f) => f.rule === 'R4'), 'a result-discarding secret set in the runbook is detected');
  say(rbBad.some((f) => f.rule === 'R2'), 'the marker-less LOOM_ROTATION_STAMP roll idiom is detected');

  console.log(ok ? '[msal-rotation-consistency] self-test OK' : '[msal-rotation-consistency] self-test FAILED');
  return ok ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  let failed = false;
  for (const [file, analyze] of [
    [BOOTSTRAP, analyzeBootstrap],
    [RUNBOOK, analyzeRunbook],
  ]) {
    if (!existsSync(file)) {
      console.error(`[msal-rotation-consistency] FAIL — subject missing: ${file}`);
      console.error('   If it moved, re-point this guard; a guard whose subject vanished measures nothing.');
      failed = true;
      continue;
    }
    const findings = analyze(readFileSync(file, 'utf8'));
    for (const f of findings) {
      console.error(`[msal-rotation-consistency] FAIL ${f.rule} — ${file.replace(/\\/g, '/')}:${f.line}`);
      console.error(`   ${f.msg}`);
      failed = true;
    }
  }
  if (failed) return 1;
  console.log(
    '[msal-rotation-consistency] OK — the MSAL secret writer stamps LOOM_MSAL_SECRET_ROTATED in the ' +
      'same command, the runbook names the UAMI, and no rotation step discards its result.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
