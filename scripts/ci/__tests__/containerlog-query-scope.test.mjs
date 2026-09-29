/**
 * check-containerlog-query-scope self-test (#4759).
 *
 * The guard exists so a ContainerAppConsoleLogs_CL query can only see the thing
 * it claims to measure. It was written knowing two of the three name columns and
 * rejected a Container App JOB query scoped by the job's own name,
 * `ContainerJobName_s` — the column a job row actually carries its job name in
 * (`ContainerAppName_s` is empty on job rows; measured, see the guard header).
 *
 * This drives the guard against throwaway workflow fixtures and pins BOTH
 * verdicts, so neither an over-strict nor an over-broad guard can hide:
 *   - the job-scoped fixtures go RED if `ContainerJobName_s` leaves `SCOPED`;
 *   - the unscoped fixtures go RED if the guard is loosened to accept any
 *     mention of the column (no operator), or `ContainerGroupName_s` alone.
 *
 * Run: node --test scripts/ci/__tests__/containerlog-query-scope.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '..', 'check-containerlog-query-scope.mjs');
const REPO = resolve(HERE, '..', '..', '..');

/** Run the guard with a throwaway repo root whose .github/workflows holds `yml`. */
function runOn(yml) {
  const dir = mkdtempSync(join(tmpdir(), 'clq-scope-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'fixture.yml'), yml);
    const r = spawnSync(process.execPath, [GUARD], { cwd: dir, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A one-step workflow whose run: body is `query` (a KQL string passed to az). */
const wf = (query) => `name: fixture
on: workflow_dispatch
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: q
        run: |
          RAW=$(az monitor log-analytics query -w "$WS" --analytics-query \\
            "${query}" \\
            --query "[0].Log_s" -o tsv)
`;

test('an UNSCOPED job query is flagged (exit 1, names the file)', () => {
  // FAILS IF the guard stops flagging a query that filters on log text only —
  // the exact shape that let a detector count its own output.
  const r = runOn(wf("ContainerAppConsoleLogs_CL | where Log_s contains 'UAT_RESULT' | take 1"));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /fixture\.yml:\d+ +ContainerAppConsoleLogs_CL query is not scoped/);
});

test('a job query scoped by ContainerJobName_s passes (exit 0)', () => {
  // FAILS IF `ContainerJobName_s` is dropped from SCOPED — what the guard was on
  // PR #4768's first head, where it went red on loom-synthetic-monitor.yml.
  const r = runOn(wf("ContainerAppConsoleLogs_CL | where ContainerJobName_s == 'loom-synthetic-monitor' | where Log_s contains 'UAT_RESULT' | take 1"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /check-containerlog-query-scope: OK/);
});

test("the synthetic monitor's real shape — job name + this execution's group — passes", () => {
  const r = runOn(wf("ContainerAppConsoleLogs_CL | where TimeGenerated > ago(2h) | where ContainerJobName_s == '$JOB_NAME' | where ContainerGroupName_s startswith '$EXEC-' | where Log_s has_any ('synthetic J') | project Log_s"));
  assert.equal(r.code, 0, r.out);
});

test('merely PROJECTING ContainerJobName_s is not a scope (exit 1)', () => {
  // FAILS IF the guard is loosened to accept the column name without a predicate
  // operator — a projection constrains nothing.
  const r = runOn(wf("ContainerAppConsoleLogs_CL | where Log_s contains 'UAT_RESULT' | project ContainerJobName_s, Log_s"));
  assert.equal(r.code, 1, r.out);
});

test('ContainerGroupName_s ALONE is not accepted (exit 1) — the guard was not widened to it', () => {
  // FAILS IF ContainerGroupName_s is added to SCOPED. It is deliberately not a
  // name predicate here: this PR extends the guard by exactly one column.
  const r = runOn(wf("ContainerAppConsoleLogs_CL | where ContainerGroupName_s startswith 'x-' | where Log_s contains 'UAT_RESULT'"));
  assert.equal(r.code, 1, r.out);
});

test('the pre-existing app and container-name scopes still pass', () => {
  // Paired positives: the extension must not have broken the two columns the
  // guard already accepted.
  assert.equal(runOn(wf("ContainerAppConsoleLogs_CL | where ContainerAppName_s == 'loom-console' | take 1")).code, 0);
  assert.equal(runOn(wf("ContainerAppConsoleLogs_CL | where ContainerName_s == 'uat' | take 1")).code, 0);
});

test('the tracked tree passes the guard', () => {
  // The real workflows, including loom-synthetic-monitor.yml's two job queries.
  const r = spawnSync(process.execPath, [GUARD], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
