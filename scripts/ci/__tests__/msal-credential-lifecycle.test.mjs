/**
 * MSAL credential lifecycle — reuse / mint / prune / ceiling (#3335).
 *
 * THE DEFECT THIS PINS. `scripts/csa-loom/bootstrap-msal-app-reg.sh` ran
 *
 *     SECRET=$(az ad app credential reset --id "$APP_ID" --append --years 2 …)
 *
 * unconditionally on EVERY invocation, and nothing ever removed one. MEASURED
 * 2026-08-13 on the live Commercial registration 5c59f3f3-…: NINE live password
 * credentials, five of them minted that day (05:26, 07:06, 08:27, 09:44,
 * 12:50Z), each `--years 2`. The mint rate follows the DEPLOY rate — that day
 * `deploy-fiab-commercial` ran 11 times and it reaches this script through
 * `csa-loom-post-deploy-bootstrap`'s `workflow_call`.
 *
 * HOW THIS TESTS IT. The REAL shipped script is executed with a stub `az` (and
 * stub `curl`) on PATH. The stub is STATEFUL: `credential reset` appends to an
 * inventory file, `credential delete` removes from it, and an ARM secret PUT
 * records the msalKeyId tag it was handed. So a case observes what the script
 * actually did to a credential store, not what a re-implementation of its rules
 * would have done. Per the fixtures-that-model-the-code lesson, the stub
 * imitates `az`'s OUTPUT CONTRACT — the exact `--query` shapes measured against
 * live Azure while writing this change (an absent tag is empty stdout + exit 0;
 * a missing secret is exit 1 with `"code":"ResourceNotFound"` on stderr) —
 * rather than the script's expectations.
 *
 * THE SAFETY PROPERTY under test is not "it prunes" but "it cannot strand the
 * running app": the in-use credential, the newest N, anything inside the grace
 * window, and anything not provably superseded are never candidates, and the
 * prune disarms entirely when the console's credential source cannot be proven.
 *
 * MUTATION-PROVEN while writing: removing the reuse gate turns REUSE-1/2 red;
 * dropping `--append` turns MINT-2 red; deleting the in-use exclusion turns
 * PRUNE-3 red; removing the ceiling turns CEILING-1 red. For the #3637 incident
 * path the mutation is the whole feature: reverting
 * `bootstrap-msal-app-reg.sh` to its pre-#3637 state turns ROTATE-1 (the flag
 * mints nothing, the reuse gate still wins) and REVOKE-1/2/8 red while every
 * case above stays green.
 *
 * Run: node --test scripts/ci/__tests__/msal-credential-lifecycle.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', '..', 'csa-loom', 'bootstrap-msal-app-reg.sh');
const APP_ID = '5c59f3f3-e26d-4122-a707-a04e21ff5255';
const DAY = 86_400_000;

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** A credential row as the stub stores it: keyId|start|end|displayName. */
const cred = (keyId, startDays, endDays, label = '-') =>
  `${keyId}|${iso(startDays * DAY)}|${iso(endDays * DAY)}|${label}`;

/**
 * Drive the REAL bootstrap script against a stub az/curl.
 *
 * @param {object} o
 * @param {string[]} o.creds        starting credential inventory rows
 * @param {string}  [o.kvTag]       msalKeyId tag on loom-msal-client-secret ('' = untagged)
 * @param {'ok'|'missing'|'unreadable'} [o.kvState]  what an ARM GET of it does
 * @param {string}  [o.caSecretUrl] keyVaultUrl of the console's loom-msal-client-secret
 * @param {string[]} [o.revisions]  active revision createdTimes (ISO)
 * @param {number}  [o.kvUpdatedDays] age of the KV secret's `updated` attribute
 * @param {boolean} [o.labelLookupFails] make the post-mint key-id lookup return nothing
 * @param {boolean} [o.deleteIsNoop] make `credential delete` exit 0 without removing anything
 * @param {boolean} [o.consoleUpdateFails] make `containerapp update` exit non-zero (the roll the CLI refused)
 * @param {string[]} [o.args]       CLI arguments passed to the script itself
 * @param {object}  [o.env]         extra environment for the run
 */
