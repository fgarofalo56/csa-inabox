// Tests for the Loom Unity pre-wire verification gate in
// .github/workflows/gov-uc-purview-wire.yml (#2643).
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
// Turning `server.authorization=enable` on has TWO failure modes that look
// IDENTICAL from outside the container:
//
//   A. not enforcing                       -> anonymous read answers 200
//   B. enforcing but unable to verify ANY  -> anonymous read answers 401,
//      token (no egress to the issuer's       and so does every real caller
//      JWKS endpoint, or the Console
//      principal was never bound)
//
// B answers 401 — exactly what a probe looking for "authorization is enforced"
// wants to see. So a gate that only checks the negative reports SUCCESS while
// the catalog is dark, turning an availability-safe finding into a silent
// outage. The workflow's previous probe was worse still: it read the command's
// stdout from `az containerapp exec`, which Azure Government does not return
// (the 2026-07-15 run's entire captured output was the connection banner), so
// every branch that could have failed the run was unreachable.
//
// ── WHAT IS ACTUALLY UNDER TEST ─────────────────────────────────────────────
// The REAL shell, extracted from the workflow YAML at run time — not a copy.
// If the step is renamed, deleted, or its logic edited, this suite sees the
// change. `az` is stubbed with the exact output shapes real az produces for the
// two commands the step issues (`show --query <scalar> -o tsv` -> one bare
// line; `logs show --format text` -> raw log lines).
//
// The fixture marker lines are NOT hand-written prose. Each was captured from
// apps/loom-unity/bin/loom-entrypoint.sh's own functions run against a local
// HTTP server (`self_probe_anonymous_read` at 200/401, `bind_console_principal`
// at 201/409/403, `probe_idp_reachability` against the live Entra Gov discovery
// endpoint and against an unreachable host). A fixture that models what the
// checker expects rather than what the producer emits proves nothing — this
// repo has shipped a deploy-breaking bug past exactly that mistake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..', '..');
const WF = path.join(REPO, '.github', 'workflows', 'gov-uc-purview-wire.yml');
const STEP_NAME = 'Verify the catalog is ENFORCED and USABLE before wiring the Console (#2643)';

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

/**
 * Pull the step's `run:` block out of the workflow as text.
 *
 * Deliberately NOT a YAML library: the `guardrails` job that runs this suite
 * does `actions/setup-node` and no install, so a third-party import would make
 * the whole file throw — and a suite that cannot load is a suite that enforces
 * nothing. Same approach scripts/ci/check-acr-agent-pool.mjs takes.
 *
 * Every failure mode below throws rather than returning something empty: an
 * extractor that silently yields `''` would make every case "pass" by running
 * no shell at all.
 */
