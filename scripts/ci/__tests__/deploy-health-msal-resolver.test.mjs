// deploy-health.yml must resolve the estate's MSAL client id before it applies
// (check-msal-resolver-before-deploy.mjs, #4224). The real guard is run against a
// SANDBOX git repo holding copies of the real workflow, so the tracked tree is never
// mutated (assertion-design.md: mutate a copy, not the tracked tree).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'deploy-health.yml');
const GUARD = join(ROOT, 'scripts', 'ci', 'check-msal-resolver-before-deploy.mjs');
const RESOLVER = 'resolve-msal-client-id.sh';

/** Build a sandbox repo with the real guard, real param files and the given workflow text; run the guard in it. */
function runGuardOn(workflowText) {
  const dir = mkdtempSync(join(tmpdir(), 'msal-resolver-'));
  const put = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
  };
  for (const f of ['commercial.bicepparam', 'gcc-high.bicepparam']) {
    const rel = join('platform', 'fiab', 'bicep', 'params', f);
    mkdirSync(join(dir, 'platform', 'fiab', 'bicep', 'params'), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  mkdirSync(join(dir, 'scripts', 'ci'), { recursive: true });
  copyFileSync(GUARD, join(dir, 'scripts', 'ci', 'check-msal-resolver-before-deploy.mjs'));
  copyFileSync(join(ROOT, 'scripts', 'ci', '_logical-lines.mjs'), join(dir, 'scripts', 'ci', '_logical-lines.mjs'));
  put(join('.github', 'workflows', 'deploy-health.yml'), workflowText);
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', '-A').status, 0);
  return spawnSync(process.execPath, [join('scripts', 'ci', 'check-msal-resolver-before-deploy.mjs')], { cwd: dir, encoding: 'utf8' });
}

test('deploy-health: the real workflow passes the guard in the sandbox (positive control)', () => {
  const real = readFileSync(WORKFLOW, 'utf8');
  assert.ok(real.includes(RESOLVER), 'the workflow must invoke the resolver');
  const r = runGuardOn(real);
  assert.equal(r.status, 0, `guard should pass the real workflow: ${r.stdout}${r.stderr}`);
});

test('deploy-health: removing the resolver step turns the guard RED, naming deploy-health.yml', () => {
  // FAILS IF: the resolver invocation is dropped. Input that breaks it: the same workflow with
  // every `resolve-msal-client-id.sh` renamed, so the apply (`az deployment sub create`) runs
  // against a params file reading LOOM_MSAL_CLIENT_ID with nothing resolving it first.
  const real = readFileSync(WORKFLOW, 'utf8');
  const mutated = real.split(RESOLVER).join('resolve-something-else.sh');
  assert.notEqual(mutated, real, 'the mutation changed nothing, so this test would witness nothing');
  const r = runGuardOn(mutated);
  assert.equal(r.status, 1, `guard must fail without the resolver: ${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /deploy-health\.yml[^\n]*never invokes resolve-msal-client-id\.sh/);
});