function run({
  creds,
  kvTag = '',
  kvState = 'ok',
  caSecretUrl = 'https://kv-loom-test.vault.azure.net/secrets/loom-msal-client-secret',
  revisions = [iso(-0.01 * DAY)],
  kvUpdatedDays = -1,
  labelLookupFails = false,
  deleteIsNoop = false,
  consoleUpdateFails = false,
  args = [],
  env = {},
}) {
  const dir = mkdtempSync(join(tmpdir(), 'msalcred-'));
  const credFile = join(dir, 'creds.tsv');
  const tagFile = join(dir, 'kvtag');
  const tagBodyFile = join(dir, 'kvtagbody');
  const updFile = join(dir, 'kvupdated');
  const revFile = join(dir, 'revisions');
  const calls = join(dir, 'calls.log');
  writeFileSync(credFile, creds.length ? `${creds.join('\n')}\n` : '');
  writeFileSync(tagFile, kvTag);
  writeFileSync(tagBodyFile, '');
  writeFileSync(updFile, String(Math.floor((Date.now() + kvUpdatedDays * DAY) / 1000)));
  writeFileSync(revFile, revisions.length ? `${revisions.join('\n')}\n` : '');

  const q = JSON.stringify;
  // MEASURED contracts this stub reproduces:
  //   • absent tag on an existing secret -> exit 0, EMPTY stdout (not "None")
  //   • missing secret -> exit 1, stderr contains "code":"ResourceNotFound"
  //   • `credential list` never returns a password, only metadata
  const az = `#!/usr/bin/env bash
echo "$*" >> ${q(calls)}
CREDS=${q(credFile)}; TAG=${q(tagFile)}; UPD=${q(updFile)}; REV=${q(revFile)}; TAGBODY=${q(tagBodyFile)}
case "$*" in
  "account show"*)  echo "11111111-2222-3333-4444-555555555555"; exit 0 ;;
  "cloud show"*)    echo "https://login.microsoftonline.com/"; exit 0 ;;
  "keyvault show"*) echo "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/kv-loom-test"; exit 0 ;;
esac
case "$*" in
  "ad app credential reset"*)
    label=""; years=1; prev=""
    for a in "$@"; do
      case "$prev" in --display-name) label="$a" ;; --years) years="$a" ;; esac
      prev="$a"
    done
    case "$*" in *--append*) : ;; *) : > "$CREDS" ;; esac
    n=$(( $(wc -l < "$CREDS") + 1 ))
    s=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    e=$(date -u -d "+$(( years * 365 )) days" +%Y-%m-%dT%H:%M:%SZ)
    printf '%s|%s|%s|%s\\n' "minted-key-$n" "$s" "$e" "$label" >> "$CREDS"
    echo "STUB-PASSWORD-NEVER-LOGGED"
    exit 0 ;;
  "ad app credential delete"*)
    kid=""; prev=""
    for a in "$@"; do case "$prev" in --key-id) kid="$a" ;; esac; prev="$a"; done
    ${deleteIsNoop
      ? '# deleteIsNoop: exit 0 having removed NOTHING — the R5 case.\n    exit 0'
      : `grep -v "^\${kid}|" "$CREDS" > "$CREDS.tmp" || true
    mv "$CREDS.tmp" "$CREDS"
    exit 0`} ;;
  "ad app credential list"*)
    case "$*" in
      *"[].keyId"*) cut -d'|' -f1 < "$CREDS"; exit 0 ;;
      *"?displayName=="*)
        ${labelLookupFails ? 'exit 0' : `want=$(printf '%s' "$*" | sed "s/.*displayName=='\\\\([^']*\\\\)'.*/\\\\1/")
        awk -F'|' -v w="$want" '$4==w{print $1}' "$CREDS"; exit 0`} ;;
      *) cat "$CREDS"; exit 0 ;;
    esac ;;
esac
case "$*" in
  "rest --method GET"*)
    case "$*" in
      *loom-msal-client-secret*)
        case "${kvState}" in
          missing)    echo 'ERROR: Not Found({"error":{"code":"ResourceNotFound"}})' >&2; exit 1 ;;
          unreadable) echo 'ERROR: Forbidden({"error":{"code":"AuthorizationFailed"}})' >&2; exit 1 ;;
        esac
        case "$*" in
          *"tags.msalKeyId"*) cat "$TAG"; echo; exit 0 ;;
          *"properties.attributes.updated"*) cat "$UPD"; echo; exit 0 ;;
        esac
        exit 0 ;;
      *) exit 0 ;;
    esac ;;
  "rest --method PUT"*|"rest --method PATCH"*)
    case "$*" in
      *loom-msal-client-secret*)
        # A vault that refuses reads refuses writes too — modelling only the
        # read as broken would invent a state Azure cannot produce, and the
        # script would be judged against it (fixtures-that-model-the-code).
        case "${kvState}" in
          unreadable) echo 'ERROR: Forbidden({"error":{"code":"AuthorizationFailed"}})' >&2; exit 1 ;;
        esac ;;
    esac
    body=""; prev=""
    for a in "$@"; do case "$prev" in --body) body="$a" ;; esac; prev="$a"; done
    case "$body" in
      *msalKeyId*)
        printf '%s' "$body" | sed 's/.*"msalKeyId":"\\([^"]*\\)".*/\\1/' > "$TAG"
        printf '%s\\n' "$body" >> "$TAGBODY"
        date -u +%s > "$UPD" ;;
    esac
    exit 0 ;;
esac
case "$*" in
  "containerapp secret list"*) printf '%s\\n' ${q(caSecretUrl)}; exit 0 ;;
  "containerapp revision list"*) cat "$REV"; exit 0 ;;
  "containerapp update"*) ${consoleUpdateFails
    ? 'echo \'ERROR: (AuthorizationFailed) does not have authorization to perform action\' >&2; exit 1'
    : 'exit 0'} ;;
  "containerapp show"*) exit 1 ;;
esac
exit 0
`;
  const azPath = join(dir, 'az');
  writeFileSync(azPath, az);
  chmodSync(azPath, 0o755);
  // The script proves a freshly minted secret by asking Entra for a token.
  const curlPath = join(dir, 'curl');
  writeFileSync(curlPath, '#!/usr/bin/env bash\necho \'{"access_token":"stub"}\'\n');
  chmodSync(curlPath, 0o755);

  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      KEYVAULT_NAME: 'kv-loom-test',
      EXISTING_CLIENT_ID: APP_ID,
      CONSOLE_APP_NAME: 'loom-console',
      CONSOLE_RG: 'rg-csa-loom-admin-test',
      UAMI_RESOURCE_ID: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/console',
      ...env,
    },
  });
  const out = `${r.stdout}${r.stderr}`;
  return {
    rc: r.status,
    out,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
    finalCreds: readFileSync(credFile, 'utf8').trim().split('\n').filter(Boolean),
    kvTag: readFileSync(tagFile, 'utf8').trim(),
    kvTagBody: readFileSync(tagBodyFile, 'utf8'),
  };
}

const mintCalls = (calls) => calls.split('\n').filter((l) => l.startsWith('ad app credential reset'));
const deleteCalls = (calls) => calls.split('\n').filter((l) => l.startsWith('ad app credential delete'));

test('the shipped bootstrap script is present — these tests drive the REAL file', () => {
  assert.ok(existsSync(SCRIPT), `${SCRIPT} must exist`);
});

// ── 1. REUSE — the fix for the sprawl ───────────────────────────────────────

