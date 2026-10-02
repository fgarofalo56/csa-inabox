/**
 * gov-uc-purview-wire: loom-unity pull identity, deploy classification, health.
 *
 * WHAT THIS PINS. On 2026-09-30 (run 36774518931) the loom-unity deploy used
 * the dedicated `uami-loom-unity-<region>` as its registry pull identity
 * without checking that it could pull; the revision never started, ARM said
 * only "Operation expired", the step printed raw ARM JSON, and the health loop
 * discarded stderr and never failed. The catalog runs ONLY as that identity
 * (operator decision 2026-10-01: no fallback to the Console identity), so the
 * pull check either grants AcrPull or stops with the exact grant.
 *
 * HOW. The SHIPPED scripts are driven with a STUB `az` on PATH that records
 * every call:
 *   - scripts/csa-loom/ensure-acr-pull-identity.sh
 *   - scripts/csa-loom/containerapp-revision-check.sh (wait, diagnose)
 * The stub prints the SHAPE the real CLI prints: a list multiselect with
 * `-o tsv` is ONE VALUE PER LINE (roll-health-verdict.test.mjs:77-79 records
 * it; az 2.90.0 measured by both reviewers of #4863). A stub that printed a
 * tab-separated row instead hid a parse defect in round 1 of #4863; the
 * STUB SHAPE case below pins the fixture itself.
 * The deploy retry loop is EXTRACTED from the workflow at run time and run
 * with a stub `deploy_unity` and a stub diagnose script.
 *
 * WHAT BREAKS EACH CASE is stated at the case. Mutation arms point these env
 * vars at sandbox copies (the tracked files are untouched):
 *   LOOM_TEST_ENSURE_SCRIPT, LOOM_TEST_REVCHECK_SCRIPT, LOOM_TEST_WIRE_WORKFLOW
 *
 * Run: node --test scripts/ci/__tests__/gov-unity-pull-identity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const ENSURE = process.env.LOOM_TEST_ENSURE_SCRIPT || join(REPO, 'scripts', 'csa-loom', 'ensure-acr-pull-identity.sh');
const REVCHECK = process.env.LOOM_TEST_REVCHECK_SCRIPT || join(REPO, 'scripts', 'csa-loom', 'containerapp-revision-check.sh');
const WF = process.env.LOOM_TEST_WIRE_WORKFLOW || join(REPO, '.github', 'workflows', 'gov-uc-purview-wire.yml');

const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

// Fixture ids. None of them may appear in what the scripts print.
const SUB = '55555555-5555-4555-8555-555555555555';
const PREF_PID = '11111111-1111-4111-8111-111111111111';
const PREF_CID = '22222222-2222-4222-8222-222222222222';
const SP_OID = '66666666-6666-4666-8666-666666666666';
const ERR_GUID = '77777777-7777-4777-8777-777777777777';
const REV_GUID = '88888888-8888-4888-8888-888888888888';
const LAW = '99999999-9999-4999-8999-999999999999';
const IDS = [SUB, PREF_PID, PREF_CID, SP_OID, ERR_GUID, REV_GUID, LAW];
const SINCE = '2026-09-30T20:47:00';

const STUB_AZ = String.raw`#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/calls.log"
a="$*"
cnt() { local f="$STUB_DIR/$1" n=0; [ -f "$f" ] && n=$(cat "$f"); n=$((n + 1)); echo "$n" > "$f"; echo "$n"; }
case "$a" in
  "acr show"*)
    [ "@{STUB_ACR:-ok}" = ok ] || { echo "ERROR: (AuthorizationFailed) cannot read registry" >&2; exit 1; }
    echo "/subscriptions/$SUB/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acrx" ;;
  "identity show -n"*)
    case "@{STUB_PREF:-ok}" in
      # REAL SHAPE: a list multiselect with -o tsv is one value per LINE.
      ok) printf '%s\n%s\n%s\n' "/subscriptions/$SUB/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-unity-usgovvirginia" "$PREF_PID" "$PREF_CID" ;;
      notfound) echo "ERROR: (ResourceNotFound) The Resource 'Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-unity-usgovvirginia' under resource group 'rg' was not found." >&2; exit 3 ;;
      *) echo "ERROR: (InternalServerError) identity read failed" >&2; exit 1 ;;
    esac ;;
  "role assignment list"*)
    if [ -f "$STUB_DIR/granted" ]; then
      n=$(cnt reads_after_grant)
      [ "@{STUB_POLL_FAIL:-}" = "1" ] && { echo "ERROR: (InternalServerError) client $ERR_GUID role read failed" >&2; exit 1; }
      if [ "$n" -ge "@{STUB_VISIBLE_AFTER:-1}" ]; then echo AcrPull; fi
      exit 0
    fi
    [ "@{STUB_PREF_ROLES:-}" = FAIL ] && { echo "ERROR: (AuthorizationFailed) client $ERR_GUID cannot read role assignments" >&2; exit 1; }
    printf '%b' "@{STUB_PREF_ROLES:-}"
    # an assignment at RG/subscription scope is listed ONLY with --include-inherited
    case "$a" in *--include-inherited*) printf '%b' "@{STUB_PREF_ROLES_INHERITED:-}" ;; esac ;;
  "role assignment create"*)
    case "@{STUB_GRANT:-ok}" in
      ok) touch "$STUB_DIR/granted" ;;
      exists) touch "$STUB_DIR/granted"; echo "ERROR: (RoleAssignmentExists) The role assignment already exists." >&2; exit 1 ;;
      authz) echo "ERROR: (AuthorizationFailed) The client 'deploy' with object id '$SP_OID' does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write' over scope '/subscriptions/$SUB/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acrx'" >&2; exit 1 ;;
      *) echo "ERROR: (InternalServerError) grant failed for $ERR_GUID" >&2; exit 1 ;;
    esac ;;
  "containerapp revision list"*"[-1].[name"*)
    [ "@{STUB_REVREAD:-ok}" = ok ] || { echo "ERROR: (InternalServerError) revision read failed" >&2; exit 1; }
    printf '%s\n%s\n' "@{STUB_REV_NAME:-loom-unity--0000009}" "@{STUB_REV_CREATED:-2026-09-30T20:47:07+00:00}" ;;
  "containerapp revision show"*"{name:"*) printf '%s\n' "@{STUB_REV_JSON:-null}" ;;
  "containerapp revision show"*healthState*)
    n=$(cnt health_reads)
    read -r -a seq <<< "@{STUB_HEALTH_SEQ:-Healthy}"
    i=$((n - 1)); [ "$i" -lt "@{#seq[@]}" ] || i=$((@{#seq[@]} - 1))
    echo "@{seq[$i]}" ;;
  "containerapp replica list"*) printf '%s\n' "@{STUB_REPLICA_JSON:-[]}" ;;
  "containerapp show"*latestRevisionName*)
    [ "@{STUB_LATEST:-ok}" = ok ] || { echo "ERROR: (InternalServerError) app read failed" >&2; exit 1; }
    echo "loom-unity--0000009" ;;
  "containerapp show"*provisioningState*) echo Failed ;;
  "containerapp show"*environmentId*) echo "/subscriptions/$SUB/resourceGroups/rg/providers/Microsoft.App/managedEnvironments/cae1" ;;
  "containerapp env show"*destination*) echo "@{STUB_DEST:-log-analytics}" ;;
  "containerapp env show"*customerId*) echo "$LAW" ;;
  "extension add"*) : ;;
  "monitor log-analytics query"*)
    printf '%s\n' "$a" >> "$STUB_DIR/kql.log"
    printf '%b' "@{STUB_SYSLOG:-}" ;;
  *) echo "UNSTUBBED: $a" >&2; exit 99 ;;
esac
`.replaceAll('@{', '${');

function stubDir() {
  const dir = mkdtempSync(join(tmpdir(), 'unity-pull-'));
  const az = join(dir, 'az');
  writeFileSync(az, STUB_AZ);
  chmodSync(az, 0o755);
  return dir;
}

function baseEnv(dir, extra) {
  return {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    STUB_DIR: dir, SUB, PREF_PID, PREF_CID, SP_OID, ERR_GUID, LAW,
    LOOM_PULL_GRANT_POLL_ATTEMPTS: '4', LOOM_PULL_GRANT_POLL_SECONDS: '0', LOOM_PULL_GRANT_SETTLE_SECONDS: '0',
    LOOM_REVISION_WAIT_ATTEMPTS: '3', LOOM_REVISION_WAIT_SECONDS: '0',
    ...extra,
  };
}

const SPAWN_TIMEOUT = 120000;

function runEnsure(stub) {
  const dir = stubDir();
  const out = join(dir, 'out.env');
  const r = spawnSync('bash', [ENSURE, '--acr', 'acrx', '--rg', 'rg', '--identity', 'uami-loom-unity-usgovvirginia', '--out', out],
    { encoding: 'utf8', env: baseEnv(dir, stub), timeout: SPAWN_TIMEOUT });
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  const env = existsSync(out) ? readFileSync(out, 'utf8') : '';
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, calls, env };
}

function runRevCheck(cmd, stub, extraArgs = []) {
  const dir = stubDir();
  const r = spawnSync('bash', [REVCHECK, cmd, '--app', 'loom-unity', '--rg', 'rg', '--acr', 'acrx',
    '--identity-name', 'uami-loom-unity-usgovvirginia', ...extraArgs], { encoding: 'utf8', env: baseEnv(dir, stub), timeout: SPAWN_TIMEOUT });
  const kql = existsSync(join(dir, 'kql.log')) ? readFileSync(join(dir, 'kql.log'), 'utf8') : '';
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, kql };
}

const field = (env, k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const leakedIds = (out) => IDS.filter((g) => out.includes(g));
const createCalls = (calls) => calls.split('\n').filter((l) => l.startsWith('role assignment create'));

// ── the fixture itself ───────────────────────────────────────────────────────

test('STUB SHAPE: the stub prints a list multiselect as one value per line, like the real CLI', { skip: !bashAvailable }, () => {
  // Breaks if: the stub goes back to a tab-separated row, which real az never
  // prints for `--query "[a, b, c]" -o tsv` -- the fixture that hid the round-1 parse defect.
  const dir = stubDir();
  const r = spawnSync('bash', [join(dir, 'az'), 'identity', 'show', '-n', 'x', '-g', 'rg', '--query', '[id, principalId, clientId]', '-o', 'tsv'],
    { encoding: 'utf8', env: baseEnv(dir, {}) });
  const lines = r.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3, r.stdout);
  assert.ok(lines.every((l) => !l.includes('\t')), 'no tab-separated fields');
  assert.equal(lines[1], PREF_PID);
});

// ── ensure-acr-pull-identity.sh ──────────────────────────────────────────────

test('HAS ROLE: AcrPull at the registry -> used, NO grant', { skip: !bashAvailable }, () => {
  // Breaks if: the identity read is parsed as a tab row (ids come back empty, exit 2),
  // or the role check is skipped (a create call appears).
  const r = runEnsure({ STUB_PREF_ROLES: 'Reader\nAcrPull\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'UAMI_NAME'), 'uami-loom-unity-usgovvirginia');
  assert.equal(field(r.env, 'UAMI_CLIENT_ID'), PREF_CID);
  assert.equal(field(r.env, 'GRANTED'), 'no');
  assert.equal(createCalls(r.calls).length, 0, `no grant expected; calls:\n${r.calls}`);
  assert.deepEqual(leakedIds(r.out), []);
});

test('HAS ROLE: AcrPush counts as pull-capable and is named', { skip: !bashAvailable }, () => {
  // Breaks if: the pull-role set is narrowed to AcrPull only.
  const r = runEnsure({ STUB_PREF_ROLES: 'AcrPush\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'PULL_ROLE'), 'AcrPush');
  assert.equal(createCalls(r.calls).length, 0);
});

test('HAS ROLE INHERITED: a Contributor assignment above the registry counts (needs --include-inherited)', { skip: !bashAvailable }, () => {
  // Breaks if: --include-inherited is dropped from the role query (the stub
  // lists the inherited assignment only when the flag is present).
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_PREF_ROLES_INHERITED: 'Contributor\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'PULL_ROLE'), 'Contributor');
  assert.equal(createCalls(r.calls).length, 0);
});

test('LACKS ROLE + GRANT OK: grants AcrPull on the registry, waits until visible, then uses it', { skip: !bashAvailable }, () => {
  // Breaks if: no grant, another role/scope/assignee, or use before the
  // assignment is visible (STUB_VISIBLE_AFTER=2: the first read after the grant shows nothing).
  const r = runEnsure({ STUB_PREF_ROLES: 'Reader\n', STUB_GRANT: 'ok', STUB_VISIBLE_AFTER: '2' });
  assert.equal(r.rc, 0, r.out);
  const creates = createCalls(r.calls);
  assert.equal(creates.length, 1, r.calls);
  assert.match(creates[0], /--role 7f951dda-4ed3-4680-a7ca-43fe172d538d/);
  assert.match(creates[0], new RegExp(`--assignee-object-id ${PREF_PID}`));
  assert.match(creates[0], /--assignee-principal-type ServicePrincipal/);
  assert.match(creates[0], /--scope \/subscriptions\/.*\/registries\/acrx/);
  const after = r.calls.split('role assignment create')[1] || '';
  assert.ok((after.match(/role assignment list/g) || []).length >= 2, `expected >= 2 role reads after the grant:\n${r.calls}`);
  assert.equal(field(r.env, 'GRANTED'), 'yes');
  assert.match(r.out, /::notice::Granted AcrPull on registry acrx/);
  assert.deepEqual(leakedIds(r.out), []);
});

test('ALREADY GRANTED: RoleAssignmentExists is reported as already granted, not as a grant by this run', { skip: !bashAvailable }, () => {
  // Breaks if: the exists branch reports "Granted" / GRANTED=yes, or is treated as a failure.
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'exists' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'GRANTED'), 'already');
  assert.match(r.out, /already granted/);
  assert.doesNotMatch(r.out, /::notice::Granted AcrPull/);
});

test('GRANT REFUSED (no roleAssignments/write): STOPS with the exact grant -- no other identity is used', { skip: !bashAvailable }, () => {
  // Breaks if: the refusal falls back to any other identity or exits 0, or the
  // remediation omits the role id, scope, principal kind or how to read the principal id.
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'authz' });
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.env, '', 'no identity may be written');
  assert.match(r.out, /::error::loom-unity's pull identity uami-loom-unity-usgovvirginia cannot pull from registry acrx/);
  assert.match(r.out, /lacks Microsoft\.Authorization\/roleAssignments\/write/);
  assert.match(r.out, /AcrPull \(role definition 7f951dda-4ed3-4680-a7ca-43fe172d538d\)/);
  assert.match(r.out, /principal type ServicePrincipal/);
  assert.match(r.out, /az identity show -n uami-loom-unity-usgovvirginia -g rg --query principalId -o tsv/);
  assert.match(r.out, /--scope "\$\(az acr show -n acrx --query id -o tsv\)"/);
  assert.deepEqual(leakedIds(r.out), [], 'the authorization error carries the deploy SP object id and the subscription id');
});

test('GRANT FAILS OTHERWISE: the quoted az error has its GUIDs masked', { skip: !bashAvailable }, () => {
  // Breaks if: mask() stops masking GUIDs (the fixture error carries ERR_GUID).
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'other' });
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /granting AcrPull failed \(az exit 1: .*<guid>/);
  assert.deepEqual(leakedIds(r.out), []);
});

test('DEDICATED ABSENT: STOPS with how to create and grant it; nothing is granted', { skip: !bashAvailable }, () => {
  // Breaks if: a missing identity is replaced by another identity, or exits 0.
  const r = runEnsure({ STUB_PREF: 'notfound' });
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /does not exist in resource group rg/);
  assert.match(r.out, /az identity create -n uami-loom-unity-usgovvirginia -g rg/);
  assert.match(r.out, /loomUnityUami/);
  assert.equal(createCalls(r.calls).length, 0);
});

test('IDENTITY READ FAILS (not not-found): exit 2, "could not be read", never "does not exist"', { skip: !bashAvailable }, () => {
  // Breaks if: any identity read failure is treated as not-found (a throttled or
  // denied read would then falsely claim absence and tell the operator to
  // create an identity that already exists -- the R7 shape this script exists
  // to remove). STUB_PREF set to anything but ok/notfound hits the stub's
  // generic InternalServerError branch (gov-unity-pull-identity.test.mjs:70).
  const r = runEnsure({ STUB_PREF: 'fail' });
  assert.equal(r.rc, 2, r.out);
  assert.match(r.out, /could not be read/);
  assert.doesNotMatch(r.out, /does not exist/);
  assert.doesNotMatch(r.out, /az identity create/);
  assert.equal(createCalls(r.calls).length, 0);
});

test('REGISTRY READ FAILS: exit 2, "Could not read registry acrx", no role assignment call', { skip: !bashAvailable }, () => {
  // Breaks if: a failed `acr show` falls through with an empty registry id
  // instead of stopping (the role/identity reads would then run against "").
  const r = runEnsure({ STUB_ACR: 'fail' });
  assert.equal(r.rc, 2, r.out);
  assert.match(r.out, /Could not read registry acrx/);
  assert.doesNotMatch(r.calls, /role assignment/);
});

test('ROLE READ FAILS: UNKNOWN -> exit 2, no grant, never "no role"; the GUID in the error is masked', { skip: !bashAvailable }, () => {
  // Breaks if: a failed read is treated as "no role" (a grant would follow), or GUIDs leak.
  const r = runEnsure({ STUB_PREF_ROLES: 'FAIL' });
  assert.equal(r.rc, 2, r.out);
  assert.equal(createCalls(r.calls).length, 0, r.calls);
  assert.match(r.out, /could not be read/);
  assert.deepEqual(leakedIds(r.out), []);
});

test('GRANT NEVER VISIBLE: STOPS rather than deploying on an identity not shown to pull', { skip: !bashAvailable }, () => {
  // Breaks if: the identity is used after the poll runs out.
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'ok', STUB_VISIBLE_AFTER: '99' });
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.env, '');
  assert.match(r.out, /did not become visible after 4 reads/);
});

test('GRANT VISIBILITY UNKNOWN: the last poll read failed -> exit 2, not exit 1', { skip: !bashAvailable }, () => {
  // Breaks if: a poll read that fails (rather than succeeding and showing no
  // role) is still reported as "did not become visible" (exit 1), which claims
  // an absence this run never established (PR_WHY would also go stale without
  // the per-call reset this case depends on).
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'ok', STUB_POLL_FAIL: '1' });
  assert.equal(r.rc, 2, r.out);
  assert.equal(r.env, '');
  assert.match(r.out, /UNKNOWN/);
  assert.match(r.out, /re-dispatch/);
  assert.deepEqual(leakedIds(r.out), []);
});

// ── containerapp-revision-check.sh ───────────────────────────────────────────

const NEW_REV = { STUB_REV_CREATED: '2026-09-30T20:48:10+00:00' };   // after SINCE
const OLD_REV = { STUB_REV_NAME: 'loom-unity--0000008', STUB_REV_CREATED: '2026-08-11T17:20:00+00:00' };
const sinceArgs = ['--since', SINCE];

test('DIAGNOSE: a pull refused for authorization on THIS deploy\'s revision is PERMISSION (11)', { skip: !bashAvailable }, () => {
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"loom-unity--0000009","provisioningError":"Operation expired"}',
    STUB_REPLICA_JSON: '[{"containers":[{"details":"ImagePullBackOff: failed to pull image: unauthorized: authentication required"}]}]' }, sinceArgs);
  assert.equal(r.rc, 11, r.out);
  assert.match(r.out, /classified PERMISSION/);
  // Breaks if: the remediation names the role by display name or drops the principal kind
  // (the operator's grant command must carry the role definition id and ServicePrincipal).
  assert.match(r.out, /--role 7f951dda-4ed3-4680-a7ca-43fe172d538d --scope/);
  assert.match(r.out, /--assignee-principal-type ServicePrincipal/);
});

test('DIAGNOSE: classification is case-insensitive', { skip: !bashAvailable }, () => {
  // Breaks if: `shopt -s nocasematch` is removed (every pattern is spelled in mixed case).
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"loom-unity--0000009"}',
    STUB_REPLICA_JSON: '[{"details":"IMAGEPULLBACKOFF: FAILED TO PULL IMAGE: UNAUTHORIZED"}]' }, sinceArgs);
  assert.equal(r.rc, 11, r.out);
});

test('DIAGNOSE: RETRY (10) comes from the deployment error', { skip: !bashAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'deperr-'));
  const f = join(dir, 'err.txt');
  writeFileSync(f, 'ERROR: (ContainerAppOperationInProgress) Cannot modify a container app while another operation is in progress.\n');
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"loom-unity--0000009"}' }, [...sinceArgs, '--deploy-stderr', f]);
  assert.equal(r.rc, 10, r.out);
  assert.match(r.out, /one retry is valid/);
});

test('DIAGNOSE: an in-progress word in the REVISION state does not trigger a retry', { skip: !bashAvailable }, () => {
  // Breaks if: RETRY is matched over the revision/replica text (it would win over the crash signal).
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"x","runningDetails":"OperationInProgress then Back-off restarting failed container"}' }, sinceArgs);
  assert.equal(r.rc, 14, r.out);
});

test('DIAGNOSE: RETRY on attempt 2 is reported exhausted', { skip: !bashAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'deperr-'));
  const f = join(dir, 'err.txt');
  writeFileSync(f, 'ERROR: (ContainerAppOperationInProgress) another operation is in progress\n');
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"x"}' }, [...sinceArgs, '--attempt', '2', '--deploy-stderr', f]);
  assert.equal(r.rc, 10, r.out);
  assert.match(r.out, /retry is exhausted/);
  assert.doesNotMatch(r.out, /one retry is valid/);
});

test('DIAGNOSE: a crash loop is IMAGE (14), worded as a fault at or after container start', { skip: !bashAvailable }, () => {
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"loom-unity--0000009","runningDetails":"Back-off restarting failed container"}' }, sinceArgs);
  assert.equal(r.rc, 14, r.out);
  assert.match(r.out, /the fault is at or after container start/);
  assert.doesNotMatch(r.out, /not at fault/);
});

test('DIAGNOSE: "Operation expired" alone is UNCLASSIFIED (16) and says it establishes no cause', { skip: !bashAvailable }, () => {
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"loom-unity--0000009","provisioningError":"Operation expired"}' }, sinceArgs);
  assert.equal(r.rc, 16, r.out);
  assert.match(r.out, /'Operation expired' on its own/);
});

test('DIAGNOSE: the "Operation expired" sentence appears only when that text is present', { skip: !bashAvailable }, () => {
  // Breaks if: the sentence is printed unconditionally.
  const dir = mkdtempSync(join(tmpdir(), 'deperr-'));
  const f = join(dir, 'err.txt');
  writeFileSync(f, 'ERROR: (InvalidTemplate) Deployment template validation failed.\n');
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"x"}' }, [...sinceArgs, '--deploy-stderr', f]);
  assert.equal(r.rc, 16, r.out);
  assert.doesNotMatch(r.out, /Operation expired/);
});

test('DIAGNOSE: a revision OLDER than the deploy is not reported or classified', { skip: !bashAvailable }, () => {
  // Breaks if: --since is ignored (the stale revision's crash text would classify as 14
  // and its JSON would be printed as this deploy's state).
  const r = runRevCheck('diagnose', { ...OLD_REV, STUB_REV_JSON: '{"name":"loom-unity--0000008","runningDetails":"STALEMARK Back-off restarting failed container"}' }, sinceArgs);
  assert.equal(r.rc, 16, r.out);
  assert.match(r.out, /No revision was created by this deploy: the newest, loom-unity--0000008 \(created 2026-08-11T17:20:00Z\), predates its start/);
  assert.match(r.out, /provisioningState: Failed/);
  assert.doesNotMatch(r.out, /STALEMARK/);
});

test('DIAGNOSE: the system log is read FROM THE DEPLOY START and classifies when no revision was created', { skip: !bashAvailable }, () => {
  // Breaks if: the system log is read over a fixed window (the KQL would not carry the start),
  // or its rows are not used for classification.
  const r = runRevCheck('diagnose', { ...OLD_REV, STUB_SYSLOG: '2026-09-30 20:48:30 loom-unity--0000009 Warning ImagePullBackOff Failed to pull image: unauthorized\n' }, sinceArgs);
  assert.match(r.kql, /datetime\(2026-09-30T20:47:00Z\)/, r.kql);
  assert.match(r.kql, /ContainerAppSystemLogs_CL/);
  assert.equal(r.rc, 11, r.out);
});

test('DIAGNOSE: the system-log query excludes the stale revision by name', { skip: !bashAvailable }, () => {
  // Breaks if: the query stops carrying the stale revision's name (the
  // where-clause exclusion added at containerapp-revision-check.sh's
  // system_log_since would silently stop firing, and a revision that keeps
  // writing system-log rows after --since -- the measured incident shape --
  // could again drive this deploy's classification).
  const r = runRevCheck('diagnose', { ...OLD_REV }, sinceArgs);
  assert.match(r.kql, /where RevisionName_s != 'loom-unity--0000008'/, r.kql);
  assert.equal(r.rc, 16, r.out);
});

test('DIAGNOSE: Azure text is printed inside a stop-commands block', { skip: !bashAvailable }, () => {
  // Breaks if: the revision JSON is printed unwrapped.
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: '{"name":"x"}\n::error::INJECTED' }, sinceArgs);
  const lines = r.out.split('\n');
  const inj = lines.findIndex((l) => l.includes('INJECTED'));
  const start = lines.slice(0, inj).filter((l) => /^::stop-commands::[0-9a-f]{32}$/.test(l)).pop();
  assert.ok(start, `no stop-commands line before the injected line:\n${r.out}`);
  const tok = start.slice('::stop-commands::'.length);
  assert.ok(lines.findIndex((l, i) => i > inj && l === `::${tok}::`) > inj, 'the block must close after the injected line');
});

test('DIAGNOSE: GUIDs in the revision JSON are masked', { skip: !bashAvailable }, () => {
  // Breaks if: shield() stops masking GUIDs.
  const r = runRevCheck('diagnose', { ...NEW_REV, STUB_REV_JSON: `{"name":"x","provisioningError":"principal ${REV_GUID} denied"}` }, sinceArgs);
  assert.deepEqual(leakedIds(r.out), []);
  assert.match(r.out, /principal <guid> denied/);
});

test('WAIT: a revision that never reports Healthy FAILS (exit 1) and is diagnosed', { skip: !bashAvailable }, () => {
  // Breaks if: the wait falls through on timeout (the defect at the old :340-341).
  const r = runRevCheck('wait', { ...NEW_REV, STUB_HEALTH_SEQ: 'Unhealthy', STUB_REV_JSON: '{"name":"loom-unity--0000009"}' }, sinceArgs);
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /did not report Healthy after 3 reads/);
  assert.match(r.out, /UNCLASSIFIED|classified/);
});

test('WAIT: Healthy on the second read exits 0', { skip: !bashAvailable }, () => {
  const r = runRevCheck('wait', { STUB_HEALTH_SEQ: 'Unknown Healthy' });
  assert.equal(r.rc, 0, r.out);
});

test('WAIT: a failed read is REPORTED, not swallowed', { skip: !bashAvailable }, () => {
  // Breaks if: stderr of the health read is discarded again.
  const r = runRevCheck('wait', { ...NEW_REV, STUB_LATEST: 'fail', STUB_REV_JSON: '{"name":"x"}' }, sinceArgs);
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /::warning::loom-unity health read 1\/3: the latest revision name could not be read \(az exit 1/);
});

// ── the workflow ─────────────────────────────────────────────────────────────

function wfText() { return readFileSync(WF, 'utf8'); }
function deployStep() {
  const lines = wfText().split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith('- name: Deploy the OSS Unity Catalog Container App'));
  assert.ok(start >= 0, 'deploy step not found');
  const end = lines.findIndex((l, i) => i > start && /^ {6}- name:/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

test('WORKFLOW: the pull identity is ensured BEFORE the deployment; no fallback; old swallowing code gone', () => {
  // Breaks if: the ensure call moves after the deploy, a fallback identity is passed,
  // or a 2>/dev/null / || true / the old loop returns.
  const s = deployStep();
  const ensureAt = s.indexOf('scripts/csa-loom/ensure-acr-pull-identity.sh');
  const callAt = s.indexOf('deploy_unity 2>');
  assert.ok(ensureAt > 0 && callAt > 0 && s.includes('az deployment group create'), 'ensure call, deployment and deploy call must all be present');
  assert.ok(ensureAt < callAt, 'the pull identity must be ensured before the deployment runs');
  assert.doesNotMatch(s, /--fallback-uami-id/);
  assert.doesNotMatch(s, /2>\/dev\/null/);
  assert.doesNotMatch(s, /\|\| true/);
  assert.doesNotMatch(s, /for i in \$\(seq 1 20\)/);
  assert.ok(s.indexOf('containerapp-revision-check.sh wait') > callAt, 'the health wait must follow the deployment');
  assert.ok(s.indexOf('DEPLOY_START=') < s.indexOf('DEPLOY_ATTEMPT=1'), 'the deploy start is taken before the first attempt');
  assert.match(s, /diagnose --app "\$UNITY_APP" --rg "\$RG" \\\n\s+--since "\$DEPLOY_START"/);
});

test('WORKFLOW: the ensure call has no fallback chained after it, and the deploy step never reads $UAMI_ID directly', () => {
  // Breaks if: a `||`, `;` or `&&` is appended after --out "$PULL_OUT" (the M8
  // shape measured against this PR: a fallback stitched onto the ensure call
  // that reintroduces the Console identity whenever the check fails), or the
  // deploy step reads the Console identity's $UAMI_ID instead of the sed -n
  // read of $PULL_OUT. The earlier "no fallback" assertion only checked for the
  // round-1 flag name `--fallback-uami-id` and could not see either shape.
  const lines = deployStep().split('\n').map((l) => l.trim());
  const ensureAt = lines.findIndex((l) => l.startsWith('bash scripts/csa-loom/ensure-acr-pull-identity.sh'));
  assert.ok(ensureAt >= 0, 'ensure call not found');
  assert.match(lines[ensureAt + 1], /--out "\$PULL_OUT"$/, `the command must end at --out "$PULL_OUT":\n${lines[ensureAt + 1]}`);
  const assigns = lines.filter((l) => l.startsWith('UNITY_UAMI_ID='));
  assert.equal(assigns.length, 1, `UNITY_UAMI_ID must be assigned exactly once:\n${assigns.join('\n')}`);
  assert.equal(assigns[0], `UNITY_UAMI_ID=$(sed -n 's/^UAMI_ID=//p' "$PULL_OUT")`);
  // Breaks if: the bash-level reference `$UAMI_ID` / `${UAMI_ID` reappears
  // (direct read of the Console identity), OR a GitHub Actions EXPRESSION
  // reappears anywhere in the step -- `${{ env.UAMI_ID }}` in the run script
  // itself, or in a step-level `env:` mapping such as
  // `UNITY_UAMI_ID: ${{ env.UAMI_ID }}` -- since both are a fallback to the
  // Console identity that the bash-only check cannot see (GH Actions
  // substitutes `${{ }}` before the shell ever runs). `\bUAMI_ID\b` does not
  // match inside `UNITY_UAMI_ID`/`UNITY_UAMI_CLIENT_ID` (no word boundary
  // before "UAMI_ID" when it is preceded by "UNITY_", since `_` is a word
  // character), so neither check flags this test's own pinned assignments.
  const nonComment = lines.filter((l) => !l.startsWith('#'));
  const directRef = /\$\{?UAMI_ID\b/;
  const expressionRef = /\$\{\{[^}]*\bUAMI_ID\b[^}]*\}\}/;
  assert.ok(nonComment.every((l) => !directRef.test(l)), 'the deploy step must not reference the Console identity $UAMI_ID directly');
  assert.ok(nonComment.every((l) => !expressionRef.test(l)), 'the deploy step must not reference the Console identity via a ${{ ... UAMI_ID ... }} expression (run script or step env:)');
  // Breaks if: the bicep deployment is pointed at the Console identity (or
  // anything but the pull-identity-ensure output) by editing either
  // parameter's value instead of the variable name.
  const unityUamiParam = lines.filter((l) => l.startsWith('unityUamiId='));
  const unityUamiClientParam = lines.filter((l) => l.startsWith('unityUamiClientId='));
  assert.equal(unityUamiParam.length, 1, `unityUamiId= must appear exactly once:\n${unityUamiParam.join('\n')}`);
  assert.equal(unityUamiClientParam.length, 1, `unityUamiClientId= must appear exactly once:\n${unityUamiClientParam.join('\n')}`);
  assert.match(unityUamiParam[0], /^unityUamiId="\$UNITY_UAMI_ID"/, unityUamiParam[0]);
  assert.match(unityUamiClientParam[0], /^unityUamiClientId="\$UNITY_UAMI_CLIENT_ID"/, unityUamiClientParam[0]);
});

test('WORKFLOW: the discovery notice prints names, not resource ids', () => {
  // Breaks if: the notice interpolates the full CAE or UAMI resource id (it carries the subscription id).
  const line = wfText().split(/\r?\n/).find((l) => l.includes('::notice::CAE='));
  assert.ok(line, 'discovery notice not found');
  assert.match(line, /\$\{CAE_ID##\*\/\}/);
  assert.match(line, /\$\{UAMI_ID##\*\/\}/);
});

function runDeployLoop({ deployRcs, diagRcs, deployStderr = 'deploy error' }) {
  const body = deployStep().split('\n').map((l) => l.replace(/^ {10}/, ''));
  const a = body.findIndex((l) => l.startsWith('DEPLOY_ATTEMPT=1'));
  const b = body.findIndex((l, i) => i > a && l === 'done');
  assert.ok(a > 0 && b > a, 'deploy loop not found in the workflow');
  const dir = mkdtempSync(join(tmpdir(), 'deployloop-'));
  mkdirSync(join(dir, 'scripts', 'csa-loom'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'csa-loom', 'containerapp-revision-check.sh'), `#!/usr/bin/env bash
n=$(cat "${dir}/diags" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/diags"
printf '%s\\n' "$*" >> "${dir}/diagargs"
read -r -a rcs <<< "${diagRcs}"; i=$((n - 1)); [ "$i" -lt "\${#rcs[@]}" ] || i=$((\${#rcs[@]} - 1))
exit "\${rcs[$i]}"
`);
  const driver = `set -euo pipefail
sleep() { :; }
deploy_unity() {
  n=$(cat "${dir}/deploys" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/deploys"
  read -r -a rcs <<< "${deployRcs}"; i=$((n - 1)); [ "$i" -lt "\${#rcs[@]}" ] || i=$((\${#rcs[@]} - 1))
  echo "${deployStderr} $n" >&2
  return "\${rcs[$i]}"
}
UNITY_APP=loom-unity RG=rg ACR=acrx UNITY_UAMI_NAME=uami DEPLOY_START=2026-09-30T20:47:00 DIAG_HINT=hint
${body.slice(a, b + 1).join('\n')}
echo LOOP_DONE
`;
  const r = spawnSync('bash', ['-c', driver], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  const read = (f) => (existsSync(join(dir, f)) ? Number(readFileSync(join(dir, f), 'utf8')) : 0);
  const diagArgs = existsSync(join(dir, 'diagargs'))
    ? readFileSync(join(dir, 'diagargs'), 'utf8').split('\n').filter((l) => l !== '') : [];
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, deploys: read('deploys'), diags: read('diags'), diagArgs, timedOut: r.error?.code === 'ETIMEDOUT' };
}

test('DEPLOY LOOP: an in-progress conflict (class 10) is retried ONCE, then succeeds', { skip: !bashAvailable }, () => {
  const r = runDeployLoop({ deployRcs: '1 0', diagRcs: '10' });
  assert.equal(r.timedOut, false);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.deploys, 2);
});

test('DEPLOY LOOP: a second in-progress conflict is NOT retried again (bounded)', { skip: !bashAvailable }, () => {
  // Breaks if: the attempt bound is removed (the loop would run until the 15 s timeout).
  const r = runDeployLoop({ deployRcs: '1', diagRcs: '10' });
  assert.equal(r.timedOut, false, 'the retry loop must be bounded');
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.deploys, 2);
  // Breaks if: the loop stops passing --attempt (or --since) to diagnose. Diagnose would then
  // treat the second in-progress conflict as attempt 1 and call it retryable, so its message
  // would claim a retry the loop never makes.
  assert.equal(r.diagArgs.length, 2, r.diagArgs.join(' | '));
  assert.match(r.diagArgs[0], /--since 2026-09-30T20:47:00 --attempt 1(\s|$)/);
  assert.match(r.diagArgs[1], /--attempt 2(\s|$)/);
});

test('DEPLOY LOOP: any other class fails at once, without a retry', { skip: !bashAvailable }, () => {
  // Breaks if: every failure is retried (deploys would be 2).
  const r = runDeployLoop({ deployRcs: '1', diagRcs: '11' });
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.deploys, 1);
  assert.equal(r.diags, 1);
  assert.match(r.out, /loom-unity deployment failed \(az exit 1, attempt 1\)/);
});

test('DEPLOY LOOP: a success is not diagnosed, and its stderr is printed as a framed warning', { skip: !bashAvailable }, () => {
  // Breaks if: stderr of a successful deployment is dropped again, or printed unframed.
  const r = runDeployLoop({ deployRcs: '0', diagRcs: '16', deployStderr: 'WARNING: bicep linter note' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.deploys, 1);
  assert.equal(r.diags, 0);
  assert.match(r.out, /::warning::the loom-unity deployment succeeded and wrote to stderr/);
  const lines = r.out.split('\n');
  const at = lines.findIndex((l) => l.includes('bicep linter note'));
  assert.ok(at > 0 && /^::stop-commands::[0-9a-f]{32}$/.test(lines[at - 1]), `stderr must be inside a block:\n${r.out}`);
});

test('HARNESS: bash must be present wherever CI runs this, or most cases silently skip', () => {
  assert.ok(bashAvailable || !process.env.CI, 'bash is required in CI');
});
