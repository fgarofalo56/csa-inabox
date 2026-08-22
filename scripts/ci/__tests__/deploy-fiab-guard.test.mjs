#!/usr/bin/env node
/**
 * deploy-fiab-guard — the az binary is RESOLVED, and the resolution reaches the
 * SPAWN (#3704).
 *
 * ## What was wrong
 *
 * `scripts/ci/deploy-fiab-guard.mjs` decides `deploy_apps_enabled` and
 * `deploy_sub` — the deploy's two most consequential outputs — and it reached
 * Azure through a hardcoded `const AZ = 'az';`. A boundary whose Azure CLI is
 * installed under a different name, wrapped, or pinned to a specific build had
 * no way to say so, and the failure was not loud: a spawn that cannot find the
 * binary lands in countExistingHubs's catch, which returns null; null is
 * UNKNOWN; and UNKNOWN on a dispatch REFUSES the deploy. Fail-closed is correct
 * for an unknown hub count, but "the CLI is not where I assumed" and "Resource
 * Graph refused me" then produce the same verdict from different causes — the
 * deploy-integrity.md R7 shape.
 *
 * ## Why these assertions spawn the script instead of importing it
 *
 * deploy-fiab-guard.mjs runs its whole guard at module scope, so importing it to
 * unit-test the resolver would EXECUTE the guard. More importantly, a unit test
 * of `azBinary()` proves only that a function returns a string — a resolver
 * nothing consults is the same defect wearing a different hat. These tests spawn
 * the real script and assert on text NODE'S OWN SPAWN produced, which can only
 * name the binary the spawn was actually given.
 *
 * ## The observable, and why it is this one
 *
 * The first cut of this suite used an EXECUTABLE stub that printed a hub count,
 * so the arms differed by the guard's whole verdict (PROCEED vs REFUSE). That
 * needed `shell: true` to spawn a `.cmd` on Windows — and measured, that shell
 * makes cmd.exe read the `|` in the guard's KQL pipeline as a SHELL pipe
 * ("'project' is not recognized as an internal or external command"). Turning
 * the shell on to make a TEST pass would have shipped a mangled query into the
 * deploy path. So the guard keeps its documented no-shell behaviour, and the
 * observable here is the one that works identically on every platform: WHICH
 * BINARY THE SPAWN NAMES IN ITS OWN ERROR.
 *
 * ## The controls, and what each one dies to
 *
 *   CLEAN   LOOM_AZ_BIN=<unique fake path> ⇒ the spawn's own error names THAT
 *           path.
 *   CONTROL the same environment against a source mutated back to the hardcoded
 *           `'az'` ⇒ the fake path appears NOWHERE in the output and the spawn
 *           names `az` instead. The measurement MOVES under the exact mutation
 *           #3704 filed.
 *   DEFAULT LOOM_AZ_BIN unset ⇒ still plain `az` / `az.cmd`, and an unreachable
 *           CLI is UNKNOWN ⇒ REFUSE. Pins that the override changed nothing for
 *           existing callers, and that the failure is still fail-CLOSED.
 *
 * PATH is stripped in every arm: on a workstation or runner that HAS the Azure
 * CLI installed, the mutated arm would reach a real `az`, succeed, and the
 * control would prove nothing about which binary was chosen.
 *
 * Run: node --test scripts/ci/__tests__/deploy-fiab-guard.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ci', 'deploy-fiab-guard.mjs');
const IS_WIN = process.platform === 'win32';

/**
 * A path that names no executable on any machine.
 *
 * mkdtempSync, not a constant name under os.tmpdir(): a predictable path in a
 * world-writable root can be pre-created or symlinked by another local user
 * (check-temp-artifact-safety.mjs flags exactly that, and flagged this).
 * Nothing is ever WRITTEN to it — the whole point is that the spawn cannot find
 * it — but the guard's rule holds regardless of intent.
 */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-guard-az-'));
const FAKE_AZ = path.join(SCRATCH, 'loom-not-a-real-cli');
test.after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

/** Node's spawn failure text, across platforms. */
const SPAWN_FAILED = /ENOENT|not recognized|cannot find|No such file/i;

/**
 * Spawn the guard with a deterministic, CLI-free environment.
 *
 * PATH is stripped of everything that could hold a real Azure CLI. On Windows it
 * is narrowed to System32 rather than emptied: an empty PATH there breaks
 * cmd.exe's own helpers and every arm fails for a reason that has nothing to do
 * with the subject. The Azure CLI installs to its own directory, not System32,
 * so the narrowed PATH still cannot reach it — and if it somehow could, the
 * DEFAULT arm asserts a REFUSAL and goes red rather than silently passing.
 */