test('REUSE-1: a tagged, healthy credential is REUSED — nothing is minted', () => {
  const r = run({
    creds: [cred('live-key', -30, 300, 'loom-console-x')],
    kvTag: 'live-key',
  });
  assert.equal(mintCalls(r.calls).length, 0, 'a healthy recorded credential must not trigger a mint');
  assert.match(r.out, /REUSE — .*holds credential live-key/);
  assert.equal(r.finalCreds.length, 1, 'the credential count must not grow on a reuse run');
});

test('REUSE-2: repeated runs stay flat — the #3335 growth curve is gone', () => {
  // Five runs is the measured 2026-08-13 burst. Before the fix that was +5.
  let creds = [cred('live-key', -30, 300, 'loom-console-x')];
  for (let i = 0; i < 5; i++) {
    const r = run({ creds, kvTag: 'live-key' });
    creds = r.finalCreds;
    assert.equal(mintCalls(r.calls).length, 0, `run ${i + 1} must not mint`);
  }
  assert.equal(creds.length, 1, 'five consecutive runs must leave exactly one credential');
});

test('REUSE-3: a credential inside the renewal window is RENEWED, not reused', () => {
  const r = run({
    creds: [cred('expiring-key', -300, 30, 'loom-console-x')],
    kvTag: 'expiring-key',
  });
  assert.equal(mintCalls(r.calls).length, 1, 'a credential 30 days from expiry must be replaced');
  assert.match(r.out, /RENEW — credential expiring-key expires/);
});

test('REUSE-4: a tag pointing at a credential the app no longer has RENEWS', () => {
  const r = run({ creds: [cred('other-key', -5, 700)], kvTag: 'deleted-key' });
  assert.equal(mintCalls(r.calls).length, 1);
  assert.match(r.out, /no longer carries it \(deleted out of band\)/);
});

// ── 2. MINT — safe by construction ──────────────────────────────────────────

test('MINT-1: an untagged Key Vault secret mints (uncertainty must not authorize reuse)', () => {
  const r = run({ creds: [cred('unknown-key', -5, 700)], kvTag: '' });
  assert.equal(mintCalls(r.calls).length, 1);
  assert.match(r.out, /carries no msalKeyId tag/);
});

test('MINT-2: the mint is APPENDED — a bare reset would wipe the live credential', () => {
  const r = run({ creds: [cred('live-key', -5, 700)], kvTag: '' });
  const [call] = mintCalls(r.calls);
  assert.match(call, /--append/, 'a bare `credential reset` deletes EVERY credential and strands the console');
  assert.match(call, /--display-name loom-console-/, 'the label is how the new key id is resolved without racing a concurrent deploy');
  assert.equal(r.finalCreds.length, 2, 'the outgoing credential must survive the mint');
  assert.ok(r.finalCreds.some((c) => c.startsWith('live-key|')), 'the previously live credential must still exist');
});

test('MINT-3: the new key id is recorded in Key Vault, so the NEXT run can reuse', () => {
  const first = run({ creds: [cred('old-key', -400, 200)], kvTag: '' });
  assert.equal(mintCalls(first.calls).length, 1);
  assert.match(first.kvTag, /^minted-key-\d+$/, 'the msalKeyId tag must be written on the mint path');
  const second = run({ creds: first.finalCreds, kvTag: first.kvTag });
  assert.equal(mintCalls(second.calls).length, 0, 'the run after a mint must reuse');
});

test('MINT-4: a missing Key Vault secret mints (first bootstrap of an estate)', () => {
  const r = run({ creds: [], kvState: 'missing' });
  assert.equal(mintCalls(r.calls).length, 1);
  assert.match(r.out, /does not exist in kv-loom-test yet/);
});

test('MINT-5: an UNREADABLE vault FAILS the run and deletes nothing — unknown is not absent', () => {
  // A 403 on the vault means the in-use credential cannot be established AND the
  // new one cannot be persisted. The script must stop, leaving the previous
  // secret authoritative — not carry on and certainly not prune.
  const r = run({ creds: [cred('a', -400, 300), cred('b', -300, 400)], kvState: 'unreadable' });
  assert.equal(r.rc, 1, 'an unwritable Key Vault must fail the run, not be swallowed');
  assert.match(r.out, /could NOT be read from kv-loom-test/);
  assert.match(r.out, /ERROR: could not write loom-msal-client-secret/);
  assert.equal(deleteCalls(r.calls).length, 0, 'an unreadable vault must never authorize a deletion');
  assert.ok(r.finalCreds.some((c) => c.startsWith('a|')), 'existing credentials must be untouched');
});

test('MINT-6: an unresolvable new key id still writes the secret but DISARMS the prune', () => {
  // Sign-in beats hygiene: an estate with a working secret and no provenance is
  // better than one with neither. But without provenance nothing is provably
  // superseded, so the prune must not run on a guess.
  const r = run({
    creds: [cred('old-1', -60, 600), cred('old-2', -50, 600), cred('old-3', -40, 600)],
    kvTag: '',
    labelLookupFails: true,
    env: { LOOM_MSAL_PRUNE: '1' },
  });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /the key id of the new credential could NOT be resolved/);
  assert.match(r.out, /prune DISARMED/);
  assert.equal(deleteCalls(r.calls).length, 0, 'no provenance means no provable supersession');
});

// ── 3. PRUNE — the safety property ──────────────────────────────────────────

const SPRAWL = [
  cred('in-use', -1, 700, 'loom-console-newest'),
  cred('recent-1', -2, 700, 'loom-console-a'),
  cred('recent-2', -3, 700, 'loom-console-b'),
  cred('old-1', -40, 600, 'loom-console-c'),
  cred('old-2', -50, 600, 'loom-console-d'),
  cred('old-3', -60, 600, 'loom-console-e'),
];

test('PRUNE-1: DRY RUN by default — candidates are printed, nothing is deleted', () => {
  const r = run({ creds: SPRAWL, kvTag: 'in-use' });
  assert.equal(deleteCalls(r.calls).length, 0, 'the default must never delete');
  assert.match(r.out, /DRY RUN — \d+ credential\(s\) above are marked PRUNE/);
  assert.match(r.out, /LOOM_MSAL_PRUNE=1/);
  assert.match(r.out, /PRUNE {2}old-3/);
  assert.equal(r.finalCreds.length, SPRAWL.length, 'the inventory must be untouched on a dry run');
});

