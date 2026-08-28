/**
 * resolve-msal-client-id.test.mjs — ABSENT is not UNKNOWN (deploy-integrity R7).
 *
 * WHAT BROKE. Until 2026-08-27 every `az` read in
 * scripts/csa-loom/resolve-msal-client-id.sh ended `2>/dev/null`, and the script
 * had ONE outcome for "there is no app registration" and for "I could not look":
 * print nothing, exit 0. Its final log line then asserted "no existing app
 * registration found in <rg>" — a claim it had not established. Downstream, an
 * empty client id makes the next ACA template render DROP LOOM_MSAL_CLIENT_ID
 * (a declarative template removes what it does not declare), taking sign-in
 * dark, and empties LOOM_UNITY_CLIENT_ID / LOOM_UNITY_AUDIENCE with it
 * (admin-plane/main.bicep:4718-4719), failing the Loom Unity catalog closed.
 * All four deploy lanes call this script, so the exposure is every boundary.
 *
 * MUTATION-PROVED. Every unknown-classifying assertion below is paired with the
 * absence shape it must NOT be confused with. A suite that only asserted the
 * happy path would have passed byte-identically on the broken script — the whole
 * defect was that failure and absence produced the SAME observable
 * (`csa_loom_unknown_as_negative_class`, `csa_loom_gates_that_cannot_fail`).
 *
 * The `az` binary is stubbed on PATH rather than the script being refactored for
 * injection, so what runs is the REAL script, unmodified, including its exit
 * codes and its stderr.
 *
 * Run: node --test scripts/ci/__tests__/resolve-msal-client-id.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'csa-loom', 'resolve-msal-client-id.sh');

/** The script's own contract. exit 3 is UNKNOWN; 0 is PRESENT or ABSENT. */
const EXIT_OK = 0;
const EXIT_UNKNOWN = 3;

const CID = '11111111-2222-3333-4444-555555555555';

/**
 * Run the real script with a stubbed `az` whose behaviour per sub-command comes
 * from `plan`. Each entry is [exitCode, stdout, stderr].
 */
