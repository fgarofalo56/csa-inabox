/**
 * Lease-release flow of the two ACR-building provision scripts (#4827).
 *
 * THE DEFECT THIS PINS. `provision-gh-runner.sh` and `deploy-loom-uat-job.sh`
 * each had ONE cleanup function that ended in `exit "$rc"` and was used both as
 * the EXIT trap AND called inline at the "release the lease" step. Inline, `rc`
 * was `$?` of the preceding `echo`, i.e. 0 -- so the script exited 0 right
 * there:
 *   - a FAILED runner-image build reported success with no FATAL (provision
 *     captured the build's rc, then never reached the check);
 *   - a SUCCESSFUL build never reached the job create/update (provision step 3,
 *     uat steps 4-5). shellcheck flagged all of it as unreachable (SC2317).
 *
 * HOW THIS TESTS IT. The REAL scripts are copied into a throwaway repo layout
 * next to a STUB `acr-firewall-lease.sh`, and driven with a STUB `az` first on
 * PATH. Both stubs record every invocation, so the assertions check what was
 * actually called -- not what the script printed about it. Every value is a
 * fixture; nothing here is a credential, and the real `az` is never reached
 * (the `acr build` call-log assertion in each case is the positive control: if
 * the stub were not first on PATH, it would be empty).
 *
 * WHAT BREAKS EACH ASSERTION (assertion-design.md):
 *   - reverting either helper to `exit "$rc"` (the #4827 defect): the
 *     build-ok cases see exit 0 with NO `containerapp job create`, and the
 *     build-fail provision case sees exit 0 instead of 7 with no FATAL;
 *   - dropping `trap - EXIT` after the verified release: the release count
 *     goes from 1 to 2;
 *   - dropping the `build_rc` check: the build-fail cases run the job create;
 *   - building `gh-aca-runner` again (round-5 image-name fix): the
 *     `--image gh-actions-runner:` assertions.
 *
 * NOT COVERED, disclosed: the provision script's trap-only path (a signal
 * between acquire and step 2) has no reachable failing command to drive it; the
 * uat trap-only path IS driven (a missing .dockerignore fails `cp` under set -e).
 *
 * Run: node --test scripts/ci/__tests__/provision-scripts-release-flow.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSA_LOOM = resolve(HERE, '..', '..', 'csa-loom');
const PROVISION = 'provision-gh-runner.sh';
const UAT = 'deploy-loom-uat-job.sh';

const DOCKERIGNORE = 'node_modules\ne2e\ntests\n.next\n';

// Records `$1` of every lease call; `release` exits $STUB_RELEASE_RC.
const LEASE_STUB = `#!/usr/bin/env bash
echo "$1" >> "$STUB_LOG_DIR/lease.log"
if [ "$1" = "release" ]; then exit "\${STUB_RELEASE_RC:-0}"; fi
exit 0
`;

// Records every az call. `acr build` exits $STUB_BUILD_RC (and snapshots the
// .dockerignore the build saw); `containerapp job show` says "not found" so the
// scripts take the CREATE path; the reads return fixture scalars.
const AZ_STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG_DIR/az.log"
case "$1 $2" in
  "acr build")
    if [ -f .dockerignore ]; then cp .dockerignore "$STUB_LOG_DIR/build-dockerignore.txt"; fi
    exit "\${STUB_BUILD_RC:-0}" ;;
esac
case "$1 $2 $3" in
  "containerapp job show") exit 1 ;;
  "containerapp env show") echo "/subscriptions/fixture/resourceGroups/rg-fixture/providers/Microsoft.App/managedEnvironments/cae-fixture"; exit 0 ;;
  "containerapp secret show") echo "fixture-session-value"; exit 0 ;;
esac
exit 0
`;

/**
 * Run one of the two scripts in a fresh sandbox.
 * @param {string} script  PROVISION or UAT
 * @param {object} [o]
 * @param {number} [o.buildRc]    exit code of the stub `az acr build`
 * @param {number} [o.releaseRc]  exit code of every stub lease `release`
 * @param {boolean} [o.dropDockerignore]  delete apps/fiab-console/.dockerignore
 */
