#!/usr/bin/env node
/**
 * GUARDRAIL: msal-rotation-consistency  (merge-blocker — #3025)
 * ---------------------------------------------------------------------------
 * Three rotation traps were found live while verifying the MSAL credential
 * state (#3025). The first two were fixed in the merge that created this
 * guard; the THIRD is what this revision exists for.
 *
 *   1. (2026-08-06) The console carried `LOOM_MSAL_SECRET_ROTATED=2026-07-19…`
 *      while the inline secret was the 2026-08-03 credential — the marker was
 *      two rotations stale, because the hand that wrote the secret never wrote
 *      the marker.
 *   2. (2026-08-06) The rotation RUNBOOK told operators `identityref:system`,
 *      while bicep and the live app resolve Key Vault references with the
 *      USER-ASSIGNED console UAMI. A recovery doc pointing at an identity the
 *      app does not use is a defect with teeth (deploy-integrity.md R8).
 *   3. (2026-08-10) Fixing (1) by co-writing the marker did not survive
 *      contact with the estate. Measured on the live loom-console:
 *      `LOOM_MSAL_SECRET_ROTATED` was ABSENT from all 425 env vars — not
 *      stale, GONE. Its only writer was a post-deploy `az containerapp
 *      update`, and it was never declared in
 *      platform/fiab/bicep/modules/admin-plane/main.bicep, so the next
 *      `az deployment sub create` re-rendered the container template without
 *      it. That is the verbatim "bicep re-render drops out-of-band state"
 *      class that already cost this repo three outages in one day (the admin
 *      OID, LOOM_ADLS_ACCOUNT, and the Front Door vanity binding). A marker
 *      that vanishes on the next deploy reads as "never rotated" during
 *      AADSTS7000215 triage — worse than no marker.
 *
 * THE FIX THIS GUARD NOW ENFORCES: there is no rotation-marker env var. The
 * record of which credential vintage is live is the Entra credential list
 * (`az ad app credential list`), cross-read with the Key Vault version
 * timeline and the active revision's createdTime — none of which a redeploy
 * can drop. See docs/fiab/runbooks/secret-rotation.md §2.1.
 *
 * THE RULES (each is mutation-proved by --self-test):
 *   R0  LIVENESS. The bicep env-declaration probe must work: the CONTROL env
 *       var (LOOM_MSAL_CLIENT_ID, which IS declared on the console container)
 *       must be found in admin-plane/main.bicep. If it is not, this guard
 *       cannot tell "declared" from "undeclared", so it says it does not know
 *       and FAILS — it never reports clean on a drifted matcher.
 *   R1  In scripts/csa-loom/bootstrap-msal-app-reg.sh, no executable line may
 *       write a rotation-marker env var (LOOM_*ROTAT*=) UNLESS
 *       admin-plane/main.bicep declares that same env var on the app. The rule
 *       is keyed to the MISMATCH — writer without a bicep declaration — not to
 *       the marker name, so re-introducing the marker PROPERLY (declared in
 *       bicep, therefore re-rendered every deploy) passes, and re-introducing
 *       it out-of-band does not. At least one `az containerapp update` wiring
 *       LOOM_MSAL_CLIENT_SECRET must exist (a guard that matches nothing
 *       measures nothing and refuses to pass).
 *       The trigger is deliberately NOT "…on a line that also contains
 *       `az containerapp`": while mutation-proving this revision, an injected
 *       marker whose line-continuation was malformed left the `--set-env-vars
 *       "LOOM_MSAL_SECRET_ROTATED=…"` fragment on a line carrying no command
 *       token, and the command-shaped trigger SKIPPED it — silently, which is
 *       the "shape I could not parse read as clean" failure. A marker
 *       assignment anywhere outside a comment or an `echo` is now the trigger.
 *   R2  docs/fiab/runbooks/secret-rotation.md must not instruct the same
 *       out-of-band stamp; it MUST name `az ad app credential list` as the
 *       authoritative vintage check (the replacement has to be present, not
 *       merely the bad thing absent); and it must still ROLL a revision AFTER
 *       the secret set — the marker stamp used to be that roll, so removing it
 *       without a replacement would leave rotations that never take effect.
 *   R3  `identityref:system` is forbidden in both subjects, and the runbook
 *       must positively derive the identity from `userAssignedIdentities`.
 *       (The negative token disappears from a FIXED file, which would leave
 *       the rule silent on exactly the file it protects; the positive floor is
 *       what keeps watching it.)
 *   R4  In BOTH subjects, no `az containerapp update|secret set` touching the
 *       MSAL credential may discard its result (`|| true`, `|| :`, `|| echo`,
 *       `2>/dev/null`). deploy-integrity.md R7: a step that cannot fail
 *       reports a rotation that did not happen. This is scoped to both files
 *       on purpose — the previous revision scoped it to the runbook, and so
 *       it stayed green on bootstrap-msal-app-reg.sh, whose wiring roll ended
 *       in `|| echo "WARN: env-var update failed"` while the NEXT line printed
 *       "wired LOOM_MSAL_CLIENT_ID=…" unconditionally.
 *
 * WHAT IS DELIBERATELY OUT OF SCOPE (stated, not implied):
 *   - Comment-only lines and `echo` lines are excluded from the command rules:
 *     they are prose/output, not writes. Judging an `echo` as a write is the
 *     R7 error in the guard itself.
 *   - `set +e` around a command would evade R4. Named here rather than
 *     silently assumed impossible.
 *   - R1's bicep probe proves the env var is declared SOMEWHERE in
 *     admin-plane/main.bicep with a value/secretRef, not that it is on the
 *     loom-console container specifically.
 *   - #3056 (loom-internal-token rotation) is a different secret with a
 *     different fix class, owned by the E1 lane (#3053).
 *
 * CLOUD PARITY: both subjects are boundary-agnostic. The runbook's §2 prereq
 * switches cloud (`az cloud set --name AzureUSGovernment`) and the writer is
 * driven by ONE cloud-agnostic workflow
 * (.github/workflows/csa-loom-post-deploy-bootstrap.yml, `boundary` input:
 * Commercial | GCC | GCC-High | IL5), so there is no per-cloud variant of
 * either file and this guard covers every boundary by construction.
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
const BICEP = join(REPO_ROOT, 'platform', 'fiab', 'bicep', 'modules', 'admin-plane', 'main.bicep');

/** An env var that IS declared on the console container — the probe's control. */
const CONTROL_ENV = 'LOOM_MSAL_CLIENT_ID';
/** A rotation-marker env assignment: LOOM_…ROTAT… = …  (LOOM_MSAL_SECRET_ROTATED,
 *  LOOM_ROTATION_STAMP, …). Requires the `=`, so prose naming the var is not a hit. */
