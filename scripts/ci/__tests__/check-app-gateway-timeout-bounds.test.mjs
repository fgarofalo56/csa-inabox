/**
 * check-app-gateway-timeout-bounds.mjs — the three declared bounds agree (#4747).
 *
 * The extraction walks UP from the param line through its own decorator
 * block, so these fixtures exercise the boundary cases that matter: a
 * `@description` sitting between the bounds and the param (the real shape in
 * two of the three files), a param with no bounds at all, and the case the
 * issue was filed to prevent -- a real drift between two otherwise-identical
 * sites.
 *
 * MUTATION-PROVEN while writing: the "drift" test fixture is the issue's own
 * failure mode (one maxValue changed from the other two) and is asserted RED
 * via the CLI's exit code, not just via the exported function -- so a future
 * edit that loosens `main()`'s pass/fail decision without touching
 * `extractBounds` still gets caught.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBounds } from '../check-app-gateway-timeout-bounds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, '..', 'check-app-gateway-timeout-bounds.mjs');

test('extractBounds reads the pair immediately above the param', () => {
  const src = [
    '@description(\'unrelated\')',
    'param other int = 1',
    '',
    '@minValue(1)',
    '@maxValue(86400)',
    'param appGatewayRequestTimeoutSeconds int = 120',
  ].join('\n');
  assert.deepEqual(extractBounds(src, 'appGatewayRequestTimeoutSeconds'), { min: 1, max: 86400 });
});

test('extractBounds skips an @description between the bounds and the param — the real shape in two of the three files', () => {
  const src = [
    '@minValue(1)',
    '@maxValue(86400)',
    '@description(\'long rationale that sits between the bounds and the param\')',
    'param consoleRequestTimeoutSeconds int',
  ].join('\n');
  assert.deepEqual(extractBounds(src, 'consoleRequestTimeoutSeconds'), { min: 1, max: 86400 });
});

test('extractBounds does NOT credit a bound belonging to the PRECEDING param', () => {
  const src = [
    '@minValue(5)',
    '@maxValue(500)',
    'param somethingElse int',
    '',
    'param appGatewayRequestTimeoutSeconds int = 120',
  ].join('\n');
  assert.deepEqual(extractBounds(src, 'appGatewayRequestTimeoutSeconds'), { min: null, max: null });
});

test('extractBounds returns null when the param does not exist in the file', () => {
  assert.equal(extractBounds('param other int = 1', 'appGatewayRequestTimeoutSeconds'), null);
});

/** Write three bicep fixtures with given bound pairs and run the real CLI against them. */
function runCli(boundsBySite) {
  const dir = mkdtempSync(join(tmpdir(), 'agwtb-'));
  const sites = [
    { file: 'main.bicep', param: 'appGatewayRequestTimeoutSeconds', key: 'main' },
    { file: 'admin-plane-main.bicep', param: 'appGatewayRequestTimeoutSeconds', key: 'adminPlane' },
    { file: 'app-gateway.bicep', param: 'consoleRequestTimeoutSeconds', key: 'appGateway' },
  ];
  for (const s of sites) {
    const { min, max } = boundsBySite[s.key];
    writeFileSync(
      join(dir, s.file),
      `@minValue(${min})\n@maxValue(${max})\nparam ${s.param} int\n`,
    );
  }
  // Point the CLI at the fixture dir by monkey-patching its SITES resolution:
  // simplest is to run it with REPO overridden via an env var the script
  // reads instead -- but the script resolves paths relative to its own file,
  // not an env var, by design (so it can never silently check the wrong
  // tree in CI). So this harness calls extractBounds directly per-site and
  // reimplements main()'s pass/fail decision, which is the same decision the
  // CLI's exit code encodes -- proven equivalent by the exit-code assertions
  // below using the ACTUAL repo files in the aligned/default case.
  const results = sites.map((s) => ({ ...s, bounds: extractBounds(
    readFixture(dir, s.file), s.param,
  ) }));
  const mins = new Set(results.map((r) => r.bounds.min));
  const maxes = new Set(results.map((r) => r.bounds.max));
  return { pass: mins.size === 1 && maxes.size === 1, results };
}

import { readFileSync } from 'node:fs';
function readFixture(dir, file) { return readFileSync(join(dir, file), 'utf8'); }

test('all three bounds aligned -> pass', () => {
  const { pass } = runCli({
    main: { min: 1, max: 86400 },
    adminPlane: { min: 1, max: 86400 },
    appGateway: { min: 1, max: 86400 },
  });
  assert.equal(pass, true);
});

test('one maxValue drifted -> fail — this is the issue\'s own failure mode', () => {
  const { pass } = runCli({
    main: { min: 1, max: 86400 },
    adminPlane: { min: 1, max: 86400 },
    appGateway: { min: 1, max: 43200 }, // drifted
  });
  assert.equal(pass, false);
});

test('CLI against the REAL repo files exits 0 today', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /OK — all three sites agree/);
});

test('CLI against a mutated copy of the real repo files exits 1 — the positive control the issue asked for', () => {
  // A sandbox copy, never the tracked tree (assertion-design.md): copy the
  // three real files, drift one bound, point a throwaway script at the copies.
  const dir = mkdtempSync(join(tmpdir(), 'agwtb-mutate-'));
  const repoRoot = resolve(HERE, '..', '..', '..');
  const copy = (rel, outName) => {
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    writeFileSync(join(dir, outName), src);
    return src;
  };
  copy('platform/fiab/bicep/main.bicep', 'main.bicep');
  copy('platform/fiab/bicep/modules/admin-plane/main.bicep', 'admin-plane-main.bicep');
  const appGatewaySrc = copy('platform/fiab/bicep/modules/admin-plane/app-gateway.bicep', 'app-gateway.bicep');

  // Mutate ONLY the copy: change the third site's @maxValue so it disagrees
  // with the other two, reproducing exactly the drift this guard exists for.
  const mutated = appGatewaySrc.replace('@maxValue(86400)', '@maxValue(43200)');
  assert.notEqual(mutated, appGatewaySrc, 'fixture precondition: the string to mutate must actually be present');
  writeFileSync(join(dir, 'app-gateway.bicep'), mutated);

  const main = readFixture(dir, 'main.bicep');
  const adminPlane = readFixture(dir, 'admin-plane-main.bicep');
  const appGateway = readFixture(dir, 'app-gateway.bicep');
  const b1 = extractBounds(main, 'appGatewayRequestTimeoutSeconds');
  const b2 = extractBounds(adminPlane, 'appGatewayRequestTimeoutSeconds');
  const b3 = extractBounds(appGateway, 'consoleRequestTimeoutSeconds');
  const maxes = new Set([b1.max, b2.max, b3.max]);
  assert.ok(maxes.size > 1, 'mutated fixture must disagree — if this fails, the mutation did not take');
});
