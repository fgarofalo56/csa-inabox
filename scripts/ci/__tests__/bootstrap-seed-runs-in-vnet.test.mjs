/**
 * The automation-identity grant seed must run on the IN-VNET runner (#5360).
 *
 * The Loom Cosmos account is publicNetworkAccess=Disabled, so the seed's data-plane
 * call is refused with HTTP 403 ("blocked by your Cosmos DB account firewall
 * settings") from a public ubuntu-latest runner (bootstrap run 44239837032).
 *
 * Every assertion names the value that would turn it red (assertion-design.md). The
 * defect is exercised against the REAL workflow text, mutated IN MEMORY only: the
 * tracked workflow is never written.
 *
 * Run: node --test scripts/ci/__tests__/bootstrap-seed-runs-in-vnet.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// BOOTSTRAP_WORKFLOW_PATH lets the defect (the pre-fix workflow) be fed in from a sandbox copy.
const WORKFLOW = process.env.BOOTSTRAP_WORKFLOW_PATH || resolve(REPO, '.github/workflows/csa-loom-post-deploy-bootstrap.yml');
const SEED_SCRIPT = 'seed-automation-feature-grant.mjs';

/** Split the workflow into { jobName: bodyText } (jobs sit at two-space indent). */
function jobs(text) {
  const lf = text.replace(/\r\n/g, '\n');
  const at = lf.indexOf('\njobs:\n');
  assert.ok(at >= 0, 'workflow has no top-level `jobs:` key');
  const out = {};
  let name = null;
  for (const line of lf.slice(at + 7).split('\n')) {
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; continue; }
    if (name) out[name] += line + '\n';
  }
  return out;
}

