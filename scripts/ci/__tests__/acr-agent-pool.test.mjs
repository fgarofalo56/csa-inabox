/**
 * Self-test for scripts/ci/check-acr-agent-pool.mjs.
 *
 * The guard's value rests on ONE distinction that a naive `grep loombuild`
 * cannot make: a workflow that RUNS on the wedged pool versus a workflow that
 * merely NAMES it in prose. Every file carrying the #2706 fix is full of the
 * word — in comments recording the incident, in the `description:` for the
 * override input, and inside ::error:: strings that name it as the thing to
 * avoid. A guard that flagged those would fail on the fixed files, and the
 * obvious way to "fix" it would be deleting the explanation.
 *
 * So the fixtures below are VERBATIM EXCERPTS of the real workflows, not
 * invented YAML: the failing cases are the actual pre-fix bodies of
 * console-bluegreen-roll.yml and build-fiab-images-acr-tasks.yml as they stood
 * on origin/main, and the passing cases are the actual post-fix forms. A
 * fixture that modelled the checker instead of the tree would prove nothing —
 * the whole point is that these exact bytes shipped and were going to wedge.
 *
 * Run: node --test scripts/ci/__tests__/acr-agent-pool.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-acr-agent-pool.mjs');

/** Build a throwaway tree of .github/workflows/<name> files. */
function fixture(workflows) {
  const root = mkdtempSync(join(tmpdir(), 'loom-acr-pool-'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) {
    writeFileSync(join(root, '.github', 'workflows', name), body);
  }
  return root;
}

function run(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** Makes a workflow Gov-reachable the way the real ones are. */
const GOV_LOGIN = `      - name: Set Azure cloud to Gov
        run: az cloud set --name AzureUSGovernment
`;

/** VERBATIM from console-bluegreen-roll.yml @origin/main (lines ~160-178). */
const PREFIX_BLUEGREEN = `name: console-bluegreen-roll
on: workflow_dispatch
jobs:
  bluegreen:
    runs-on: ubuntu-latest
    steps:
${GOV_LOGIN}      - name: Build + push green image
        run: |
          az acr agentpool show -r "$ACR" -n loombuild -o none 2>/dev/null \\
            || az acr agentpool create -r "$ACR" -n loombuild --tier S3 -o none
          CNT=$(az acr agentpool show -r "$ACR" -n loombuild --query count -o tsv | tr -d '\\r')
          [ "\${CNT:-0}" -ge 1 ] || az acr agentpool update -r "$ACR" -n loombuild --count 1 -o none
          az acr build --registry "$ACR" --no-logs --agent-pool loombuild \\
            --image "loom-console:$SHA" --image "loom-console:latest" \\
            --file apps/fiab-console/Dockerfile \\
            apps/fiab-console
`;

/** VERBATIM from build-fiab-images-acr-tasks.yml @origin/main (lines ~372-377). */
const PREFIX_ACR_TASKS = `name: build-fiab-images-acr-tasks
on: workflow_dispatch
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${GOV_LOGIN}      - name: Build
        run: |
          POOL_ARGS=""
          if [ "\${{ matrix.name }}" = "loom-console" ]; then
            az acr agentpool show -r "$ACR" -n loombuild -o none 2>/dev/null \\
              || az acr agentpool create -r "$ACR" -n loombuild --tier S3 -o none
            POOL_ARGS="--agent-pool loombuild"
          fi
          az acr build --registry "$ACR" $POOL_ARGS --image "x:1" apps/fiab-console
`;

/** The post-fix form: variable pool, streaming logs, prose naming the wedge. */
const FIXED = `name: gov-console-roll
on:
  workflow_dispatch:
    inputs:
      agent_pool_name:
        description: 'ACR agent pool (#2706). Default loombuild2 — the ORIGINAL loombuild pool has a queue stuck in "being deleted".'
        default: 'loombuild2'
jobs:
  roll:
    runs-on: ubuntu-latest
    steps:
${GOV_LOGIN}      - name: Build
        run: |
          # #2706 — the loombuild queue is wedged; loombuild2 is the fresh name.
          POOL="\${POOL:-loombuild2}"
          echo "::error::do NOT retry on loombuild — re-dispatch with a fresh name"
          az acr agentpool show -r "$ACR" -n "$POOL" -o none 2>/dev/null \\
            || az acr agentpool create -r "$ACR" -n "$POOL" --tier S3 -o none
          az acr build --registry "$ACR" --agent-pool "$POOL" --image "x:1" apps/fiab-console
`;

test('the REAL pre-fix console-bluegreen body fails on both rules', () => {
  const r = run(fixture({ 'bg.yml': PREFIX_BLUEGREEN }));
  assert.equal(r.code, 1, 'the body that shipped must be rejected');
  assert.match(r.out, /R1-wedged-pool/, 'must name the wedged-pool rule');
  assert.match(r.out, /R2-silent-pool-build/, 'a --no-logs pool build must be caught');
});

test('the REAL pre-fix acr-tasks body fails on the wedged pool', () => {
  const r = run(fixture({ 'tasks.yml': PREFIX_ACR_TASKS }));
  assert.equal(r.code, 1);
  assert.match(r.out, /R1-wedged-pool/);
});

test('the post-fix form passes even though it says "loombuild" in prose', () => {
  const r = run(fixture({ 'roll.yml': FIXED }));
  assert.equal(r.code, 0, `prose mentions must not fail the guard:\n${r.out}`);
});

test('loombuild2 is not mistaken for the wedged loombuild', () => {
  const wf = `name: w
on: workflow_dispatch
jobs:
  b:
    steps:
${GOV_LOGIN}      - run: |
          az acr build --registry "$ACR" --agent-pool loombuild2 --image x:1 apps/a
`;
  const r = run(fixture({ 'w.yml': wf }));
  assert.equal(r.code, 0, `word-boundary match failed:\n${r.out}`);
});

test('a Commercial-only workflow may keep the loombuild pool', () => {
  // The wedge is a property of ONE queue on the GOV registry. Commercial's
  // loombuild is healthy and builds the same commit in ~15min, so scoping the
  // rule to Gov-reachable workflows is deliberate, not an oversight.
  const wf = `name: full-app-deploy-commercial
on: workflow_dispatch
jobs:
  b:
    steps:
      - run: |
          az acr build --registry "$ACR" --agent-pool loombuild --image x:1 apps/a
`;
  // Paired with a Gov builder so the self-check (zero Gov builders = FAIL) is satisfied.
  const r = run(fixture({ 'commercial.yml': wf, 'roll.yml': FIXED }));
  assert.equal(r.code, 0, `Commercial-only use must not be flagged:\n${r.out}`);
  assert.match(r.out, /commercial-only/);
});

test('--no-logs on a DEFAULT-agent Gov build is allowed', () => {
  // Eight Gov workflows do this today. A default-agent build cannot inherit a
  // wedged pool queue, so R2 is scoped to pool builds to stay a discriminator.
  const wf = `name: gov-provision-x
on: workflow_dispatch
jobs:
  b:
    steps:
${GOV_LOGIN}      - run: |
          az acr build --registry "$ACR" --no-logs --image x:1 apps/a
`;
  const r = run(fixture({ 'x.yml': wf }));
  assert.equal(r.code, 0, `default-agent --no-logs must be allowed:\n${r.out}`);
});

test('--agent-pool and --no-logs split across continued lines is still caught', () => {
  // The real invocations are backslash-continued across 4-5 physical lines. If
  // the checker judged lines independently, R2 could never fire on the actual
  // formatting — which is precisely the shape that shipped.
  const wf = `name: w
on: workflow_dispatch
jobs:
  b:
    steps:
${GOV_LOGIN}      - run: |
          az acr build --registry "$ACR" --agent-pool "$POOL" \\
            --image "loom-console:$SHA" \\
            --no-logs \\
            apps/fiab-console
`;
  const r = run(fixture({ 'w.yml': wf }));
  assert.equal(r.code, 1, `continuation joining is load-bearing:\n${r.out}`);
  assert.match(r.out, /R2-silent-pool-build/);
});

test('a tree with no Gov-reachable builder FAILS rather than passing vacuously', () => {
  // A scan that matches nothing must not report green — that is the
  // "gate that measures nothing" shape this repo keeps getting burned by.
  const r = run(fixture({ 'none.yml': 'name: n\non: push\njobs: {}\n' }));
  assert.equal(r.code, 1);
  assert.match(r.out, /ZERO Gov-reachable/);
});