test('PRUNE-2: the dry run prints key ids and dates only — never a secret value', () => {
  const r = run({ creds: SPRAWL, kvTag: 'in-use' });
  assert.doesNotMatch(r.out, /STUB-PASSWORD-NEVER-LOGGED/, 'no code path may echo a credential value');
});

test('PRUNE-3: authorized — the in-use credential is NEVER a candidate', () => {
  const r = run({ creds: SPRAWL, kvTag: 'in-use', env: { LOOM_MSAL_PRUNE: '1' } });
  const deleted = deleteCalls(r.calls).join(' ');
  assert.doesNotMatch(deleted, /in-use/, 'deleting the in-use credential is the stranding failure this design exists to prevent');
  assert.ok(r.finalCreds.some((c) => c.startsWith('in-use|')), 'the in-use credential must survive');
});

test('PRUNE-4: authorized — the newest KEEP and the grace window survive; only superseded go', () => {
  const r = run({ creds: SPRAWL, kvTag: 'in-use', env: { LOOM_MSAL_PRUNE: '1' } });
  const remaining = r.finalCreds.map((c) => c.split('|')[0]).sort();
  // in-use (recorded) + recent-1 (newest KEEP=2 window) + recent-2 (2 days old,
  // inside the 7-day grace). Everything else is >7d old AND minted before the
  // in-use credential, i.e. provably superseded.
  assert.deepEqual(remaining, ['in-use', 'recent-1', 'recent-2']);
});

test('PRUNE-5: never below one — a keep set of zero refuses rather than emptying the app', () => {
  const r = run({ creds: [cred('in-use', -1, 700)], kvTag: 'in-use', env: { LOOM_MSAL_PRUNE: '1' } });
  assert.equal(deleteCalls(r.calls).length, 0);
  assert.equal(r.finalCreds.length, 1);
  assert.match(r.out, /nothing to prune/);
});

test('PRUNE-6: an inline (non-KV-reference) console secret degrades to expired-only', () => {
  const withExpired = [...SPRAWL, cred('long-dead', -800, -30, 'loom-console-dead')];
  const r = run({
    creds: withExpired,
    kvTag: 'in-use',
    caSecretUrl: '',
    env: { LOOM_MSAL_PRUNE: '1' },
  });
  assert.match(r.out, /prune limited to ALREADY-EXPIRED credentials/);
  const deleted = deleteCalls(r.calls).join(' ');
  assert.match(deleted, /long-dead/, 'an already-expired credential can strand nobody');
  assert.doesNotMatch(deleted, /old-1|old-2|old-3/, 'a still-valid credential must not be removed on an unproven binding');
});

test('PRUNE-7: a VERSIONED Key Vault reference is not proof — degrades to expired-only', () => {
  const r = run({
    creds: SPRAWL,
    kvTag: 'in-use',
    caSecretUrl: 'https://kv-loom-test.vault.azure.net/secrets/loom-msal-client-secret/abc123version',
    env: { LOOM_MSAL_PRUNE: '1' },
  });
  assert.match(r.out, /not an unversioned Key Vault reference/);
  assert.equal(deleteCalls(r.calls).length, 0);
});

test('PRUNE-8: an active revision older than the Key Vault write blocks the prune (P3b)', () => {
  // A KV reference is resolved at revision CREATION and then pinned, so this
  // revision is still serving the PREVIOUS credential.
  const r = run({
    creds: SPRAWL,
    kvTag: 'in-use',
    kvUpdatedDays: -0.5,
    revisions: [iso(-5 * DAY)],
    env: { LOOM_MSAL_PRUNE: '1' },
  });
  assert.match(r.out, /PREDATES the Key Vault write/);
  assert.equal(deleteCalls(r.calls).length, 0, 'a stale active revision must veto the prune');
});

test('PRUNE-9: the in-use credential survives even when it is NOT the newest', () => {  // The load-bearing case, and the measured one: on 2026-08-13 five credentials
  // were minted in a single day by concurrent deploys, so the credential the
  // console is actually pinned to need not be the most recent. In SPRAWL the
  // in-use credential is also the newest, which means the "newest N" rule masks
  // the supersession rule — mutating the in-use exclusion there changes nothing.
  // Here the in-use credential is rank 3 of 5, outside the keep window and
  // outside the grace, so ONLY "minted before the in-use one" protects it.
  const middle = [
    cred('newer-1', -1, 700, 'loom-console-n1'),
    cred('newer-2', -2, 700, 'loom-console-n2'),
    cred('in-use', -40, 700, 'loom-console-pinned'),
    cred('older-1', -60, 600, 'loom-console-o1'),
    cred('older-2', -70, 600, 'loom-console-o2'),
  ];
  const r = run({ creds: middle, kvTag: 'in-use', env: { LOOM_MSAL_PRUNE: '1' } });
  const remaining = r.finalCreds.map((c) => c.split('|')[0]).sort();
  assert.ok(remaining.includes('in-use'), 'the credential the console is pinned to must never be deleted');
  assert.deepEqual(remaining, ['in-use', 'newer-1', 'newer-2'], 'only credentials minted BEFORE the in-use one are superseded');
});

