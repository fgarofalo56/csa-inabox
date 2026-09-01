// #3704 — the az-binary override on the script that decides REGION and
// deploy_apps_enabled.
//
// ── WHAT WAS MEASURED ───────────────────────────────────────────────────────
// `scripts/ci/reconcile-resolve.mjs` carried `const AZ = 'az'` with no override,
// while ten sibling scripts already honoured `LOOM_AZ_BIN`. It is the script
// that resolves the estate's REGION and decides whether `deployAppsEnabled`
// upgrades from the safe `false` to `true` — and `deployAppsEnabled` is, in the
// workflow's own words, "the ONLY way any LOOM_* env var reaches the running
// Console".
//
// On 2026-08-18, verifying whether the 06:00 nightly would repair the estate
// after #3701, running it locally gave:
//
//     ::warning::admin-RG list failed: spawnSync az ENOENT
//     ::error::REGION REFUSED — could not list rg-csa-loom-admin-* resource groups
//
// with `az account show` working in the same shell (on Windows `az` is a `.cmd`
// shim node will not spawn without one). The answer had to be reconstructed by
// hand. `deploy-integrity.md` R4 requires each path to be verified
// independently; a decision procedure that runs only inside the job it gates can
// be verified only after the fact, from logs — which is how #3701 stayed
// invisible for three nightlies.
//
// ── WHAT IS UNDER TEST ──────────────────────────────────────────────────────
// The SHIPPED script, SPAWNED with `LOOM_AZ_BIN` pointed at a stub that answers
// with a known estate, and the RESOLUTION it writes to $GITHUB_OUTPUT read back.
// That proves the override reaches the spawn and CHANGES THE DECISION — not
// merely that some function returns a string, which is what a unit test of the
// resolver would prove and is a hazard this repo has shipped before.
//
// The script has no `invokedDirectly` fence (deliberately — one that
// mis-resolved `process.argv[1]` would turn the deploy's most consequential
// decision into a silent no-op), so it cannot be imported without running. Spawn
// is the only honest instrument here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'reconcile-resolve.mjs');
const POLICY = path.join(REPO, 'scripts', 'ci', 'reconcile-policy.mjs');

/** The region the stub estate is in. Deliberately NOT a region any default uses. */
const STUB_REGION = 'westus3';

/**
 * A stub `az` that answers the two read-only queries this script makes.
 *
 * Written under `os.tmpdir()`, never into the tree: a control that writes an
 * executable into `scripts/ci` is one a concurrent suite can pick up, and this
 * repo has had exactly that happen.
 *
 * Cross-platform on purpose. CI is ubuntu-latest, but the whole POINT of #3704
 * is that the script must be runnable on the workstation where the answer was
 * needed, so the control has to exercise the Windows arm too — which is the
 * `.cmd` extension the script's `shell:` predicate keys on.
 */
function writeStubAz(dir, containers = []) {
  const impl = path.join(dir, 'stub-az.mjs');
  fs.writeFileSync(impl, [
    'const a = process.argv.slice(2).join(" ");',
    'if (a.includes("group") && a.includes("list")) {',
    `  process.stdout.write(JSON.stringify(["rg-csa-loom-admin-${STUB_REGION}"]));`,
    '} else if (a.includes("containerapp") && a.includes("list")) {',
    `  process.stdout.write(${JSON.stringify(JSON.stringify(containers))});`,
    '} else {',
    '  process.stderr.write("stub-az: unexpected args: " + a);',
    '  process.exit(2);',
    '}',
    '',
  ].join('\n'), 'utf8');

  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'stub-az.cmd');
    fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0stub-az.mjs" %*\r\n`, 'utf8');
    return cmd;
  }
  const sh = path.join(dir, 'stub-az');
  fs.writeFileSync(sh, `#!/usr/bin/env sh\nexec node "$(dirname "$0")/stub-az.mjs" "$@"\n`, 'utf8');
  fs.chmodSync(sh, 0o755);
  return sh;
}