function run(script, { buildRc = 0, releaseRc = 0, dropDockerignore = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'provflow-'));
  const scripts = join(root, 'scripts', 'csa-loom');
  const bin = join(root, 'bin');
  const logs = join(root, 'logs');
  const app = join(root, 'apps', 'fiab-console');
  for (const d of [scripts, bin, logs, app, join(root, 'platform', 'runners', 'github-actions')]) {
    mkdirSync(d, { recursive: true });
  }
  copyFileSync(join(CSA_LOOM, script), join(scripts, script));
  writeFileSync(join(scripts, 'acr-firewall-lease.sh'), LEASE_STUB);
  writeFileSync(join(bin, 'az'), AZ_STUB);
  chmodSync(join(bin, 'az'), 0o755);
  if (!dropDockerignore) writeFileSync(join(app, '.dockerignore'), DOCKERIGNORE);

  // PATH is prepended INSIDE bash, from the driver's own location, so the stub
  // wins on both POSIX and Git Bash without translating a Windows path.
  writeFileSync(
    join(root, 'drive.sh'),
    `#!/usr/bin/env bash
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HERE/bin:$PATH"
export STUB_LOG_DIR="$HERE/logs"
exec bash "$HERE/scripts/csa-loom/${script}"
`,
  );

  const env = { ...process.env };
  // Nothing from the caller's shell may steer the scripts.
  for (const k of [
    'KEYVAULT_NAME', 'PAT_SECRET_NAME', 'RUNNER_VERSION', 'RUNNER_SHA256', 'IMAGE_REPO',
    'IMAGE_TAG', 'JOB_NAME', 'UAT_GREP', 'UAT_GREP_INVERT', 'LOOM_UAT_RESULTS_CONTAINER',
    'LOOM_UAT_RESULTS_ACCOUNT', 'LOOM_UAMI_CLIENT_ID',
  ]) delete env[k];
  Object.assign(env, {
    STUB_BUILD_RC: String(buildRc),
    STUB_RELEASE_RC: String(releaseRc),
    // Fixtures only. The provision script requires SOME PAT to proceed.
    GITHUB_PAT: 'fixture-not-a-token',
    SUB: '00000000-0000-0000-0000-000000000000',
    ACR: 'acrfixture.azurecr.io',
    CONSOLE_UAMI_ID: '/subscriptions/fixture/resourceGroups/rg-fixture/providers/Microsoft.ManagedIdentity/userAssignedIdentities/uami-fixture',
    LOOM_URL: 'https://loom.fixture.invalid',
    LOOM_AUTOMATION_OID: '11111111-1111-1111-1111-111111111111',
  });

  const r = spawnSync('bash', [join(root, 'drive.sh')], { encoding: 'utf8', env, timeout: 60_000 });
  const read = (f) => (existsSync(join(logs, f)) ? readFileSync(join(logs, f), 'utf8') : '');
  const lease = read('lease.log').split('\n').filter(Boolean);
  const result = {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    az: read('az.log'),
    releases: lease.filter((l) => l === 'release').length,
    acquires: lease.filter((l) => l === 'acquire').length,
    buildDockerignore: read('build-dockerignore.txt'),
    dockerignoreAfter: existsSync(join(app, '.dockerignore')) ? readFileSync(join(app, '.dockerignore'), 'utf8') : null,
    bakLeft: existsSync(join(app, '.dockerignore.bak')),
  };
  rmSync(root, { recursive: true, force: true });
  return result;
}

const why = (r) => `exit=${r.status}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}\n--- az\n${r.az}`;

// ── provision-gh-runner.sh ──────────────────────────────────────────────────

test('provision: build OK -> step 3 runs and CREATES the job; lease released exactly once', () => {
  const r = run(PROVISION);
  assert.equal(r.status, 0, why(r));
  assert.match(r.az, /^acr build /m, 'positive control: the stub az was the one called');
  assert.match(r.stdout, /3\/3 Deploying event-driven job 'gh-aca-runner'/, why(r));
  // #4827: with the old `exit "$rc"` helper this line is never reached.
  assert.match(r.az, /^containerapp job create --name gh-aca-runner /m, why(r));
  assert.equal(r.acquires, 1);
  // 2 here = the EXIT trap was not cleared after the verified inline release.
  assert.equal(r.releases, 1, 'released inline once; the trap must be cleared after it');
});

test('provision: builds and deploys the image REPOSITORY the live job pulls (gh-actions-runner)', () => {
  // Round 5: the live job gh-aca-runner runs gh-actions-runner:ci-*; the
  // script used to build gh-aca-runner:<tag>.
  const r = run(PROVISION);
  assert.equal(r.status, 0, why(r));
  assert.match(r.az, /^acr build .*--image gh-actions-runner:latest /m, why(r));
  assert.match(r.az, /^containerapp job create .*--image acrfixture\.azurecr\.io\/gh-actions-runner:latest /m, why(r));
  assert.doesNotMatch(r.az, /--image (\S+\/)?gh-aca-runner:/, 'the job NAME is not the image repository');
});