test('PRUNE-10: an existing BACKLOG is held by the grace, and the run says so with the knob', () => {
  // The operator's real first experience. The 9 credentials measured live on
  // 2026-08-13 were all minted within 4 days of each other, so on a first
  // cleanup EVERY one is inside the default 7-day grace and the prune is a
  // no-op. A silent no-op reads as "the prune is broken"; it must name the
  // window that held them and the exact knob to narrow it.
  const backlog = [
    cred('in-use', -0.2, 700, 'loom-console-newest'),
    cred('b1', -0.3, 700, 'loom-console-b1'),
    cred('b2', -0.5, 700, 'loom-console-b2'),
    cred('b3', -1, 700, 'loom-console-b3'),
    cred('b4', -4, 700, 'loom-console-b4'),
  ];
  const held = run({ creds: backlog, kvTag: 'in-use', env: { LOOM_MSAL_PRUNE: '1' } });
  assert.equal(deleteCalls(held.calls).length, 0, 'everything is inside the grace, so nothing may go');
  assert.match(held.out, /held ONLY by the 7-day grace window/);
  assert.match(held.out, /LOOM_MSAL_PRUNE_MIN_AGE_DAYS=1/);

  // And with the window narrowed after review, the backlog actually clears.
  const cleared = run({
    creds: backlog,
    kvTag: 'in-use',
    env: { LOOM_MSAL_PRUNE: '1', LOOM_MSAL_PRUNE_MIN_AGE_DAYS: '0' },
  });
  assert.deepEqual(
    cleared.finalCreds.map((c) => c.split('|')[0]).sort(),
    ['b1', 'in-use'],
    'in-use plus the newest KEEP=2 window survive; the rest are provably superseded',
  );
});

// ── 4. CEILING — the regression alarm ───────────────────────────────────────
test('CEILING-1: exceeding the ceiling FAILS the run', () => {
  const many = Array.from({ length: 6 }, (_, i) => cred(`k${i}`, -1 - i, 700, `l${i}`));
  const r = run({ creds: many, kvTag: 'k0', env: { LOOM_MSAL_CREDENTIAL_CEILING: '3' } });
  assert.equal(r.rc, 1, 'the hygiene ceiling must be able to fail');
  assert.match(r.out, /MSAL credential ceiling exceeded/);
  assert.match(r.out, /Sign-in IS wired and working/, 'the message must not misreport this as an outage');
});

test('CEILING-2: an authorized prune brings the count back under the ceiling', () => {
  const r = run({
    creds: SPRAWL,
    kvTag: 'in-use',
    env: { LOOM_MSAL_PRUNE: '1', LOOM_MSAL_CREDENTIAL_CEILING: '3' },
  });
  assert.equal(r.rc, 0, `prune should have satisfied the ceiling:\n${r.out}`);
  assert.equal(r.finalCreds.length, 3);
});

test('CEILING-3: within the ceiling the run succeeds and says the measured count', () => {
  const r = run({ creds: [cred('in-use', -1, 700)], kvTag: 'in-use' });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /1 live credential\(s\), within the ceiling of 12/);
});

// ── 5. CONFIG INVARIANTS ────────────────────────────────────────────────────

test('CONFIG-1: a renewal threshold >= the whole lifetime is rejected (mint-always)', () => {
  const r = run({
    creds: [cred('in-use', -1, 700)],
    kvTag: 'in-use',
    env: { LOOM_MSAL_SECRET_YEARS: '1', LOOM_MSAL_SECRET_MIN_REMAINING_DAYS: '400' },
  });
  assert.equal(r.rc, 1);
  assert.match(r.out, /every run would mint another one/);
});

test('CONFIG-2: a keep count below 1 is rejected', () => {
  const r = run({
    creds: [cred('in-use', -1, 700)],
    kvTag: 'in-use',
    env: { LOOM_MSAL_PRUNE_KEEP: '0' },
  });
  assert.equal(r.rc, 1);
  assert.match(r.out, /The floor is 1/);
});

// ── 6. ROTATE + REVOKE — the incident path (#3637) ──────────────────────────
//
// WHY THESE ARE NOT MORE PRUNE CASES. Every rule above optimises for NOT
// minting and NOT deleting, which is right for hygiene and exactly wrong after
// a disclosure: a credential that leaked this morning has ~300 days left, so
// the reuse gate kept serving it, and the 7-day grace plus the keep window made
// it un-prunable at any setting. The two things an incident needs — "mint a
// replacement even though this one looks healthy" and "delete THIS id now" —
// had no expression in the script at all. ROTATE-1 is the direct
// counterfactual: the SAME inputs that produce REUSE without the flag must
// produce a mint with it.

const HEALTHY = [cred('leaked-key', -30, 300, 'loom-console-leaked')];

test('ROTATE-1: --rotate mints even though the recorded credential is healthy', () => {
  // The counterfactual first: without the flag these inputs REUSE and mint
  // nothing. That is the defect, and asserting it here is what makes the second
  // half a measurement rather than an assumption.
  const without = run({ creds: HEALTHY, kvTag: 'leaked-key' });
  assert.equal(mintCalls(without.calls).length, 0, 'baseline: the reuse gate keeps serving the leaked credential');
  assert.match(without.out, /REUSE — .*holds credential leaked-key/);
  assert.equal(without.finalCreds.length, 1);

  const rotated = run({ creds: HEALTHY, kvTag: 'leaked-key', args: ['--rotate'] });
  assert.equal(rotated.rc, 0, rotated.out);
  assert.equal(mintCalls(rotated.calls).length, 1, '--rotate must mint regardless of remaining lifetime');
  assert.match(rotated.out, /ROTATE — --rotate given, so the reuse gate is SKIPPED for credential leaked-key/);
  assert.doesNotMatch(rotated.out, /REUSE — /, 'the reuse gate must not also fire');
  assert.equal(rotated.finalCreds.length, 2, 'the inventory must grow by exactly one');
  assert.ok(rotated.finalCreds.some((c) => c.startsWith('leaked-key|')), 'the outgoing credential must survive the rotation');
});

test('ROTATE-2: the mint is still APPENDED and still validated before Key Vault', () => {
  const r = run({ creds: HEALTHY, kvTag: 'leaked-key', args: ['--rotate'] });
  const [call] = mintCalls(r.calls);
  assert.match(call, /--append/, 'a rotation that wiped every credential would strand the console mid-roll');
  assert.match(r.out, /validating the new secret against Entra/);
  assert.match(r.kvTag, /^minted-key-\d+$/, 'Key Vault must record the NEW credential as in use');
});

