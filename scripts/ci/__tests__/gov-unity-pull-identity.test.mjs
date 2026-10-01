/**
 * gov-uc-purview-wire: loom-unity pull identity, deploy classification, health.
 *
 * WHAT THIS PINS. On 2026-09-30 (run 36774518931) the loom-unity deploy chose
 * the dedicated `uami-loom-unity-<region>` as its registry pull identity
 * without checking that it could pull. It held no pull role on the Gov ACR, the
 * revision never started, ARM said only "Operation expired", the step printed
 * raw ARM JSON, and the health loop discarded stderr and never failed.
 *
 * HOW. The SHIPPED scripts are driven with a STUB `az` on PATH; the stub
 * records every call so assertions read what was actually invoked:
 *   - scripts/csa-loom/ensure-acr-pull-identity.sh   (choose / grant / fall back)
 *   - scripts/csa-loom/containerapp-revision-check.sh (wait, diagnose)
 * The deploy retry loop is EXTRACTED from the workflow at run time (never
 * transcribed) and run with a stub `deploy_unity` and a stub diagnose script.
 *
 * WHAT BREAKS EACH CASE is stated at the case. Mutation arms are run on sandbox
 * copies by pointing these env vars at them (the tracked files are untouched):
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
const FB_PID = '33333333-3333-4333-8333-333333333333';
const FB_CID = '44444444-4444-4444-8444-444444444444';
const SP_OID = '66666666-6666-4666-8666-666666666666';
const IDS = [SUB, PREF_PID, PREF_CID, FB_PID, FB_CID, SP_OID];
const FB_ID = `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-console-usgovvirginia`;

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
      ok) printf '%s\t%s\t%s\n' "/subscriptions/$SUB/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-unity-usgovvirginia" "$PREF_PID" "$PREF_CID" ;;
      notfound) echo "ERROR: (ResourceNotFound) The Resource 'Microsoft.ManagedIdentity/userAssignedIdentities/uami-loom-unity-usgovvirginia' under resource group 'rg' was not found." >&2; exit 3 ;;
      *) echo "ERROR: (InternalServerError) identity read failed" >&2; exit 1 ;;
    esac ;;
  "identity show --ids"*)
    [ "@{STUB_FB:-ok}" = ok ] || { echo "ERROR: (InternalServerError) fallback read failed" >&2; exit 1; }
    printf '%s\t%s\n' "$FB_PID" "$FB_CID" ;;
  "role assignment list"*)
    case "$a" in
      *"$PREF_PID"*)
        if [ -f "$STUB_DIR/granted" ]; then
          n=$(cnt reads_after_grant)
          if [ "$n" -ge "@{STUB_VISIBLE_AFTER:-1}" ]; then echo AcrPull; fi
          exit 0
        fi
        [ "@{STUB_PREF_ROLES:-}" = FAIL ] && { echo "ERROR: (AuthorizationFailed) cannot read role assignments" >&2; exit 1; }
        printf '%b' "@{STUB_PREF_ROLES:-}" ;;
      *"$FB_PID"*)
        [ "@{STUB_FB_ROLES:-}" = FAIL ] && { echo "ERROR: (AuthorizationFailed) cannot read role assignments" >&2; exit 1; }
        printf '%b' "@{STUB_FB_ROLES:-}" ;;
      *) echo "UNSTUBBED principal" >&2; exit 98 ;;
    esac ;;
  "role assignment create"*)
    case "@{STUB_GRANT:-ok}" in
      ok) touch "$STUB_DIR/granted" ;;
      exists) touch "$STUB_DIR/granted"; echo "ERROR: (RoleAssignmentExists) The role assignment already exists." >&2; exit 1 ;;
      authz) echo "ERROR: (AuthorizationFailed) The client 'deploy' with object id '$SP_OID' does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write' over scope '/subscriptions/$SUB/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acrx'" >&2; exit 1 ;;
      *) echo "ERROR: (InternalServerError) grant failed" >&2; exit 1 ;;
    esac ;;
  "containerapp revision list"*"[-1].{"*)
    [ "@{STUB_REVREAD:-ok}" = ok ] || { echo "ERROR: (InternalServerError) revision read failed" >&2; exit 1; }
    printf '%s\n' "@{STUB_REV_JSON:-null}" ;;
  "containerapp revision list"*"[-1].name"*) echo "loom-unity--0000009" ;;
  "containerapp replica list"*) printf '%s\n' "@{STUB_REPLICA_JSON:-[]}" ;;
  "containerapp show"*latestRevisionName*)
    [ "@{STUB_LATEST:-ok}" = ok ] || { echo "ERROR: (InternalServerError) app read failed" >&2; exit 1; }
    echo "loom-unity--0000009" ;;
  "containerapp revision show"*healthState*)
    n=$(cnt health_reads)
    read -r -a seq <<< "@{STUB_HEALTH_SEQ:-Healthy}"
    i=$((n - 1)); [ "$i" -lt "@{#seq[@]}" ] || i=$((@{#seq[@]} - 1))
    echo "@{seq[$i]}" ;;
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
    STUB_DIR: dir, SUB, PREF_PID, PREF_CID, FB_PID, FB_CID, SP_OID,
    LOOM_PULL_GRANT_POLL_ATTEMPTS: '4', LOOM_PULL_GRANT_POLL_SECONDS: '0', LOOM_PULL_GRANT_SETTLE_SECONDS: '0',
    LOOM_REVISION_WAIT_ATTEMPTS: '3', LOOM_REVISION_WAIT_SECONDS: '0',
    ...extra,
  };
}

function runEnsure(stub) {
  const dir = stubDir();
  const out = join(dir, 'out.env');
  const r = spawnSync('bash', [ENSURE, '--acr', 'acrx', '--rg', 'rg', '--preferred-uami', 'uami-loom-unity-usgovvirginia',
    '--fallback-uami-id', FB_ID, '--out', out], { encoding: 'utf8', env: baseEnv(dir, stub), timeout: 120000 });
  const calls = existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8') : '';
  const env = existsSync(out) ? readFileSync(out, 'utf8') : '';
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, calls, env };
}

function runRevCheck(cmd, stub, extraArgs = []) {
  const dir = stubDir();
  const r = spawnSync('bash', [REVCHECK, cmd, '--app', 'loom-unity', '--rg', 'rg', '--acr', 'acrx',
    '--identity-name', 'uami-loom-unity-usgovvirginia', ...extraArgs], { encoding: 'utf8', env: baseEnv(dir, stub), timeout: 120000 });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, dir };
}

const field = (env, k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
const noIds = (out) => IDS.filter((g) => out.includes(g));
const createCalls = (calls) => calls.split('\n').filter((l) => l.startsWith('role assignment create'));

// ── ensure-acr-pull-identity.sh ──────────────────────────────────────────────

test('HAS ROLE: the dedicated identity holds AcrPull -> chosen, NO grant', { skip: !bashAvailable }, () => {
  // Breaks if: the role check is skipped (a create call appears), or another identity is chosen.
  const r = runEnsure({ STUB_PREF_ROLES: 'Reader\nAcrPull\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'UAMI_NAME'), 'uami-loom-unity-usgovvirginia');
  assert.equal(field(r.env, 'UAMI_CLIENT_ID'), PREF_CID);
  assert.equal(field(r.env, 'GRANTED'), 'no');
  assert.equal(createCalls(r.calls).length, 0, `no grant expected; calls:\n${r.calls}`);
  assert.deepEqual(noIds(r.out), [], 'no principal/client/subscription id may be printed');
});

test('HAS ROLE: AcrPush counts as pull-capable and is named', { skip: !bashAvailable }, () => {
  // Breaks if: the pull-role set is narrowed to AcrPull only (a grant would be attempted).
  const r = runEnsure({ STUB_PREF_ROLES: 'AcrPush\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'PULL_ROLE'), 'AcrPush');
  assert.equal(createCalls(r.calls).length, 0);
});

test('LACKS ROLE + GRANT OK: grants AcrPull on the registry, waits until visible, then chooses the dedicated identity', { skip: !bashAvailable }, () => {
  // Breaks if: no grant is made, the grant uses another role/scope/assignee,
  // or the identity is chosen before the assignment is visible (STUB_VISIBLE_AFTER=2
  // means the first read after the grant still shows nothing).
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
  assert.equal(field(r.env, 'UAMI_NAME'), 'uami-loom-unity-usgovvirginia');
  assert.equal(field(r.env, 'GRANTED'), 'yes');
  assert.deepEqual(noIds(r.out), []);
});

test('LACKS ROLE + GRANT FAILS (no roleAssignments/write): falls back to the Console UAMI that can pull, and says why', { skip: !bashAvailable }, () => {
  // Breaks if: the authorization failure aborts instead of falling back, the
  // fallback is chosen without checking its role, or the notice hides the cause.
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'authz', STUB_FB_ROLES: 'AcrPull\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'UAMI_NAME'), 'uami-console-usgovvirginia');
  assert.equal(field(r.env, 'UAMI_CLIENT_ID'), FB_CID);
  assert.match(r.out, /::notice::loom-unity will pull with the Console UAMI uami-console-usgovvirginia \(role AcrPull/);
  assert.match(r.out, /lacks Microsoft\.Authorization\/roleAssignments\/write on registry acrx/);
  assert.deepEqual(noIds(r.out), [], 'the authorization error carries the deploy SP object id; it must not be printed');
});

test('NEITHER CAN PULL: fails closed with the role, scope and principal kind, and a command', { skip: !bashAvailable }, () => {
  // Breaks if: the script exits 0 (fail open), or the error omits the role/scope/kind.
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'authz', STUB_FB_ROLES: 'Reader\n' });
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.env, '', 'no identity may be written when none can pull');
  assert.match(r.out, /::error::No pull identity can pull from registry acrx/);
  assert.match(r.out, /AcrPull \(role definition 7f951dda-4ed3-4680-a7ca-43fe172d538d\) on registry acrx/);
  assert.match(r.out, /user-assigned managed identity uami-loom-unity-usgovvirginia \(principal type ServicePrincipal\)/);
  assert.match(r.out, /az role assignment create --assignee-object-id/);
  assert.deepEqual(noIds(r.out), []);
});

test('DEDICATED ABSENT: uses the Console UAMI when it can pull, and says the dedicated one does not exist', { skip: !bashAvailable }, () => {
  // Breaks if: a missing identity is treated as fatal, or the notice names the wrong cause.
  const r = runEnsure({ STUB_PREF: 'notfound', STUB_FB_ROLES: 'Contributor\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'UAMI_NAME'), 'uami-console-usgovvirginia');
  assert.match(r.out, /because the dedicated identity uami-loom-unity-usgovvirginia does not exist in rg/);
  assert.equal(createCalls(r.calls).length, 0);
});

test('ROLE READ FAILS: the answer is UNKNOWN, so no grant and exit 2 (never reported as "no role")', { skip: !bashAvailable }, () => {
  // Breaks if: a failed read is treated as "no role" (a grant would follow) or as success.
  const r = runEnsure({ STUB_PREF_ROLES: 'FAIL', STUB_FB_ROLES: 'FAIL' });
  assert.equal(r.rc, 2, r.out);
  assert.equal(createCalls(r.calls).length, 0, r.calls);
  assert.match(r.out, /could not be read/);
  assert.doesNotMatch(r.out, /holds no AcrPull/);
  assert.deepEqual(noIds(r.out), []);
});

test('GRANT NEVER VISIBLE: falls back rather than choosing an identity that is not shown to pull', { skip: !bashAvailable }, () => {
  // Breaks if: the dedicated identity is chosen after the poll runs out.
  const r = runEnsure({ STUB_PREF_ROLES: '', STUB_GRANT: 'ok', STUB_VISIBLE_AFTER: '99', STUB_FB_ROLES: 'AcrPull\n' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(field(r.env, 'UAMI_NAME'), 'uami-console-usgovvirginia');
  assert.match(r.out, /did not become visible after 4 reads/);
});

// ── containerapp-revision-check.sh ───────────────────────────────────────────

test('DIAGNOSE: an image pull refused for authorization is classified PERMISSION (11) with a remediation', { skip: !bashAvailable }, () => {
  // Breaks if: the pull+authorization signal is not read from the replica details.
  const r = runRevCheck('diagnose', {
    STUB_REV_JSON: '{"name":"loom-unity--0000009","provisioningError":"Operation expired"}',
    STUB_REPLICA_JSON: '[{"containers":[{"details":"ImagePullBackOff: failed to pull image: unauthorized: authentication required"}]}]',
  });
  assert.equal(r.rc, 11, r.out);
  assert.match(r.out, /classified PERMISSION/);
  assert.match(r.out, /--role AcrPull/);
});

test('DIAGNOSE: another operation in progress is classified RETRY (10)', { skip: !bashAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'deperr-'));
  const f = join(dir, 'err.txt');
  writeFileSync(f, 'ERROR: (ContainerAppOperationInProgress) Cannot modify a container app while another operation is in progress.\n');
  const r = runRevCheck('diagnose', { STUB_REV_JSON: '{"name":"loom-unity--0000009"}' }, ['--deploy-stderr', f]);
  assert.equal(r.rc, 10, r.out);
});

test('DIAGNOSE: a crash loop is classified IMAGE (14)', { skip: !bashAvailable }, () => {
  const r = runRevCheck('diagnose', {
    STUB_REV_JSON: '{"name":"loom-unity--0000009","runningDetails":"Back-off restarting failed container"}',
  });
  assert.equal(r.rc, 14, r.out);
  assert.match(r.out, /classified IMAGE/);
});

test('DIAGNOSE: "Operation expired" alone is UNCLASSIFIED (16), and says it does not establish a cause', { skip: !bashAvailable }, () => {
  // Breaks if: an expiry with no other signal is labelled as a specific cause.
  const r = runRevCheck('diagnose', { STUB_REV_JSON: '{"name":"loom-unity--0000009","provisioningError":"Operation expired"}' });
  assert.equal(r.rc, 16, r.out);
  assert.match(r.out, /does not say why/);
});

test('DIAGNOSE: Azure text is printed inside a stop-commands block', { skip: !bashAvailable }, () => {
  // Breaks if: the revision JSON is printed unwrapped (the injected line would be a live command).
  const r = runRevCheck('diagnose', { STUB_REV_JSON: '{"name":"x"}\n::error::INJECTED' });
  const lines = r.out.split('\n');
  const inj = lines.findIndex((l) => l.includes('INJECTED'));
  const start = lines.slice(0, inj).map((l, i) => [l, i]).filter(([l]) => /^::stop-commands::[0-9a-f]{32}$/.test(l)).pop();
  assert.ok(start, `no stop-commands line before the injected line:\n${r.out}`);
  const tok = start[0].slice('::stop-commands::'.length);
  const end = lines.findIndex((l, i) => i > inj && l === `::${tok}::`);
  assert.ok(end > inj, 'the block must close after the injected line');
});

test('WAIT: a revision that never reports Healthy FAILS (exit 1) and is diagnosed', { skip: !bashAvailable }, () => {
  // Breaks if: the wait falls through on timeout (the defect at the old :340-341).
  const r = runRevCheck('wait', { STUB_HEALTH_SEQ: 'Unhealthy', STUB_REV_JSON: '{"name":"loom-unity--0000009"}' });
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
  const r = runRevCheck('wait', { STUB_LATEST: 'fail', STUB_REV_JSON: '{"name":"x"}' });
  assert.equal(r.rc, 1, r.out);
  assert.match(r.out, /::warning::loom-unity health read 1\/3: the latest revision name could not be read \(az exit 1/);
});

// ── the workflow ─────────────────────────────────────────────────────────────

function deployStep() {
  const lines = readFileSync(WF, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith('- name: Deploy the OSS Unity Catalog Container App'));
  assert.ok(start >= 0, 'deploy step not found');
  const end = lines.findIndex((l, i) => i > start && /^ {6}- name:/.test(l));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}

test('WORKFLOW: the pull identity is ensured BEFORE the deployment, and the old swallowing code is gone', () => {
  // Breaks if: the ensure call moves after the deploy, or a 2>/dev/null / || true / the old loop returns.
  const s = deployStep();
  const ensureAt = s.indexOf('scripts/csa-loom/ensure-acr-pull-identity.sh');
  const createAt = s.indexOf('az deployment group create');
  const callAt = s.indexOf('deploy_unity 2>');
  assert.ok(ensureAt > 0 && createAt > 0 && callAt > 0, 'ensure call, deployment and deploy call must all be present');
  assert.ok(ensureAt < callAt, 'the pull identity must be ensured before the deployment runs');
  assert.doesNotMatch(s, /2>\/dev\/null/);
  assert.doesNotMatch(s, /\|\| true/);
  assert.doesNotMatch(s, /for i in \$\(seq 1 20\)/);
  assert.match(s, /containerapp-revision-check\.sh wait/);
  assert.ok(s.indexOf('containerapp-revision-check.sh wait') > callAt, 'the health wait must follow the deployment');
});

function runDeployLoop({ deployRcs, diagRcs }) {
  const s = deployStep();
  const body = s.split('\n').map((l) => l.replace(/^ {10}/, ''));
  const a = body.findIndex((l) => l.startsWith('DEPLOY_ATTEMPT=1'));
  const b = body.findIndex((l, i) => i > a && l === 'done');
  assert.ok(a > 0 && b > a, 'deploy loop not found in the workflow');
  const dir = mkdtempSync(join(tmpdir(), 'deployloop-'));
  mkdirSync(join(dir, 'scripts', 'csa-loom'), { recursive: true });
  const diag = join(dir, 'scripts', 'csa-loom', 'containerapp-revision-check.sh');
  writeFileSync(diag, `#!/usr/bin/env bash
n=$(cat "${dir}/diags" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/diags"
read -r -a rcs <<< "${diagRcs}"; i=$((n - 1)); [ "$i" -lt "\${#rcs[@]}" ] || i=$((\${#rcs[@]} - 1))
exit "\${rcs[$i]}"
`);
  const driver = `set -euo pipefail
sleep() { :; }
deploy_unity() {
  n=$(cat "${dir}/deploys" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${dir}/deploys"
  read -r -a rcs <<< "${deployRcs}"; i=$((n - 1)); [ "$i" -lt "\${#rcs[@]}" ] || i=$((\${#rcs[@]} - 1))
  echo "deploy error $n" >&2
  return "\${rcs[$i]}"
}
UNITY_APP=loom-unity RG=rg ACR=acrx UNITY_UAMI_NAME=uami
${body.slice(a, b + 1).join('\n')}
echo LOOP_DONE
`;
  const r = spawnSync('bash', ['-c', driver], { cwd: dir, encoding: 'utf8', timeout: 15000 });
  const read = (f) => (existsSync(join(dir, f)) ? Number(readFileSync(join(dir, f), 'utf8')) : 0);
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, deploys: read('deploys'), diags: read('diags'), timedOut: r.error?.code === 'ETIMEDOUT' };
}

test('DEPLOY LOOP: an in-progress conflict (class 10) is retried ONCE, then succeeds', { skip: !bashAvailable }, () => {
  const r = runDeployLoop({ deployRcs: '1 0', diagRcs: '10' });
  assert.equal(r.timedOut, false);
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.deploys, 2);
  assert.match(r.out, /LOOP_DONE/);
});

test('DEPLOY LOOP: a second in-progress conflict is NOT retried again (bounded)', { skip: !bashAvailable }, () => {
  // Breaks if: the attempt bound is removed (the loop would run until the timeout).
  const r = runDeployLoop({ deployRcs: '1', diagRcs: '10' });
  assert.equal(r.timedOut, false, 'the retry loop must be bounded');
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.deploys, 2);
});

test('DEPLOY LOOP: any other class fails at once, without a retry', { skip: !bashAvailable }, () => {
  // Breaks if: every failure is retried (deploys would be 2).
  const r = runDeployLoop({ deployRcs: '1', diagRcs: '11' });
  assert.equal(r.rc, 1, r.out);
  assert.equal(r.deploys, 1);
  assert.equal(r.diags, 1);
  assert.match(r.out, /loom-unity deployment failed \(az exit 1, attempt 1\)/);
});

test('DEPLOY LOOP: a successful deployment is not diagnosed', { skip: !bashAvailable }, () => {
  const r = runDeployLoop({ deployRcs: '0', diagRcs: '16' });
  assert.equal(r.rc, 0, r.out);
  assert.equal(r.deploys, 1);
  assert.equal(r.diags, 0);
});

test('HARNESS: bash must be present wherever CI runs this, or most cases silently skip', () => {
  assert.ok(bashAvailable || !process.env.CI, 'bash is required in CI');
});