const MARKER_ASSIGN = /\b(LOOM_[A-Z0-9_]*ROTAT[A-Z0-9_]*)=/g;
const MSAL_TOKEN = /loom-msal-client-secret|LOOM_MSAL_CLIENT_SECRET|LOOM_MSAL_CLIENT_ID/;
const CA_WRITE = /az\s+containerapp\s+(update|create|secret\s+set|revision\s+copy)\b/;
const DISCARDS = /\|\|\s*(true|:|echo)\b|2>\s*\/dev\/null/;

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

/** Commands only: drop comment-only lines and `echo` output lines. */
export function executableCommands(text) {
  return logicalCommands(text).filter((c) => !/^\s*#/.test(c.text) && !/^\s*echo\b/.test(c.text));
}

/** Is `name` declared as a container env var in the bicep text?
 *  Matches the repo's shape: `{ name: 'X', value: … }` / `{ name: 'X', secretRef: … }`. */
export function bicepEnvDeclared(bicepText, name) {
  if (!/^[A-Z0-9_]+$/.test(name)) return false; // only ever called with an env-var name
  return new RegExp(`name:\\s*'${name}'\\s*,?\\s*(value|secretRef)\\s*:`).test(bicepText);
}

/** A probe whose OWN health is checked before its verdicts are trusted. */
export function makeBicepProbe(bicepText, path = BICEP) {
  if (typeof bicepText !== 'string') {
    return { ok: false, path, why: `the file could not be read`, declares: () => false };
  }
  if (!bicepEnvDeclared(bicepText, CONTROL_ENV)) {
    return {
      ok: false,
      path,
      why: `the control env var ${CONTROL_ENV} was not found declared in it`,
      declares: () => false,
    };
  }
  return { ok: true, path, why: '', declares: (n) => bicepEnvDeclared(bicepText, n) };
}

function probeFinding(probe) {
  return {
    rule: 'R0',
    line: 0,
    msg:
      `cannot establish whether an env var is declared in bicep: ${probe.path.replace(/\\/g, '/')} — ` +
      `${probe.why}. This guard's central rule is "written by a script AND not declared in bicep"; ` +
      `with the probe dark it would report clean on exactly the regression it exists to catch. ` +
      `Re-point it at the console container's env list (or fix the file), then re-run.`,
  };
}

/** Rotation-marker writes in a command, with the name(s) written. */
function markerWrites(cmdText) {
  const names = new Set();
  for (const m of cmdText.matchAll(MARKER_ASSIGN)) names.add(m[1]);
  return [...names];
}

/** R0/R1/R3/R4 — the writer: bootstrap-msal-app-reg.sh */
export function analyzeBootstrap(text, probe) {
  const findings = [];
  if (!probe.ok) findings.push(probeFinding(probe));
  const cmds = executableCommands(text);

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

  for (const c of cmds) {
    // Trigger on the ASSIGNMENT, not on a command shape — see the R1 note in
    // the header: a marker whose command token sat on another line was skipped.
    for (const name of markerWrites(c.text)) {
      if (!probe.ok) break; // already reported as UNKNOWN by R0; do not guess a verdict
      if (probe.declares(name)) continue; // declared in bicep → survives the re-render → allowed
      findings.push({
        rule: 'R1',
        line: c.line,
        msg:
          `this line writes the rotation marker ${name}, which ` +
          `${probe.path.replace(/\\/g, '/')} does NOT declare on the app. A post-deploy env var ` +
          `that bicep does not carry is dropped by the next \`az deployment sub create\` — ` +
          `measured: ${name} was absent from all 425 env vars on the live loom-console (#3025). ` +
          `Either delete the write (the credential vintage is answered by ` +
          `\`az ad app credential list\`, per docs/fiab/runbooks/secret-rotation.md §2.1), or ` +
          `declare ${name} in that bicep so a re-render preserves it.`,
      });
    }
    if (/identityref:system\b/.test(c.text)) {
      findings.push({
        rule: 'R3',
        line: c.line,
        msg: '`identityref:system` — console KV references resolve via the user-assigned UAMI, never the system identity.',
      });
    }
    if (CA_WRITE.test(c.text) && MSAL_TOKEN.test(c.text) && DISCARDS.test(c.text)) {
      findings.push({
        rule: 'R4',
        line: c.line,
        msg:
          'this MSAL wiring command discards its result (`|| true` / `|| :` / `|| echo` / ' +
          '`2>/dev/null`), so the line that reports the wiring cannot know it happened — ' +
          'deploy-integrity.md R7. Branch on it (`if az containerapp …; then … else … fi`) and ' +
          'fail closed: an unwired console serves the PREVIOUS secret and signs in with AADSTS7000215.',
      });
    }
  }
  return findings;
}

/** R0/R2/R3/R4 — the recovery doc: secret-rotation.md */
export function analyzeRunbook(text, probe) {
  const findings = [];
  if (!probe.ok) findings.push(probeFinding(probe));
  const cmds = executableCommands(text);

  if (!/az\s+ad\s+app\s+credential\s+list\b/.test(text)) {
    findings.push({
      rule: 'R2',
      line: 0,
      msg:
        'the rotation runbook never names `az ad app credential list` — with the rotation marker ' +
        'gone (it did not survive a bicep re-render, #3025), the Entra credential list IS the ' +
        'authoritative answer to "which credential is live". A runbook that removes the hint and ' +
        'does not name the record leaves AADSTS7000215 triage with nothing.',
    });
  }
  if (!/userAssignedIdentities/.test(text)) {
    findings.push({
      rule: 'R3',
      line: 0,
      msg:
        'the runbook no longer derives the Key Vault reference identity from ' +
        '`userAssignedIdentities` — the console resolves secretRefs with the user-assigned UAMI, ' +
        'and this doc is read while sign-in is already broken (deploy-integrity.md R8).',
    });
  }

  const secretSets = cmds.filter(
    (c) => /az\s+containerapp\s+secret\s+set\b/.test(c.text) && /loom-msal-client-secret/.test(c.text),
  );
  const rolls = cmds.filter(
    (c) =>
      /az\s+containerapp\s+revision\s+copy\b/.test(c.text) ||
      (/az\s+containerapp\s+update\b/.test(c.text) &&
        /--(revision-suffix|set-env-vars|image|yaml)\b/.test(c.text)),
  );
  if (secretSets.length === 0) {
    findings.push({
      rule: 'R2',
      line: 0,
      msg:
        'the runbook has no `az containerapp secret set` for loom-msal-client-secret — the ' +
        'structure this guard watches has changed. Re-point it; a guard matching nothing ' +
        'measures nothing.',
    });
  } else {
    const firstSet = Math.min(...secretSets.map((c) => c.line));
    if (!rolls.some((c) => c.line > firstSet)) {
      findings.push({
        rule: 'R2',
        line: firstSet,
        msg:
          'the runbook sets the Container App secret but never rolls a revision AFTER it ' +
          '(`az containerapp update --revision-suffix …` or `az containerapp revision copy`). ' +
          'Key Vault references resolve at revision ACTIVATION, so without a following roll the ' +
          'rotation silently does not take effect. The marker stamp used to be that roll — ' +
          'removing it without a replacement is how this step goes quiet (#3025).',
      });
    }
  }

  for (const c of cmds) {
    // Same trigger as R1: the assignment itself, not a command shape.
    for (const name of markerWrites(c.text)) {
      if (!probe.ok) break; // reported as UNKNOWN by R0
      if (probe.declares(name)) continue;
      findings.push({
        rule: 'R2',
        line: c.line,
        msg:
          `this step tells the operator to stamp the rotation marker ${name}, which ` +
          `${probe.path.replace(/\\/g, '/')} does not declare — the next deploy re-renders the ` +
          `container template without it, so the marker is gone exactly when the NEXT triage ` +
          `looks for it (#3025). Point the operator at \`az ad app credential list\` instead, ` +
          `or declare ${name} in bicep first.`,
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
    if (CA_WRITE.test(c.text) && MSAL_TOKEN.test(c.text) && DISCARDS.test(c.text)) {
      findings.push({
        rule: 'R4',
        line: c.line,
        msg:
          'this rotation command discards its result (`|| true` / `|| :` / `|| echo` / ' +
          '`2>/dev/null`) — a recovery step that cannot fail reports a rotation that did not ' +
          'happen (deploy-integrity.md R7).',
      });
    }
  }
  return findings;
}

// ── self-test: the guard must be observed FAILING on each defect ────────────
// Mutations are ADDITIVE where a floor could hide them: the bad command is
// added ALONGSIDE the good one, so `found >= 1` is satisfied by the good one
// and the blind spot would survive a replacement-only mutation.
const BICEP_OK = `
          env: [
            { name: 'LOOM_MSAL_CLIENT_ID', value: effectiveMsalClientId }
            { name: 'LOOM_MSAL_CLIENT_SECRET', secretRef: 'loom-msal-client-secret' }
          ]
`;
const BICEP_OK_WITH_MARKER = `${BICEP_OK}
            { name: 'LOOM_MSAL_SECRET_ROTATED', value: msalRotatedStamp }
`;
const BICEP_DRIFTED = `
          env: [
            { NAME: "LOOM_MSAL_CLIENT_ID", VALUE: effectiveMsalClientId }
          ]
`;

const FIX_BOOT_CLEAN = `
if az containerapp secret set -n app -g rg --secrets \\
  "loom-msal-client-secret=keyvaultref:https://kv/secrets/s,identityref:/subscriptions/x/uami" -o none; then
  KVREF_OK=1
fi
if az containerapp update -n app -g rg \\
  --set-env-vars "LOOM_MSAL_CLIENT_ID=id" "LOOM_MSAL_CLIENT_SECRET=secretref:s" -o none; then
  echo "    wired LOOM_MSAL_CLIENT_ID=id"
else
  echo "    ERROR: the env-var update FAILED — not confirmed wired"
  exit 1
fi
`;
// ADDITIVE: the compliant roll above is kept; an out-of-band marker write is added.
const FIX_BOOT_MARKER_ADDED = `${FIX_BOOT_CLEAN}
az containerapp update -n app -g rg --set-env-vars "LOOM_MSAL_SECRET_ROTATED=2026-08-11T0000Z" -o none
`;
// The shape that slipped past the first cut of this guard: the marker fragment
// sits on a line with NO command token (a malformed continuation, a wrapped
// arg, a variable-built command). It must still be caught.
const FIX_BOOT_MARKER_FRAGMENT = `${FIX_BOOT_CLEAN}
  --set-env-vars "LOOM_MSAL_SECRET_ROTATED=$(date -u +%Y-%m-%dT%H%MZ)"
`;
// The other marker-less-roll idiom the previous revision policed by name.
const FIX_BOOT_ROTATION_STAMP = `${FIX_BOOT_CLEAN}
az containerapp update -n app -g rg --set-env-vars "LOOM_ROTATION_STAMP=$(date +%s)" -o none
`;
// ADDITIVE: a second wiring command that swallows its result.
const FIX_BOOT_DISCARD_ADDED = `${FIX_BOOT_CLEAN}
az containerapp update -n app2 -g rg --set-env-vars "LOOM_MSAL_CLIENT_ID=id" -o none || echo "WARN: env-var update failed"
`;
const FIX_BOOT_NO_ROLL = `
az containerapp secret set -n app -g rg --secrets "session-secret=keyvaultref:https://kv/secrets/s" -o none
`;

const FIX_RB_CLEAN = `
az ad app credential list --id "$APP_ID" --query "[].{keyId:keyId,end:endDateTime}" -o table
UAMI_ID=$(az containerapp show -n app -g rg --query "keys(identity.userAssignedIdentities)[0]" -o tsv)
az containerapp secret set -n app -g rg \\
  --secrets "loom-msal-client-secret=keyvaultref:https://kv/secrets/s,identityref:$UAMI_ID"
az containerapp update -n app -g rg --revision-suffix "rotated-20260811-1200"
`;
// ADDITIVE: the clean roll stays; a marker stamp is added after it.
const FIX_RB_MARKER_ADDED = `${FIX_RB_CLEAN}
az containerapp update -n app -g rg --set-env-vars "LOOM_MSAL_SECRET_ROTATED=$(date -u +%Y-%m-%dT%H%MZ)"
`;
const FIX_RB_NO_AUTHORITY = FIX_RB_CLEAN.replace(/az ad app credential list[^\n]*\n/, '');
const FIX_RB_ROLL_BEFORE_SET = `
az ad app credential list --id "$APP_ID" -o table
UAMI_ID=$(az containerapp show -n app -g rg --query "keys(identity.userAssignedIdentities)[0]" -o tsv)
az containerapp update -n app -g rg --revision-suffix "rotated-20260811-1200"
az containerapp secret set -n app -g rg \\
  --secrets "loom-msal-client-secret=keyvaultref:https://kv/secrets/s,identityref:$UAMI_ID"
`;
const FIX_RB_WRONG_IDENTITY_SWALLOWED = `
az ad app credential list --id "$APP_ID" -o table
UAMI_ID=$(az containerapp show -n app -g rg --query "keys(identity.userAssignedIdentities)[0]" -o tsv)
az containerapp secret set -n app -g rg \\
  --secrets "loom-msal-client-secret=keyvaultref:https://kv/secrets/s,identityref:system" 2>/dev/null || true
az containerapp update -n app -g rg --revision-suffix "rot-1"
`;
// The runbook mentions the marker in PROSE only — must stay silent (R7: do not
// report a write the text does not perform).
const FIX_RB_PROSE_ONLY = `${FIX_RB_CLEAN}
# There is deliberately no LOOM_MSAL_SECRET_ROTATED marker: see #3025.
`;

function selfTest() {
  let ok = true;
  const say = (pass, msg) => {
    console.log(`   ${pass ? 'PASS' : 'FAIL'}  ${msg}`);
    if (!pass) ok = false;
  };
  const rules = (fs) => fs.map((f) => f.rule).join(',') || 'none';
  console.log('[msal-rotation-consistency] self-test — the guard must FAIL on the real defects');

  const probe = makeBicepProbe(BICEP_OK);
  const probeWithMarker = makeBicepProbe(BICEP_OK_WITH_MARKER);
  const probeDark = makeBicepProbe(BICEP_DRIFTED);

  say(probe.ok, 'the bicep probe is live on a well-formed env list (control found)');
  say(!probeDark.ok, 'the bicep probe reports itself DARK when the control env var is not found');

  const clean = analyzeBootstrap(FIX_BOOT_CLEAN, probe);
  say(clean.length === 0, `clean bootstrap shape is silent (got ${rules(clean)})`);

  const markerAdded = analyzeBootstrap(FIX_BOOT_MARKER_ADDED, probe);
  say(
    markerAdded.some((f) => f.rule === 'R1' && f.line > 0),
    'a marker env var written ALONGSIDE a compliant roll is detected (the #3025 out-of-band write)',
  );
  say(
    markerAdded.some((f) => /LOOM_MSAL_SECRET_ROTATED/.test(f.msg)),
    'the R1 finding names the exact env var it objects to',
  );

  const fragment = analyzeBootstrap(FIX_BOOT_MARKER_FRAGMENT, probe);
  say(
    fragment.some((f) => f.rule === 'R1' && f.line > 0),
    'a marker fragment on a line with NO command token is detected (the shape that slipped the first cut)',
  );

  const stampIdiom = analyzeBootstrap(FIX_BOOT_ROTATION_STAMP, probe);
  say(
    stampIdiom.some((f) => f.rule === 'R1' && /LOOM_ROTATION_STAMP/.test(f.msg)),
    'the marker-less LOOM_ROTATION_STAMP roll idiom is detected by the same rule',
  );

  const markerDeclared = analyzeBootstrap(FIX_BOOT_MARKER_ADDED, probeWithMarker);
  say(
    markerDeclared.length === 0,
    `the SAME marker write is allowed once bicep declares it (keyed to the mismatch, got ${rules(markerDeclared)})`,
  );

  const dark = analyzeBootstrap(FIX_BOOT_CLEAN, probeDark);
  say(
    dark.some((f) => f.rule === 'R0'),
    'a DARK bicep probe fails the guard even on a clean file (unknown is not safe)',
  );

  const noRoll = analyzeBootstrap(FIX_BOOT_NO_ROLL, probe);
  say(noRoll.some((f) => f.rule === 'R1' && f.line === 0), 'a bootstrap with no MSAL secret-wiring roll trips the population floor');

  const discard = analyzeBootstrap(FIX_BOOT_DISCARD_ADDED, probe);
  say(
    discard.some((f) => f.rule === 'R4' && f.line > 0),
    'a result-discarding MSAL wiring command in the BOOTSTRAP is detected (was runbook-only before)',
  );

  const rbClean = analyzeRunbook(FIX_RB_CLEAN, probe);
  say(rbClean.length === 0, `clean runbook shape is silent (got ${rules(rbClean)})`);

  const rbProse = analyzeRunbook(FIX_RB_PROSE_ONLY, probe);
  say(rbProse.length === 0, `naming the marker in PROSE is not reported as a write (got ${rules(rbProse)})`);

  const rbMarker = analyzeRunbook(FIX_RB_MARKER_ADDED, probe);
  say(rbMarker.some((f) => f.rule === 'R2' && f.line > 0), 'a marker stamp ADDED to a clean runbook is detected');

  const rbNoAuth = analyzeRunbook(FIX_RB_NO_AUTHORITY, probe);
  say(
    rbNoAuth.some((f) => f.rule === 'R2'),
    'a runbook that never names `az ad app credential list` is detected (the replacement must be present)',
  );

  const rbOrder = analyzeRunbook(FIX_RB_ROLL_BEFORE_SET, probe);
  say(
    rbOrder.some((f) => f.rule === 'R2' && f.line > 0),
    'a roll that happens BEFORE the secret set is detected (no pickup)',
  );

  const rbBad = analyzeRunbook(FIX_RB_WRONG_IDENTITY_SWALLOWED, probe);
  say(rbBad.some((f) => f.rule === 'R3'), 'identityref:system in the runbook is detected');
  say(rbBad.some((f) => f.rule === 'R4'), 'a result-discarding secret set in the runbook is detected');

  const rbNoUami = analyzeRunbook(FIX_RB_CLEAN.replace(/userAssignedIdentities/g, 'x'), probe);
  say(
    rbNoUami.some((f) => f.rule === 'R3' && f.line === 0),
    'a runbook that stops deriving the UAMI identity is detected (positive floor, survives the fix)',
  );

  console.log(ok ? '[msal-rotation-consistency] self-test OK' : '[msal-rotation-consistency] self-test FAILED');
  return ok ? 0 : 1;
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  let failed = false;
  const probe = makeBicepProbe(existsSync(BICEP) ? readFileSync(BICEP, 'utf8') : null, BICEP);

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
    const findings = analyze(readFileSync(file, 'utf8'), probe);
    for (const f of findings) {
      console.error(`[msal-rotation-consistency] FAIL ${f.rule} — ${file.replace(/\\/g, '/')}:${f.line}`);
      console.error(`   ${f.msg}`);
      failed = true;
    }
  }
  if (failed) return 1;
  console.log(
    '[msal-rotation-consistency] OK — no out-of-band rotation marker is written by the MSAL secret ' +
      'writer or instructed by the runbook (bicep-declaration probe live), the runbook names ' +
      '`az ad app credential list` as the record and rolls a revision after the secret set, names ' +
      'the UAMI, and no MSAL wiring command discards its result.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
