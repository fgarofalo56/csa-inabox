/**
 * check-kv-firewall-restore self-test (#2855).
 *
 * The guard exists because six Key Vault call sites re-locked the firewall
 * without ever checking that the re-lock applied. A GUARD that cannot fail is
 * the same defect one level up, so this drives it against synthetic fixtures
 * and pins both verdicts.
 *
 * The masked-body cases are the point: a `#` comment or an `echo` that NAMES
 * `kv-firewall-window.sh close` must NOT discharge the pairing rule. The first
 * draft of the guard failed exactly that — its own JSDoc header scored as three
 * helper "call sites".
 *
 * MUTATION-PROVEN (counts in the PR body): removing either rule from
 * check-kv-firewall-restore.mjs turns the matching "detects" tests RED while the
 * CONTROL tests stay green, so an over-broad guard that flags everything cannot
 * hide either.
 *
 * Run: node --test scripts/ci/__tests__/kv-firewall-restore.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = resolve(HERE, '..', 'check-kv-firewall-restore.mjs');

/** Run the guard over a throwaway repo root containing `files` (rel paths). */
function runOn(files) {
  const dir = mkdtempSync(join(tmpdir(), 'kvfw-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const abs = join(dir, name);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    const r = spawnSync(process.execPath, [GUARD, dir], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WF = '.github/workflows/fixture.yml';
const wf = (run) => `name: fixture
on: workflow_dispatch
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - name: do it
        run: |
${run
  .split('\n')
  .map((l) => `          ${l}`)
  .join('\n')}
`;

// ---------------------------------------------------------------------------
// DETECTS — rule 1, the chokepoint
// ---------------------------------------------------------------------------
test('detects a raw `az keyvault update --public-network-access`', () => {
  const r = runOn({
    [WF]: wf('az keyvault update -n "$KV" --public-network-access Disabled --default-action Deny -o none || true'),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /raw `az keyvault update --public-network-access`/);
});

test('detects a raw `az keyvault network-rule add`', () => {
  const r = runOn({
    [WF]: wf('az keyvault network-rule add -n "$KV" --ip-address "$IP" -o none'),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /raw `az keyvault network-rule add\|remove`/);
});

test('detects the exact shape shipped before #2855 (masked stderr, discarded rc)', () => {
  const r = runOn({
    [WF]: wf(
      'az keyvault update -n "$KV" --public-network-access Disabled --default-action Deny -o none 2>/dev/null \\\n  && echo "re-asserted private" \\\n  || echo "::warning::Could not re-assert private posture"',
    ),
  });
  assert.equal(r.code, 1);
});

// ---------------------------------------------------------------------------
// DETECTS — rule 2, pairing, evaluated against the MASKED body
// ---------------------------------------------------------------------------
test('detects an open with no close', () => {
  const r = runOn({
    [WF]: wf('bash scripts/csa-loom/kv-firewall-window.sh open --vault "$KV"'),
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /never runs `kv-firewall-window\.sh close`/);
});

test('a COMMENT naming the close does NOT satisfy the pairing rule', () => {
  const r = runOn({
    [WF]: wf(
      '# restored later via: bash scripts/csa-loom/kv-firewall-window.sh close --vault "$KV"\nbash scripts/csa-loom/kv-firewall-window.sh open --vault "$KV"',
    ),
  });
  assert.equal(r.code, 1, 'a comment must not discharge the restore requirement');
  assert.match(r.out, /never runs `kv-firewall-window\.sh close`/);
});

test('an echo naming the close does NOT satisfy the pairing rule', () => {
  const r = runOn({
    [WF]: wf(
      'bash scripts/csa-loom/kv-firewall-window.sh open --vault "$KV"\necho "run bash scripts/csa-loom/kv-firewall-window.sh close --vault $KV when done"',
    ),
  });
  assert.equal(r.code, 1, 'an echo naming a script is output, not execution (#2816)');
});

test('a ::warning:: naming the close does NOT satisfy the pairing rule', () => {
  const r = runOn({
    [WF]: wf(
      'bash scripts/csa-loom/kv-firewall-window.sh open --vault "$KV"\necho "::warning::re-lock with scripts/csa-loom/kv-firewall-window.sh close --vault $KV"',
    ),
  });
  assert.equal(r.code, 1);
});

// ---------------------------------------------------------------------------
// CONTROLS — must stay green, or the guard is over-broad
// ---------------------------------------------------------------------------
test('CONTROL: a compliant open + close pair passes', () => {
  const r = runOn({
    [WF]: wf(
      'bash scripts/csa-loom/kv-firewall-window.sh open --vault "$KV"\naz keyvault secret set --vault-name "$KV" --name s --value v -o none\nbash scripts/csa-loom/kv-firewall-window.sh close --vault "$KV"',
    ),
  });
  assert.equal(r.code, 0, r.out);
});

test('CONTROL: a close on its own (an always() backstop) passes', () => {
  const r = runOn({
    [WF]: wf('bash scripts/csa-loom/kv-firewall-window.sh close --vault "$KV" --subscription "$SUB"'),
  });
  assert.equal(r.code, 0, r.out);
});

test('CONTROL: the old broken command QUOTED in a comment is not a violation', () => {
  const r = runOn({
    [WF]: wf(
      '# was: az keyvault update -n "$KV" --public-network-access Disabled -o none || true\nbash scripts/csa-loom/kv-firewall-window.sh close --vault "$KV"',
    ),
  });
  assert.equal(r.code, 0, r.out);
});

test('CONTROL: unrelated `az keyvault` calls are untouched', () => {
  const r = runOn({
    [WF]: wf(
      'az keyvault secret set --vault-name "$KV" --name s --value v -o none\naz keyvault list -g "$RG" --query "[].name" -o tsv\naz keyvault network-rule list -n "$KV" --query "ipRules[].value" -o tsv\nbash scripts/csa-loom/kv-firewall-window.sh close --vault "$KV"',
    ),
  });
  assert.equal(r.code, 0, r.out);
});

test('CONTROL: a shell script under scripts/ using the helper passes', () => {
  const r = runOn({
    'scripts/csa-loom/thing.sh': [
      '#!/usr/bin/env bash',
      'bash "$(dirname "$0")/kv-firewall-window.sh" open --vault "$KV"',
      'if ! bash "$(dirname "$0")/kv-firewall-window.sh" close --vault "$KV"; then exit 1; fi',
    ].join('\n'),
  });
  assert.equal(r.code, 0, r.out);
});

// ---------------------------------------------------------------------------
// SELF-DEFENCE — the guard must not pass vacuously
// ---------------------------------------------------------------------------
test('fails when it scans nothing', () => {
  const r = runOn({ 'README.md': 'nothing to see' });
  assert.equal(r.code, 1);
  assert.match(r.out, /GUARD SELF-CHECK FAILED/);
  assert.match(r.out, /scanned 0 files/);
});