test('ROTATE-3: --rotate DELETES NOTHING and says so', () => {
  // A rotation run must not reach any delete path. The rolled revision is not
  // Healthy when the script exits, so the old credential is still what live
  // replicas present.
  const r = run({
    creds: [...HEALTHY, cred('ancient-1', -400, 300, 'loom-console-old')],
    kvTag: 'leaked-key',
    args: ['--rotate'],
    // Even with the prune AUTHORIZED, a rotate run must not delete.
    env: { LOOM_MSAL_PRUNE: '1', LOOM_MSAL_PRUNE_MIN_AGE_DAYS: '0' },
  });
  assert.equal(deleteCalls(r.calls).length, 0, 'a rotation must not delete, even with the prune authorized');
  assert.match(r.out, /NOTHING was deleted/);
  assert.equal(r.finalCreds.length, 3, 'both pre-existing credentials plus the new one');
});

test('ROTATE-4: the reason is recorded as a Key Vault TAG (an env var would be re-rendered away)', () => {
  const r = run({
    creds: HEALTHY,
    kvTag: 'leaked-key',
    args: ['--rotate', '--rotate-reason', 'disclosed-in-ci-log'],
  });
  assert.match(r.kvTagBody, /"msalRotateReason":"disclosed-in-ci-log"/);
  assert.match(r.kvTagBody, /"msalProvenance":"rotated"/);
  assert.match(r.kvTagBody, /"msalRotatedFrom":"leaked-key"/, 'the tag must name which credential was replaced');
  assert.match(r.out, /msalRotateReason=disclosed-in-ci-log/);
});

test('ROTATE-5: the receipt names what the run could NOT establish, and the next step', () => {
  // R7. This process cannot see whether the rolled revision reached Healthy or
  // whether interactive sign-in works, so it must not imply either.
  const r = run({ creds: HEALTHY, kvTag: 'leaked-key', args: ['--rotate'] });
  assert.match(r.out, /NOT VERIFIED BY THIS RUN/);
  assert.match(r.out, /IRREVERSIBLE|no undo|Entra never returns/i);
  assert.match(r.out, /--revoke <key-id>/);
});

test('ROTATE-5b: with NO Container App supplied the receipt says NOT ROLLED, and claims no revision', () => {
  // R7 again, on the half the first cut got wrong. CONSOLE_APP_NAME/CONSOLE_RG
  // are documented OPTIONAL and the wiring block is gated on both, but the
  // receipt below it was not — so a rotate without them printed "whether the
  // rolled revision is Healthy", naming a revision that was never created. The
  // honest reading of that line is "it rolled, go check it"; the truth is the
  // new credential is sitting in Key Vault with nothing serving it, and the
  // console is still presenting the compromised one.
  const r = run({
    creds: HEALTHY,
    kvTag: 'leaked-key',
    args: ['--rotate'],
    env: { CONSOLE_APP_NAME: '', CONSOLE_RG: '' },
  });
  assert.equal(r.rc, 0, r.out);
  assert.equal(mintCalls(r.calls).length, 1, 'the mint half genuinely happened — that is why the receipt must be precise about the other half');
  assert.match(r.out, /CONSOLE NOT ROLLED/);
  assert.match(r.out, /NOTHING IS SERVING THE NEW\s+CREDENTIAL YET/);
  assert.match(r.out, /still presenting the COMPROMISED credential/);
  // The specific false assertion, gone:
  assert.doesNotMatch(r.out, /the rolled revision/, 'must not name a revision that was never rolled');
  assert.doesNotMatch(r.out, /CONSOLE ROLLED:/);
  // And it must not send the operator on to the revoke, which would refuse anyway.
  assert.match(r.out, /Do NOT proceed to --revoke/);
  assert.equal(
    r.calls.split('\n').filter((l) => l.startsWith('containerapp update')).length,
    0,
    'no revision roll may have been attempted',
  );
});

test('ROTATE-5c: with a Container App supplied the receipt says ROLLED — the counterfactual', () => {
  // Same inputs, console named. This is what makes 5b a measurement of the
  // BRANCH rather than of a string that is simply always absent.
  const r = run({ creds: HEALTHY, kvTag: 'leaked-key', args: ['--rotate'] });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /CONSOLE ROLLED:/);
  assert.match(r.out, /NOT VERIFIED BY THIS RUN: whether that rolled revision is Healthy/);
  assert.doesNotMatch(r.out, /CONSOLE NOT ROLLED/);
  assert.equal(
    r.calls.split('\n').filter((l) => l.startsWith('containerapp update')).length,
    1,
    'exactly one revision roll',
  );
});

test('ROTATE-5d: a roll the CLI refused is never reported as rolled', () => {
  // The third state, and the one that must not collapse into either branch:
  // the console WAS supplied but `az containerapp update` failed. The run
  // already exits 1 there; what this pins is that it does so without printing
  // a ROLLED receipt over a roll that did not happen.
  const r = run({
    creds: HEALTHY,
    kvTag: 'leaked-key',
    args: ['--rotate'],
    consoleUpdateFails: true,
  });
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /the env-var update on .* FAILED/);
  assert.doesNotMatch(r.out, /CONSOLE ROLLED:/);
  assert.doesNotMatch(r.out, /ROTATE COMPLETE/, 'a failed roll must not reach the rotate success receipt');
});

test('ROTATE-6: --rotate and --revoke in one invocation are REFUSED', () => {
  const r = run({
    creds: HEALTHY,
    kvTag: 'leaked-key',
    args: ['--rotate', '--revoke', 'leaked-key'],
  });
  assert.equal(r.rc, 1);
  assert.match(r.out, /--rotate and --revoke cannot be combined/);
  assert.equal(mintCalls(r.calls).length, 0, 'the refusal must happen before anything is minted');
  assert.equal(deleteCalls(r.calls).length, 0);
});