function verifyStepScript() {
  const lines = readFileSync(WF, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- name: ${STEP_NAME}`);
  assert.ok(start >= 0, `workflow step "${STEP_NAME}" not found in ${WF} — renamed or removed?`);
  let runAt = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*- name:/.test(lines[i])) break; // next step — no run block
    if (/^\s*run:\s*\|\s*$/.test(lines[i])) { runAt = i; break; }
  }
  assert.ok(runAt >= 0, `no "run: |" block under "${STEP_NAME}"`);
  const runIndent = lines[runAt].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { body.push(''); continue; }
    const indent = l.match(/^\s*/)[0].length;
    if (indent <= runIndent) break;
    body.push(l.slice(runIndent + 2));
  }
  const script = body.join('\n');
  assert.ok(script.includes('IDP-REACHABILITY'), 'extracted block does not look like the verify step');
  return script;
}

// ── Fixtures: verbatim output of the entrypoint's own probe functions ────────
const IDP_OK =
  '[loom-unity] IDP-REACHABILITY: ok host=login.microsoftonline.us discovery=200 jwks=200 jwks-host=login.microsoftonline.us';
const IDP_FAILED =
  "[loom-unity] IDP-REACHABILITY: FAILED host=login.microsoftonline.us discovery=000 jwks=000 — authorization is ENABLED but this container cannot fetch the issuer's signing keys, so EVERY token verification will fail and the catalog will refuse every caller (including the Console).";
const anon = (code, mode = 'enable') =>
  `[loom-unity] ANON-READ: ${code} (unauthenticated GET /api/2.1/unity-catalog/catalogs over loopback; authorization=${mode})`;
const BIND_201 =
  '[loom-unity] auto-bind: registered the Console principal 11111111-2222-3333-4444-555555555555 as an ENABLED Unity Catalog user (HTTP 201) — the Entra token exchange can now mint an internal token for it.';
const BIND_409 =
  '[loom-unity] auto-bind: the Console principal 11111111-2222-3333-4444-555555555555 is already a Unity Catalog user (HTTP 409) — nothing to do.';
const BIND_FAILED =
  '[loom-unity] AUTO-BIND FAILED: registering the Console principal 11111111-2222-3333-4444-555555555555 as a Unity Catalog user returned HTTP 403. Authorization stays ENFORCED — the catalog refuses every caller rather than falling back to anonymous.';

/** Run the real step shell against a fixture log. Returns { status, out }. */
function runGate(logLines, { mode = 'entra', script = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'uc-gate-'));
  const stepPath = path.join(dir, 'step.sh');
  const logPath = path.join(dir, 'fixture.log');
  const binDir = path.join(dir, 'bin');
  const azPath = path.join(binDir, 'az');

  writeFileSync(stepPath, script ?? verifyStepScript(), { encoding: 'utf8' });
  writeFileSync(logPath, logLines.join('\n') + (logLines.length ? '\n' : ''), 'utf8');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    azPath,
    [
      '#!/bin/sh',
      '# Output shapes mirror real az: `show --query <scalar> -o tsv` prints one',
      '# bare line (no header, no tab row); `logs show --format text` prints raw',
      '# log lines. Inventing a header row here is how a fixture stops modelling',
      '# reality and starts modelling the checker.',
      'case "$*" in',
      '  *"logs show"*) cat "$FIXTURE_LOG" ;;',
      '  *latestRevisionName*) printf \'%s\\n\' "loom-unity--fixture" ;;',
      '  *) : ;;',
      'esac',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(azPath, 0o755);

  const r = spawnSync('bash', [stepPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIXTURE_LOG: logPath,
      RG: 'rg-fixture',
      APP: 'loom-console',
      UNITY_APP: 'loom-unity',
      UNITY_AUTH_MODE: mode,
      // Absent-marker branches are the ones that matter most; without this the
      // step's production patience (24 x 15s) would make the suite take 18min.
      LOOM_UNITY_VERIFY_ATTEMPTS: '2',
      LOOM_UNITY_VERIFY_SLEEP: '0',
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('the production wait is NOT the shortened test one', { skip: !bashAvailable }, () => {
  // The knob above must not become a way to quietly make the real deploy
  // impatient — a gate that gives up after 2 polls would report UNKNOWN on a
  // merely slow boot and block a legitimate flip.
  const src = verifyStepScript();
  assert.match(src, /LOOM_UNITY_VERIFY_ATTEMPTS:-24/);
  assert.match(src, /LOOM_UNITY_VERIFY_SLEEP:-15/);
});

test('ALLOWS wiring when the catalog is enforced, the IdP is reachable, and the Console is bound', { skip: !bashAvailable }, () => {
  const r = runGate([IDP_OK, anon(401), BIND_201]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /verified ENFORCED .* and USABLE/);
});

test('ALLOWS wiring when the Console principal was already registered (HTTP 409)', { skip: !bashAvailable }, () => {
  const r = runGate([IDP_OK, anon(403), BIND_409]);
  assert.equal(r.status, 0, r.out);
});

test('THE OUTAGE CASE: JWKS egress blocked -> REFUSES to wire the Console', { skip: !bashAvailable }, () => {
  // The whole point. The anonymous read is 401 and the bind succeeded, so every
  // signal the OLD probe looked at says "enforced". Only the reachability marker
  // distinguishes "secure" from "sealed against everyone".
  const r = runGate([IDP_FAILED, anon(401), BIND_201]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /IDP-REACHABILITY: FAILED/);
  assert.match(r.out, /NOT wiring the Console/);
  assert.match(r.out, /unity_auth_mode=disabled/); // names the rollback
});

test('NOT ENFORCING: an anonymous 200 under authMode=entra -> REFUSES', { skip: !bashAvailable }, () => {
  const r = runGate([IDP_OK, anon(200), BIND_201]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /authorization is NOT being enforced/);
});

test('SEALED: auto-bind failed -> REFUSES (enforced but unusable by its own Console)', { skip: !bashAvailable }, () => {
  const r = runGate([IDP_OK, anon(401), BIND_FAILED]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /NOT confirmed registered as an ENABLED Unity Catalog user/);
});

test('UNKNOWN IS NOT A PASS: no reachability marker (stale image) -> REFUSES', { skip: !bashAvailable }, () => {
  const r = runGate([anon(401), BIND_201]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /No IDP-REACHABILITY marker/);
});

test('UNKNOWN IS NOT A PASS: no anonymous-read marker -> REFUSES', { skip: !bashAvailable }, () => {
  const r = runGate([IDP_OK, BIND_201]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /No ANON-READ marker/);
});

test('UNKNOWN IS NOT A PASS: no bind marker -> REFUSES', { skip: !bashAvailable }, () => {
  const r = runGate([IDP_OK, anon(401)]);
  assert.equal(r.status, 1, r.out);
});

test('UNKNOWN IS NOT A PASS: no log output at all -> REFUSES', { skip: !bashAvailable }, () => {
  const r = runGate([]);
  assert.equal(r.status, 1, r.out);
});

test('the AUDITED opt-out (unity_auth_mode=disabled) still deploys, and says the hole is open', { skip: !bashAvailable }, () => {
  // Gating the opt-out on "ok" would block the documented rollback — the one
  // move an operator needs if the egress finding above is real.
  const r = runGate([anon(200, 'disable')], { mode: 'disabled' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /svc-loom-unity-authz is OPEN on this estate/);
});

test('MUTATION PROOF: the egress check has teeth (removing its FAIL=1 turns the outage green)', { skip: !bashAvailable }, () => {
  // Asserting a red result is only meaningful if a plausible weakening makes it
  // green. Mutate the CONTROL — the assignment that makes the branch fatal —
  // rather than a message, and confirm the same fixture then passes.
  const src = verifyStepScript();
  const idx = src.indexOf('if [ "${IDP_BAD:-0}" != "0" ]; then');
  assert.ok(idx >= 0, 'the reachability branch moved — this proof no longer targets it');
  const tail = src.slice(idx);
  const relative = tail.indexOf('\n  FAIL=1');
  assert.ok(relative >= 0, 'no FAIL=1 inside the reachability branch');
  const weakened = src.slice(0, idx) + tail.slice(0, relative) + tail.slice(relative + '\n  FAIL=1'.length);

  const strict = runGate([IDP_FAILED, anon(401), BIND_201]);
  assert.equal(strict.status, 1, 'baseline must refuse');
  const loose = runGate([IDP_FAILED, anon(401), BIND_201], { script: weakened });
  assert.equal(loose.status, 0, 'the weakened gate must pass — otherwise the strict result was not caused by this check');
});