function run(plan, env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'msal-stub-'));
  try {
    // The stub dispatches on the first two argv words ("group list",
    // "keyvault secret", "containerapp show"), which is enough to key every
    // read the script performs.
    const cases = Object.entries(plan)
      .map(([key, [code, out, err]]) => {
        const q = (s) => String(s).replace(/'/g, `'\\''`);
        return `  '${q(key)}') printf '%s' '${q(out)}'; printf '%s' '${q(err)}' >&2; exit ${code} ;;`;
      })
      .join('\n');

    const stub = [
      '#!/usr/bin/env bash',
      'key="$1 $2"',
      'case "$key" in',
      cases,
      '  *) echo "unstubbed az call: $key" >&2; exit 99 ;;',
      'esac',
      '',
    ].join('\n');

    const azPath = path.join(dir, 'az');
    writeFileSync(azPath, stub, { mode: 0o755 });
    chmodSync(azPath, 0o755);

    const r = spawnSync('bash', [SCRIPT, '--rg', 'rg-csa-loom-admin-usgovvirginia'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        LOOM_MSAL_CLIENT_ID: env.LOOM_MSAL_CLIENT_ID ?? '',
        LOOM_ADMIN_KEYVAULT: env.LOOM_ADMIN_KEYVAULT ?? '',
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      },
    });
    return { code: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── CONTROL ─────────────────────────────────────────────────────────────────
// If the stub harness cannot make the script fail at all, every UNKNOWN
// assertion below is vacuous. Prove it can.
test('control — an unstubbed az call is visible to the harness', () => {
  const r = run({});
  assert.notEqual(r.code, EXIT_OK, 'a totally unstubbed az must not yield a clean exit 0');
});

// ── PRESENT ─────────────────────────────────────────────────────────────────
test('PRESENT — resolved from Key Vault: exit 0 and the id on stdout', () => {
  const r = run({
    'keyvault list': [0, 'kv-loom-admin\n', ''],
    'keyvault secret': [0, `${CID}\n`, ''],
  });
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.out, CID);
});

test('PRESENT — falls through to the live Console app when Key Vault has no secret', () => {
  const r = run({
    'keyvault list': [0, 'kv-loom-admin\n', ''],
    'keyvault secret': [1, '', 'ERROR: (SecretNotFound) A secret with (name/id) loom-msal-client-id was not found in this key vault.'],
    'containerapp show': [0, `${CID}\n`, ''],
  });
  assert.equal(r.code, EXIT_OK, 'a genuinely missing SECRET is an absence, not an unknown');
  assert.equal(r.out, CID);
});

// ── ABSENT ──────────────────────────────────────────────────────────────────
test('ABSENT — every read succeeds and returns nothing: exit 0, empty stdout', () => {
  const r = run({
    'keyvault list': [0, '\n', ''],
    'containerapp show': [0, '\n', ''],
  });
  assert.equal(r.code, EXIT_OK, 'a genuinely fresh subscription must stay a clean exit 0');
  assert.equal(r.out, '');
  assert.match(
    r.err,
    /every read SUCCEEDED and returned nothing/,
    'the absence message must say it established absence, not merely assert it (R7)',
  );
});

test('ABSENT — no console app yet is an absence, not an unknown', () => {
  const r = run({
    'keyvault list': [0, '\n', ''],
    'containerapp show': [1, '', "ERROR: (ResourceNotFound) The Resource 'Microsoft.App/containerApps/loom-console' under resource group 'rg-csa-loom-admin-usgovvirginia' was not found."],
  });
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.out, '');
});

// ── UNKNOWN — the whole point ───────────────────────────────────────────────
// Each of these produced exit 0 + empty stdout on the pre-fix script, i.e. was
// INDISTINGUISHABLE from the two ABSENT cases above.
test('UNKNOWN — an expired token on the Key Vault data plane is not absence', () => {
  const r = run({
    'keyvault list': [0, 'kv-loom-admin\n', ''],
    'keyvault secret': [1, '', 'ERROR: AADSTS700082: The refresh token has expired due to inactivity.'],
  });
  assert.equal(r.code, EXIT_UNKNOWN, 'an auth failure must NOT be reported as "no registration"');
  assert.equal(r.out, '', 'unknown must never emit a client id');
  assert.match(r.err, /UNKNOWN/);
});

test('UNKNOWN — an RBAC denial reading the secret is not absence', () => {
  const r = run({
    'keyvault list': [0, 'kv-loom-admin\n', ''],
    'keyvault secret': [1, '', 'ERROR: (Forbidden) Caller is not authorized to perform action on resource.'],
  });
  assert.equal(r.code, EXIT_UNKNOWN);
  assert.equal(r.out, '');
});

test('UNKNOWN — a failed resource-group LIST is not "fresh estate"', () => {
  // `run` always passes --rg, which skips discovery entirely, so this branch
  // needs its own invocation with no --rg and LOOM_ADMIN_RG cleared.
  const failed = discovery([1, '', 'ERROR: Please run "az login" to setup account.']);
  assert.equal(
    failed.code,
    EXIT_UNKNOWN,
    'a failed `az group list` must classify UNKNOWN, never "no rg-csa-loom-admin-* — fresh estate"',
  );
  assert.equal(failed.out, '');

  // The paired absence: the SAME list succeeding with an empty result is a
  // genuinely fresh subscription and must stay exit 0. Without this pair the
  // assertion above would also hold for a script that failed unconditionally.
  const empty = discovery([0, '\n', '']);
  assert.equal(empty.code, EXIT_OK, 'an empty-but-successful list is absence, not unknown');
  assert.equal(empty.out, '');
});

test('UNKNOWN — a failed keyvault LIST is not "no key vault"', () => {
  const r = run({ 'keyvault list': [1, '', 'ERROR: The subscription is not registered.'] });
  assert.equal(r.code, EXIT_UNKNOWN);
  assert.equal(r.out, '');
});

test('UNKNOWN — a throttle on the Console read is not absence', () => {
  const r = run({
    'keyvault list': [0, '\n', ''],
    'containerapp show': [1, '', 'ERROR: (TooManyRequests) Rate limit exceeded. Retry after 30 seconds.'],
  });
  assert.equal(r.code, EXIT_UNKNOWN);
  assert.equal(r.out, '');
});

// ── the environment short-circuit still wins ────────────────────────────────
test('PRESENT — an explicit LOOM_MSAL_CLIENT_ID short-circuits every read', () => {
  const r = run({}, { LOOM_MSAL_CLIENT_ID: CID });
  assert.equal(r.code, EXIT_OK);
  assert.equal(r.out, CID, 'no az call should be needed, so the unstubbed-call trap must not fire');
});

/**
 * Drive the resource-group DISCOVERY branch (no --rg, no LOOM_ADMIN_RG), which
 * the `run` helper cannot reach because it always passes --rg.
 * `groupList` is [exitCode, stdout, stderr] for the single `az group list` call.
 */
function discovery(groupList) {
  const dir = mkdtempSync(path.join(tmpdir(), 'msal-stub-disc-'));
  try {
    const q = (s) => String(s).replace(/'/g, `'\\''`);
    const [code, out, err] = groupList;
    const stub = [
      '#!/usr/bin/env bash',
      'key="$1 $2"',
      'case "$key" in',
      `  'group list') printf '%s' '${q(out)}'; printf '%s' '${q(err)}' >&2; exit ${code} ;;`,
      `  'keyvault list') printf '%s' ''; exit 0 ;;`,
      `  'containerapp show') printf '%s' ''; exit 0 ;;`,
      '  *) echo "unstubbed az call: $key" >&2; exit 99 ;;',
      'esac',
      '',
    ].join('\n');
    const azPath = path.join(dir, 'az');
    writeFileSync(azPath, stub, { mode: 0o755 });
    chmodSync(azPath, 0o755);
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LOOM_MSAL_CLIENT_ID: '',
        LOOM_ADMIN_RG: '',
        LOOM_ADMIN_KEYVAULT: '',
        PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      },
    });
    return { code: r.status, out: (r.stdout ?? '').trim(), err: r.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