// The state AFTER a rotation: a fresh credential in service, the leaked one
// still live and only hours old — inside every grace window the prune honours.
const AFTER_ROTATION = [
  cred('fresh-key', -0.05, 365, 'loom-console-fresh'),
  cred('leaked-key', -1, 300, 'loom-console-leaked'),
];

test('REVOKE-1: removes exactly the named credential, bypassing PRUNE_MIN_AGE_DAYS', () => {
  // The counterfactual: an authorized PRUNE at the default grace cannot touch
  // it — the leaked credential is 1 day old and one of the newest two. That is
  // precisely why --revoke had to exist.
  const pruned = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', env: { LOOM_MSAL_PRUNE: '1' } });
  assert.equal(deleteCalls(pruned.calls).length, 0, 'baseline: no prune setting removes a 1-day-old credential');
  assert.ok(pruned.finalCreds.some((c) => c.startsWith('leaked-key|')));

  const revoked = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', args: ['--revoke', 'leaked-key'] });
  assert.equal(revoked.rc, 0, revoked.out);
  assert.deepEqual(
    revoked.finalCreds.map((c) => c.split('|')[0]),
    ['fresh-key'],
    'exactly the named credential goes, and only it',
  );
  assert.equal(deleteCalls(revoked.calls).length, 1, 'one credential named, one delete issued');
  assert.match(revoked.out, /REVOKED — leaked-key is confirmed absent/);
  assert.match(revoked.out, /BYPASSES the 7-day hygiene grace/, 'bypassing the grace must be stated, not silent');
});

test('REVOKE-2: revoking the credential the console SERVES is refused', () => {
  const r = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', args: ['--revoke', 'fresh-key'] });
  assert.equal(r.rc, 1);
  assert.match(r.out, /REFUSING to revoke: fresh-key IS the credential/);
  assert.equal(deleteCalls(r.calls).length, 0, 'the refusal must precede any delete');
  assert.equal(r.finalCreds.length, 2, 'nothing may be removed');
  assert.match(r.out, /--rotate/, 'the refusal must name the route that does work');
});

test('REVOKE-3: a target NEWER than the in-use credential is refused', () => {
  // R2 alone is not enough. Here the target is not the in-use one, but it was
  // minted AFTER it — so "a newer credential is what the console serves" is
  // false, and this may be the successor rather than the superseded one.
  const r = run({
    creds: [cred('older-in-use', -30, 300, 'loom-console-a'), cred('newer-other', -1, 700, 'loom-console-b')],
    kvTag: 'older-in-use',
    args: ['--revoke', 'newer-other'],
  });
  assert.equal(r.rc, 1);
  assert.match(r.out, /is NOT older than the in-use credential/);
  assert.equal(deleteCalls(r.calls).length, 0);
});

test('REVOKE-4: an UNPROVEN console binding refuses the revoke', () => {
  // The same P3 evidence the prune requires. An inline (non-KV-reference)
  // console secret means the Key Vault tag records what the estate is
  // CONFIGURED to present, not what running replicas actually present.
  const r = run({
    creds: AFTER_ROTATION,
    kvTag: 'fresh-key',
    caSecretUrl: '',
    args: ['--revoke', 'leaked-key'],
  });
  assert.equal(r.rc, 1);
  assert.match(r.out, /REFUSING to revoke: what the console actually serves is NOT proven/);
  assert.equal(deleteCalls(r.calls).length, 0);
});

test('REVOKE-5: a stale active revision (P3b) also refuses the revoke', () => {
  const r = run({
    creds: AFTER_ROTATION,
    kvTag: 'fresh-key',
    kvUpdatedDays: -0.5,
    revisions: [iso(-5 * DAY)],
    args: ['--revoke', 'leaked-key'],
  });
  assert.equal(r.rc, 1);
  assert.match(r.out, /PREDATES the Key Vault write/);
  assert.match(r.out, /REFUSING to revoke/);
  assert.equal(deleteCalls(r.calls).length, 0);
});

test('REVOKE-6: an unknown key id FAILS and does not claim it was already removed', () => {
  // R7. The credential list shows what is present now; it cannot distinguish
  // "already deleted" from "never existed", so the message must not assert
  // either.
  const r = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', args: ['--revoke', 'no-such-key'] });
  assert.equal(r.rc, 1);
  assert.match(r.out, /has no password credential with key id no-such-key/);
  assert.match(r.out, /cannot tell you whether that id was already removed or never existed/);
  assert.equal(deleteCalls(r.calls).length, 0);
});

test('REVOKE-7: no provenance means no revoke — an unresolvable key id is refused', () => {
  // NOT an untagged Key Vault secret: that case MINTS (MINT-1), and the mint
  // records provenance, so the run ends up knowing exactly what is in use. The
  // state where provenance is genuinely unknown is the one MINT-6 pins — the
  // secret was written but the new credential's key id could not be resolved by
  // its label. Measured while writing this: the first draft asserted the
  // untagged case and failed here, refusing at R4 instead of R2.
  const r = run({
    creds: AFTER_ROTATION,
    kvTag: '',
    labelLookupFails: true,
    args: ['--revoke', 'leaked-key'],
  });
  assert.equal(r.rc, 1);
  assert.match(r.out, /could not establish which credential the estate is configured to present/);
  assert.equal(deleteCalls(r.calls).length, 0);
});

test('REVOKE-8: a delete that reports success but removes nothing FAILS the run', () => {
  // R5, and the reason the post-delete re-read exists: `az ad app credential
  // delete` exiting 0 is not evidence the credential is gone. Without the
  // assertion this run would print REVOKED over a live credential — the worst
  // possible outcome of an incident procedure.
  const r = run({
    creds: AFTER_ROTATION,
    kvTag: 'fresh-key',
    deleteIsNoop: true,
    args: ['--revoke', 'leaked-key'],
  });
  assert.equal(r.rc, 1, 'an unconfirmed deletion must not be reported as a revocation');
  assert.match(r.out, /is STILL present on .* after a delete that reported success/);
  assert.doesNotMatch(r.out, /REVOKED — leaked-key is confirmed absent/);
});