test('provision: build FAILS -> exits with the build rc and a FATAL naming step 1/3; job untouched', () => {
  const r = run(PROVISION, { buildRc: 7 });
  // #4827: the old code exited 0 here with no FATAL.
  assert.equal(r.status, 7, why(r));
  assert.match(r.stderr, /\[FATAL\] step 1\/3: az acr build of gh-actions-runner:latest exited 7\./, why(r));
  assert.match(r.az, /^acr build /m, 'positive control: the build was attempted');
  assert.doesNotMatch(r.az, /^containerapp /m, 'no job create/update after a failed build');
  assert.equal(r.releases, 1, 'the registry is still re-locked on a failed build');
});

test('provision: release UNVERIFIED -> FATAL naming step 2/3, non-zero, job untouched, trap retries once', () => {
  const r = run(PROVISION, { releaseRc: 1 });
  assert.equal(r.status, 1, why(r));
  assert.match(r.stderr, /\[FATAL\] step 2\/3: the ACR firewall lease release could not verify acrfixture re-locked \(build rc=0\)/, why(r));
  assert.match(r.az, /^acr build /m, 'positive control: the build ran first');
  assert.doesNotMatch(r.az, /^containerapp /m, 'never deploy over an unverified re-lock');
  // inline attempt + the still-armed EXIT trap's retry
  assert.equal(r.releases, 2, why(r));
});

// ── deploy-loom-uat-job.sh ──────────────────────────────────────────────────

test('uat: build OK -> steps 4-5 run (job create + session-secret); .dockerignore restored; released once', () => {
  const r = run(UAT);
  assert.equal(r.status, 0, why(r));
  assert.match(r.az, /^acr build /m, 'positive control: the stub az was the one called');
  // #4827: with the old `exit "$rc"` cleanup, the script exited 0 at step 3.
  assert.match(r.az, /^containerapp job create -n loom-uat /m, why(r));
  assert.match(r.az, /^containerapp job secret set -n loom-uat /m, why(r));
  assert.match(r.stdout, /loom-uat job deployed successfully/, why(r));
  assert.equal(r.releases, 1, 'released inline once; the trap must be cleared after it');
  // The build saw the e2e/tests exclusions dropped, and the file is restored.
  assert.ok(r.buildDockerignore.includes('node_modules'), `build saw: ${JSON.stringify(r.buildDockerignore)}`);
  assert.doesNotMatch(r.buildDockerignore, /^(e2e|tests)$/m);
  assert.equal(r.dockerignoreAfter, DOCKERIGNORE);
  assert.equal(r.bakLeft, false);
});

test('uat: build FAILS -> exits with the build rc and a FATAL naming step 2/5; job untouched; .dockerignore restored', () => {
  const r = run(UAT, { buildRc: 5 });
  assert.equal(r.status, 5, why(r));
  assert.match(r.stderr, /\[FATAL\] step 2\/5: az acr build of loom-uat:latest exited 5\./, why(r));
  assert.match(r.az, /^acr build /m, 'positive control: the build was attempted');
  assert.doesNotMatch(r.az, /^containerapp /m, 'no job create/update after a failed build');
  assert.equal(r.releases, 1);
  assert.equal(r.dockerignoreAfter, DOCKERIGNORE);
  assert.equal(r.bakLeft, false);
});

test('uat: release UNVERIFIED -> FATAL naming step 3/5, non-zero, job untouched', () => {
  const r = run(UAT, { releaseRc: 1 });
  assert.equal(r.status, 1, why(r));
  assert.match(r.stderr, /\[FATAL\] step 3\/5: the ACR firewall lease release could not verify acrfixture re-locked \(build rc=0\)/, why(r));
  assert.match(r.az, /^acr build /m, 'positive control: the build ran first');
  assert.doesNotMatch(r.az, /^containerapp /m, 'never deploy over an unverified re-lock');
  assert.equal(r.releases, 2, why(r));
});

test('uat: failure BEFORE the build (trap-only path) still releases the lease and exits non-zero', () => {
  // No .dockerignore -> `cp` fails under set -e between acquire and build.
  const r = run(UAT, { dropDockerignore: true });
  assert.notEqual(r.status, 0, why(r));
  assert.equal(r.acquires, 1, 'positive control: the lease was taken before the failure');
  assert.equal(r.releases, 1, 'the EXIT trap must still release it');
  assert.doesNotMatch(r.az, /^acr build /m, 'the failure happened before the build');
});
