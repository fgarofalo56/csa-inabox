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
 * PRUNE-3 red; removing the ceiling turns CEILING-1 red.
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
  env = {},
}) {
  const dir = mkdtempSync(join(tmpdir(), 'msalcred-'));
  const credFile = join(dir, 'creds.tsv');
  const tagFile = join(dir, 'kvtag');
  const updFile = join(dir, 'kvupdated');
  const revFile = join(dir, 'revisions');
  const calls = join(dir, 'calls.log');
  writeFileSync(credFile, creds.length ? `${creds.join('\n')}\n` : '');
  writeFileSync(tagFile, kvTag);
  writeFileSync(updFile, String(Math.floor((Date.now() + kvUpdatedDays * DAY) / 1000)));
  writeFileSync(revFile, revisions.length ? `${revisions.join('\n')}\n` : '');

  const q = JSON.stringify;
  // MEASURED contracts this stub reproduces:
  //   • absent tag on an existing secret -> exit 0, EMPTY stdout (not "None")
  //   • missing secret -> exit 1, stderr contains "code":"ResourceNotFound"
  //   • `credential list` never returns a password, only metadata
  const az = `#!/usr/bin/env bash
echo "$*" >> ${q(calls)}
CREDS=${q(credFile)}; TAG=${q(tagFile)}; UPD=${q(updFile)}; REV=${q(revFile)}
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
    grep -v "^\${kid}|" "$CREDS" > "$CREDS.tmp" || true
    mv "$CREDS.tmp" "$CREDS"
    exit 0 ;;
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
        date -u +%s > "$UPD" ;;
    esac
    exit 0 ;;
esac
case "$*" in
  "containerapp secret list"*) printf '%s\\n' ${q(caSecretUrl)}; exit 0 ;;
  "containerapp revision list"*) cat "$REV"; exit 0 ;;
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

  const r = spawnSync('bash', [SCRIPT], {
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
