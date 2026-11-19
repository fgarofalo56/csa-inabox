/**
 * #5368 - scripts/csa-loom/seed-governance.sh must FAIL RED on a Cosmos data-plane
 * error. On bootstrap run 44256284701 all 7 upserts failed and each was a
 * `::warning::`, so the job went green over an empty governance surface.
 *
 * The script runs for real with a fake `az` first on PATH (no network). Each case
 * names the value that breaks it (assertion-design.md):
 *
 *  - restore the old `echo "::warning::..."` fallback in upsert() -> the 403 and 404
 *    cases go RED on `status !== 0`.
 *  - drop the 403 branch of report_failure() -> the 403 case goes RED (no HTTP 403 /
 *    container / role text).
 *  - make a conflict fatal -> the CONFLICT case goes RED (status !== 0).
 *  - revert the `done < <(...)` back to a pipe -> the domains-only 403 case goes RED
 *    (failure lost in the subshell, exit 0).
 *
 * Run: node --test scripts/ci/__tests__/seed-governance-fail-red.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.SEED_GOVERNANCE_SCRIPT ?? resolve(HERE, '..', '..', 'csa-loom', 'seed-governance.sh');

// Fake az. MODE is "<container>=<create-behaviour>[,...]"; behaviour:
//   ok        create succeeds
//   conflict  create -> 409 Conflict, replace succeeds
//   403 / 404 create fails with that error
// `az account set` always succeeds. Calls are appended to $AZ_LOG.
const FAKE_AZ = `#!/usr/bin/env bash
echo "$*" >> "$AZ_LOG"
[ "$1" = "account" ] && exit 0
op="$5"; cont=""
while [ $# -gt 0 ]; do [ "$1" = "-c" ] && cont="$2"; shift; done
beh="ok"
IFS=',' read -ra pairs <<< "$MODE"
for p in "\${pairs[@]}"; do [ "\${p%%=*}" = "$cont" ] && beh="\${p#*=}"; done
case "$beh" in
  ok) exit 0 ;;
  conflict) if [ "$op" = "create" ]; then echo "(Conflict) Entity with the specified id already exists. StatusCode: 409" >&2; exit 1; fi; exit 0 ;;
  403) echo "(Forbidden) Request blocked by Auth: principal does not have required RBAC permissions to perform action containers/items/read" >&2; exit 1 ;;
  404) echo "(NotFound) Owner resource does not exist" >&2; exit 1 ;;
esac
`;

function run(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'seedgov-'));
  const az = join(dir, 'az');
  writeFileSync(az, FAKE_AZ);
  chmodSync(az, 0o755);
  const log = join(dir, 'az.log');
  writeFileSync(log, '');
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      LOOM_COSMOS_ACCOUNT: 'cosmos-test',
      LOOM_COSMOS_RG: 'rg-test',
      LOOM_PURVIEW_ACCOUNT: '',
      MODE: mode,
      AZ_LOG: log,
    },
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, calls: readFileSync(log, 'utf8') };
}

test('CONTROL: all upserts succeed -> exit 0 and the success line (the fake az does reach the script)', () => {
  const r = run('');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Governance taxonomy seed complete/);
  // 2 tenant-settings + 5 domains creates must have been issued, or exit 0 is vacuous.
  assert.equal((r.calls.match(/item create/g) ?? []).length, 7, r.calls);
});

test('403 on tenant-settings fails red, naming container, HTTP 403 and the role', () => {
  const r = run('tenant-settings=403');
  assert.notEqual(r.status, 0, 'a 403 must exit non-zero; the old behaviour was a ::warning:: and exit 0');
  assert.match(r.out, /::error::[^\n]*HTTP 403[^\n]*container 'tenant-settings'/);
  assert.match(r.out, /Cosmos DB Built-in Data Contributor scoped to 'tenant-settings'/);
  assert.doesNotMatch(r.out, /::warning::governance seed upsert failed/);
  // governance-domains still attempted (all failures reported, not first-only).
  assert.equal((r.calls.match(/-c governance-domains/g) ?? []).length, 5, r.calls);
});

test('403 on governance-domains ONLY (the while-loop, not a pipe subshell) fails red', () => {
  const r = run('governance-domains=403');
  assert.notEqual(r.status, 0, 'failure inside the domains loop must reach the exit status');
  assert.match(r.out, /HTTP 403[^\n]*container 'governance-domains'/);
});

test('404 fails red with HTTP 404 and does not claim a 403 or a cause', () => {
  const r = run('tenant-settings=404');
  assert.notEqual(r.status, 0);
  assert.match(r.out, /HTTP 404 \(NotFound\)[^\n]*container 'tenant-settings'/);
  assert.doesNotMatch(r.out, /HTTP 403/);
  // 404 must not be retried as a replace (replace cannot succeed where create was refused).
  assert.doesNotMatch(r.calls, /item replace[^\n]*-c tenant-settings/);
});

test('CONFLICT (already exists) is still success: create 409 -> replace -> exit 0', () => {
  const r = run('tenant-settings=conflict,governance-domains=conflict');
  assert.equal(r.status, 0, r.out);
  assert.equal((r.calls.match(/item replace/g) ?? []).length, 7, r.calls);
  assert.doesNotMatch(r.out, /::error::/);
});