/**
 * Run a copy of the resolver and hand back its exit status, output, and the
 * key=value pairs it wrote to $GITHUB_OUTPUT.
 *
 * The environment is built by DELETING every variable the script reads from the
 * inherited one and adding back only what is supplied — an ambient
 * `INPUT_REGION` or `LOOM_AZ_BIN` from a developer's shell must not be able to
 * decide a case.
 */
function runResolver(scriptPath, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-az-'));
  const outFile = path.join(dir, 'gh-output');
  const envFile = path.join(dir, 'gh-env');
  const summary = path.join(dir, 'gh-summary');
  fs.writeFileSync(outFile, '', 'utf8');
  fs.writeFileSync(envFile, '', 'utf8');

  const env = { ...process.env };
  for (const k of [
    'GITHUB_EVENT_NAME', 'INPUT_REGION', 'CSA_LOOM_TOPOLOGY', 'CSA_LOOM_TARGET_SUBSCRIPTION',
    'DEPLOY_SUB', 'BASE_DEPLOY_APPS_ENABLED', 'LOOM_AZ_BIN', 'GITHUB_STEP_SUMMARY',
  ]) delete env[k];

  const res = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    cwd: REPO,
    env: {
      ...env,
      GITHUB_EVENT_NAME: 'schedule',
      BASE_DEPLOY_APPS_ENABLED: 'false',
      GITHUB_OUTPUT: outFile,
      GITHUB_ENV: envFile,
      GITHUB_STEP_SUMMARY: summary,
      ...extraEnv,
    },
  });

  const outputs = Object.fromEntries(
    fs.readFileSync(outFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  const envLines = fs.readFileSync(envFile, 'utf8');
  const summaryText = fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '';
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, outputs, envLines, summaryText };
}

/**
 * A copy of the resolver in a temp dir, with `reconcile-policy.mjs` beside it so
 * its relative import still resolves. Used for the mutation arm: a control that
 * rewrites a deploy script IN PLACE can leave the tree dirty if it dies.
 */
function writeMutantOutsideTheTree(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-mutant-'));
  fs.copyFileSync(POLICY, path.join(dir, 'reconcile-policy.mjs'));
  const file = path.join(dir, 'reconcile-resolve.mjs');
  fs.writeFileSync(file, source, 'utf8');
  return { dir, file };
}