test('REVOKE-9: a revoke run mints nothing — it is not a rotation in disguise', () => {
  const r = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', args: ['--revoke', 'leaked-key'] });
  assert.equal(mintCalls(r.calls).length, 0, 'the in-use credential is healthy, so the reuse gate must still hold');
});

test('REVOKE-10: neither rotate nor revoke prints a secret value', () => {
  const rot = run({ creds: HEALTHY, kvTag: 'leaked-key', args: ['--rotate'] });
  assert.doesNotMatch(rot.out, /STUB-PASSWORD-NEVER-LOGGED/);
  const rev = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', args: ['--revoke', 'leaked-key'] });
  assert.doesNotMatch(rev.out, /STUB-PASSWORD-NEVER-LOGGED/);
});

// ── 6b. A REQUESTED revoke with NO TARGET must refuse ───────────────────────
//
// The destructive half had no equivalent of ROTATE's REUSED=1 belt-and-braces
// guard. Every REVOKE case above names a key id, so all of them entered the
// revoke block and none could see what happens when the id is EMPTY: the block
// was gated on `[ -n "${REVOKE_KEY_ID}" ]`, so an empty id skipped it entirely,
// ran the ordinary bootstrap to completion and printed the normal "==> Done."
// success banner with exit 0. Mid-incident that reads as "the leaked credential
// is gone" when it is still live — the worst possible false receipt, and the
// exact failure mode the whole R1–R5 chain exists to prevent.
//
// The shared assertions are the load-bearing ones: rc=1, zero deletes, and the
// ABSENCE of the success banner. A refusal that still printed "==> Done." would
// satisfy an rc check alone.
const NO_TARGET_CASES = [
  ['a bare --revoke with no following value', { args: ['--revoke'] }],
  ['--revoke "$KID" where KID is unset or empty', { args: ['--revoke', ''] }],
  ['--revoke= with nothing after the equals', { args: ['--revoke='] }],
  ['a value that was only whitespace', { args: ['--revoke', '   '] }],
  ['LOOM_MSAL_REVOKE_KEY_ID defined as an empty string', { env: { LOOM_MSAL_REVOKE_KEY_ID: '' } }],
];

for (const [label, extra] of NO_TARGET_CASES) {
  test(`REVOKE-11 (${label}): refuses, deletes nothing, and never prints the success banner`, () => {
    const r = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', ...extra });
    assert.equal(r.rc, 1, `a revoke with no target must exit non-zero.\n${r.out}`);
    assert.match(r.out, /a revoke was requested but NO credential key id was given/);
    assert.match(r.out, /NOTHING was revoked/);
    assert.equal(deleteCalls(r.calls).length, 0, 'nothing may be deleted');
    assert.equal(mintCalls(r.calls).length, 0, 'and nothing minted');
    assert.doesNotMatch(r.out, /==> Done\./, 'the ordinary success banner must NOT appear over a revoke that did nothing');
    assert.equal(r.finalCreds.length, AFTER_ROTATION.length, 'the inventory must be untouched');
  });
}

test('REVOKE-12: the refusal happens before ANY Entra or Key Vault call', () => {
  // "Exits 1" is not enough on a destructive path: it must exit before the run
  // can have had a side effect. The stub logs every az invocation, so an empty
  // call log is the measurement.
  const r = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', args: ['--revoke'] });
  assert.equal(r.calls.trim(), '', `no az call may be made at all, got:\n${r.calls}`);
});

test('REVOKE-13: --revoke --prune does not swallow the flag as a key id', () => {
  // A key id is a GUID and can never start with `--`, so a flag-shaped follower
  // is an ABSENT value. Before this, `--prune` was shifted into REVOKE_KEY_ID:
  // the operator lost the prune they asked for AND a missing target became a
  // bogus one, so the run failed with "no password credential with key id
  // --prune" — an accurate-sounding message about the wrong problem.
  const r = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key', args: ['--revoke', '--prune'] });
  assert.equal(r.rc, 1);
  assert.match(r.out, /a revoke was requested but NO credential key id was given/);
  assert.doesNotMatch(r.out, /key id --prune/, 'the flag must not be reported as the target');
});

test('REVOKE-14: an UNSET LOOM_MSAL_REVOKE_KEY_ID is still "no revoke", not a refusal', () => {
  // The counterfactual for REVOKE-11's env case, and the regression guard for
  // the deploy path: csa-loom-post-deploy-bootstrap.yml runs this script bare,
  // so if "unset" were also read as a requested revoke, every bootstrap in every
  // boundary would exit 1.
  const r = run({ creds: AFTER_ROTATION, kvTag: 'fresh-key' });
  assert.equal(r.rc, 0, r.out);
  assert.match(r.out, /==> Done\./);
  assert.doesNotMatch(r.out, /revoke was requested/);
  assert.equal(deleteCalls(r.calls).length, 0);
});

test('DEFAULT-1: with no new flag the behaviour is byte-for-byte the old behaviour', () => {
  // The regression guard for the flag-parsing rewrite (`for arg in "$@"` became
  // `while … shift` so `--revoke` could take a value). A parser change that
  // silently dropped `--prune` would be invisible in every case above.
  const r = run({ creds: SPRAWL, kvTag: 'in-use', args: ['--prune'] });
  assert.equal(r.rc, 0, r.out);
  assert.deepEqual(r.finalCreds.map((c) => c.split('|')[0]).sort(), ['in-use', 'recent-1', 'recent-2']);
  const dry = run({ creds: SPRAWL, kvTag: 'in-use', args: ['--dry-run-prune'] });
  assert.equal(deleteCalls(dry.calls).length, 0);
  assert.match(dry.out, /DRY RUN — \d+ credential\(s\) above are marked PRUNE/);
});