function runGuard(extraEnv = {}, script = SCRIPT) {
  const scrubbedPath = IS_WIN
    ? [
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
      process.env.SystemRoot || 'C:\\Windows',
    ].join(';')
    : '';
  const env = {
    PATH: scrubbedPath,
    Path: scrubbedPath,
    ...(IS_WIN
      ? { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir() }
      : {}),
    // A dispatch, not a schedule: on a schedule an UNKNOWN hub count PROCEEDS
    // with a warning, which would collapse two of the arms onto one verdict.
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    CSA_LOOM_TOPOLOGY: 'tenant',
    CSA_LOOM_TARGET_SUBSCRIPTION: '',
    CSA_LOOM_SUBSCRIPTION_OVERRIDE: '',
    INPUT_ALLOW_EXISTING_HUB: 'false',
    INPUT_PURVIEW_ENABLED: 'true',
    INPUT_AZURE_MAPS_ENABLED: 'true',
    INPUT_FIREWALL_ENABLED: 'false',
    INPUT_DEPLOY_APPS_ENABLED: 'true',
    INPUT_SKIP_ROLE_GRANTS: 'false',
    INPUT_FRONT_DOOR_ENABLED: 'true',
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, cwd: REPO });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('CLEAN — LOOM_AZ_BIN reaches the SPAWN: the spawn error names the OVERRIDDEN binary', () => {
  const r = runGuard({ LOOM_AZ_BIN: FAKE_AZ });

  assert.match(r.out, /hub-count query failed/, `the guard never attempted a query:\n${r.out}`);
  // The label is this repo's own interpolation, so on its own it would prove
  // nothing — a hardcoded spawn with a resolved label would still print it.
  assert.ok(r.out.includes(`az binary: ${FAKE_AZ}`), `the warning did not name the binary it tried:\n${r.out}`);
  // THIS is the load-bearing assertion: the text after the label is Node's own
  // spawn failure, and it can only carry FAKE_AZ if FAKE_AZ is what was spawned.
  const after = r.out.slice(r.out.indexOf(`az binary: ${FAKE_AZ}`) + `az binary: ${FAKE_AZ}`.length);
  assert.match(after, SPAWN_FAILED, `no spawn failure followed the label:\n${r.out}`);
  assert.ok(
    after.includes(FAKE_AZ) || after.includes(path.basename(FAKE_AZ)),
    `the SPAWN's own error did not name the resolved binary — the resolver was interpolated into a message while something else was spawned:\n${r.out}`,
  );
});

test('CONTROL — re-hardcoding the binary makes the measurement MOVE', () => {
  // The exact mutation #3704 filed, applied to a COPY: a suite that rewrites a
  // deploy script in place can leave the tree dirty if it dies mid-test.
  const original = fs.readFileSync(SCRIPT, 'utf8');
  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(nl);
  const at = lines.findIndex((l) => /^\s*if \(env\.LOOM_AZ_BIN\) return env\.LOOM_AZ_BIN;\s*$/.test(l));
  assert.ok(at >= 0, 'the mutation did not apply — the resolver line was not found, so this control proves NOTHING');
  lines[at] = "  return 'az'; // MUTATED BY THE CONTROL";

  // The copy sits beside the original so its relative import of
  // ./deploy-trigger-policy.mjs still resolves.
  const mutant = path.join(REPO, 'scripts', 'ci', 'deploy-fiab-guard.__control__.mjs');
  fs.writeFileSync(mutant, lines.join(nl));
  try {
    const r = runGuard({ LOOM_AZ_BIN: FAKE_AZ }, mutant);
    assert.match(r.out, /hub-count query failed/, `the mutant never attempted a query:\n${r.out}`);
    assert.ok(
      !r.out.includes(FAKE_AZ),
      `the mutated guard still named the override — this control cannot distinguish the two arms:\n${r.out}`,
    );
    assert.match(r.out, /az binary: az(\.cmd)?\)/, `the mutant did not fall back to the hardcoded binary:\n${r.out}`);
  } finally {
    fs.rmSync(mutant, { force: true });
  }

  assert.equal(fs.readFileSync(SCRIPT, 'utf8'), original, 'the real guard must be untouched by this control');
});

test('DEFAULT — with LOOM_AZ_BIN unset the guard still looks for plain az, and fails CLOSED', () => {
  // Two claims in one: the default did not change for existing callers, and an
  // unreachable CLI is UNKNOWN (refuse), never a permissive zero. The second is
  // the whole reason this file replaced an inline `2>/dev/null || echo "0"`.
  const r = runGuard({});
  assert.equal(r.status, 1, `an unreachable az must REFUSE, never proceed; output:\n${r.out}`);
  assert.match(r.out, /hub-count query failed \(az binary: az(\.cmd)?\)/, r.out);
  assert.match(r.out, /could not determine whether a CSA Loom hub already exists/, r.out);
});

test('the ONLY az invocation in this guard goes through the resolver', () => {
  // Keyed to the SAFE state, not to the removed `const AZ = 'az'` literal: a
  // guard keyed to the unsafe pattern goes green the moment someone renames it.
  // This asserts the property that must hold — every execFileSync in the file
  // spawns `azBinary()`'s result — so a SECOND, un-resolved az call added later
  // fails here even though the old literal is long gone.
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const spawns = [...src.matchAll(/execFileSync\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.ok(spawns.length > 0, 'no execFileSync call was found — this assertion has a ZERO population and proves nothing');
  assert.deepEqual(
    [...new Set(spawns)],
    ['bin'],
    `every execFileSync must spawn the resolved binary; found: ${spawns.join(', ')}`,
  );
  assert.match(src, /function azBinary\(\)/, 'the resolver itself is gone');
  assert.match(src, /env\.LOOM_AZ_BIN/, 'the resolver no longer reads the documented override');
});