/** The job whose EXECUTABLE lines run the seed script, and that job's `runs-on:` line. */
function seedJob(text) {
  const found = Object.entries(jobs(text)).filter(([, body]) =>
    body.split('\n').some((l) => l.includes(`node scripts/csa-loom/${SEED_SCRIPT}`) && !/^\s*#/.test(l)));
  return { names: found.map(([n]) => n), body: found[0]?.[1] ?? '' };
}
const runsOn = (body) => (/^ {4}runs-on:\s*(.*)$/m.exec(body) || [])[1] ?? '';

const real = readFileSync(WORKFLOW, 'utf8');

test('the seed script is executed by exactly ONE job, and it is not `bootstrap`', () => {
  const { names } = seedJob(real);
  // Breaks if the step is moved back into `bootstrap` (names = ['bootstrap']) or duplicated (2 names).
  assert.deepEqual(names, ['seed-automation-grant'], `seed runs in ${JSON.stringify(names)}`);
});

test('the seed job targets the in-VNet loom-aca runner on Commercial', () => {
  const { body } = seedJob(real);
  // Breaks if runs-on loses `loom-aca` (e.g. reverted to the CI_RUNNER/ubuntu-latest expression).
  assert.match(runsOn(body), /inputs\.boundary == 'Commercial' && fromJSON\('\["self-hosted","loom-aca"\]'\)/,
    `runs-on is: ${runsOn(body)}`);
});

test('the seed job keeps a non-Commercial fallback and states the parity gap', () => {
  const { body } = seedJob(real);
  // Breaks if the fallback arm (the CI_RUNNER expression) is deleted: Gov would then queue forever on a label with no runner.
  assert.match(runsOn(body), /\|\| fromJSON\(startsWith\(vars\.CI_RUNNER/);
  // Breaks if the disclosure is removed: a Gov 403 would read as a bad grant.
  assert.match(body, /Cloud-parity gap \(#5360\)/);
  assert.match(body, /\[ "\$BOUNDARY" != "Commercial" \]/);
});

test('the seed job depends on bootstrap, tolerates a failed bootstrap, and is not continue-on-error', () => {
  const { body } = seedJob(real);
  assert.match(body, /^ {4}needs: bootstrap$/m, 'job must wait for bootstrap (DLZ outputs)');
  assert.match(body, /!cancelled\(\) && needs\.bootstrap\.result != 'skipped'/);
  // Breaks if anyone adds continue-on-error: the job would report green over a failed seed.
  assert.doesNotMatch(body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /continue-on-error/);
  // Positive pair for the absence check above: the failing path really exits non-zero.
  assert.match(body, /seed-automation-feature-grant\.mjs \|\| fail "seed"/);
  assert.match(body, /^ {4}timeout-minutes: \d+$/m);
});

test('the seed job logs in with the same credential set as bootstrap, per boundary', () => {
  const j = jobs(real);
  for (const secret of ['AZURE_CLIENT_ID', 'AZURE_GCC_CLIENT_ID', 'AZURE_GOV_CLIENT_ID']) {
    // Breaks if a boundary's login step is dropped from the new job (it would run unauthenticated).
    assert.ok(j['seed-automation-grant'].includes(`secrets.${secret}`), `seed job lacks the ${secret} login`);
  }
});

test('MUTATION: the seed step back on the public-runner job is detected (the defect)', () => {
  // Move the real run line into the bootstrap job body, in memory only.
  const lf = real.replace(/\r\n/g, '\n');
  const line = `          node scripts/csa-loom/${SEED_SCRIPT} || fail "seed" "x"\n`;
  const stripped = lf.replace(/ {10}node scripts\/csa-loom\/seed-automation-feature-grant\.mjs \|\| fail[^\n]*\n/, '');
  assert.notEqual(stripped, lf, 'fixture did not remove the real seed run line - the mutation is blind');
  const mutated = stripped.replace('\n  seed-automation-grant:\n', `\n  bootstrap_tail_marker_unused:\n`)
    .replace('      - name: Restore Loom Key Vault private (verified)\n', `      - name: planted\n        run: |\n${line}      - name: Restore Loom Key Vault private (verified)\n`);
  const { names } = seedJob(mutated);
  assert.ok(names.includes('bootstrap'), `mutation not planted in bootstrap: ${JSON.stringify(names)}`);
  assert.notDeepEqual(names, ['seed-automation-grant'], 'the first test would NOT catch the seed back on the public runner');
  // And the runner assertion alone also fails against a ubuntu-latest runs-on.
  const hosted = lf.replace(/(seed-automation-grant:[\s\S]*?\n {4}runs-on:)[^\n]*/, `$1 \${{ fromJSON('["ubuntu-latest"]') }}`);
  assert.doesNotMatch(runsOn(seedJob(hosted).body), /loom-aca/, 'hosted mutation did not remove loom-aca');
});

test('the seed job re-discovers the DLZ in-job and never consumes the masked bootstrap output', () => {
  const { body } = seedJob(real);
  const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  // Breaks on the value `needs.bootstrap.outputs.dlz_sub` (or dlz_rg): bootstrap ::add-mask::s the
  // discovered subscription and GitHub redacts masked values from job outputs, so it is ALWAYS empty
  // and the seed would silently fall back to ADMIN_SUB.
  assert.doesNotMatch(code, /needs\.bootstrap\.outputs\.dlz_/);
  // Positive pair: discovery really runs in this job, before the seed step, and writes GITHUB_ENV.
  const disc = code.indexOf('resolve-dlz-coordinates.mjs');
  const seed = code.indexOf(`node scripts/csa-loom/${SEED_SCRIPT}`);
  assert.ok(disc >= 0 && disc < seed, `discovery at ${disc}, seed at ${seed}`);
  assert.match(code, /--github-env "\$GITHUB_ENV"/);
  // The bootstrap job must not keep a dead output of the same name.
  assert.doesNotMatch(jobs(real).bootstrap, /^ {4}outputs:/m);
});

test('MUTATION: consuming the masked output again is detected', () => {
  const lf = real.replace(/\r\n/g, '\n');
  const mutated = lf.replace(
    '          # DLZ_RG / DLZ_SUB come from',
    '          DLZ_SUB: ${{ needs.bootstrap.outputs.dlz_sub || env.ADMIN_SUB }}\n          # DLZ_RG / DLZ_SUB come from');
  assert.notEqual(mutated, lf, 'mutation did not apply - blind');
  const code = seedJob(mutated).body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.match(code, /needs\.bootstrap\.outputs\.dlz_sub/, 'the guard regex would not see the planted consumption');
});

test('the bootstrap Summary says the seed runs in the separate job', () => {
  // Breaks if the line is removed: a green Summary would read as if the seed had run in this job.
  assert.match(real, /NOT in this job - it runs in the separate seed-automation-grant job/);
});
