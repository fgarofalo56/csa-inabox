// The secret-expiry monitor's tracked Key Vault secret list has THREE defaults:
// the bicep param (admin-plane deploy), the script fallback (script redeploy
// path), and the runtime fallback (env unset). If one drifts, a redeploy
// through that path silently drops a tracked secret — exactly how the runner
// PAT (#5483) could fall out of coverage. This test LIFTS each default from
// source (assertion-design.md rule 3) and requires all three to be equal and
// to include gh-actions-pat.
//
// Breaking value: any one of the three strings lacking `gh-actions-pat` (or
// otherwise differing from the other two).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const SOURCES = [
  ['bicep', 'platform/fiab/bicep/modules/admin-plane/secret-expiry-monitor-job.bicep',
    /^param trackedKvSecrets string = '([^']*)'/m],
  ['script', 'scripts/csa-loom/deploy-secret-expiry-job.sh',
    /^LOOM_SECRET_EXPIRY_KV_SECRETS="\$\{LOOM_SECRET_EXPIRY_KV_SECRETS:-([^}]*)\}"/m],
  ['runtime', 'azure-functions/secret-expiry-monitor/src/run-monitor.ts',
    /env\.LOOM_SECRET_EXPIRY_KV_SECRETS \|\| '([^']*)'/],
];

const lifted = SOURCES.map(([label, rel, re]) => {
  const m = read(rel).match(re);
  return { label, rel, value: m ? m[1] : null };
});

test('every default was found in its source (otherwise the equality below is blind)', () => {
  for (const d of lifted) assert.ok(d.value, `could not lift the tracked-secrets default from ${d.rel}`);
});

test('all three tracked-secret defaults are identical (breaks if any one copy drifts)', () => {
  const [bicep, ...rest] = lifted;
  for (const d of rest) {
    assert.equal(d.value, bicep.value, `${d.label} default (${d.rel}) differs from the bicep default`);
  }
});

test('the defaults track the runner PAT mirror gh-actions-pat (#5483)', () => {
  for (const d of lifted) {
    assert.ok(d.value.split(',').includes('gh-actions-pat'), `${d.label} default lacks gh-actions-pat: '${d.value}'`);
  }
});