test('#3704 the LOOM_AZ_BIN override is CONSULTED, and it decides the region', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-stub-'));
  try {
    const stub = writeStubAz(dir);
    const r = runResolver(SCRIPT, { LOOM_AZ_BIN: stub, INPUT_REGION: '' });
    // Not just "it ran": the estate the stub described is the estate the script
    // resolved. A resolver that returned a string nobody spawned could not do
    // this.
    assert.equal(r.status, 0, `the resolver refused despite a working az stub:\n${r.out}`);
    assert.equal(r.outputs.region, STUB_REGION, r.out);
    assert.equal(r.outputs.region_source, 'adopted', r.out);
    assert.equal(r.outputs.hub_present, 'true', r.out);
    assert.match(r.envLines, new RegExp(`AZURE_LOCATION=${STUB_REGION}`), r.envLines);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#3704 the override also carries the deploy_apps_enabled decision', () => {
  // The output the 2026-08-18 investigation actually needed. With every image
  // ABSENT (an empty containerapp list) and no UNKNOWNs, a scheduled run may
  // upgrade — and that verdict is now readable in one command instead of being
  // reconstructed by hand.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-stub-'));
  try {
    const stub = writeStubAz(dir);
    const r = runResolver(SCRIPT, { LOOM_AZ_BIN: stub, INPUT_REGION: '' });
    assert.equal(r.outputs.unknown_count, '0', r.out);
    assert.equal(r.outputs.unknown_keys, '', r.out);
    assert.ok(
      r.outputs.deploy_apps_enabled === 'true' || r.outputs.deploy_apps_enabled === 'false',
      `deploy_apps_enabled must be decided, got ${JSON.stringify(r.outputs.deploy_apps_enabled)}:\n${r.out}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#3704 CONTROL — re-hardcoding the binary makes the measurement MOVE', () => {
  // The pre-fix state — the override line removed — on a COPY. If the mutant
  // still adopted the stub's region, the assertions above would prove nothing.
  //
  // The hardcoded name is a DELIBERATELY absent binary rather than the literal
  // `'az'`, and that is not a softening: the ubuntu-latest runner HAS a real
  // `az` on PATH, so a mutant hardcoding `'az'` would spawn it, get an
  // unauthenticated failure, and refuse — passing this control for a reason
  // that has nothing to do with the override. The property under test is that
  // the mutant IGNORES `LOOM_AZ_BIN`, and an absent name measures exactly that
  // on every platform.
  const original = fs.readFileSync(SCRIPT, 'utf8');
  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(nl);
  const at = lines.findIndex((l) => /^\s*if \(env\.LOOM_AZ_BIN\) return env\.LOOM_AZ_BIN;\s*$/.test(l));
  assert.ok(at >= 0, 'the mutation did not apply — the resolver line was not found, so this control proves NOTHING');
  lines[at] = "  return 'az.__no_such_binary__'; // MUTATED BY THE CONTROL";

  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-stub-'));
  const { dir, file } = writeMutantOutsideTheTree(lines.join(nl));
  try {
    const stub = writeStubAz(stubDir);
    const r = runResolver(file, { LOOM_AZ_BIN: stub, INPUT_REGION: '' });
    assert.notEqual(r.outputs.region, STUB_REGION,
      `the mutant still adopted the stub's region — this control cannot distinguish the two arms:\n${r.out}`);
    // And it FAILS CLOSED rather than assuming a region: an unreadable estate is
    // UNKNOWN, which is the #3029 lesson this script exists to hold.
    assert.equal(r.status, 1, `an unreachable az must REFUSE, never proceed:\n${r.out}`);
    assert.match(r.out, /REGION REFUSED/, r.out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  }

  assert.equal(fs.readFileSync(SCRIPT, 'utf8'), original, 'the real resolver must be untouched by this control');
});

test('#3704 DEFAULT — with LOOM_AZ_BIN unset the resolver still asks for plain az', () => {
  // The default must not have changed for the runner, where `az` is a real
  // executable on PATH. Asserted on the SOURCE plus one behavioural half: with
  // the override unset and a stub only reachable by name, the script must not
  // pick the stub up by accident.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /function azBinary\(\)/, 'the resolver itself is gone');
  assert.match(src, /env\.LOOM_AZ_BIN/, 'the resolver no longer reads the documented override');
  assert.match(src, /process\.platform === 'win32' \? 'az\.cmd' : 'az'/,
    'the platform default changed — the runner arm must still be plain `az`');
});

test('#3704 every az spawn in this script goes through the resolver', () => {
  // Keyed to the SAFE state, not to the removed `const AZ = 'az'` literal: a
  // guard keyed to the unsafe pattern goes green the moment someone renames it.
  // This asserts the property that must hold — every child-process spawn in the
  // file spawns `azBinary()`'s result — so a SECOND, un-resolved az call added
  // later fails here even though the old literal is long gone.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const spawns = [...src.matchAll(/(?:spawnSync|execFileSync|execSync|exec)\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(spawns.length > 0, 'no spawn call was found — this assertion has a ZERO population and proves nothing');
  assert.deepEqual(
    [...new Set(spawns)], ['bin'],
    `every spawn must use the resolved binary; found: ${spawns.join(', ')}`,
  );
});

test('#3704 a failed az read stays UNKNOWN — it never becomes "no hub"', () => {
  // The property the override must not weaken. `resolveReconcileRegion` refuses
  // on a null RG list, and null is what a spawn failure must produce — "I could
  // not look" spent as "there is nothing there" is deploy-integrity.md R7, and
  // here it would aim a reconcile at a region the estate is not in (#3029).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-badbin-'));
  try {
    const missing = path.join(dir, 'definitely-not-a-binary');
    const r = runResolver(SCRIPT, { LOOM_AZ_BIN: missing, INPUT_REGION: '' });
    assert.equal(r.status, 1, `an unspawnable binary must REFUSE:\n${r.out}`);
    assert.match(r.out, /REGION REFUSED/, r.out);
    // R7 — the warning quotes the CLI/spawn failure rather than inventing one.
    assert.match(r.out, /admin-RG list failed/, r.out);
    assert.equal(r.outputs.region, undefined, 'a refused run must emit no region');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── #4240 — THE FOLLOWER DIVERGENCE HAS TO REACH *THIS* SURFACE ───────────
 *
 * `resolveRunningImageTags()` has emitted a NOTE for a shared-repo follower off
 * its canonical's tag since #4240, and the `pin-refresh` CLI logs it. This
 * script — the ESTATE-WIDE reconcile, the step at deploy-fiab-commercial.yml —
 * did NOT: `grep -n notes scripts/ci/reconcile-resolve.mjs` returned nothing.
 * So the surface an operator actually reads for estate state printed
 * `PIN unity loom-unity:<tag>` and `UNKNOWN: (none)` whether the pair was
 * mid-roll or a follower stuck for a week — byte-identical output for two very
 * different estates, which is #4240's literal title, unfixed.
 *
 * These run the SHIPPED script against a stubbed `az`, and the second is the
 * control: same script, same code path, converged pair, no line. Without the
 * control the first arm could be satisfied by a notice printed unconditionally.
 */
const UNITY_CANONICAL = { name: 'loom-unity', image: 'x.azurecr.io/loom-unity:2456cebb' };

test('#4240 a half-rolled shared-repo pair is NAMED by the estate-wide reconcile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-follower-'));
  try {
    const stub = writeStubAz(dir, [
      UNITY_CANONICAL,
      { name: 'iceberg-catalog', image: 'x.azurecr.io/loom-unity:4d4fd0b9' },
    ]);
    const r = runResolver(SCRIPT, { LOOM_AZ_BIN: stub, INPUT_REGION: '' });
    assert.equal(r.status, 0, `a follower divergence must not fail the reconcile:\n${r.out}`);

    // It is an OBSERVATION: the decided fields must be untouched by it.
    assert.equal(r.outputs.unknown_count, '0', `a follower must not manufacture UNKNOWN:\n${r.out}`);
    assert.match(r.envLines, /LOOM_UNITY_TAG=2456cebb/, `the pin still follows the canonical app:\n${r.envLines}`);

    // And it must be VISIBLE — the whole point of #4240.
    assert.match(r.out, /::notice::\[reconcile\] FOLLOWER/, `no follower line reached the log:\n${r.out}`);
    assert.match(r.out, /iceberg-catalog runs loom-unity:4d4fd0b9/, r.out);
    assert.equal(r.outputs.follower_count, '1', r.out);
    assert.equal(r.outputs.follower_keys, 'unity', r.out);
    assert.match(
      r.summaryText,
      /shared-repo followers not on their canonical's tag: unity pins to 2456cebb/,
      r.summaryText,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#4240 CONTROL — a CONVERGED pair prints no follower line at all', () => {
  // A notice that fires on every run is a notice nobody reads, and it would
  // make the arm above green for the wrong reason.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-converged-'));
  try {
    const stub = writeStubAz(dir, [
      UNITY_CANONICAL,
      { name: 'iceberg-catalog', image: 'x.azurecr.io/loom-unity:2456cebb' },
    ]);
    const r = runResolver(SCRIPT, { LOOM_AZ_BIN: stub, INPUT_REGION: '' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.envLines, /LOOM_UNITY_TAG=2456cebb/, 'the same pin either way');
    assert.doesNotMatch(r.out, /FOLLOWER/, `a converged estate must be silent:\n${r.out}`);
    assert.equal(r.outputs.follower_count, '0', r.out);
    assert.match(r.summaryText, /followers not on their canonical's tag: \(none\)/, r.summaryText);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
