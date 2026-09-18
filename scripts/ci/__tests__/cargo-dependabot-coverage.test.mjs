/**
 * Teeth for check-cargo-dependabot-coverage.mjs (#3982).
 *
 * Each block pairs a case that MUST be flagged with one that MUST NOT be, so a
 * matcher that has degenerated into "always fire" or "never fire" fails here.
 * The value that breaks each assertion is named at its site.
 *
 * The real-tree blocks LIFT the config and the crate list at runtime rather than
 * transcribing them, so a typo in this file cannot make the probe disagree with
 * the thing it is probing.
 *
 * Run: node --test scripts/ci/__tests__/cargo-dependabot-coverage.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findCargoManifestDirs,
  parseUpdates,
  evaluate,
  REPO_ROOT,
  DEPENDABOT_PATH,
} from '../check-cargo-dependabot-coverage.mjs';
import { readFileSync } from 'node:fs';

const GUARD = fileURLToPath(new URL('../check-cargo-dependabot-coverage.mjs', import.meta.url));

/** Build a throwaway repo root. Returned dir is removed by the caller. */
function scratch(files) {
  const root = mkdtempSync(join(tmpdir(), 'cargo-dependabot-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

/** Run the guard CLI against a root; never throws, returns {code, stdout, stderr}. */
function runGuard(root) {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, root], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const YML_CARGO = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: "cargo"',
  '    directory: "/apps/loom-directlake"',
  '    schedule:',
  '      interval: "weekly"',
  '',
].join('\n');

const YML_NO_CARGO = [
  'version: 2',
  'updates:',
  '  - package-ecosystem: "npm"',
  '    directory: "/portal/react-webapp"',
  '    schedule:',
  '      interval: "weekly"',
  '',
].join('\n');

const CRATE = '[package]\nname = "x"\nversion = "0.1.0"\n';

// ── the core verdict, both directions ────────────────────────────────────────

test('a crate with no cargo entry is flagged', () => {
  const { missing, covered } = evaluate(['apps/loom-directlake'], parseUpdates(YML_NO_CARGO));
  // FAILS IF: evaluate stops filtering on ecosystem === 'cargo' and treats the
  // npm entry as coverage, or stops comparing directories at all.
  assert.deepEqual(missing, ['apps/loom-directlake']);
  assert.deepEqual(covered, []);
});

test('a crate WITH a cargo entry is not flagged', () => {
  const { missing, covered } = evaluate(['apps/loom-directlake'], parseUpdates(YML_CARGO));
  // FAILS IF: the guard degenerates to "always fire" — e.g. the leading-slash
  // normalisation is dropped, so "/apps/loom-directlake" never matches
  // "apps/loom-directlake" and a correctly-configured repo reports missing.
  assert.deepEqual(missing, []);
  assert.deepEqual(covered, ['apps/loom-directlake']);
});

test('a cargo entry for a DIFFERENT directory does not cover this crate', () => {
  const yml = YML_CARGO.replace('/apps/loom-directlake', '/apps/some-other-crate');
  const { missing } = evaluate(['apps/loom-directlake'], parseUpdates(yml));
  // FAILS IF: coverage is decided by ecosystem alone and the directory is
  // ignored — which would pass any repo that has one cargo entry anywhere.
  assert.deepEqual(missing, ['apps/loom-directlake']);
});

// ── the parser: a later entry's directory must not leak backwards ────────────

test('directory is attributed to its own updates[] entry, not a later one', () => {
  const yml = [
    'version: 2',
    'updates:',
    '  - package-ecosystem: "cargo"', // deliberately has NO directory of its own
    '    schedule:',
    '      interval: "weekly"',
    '  - package-ecosystem: "npm"',
    '    directory: "/apps/loom-directlake"',
    '',
  ].join('\n');
  const updates = parseUpdates(yml);
  assert.equal(updates.length, 2);
  // FAILS IF: the parser scans for `directory:` without resetting on the
  // `- package-ecosystem:` item marker — the cargo entry would inherit the npm
  // entry's directory and the crate would read as covered when it is not.
  assert.equal(updates[0].ecosystem, 'cargo');
  assert.equal(updates[0].directory, null);
  assert.equal(updates[1].directory, '/apps/loom-directlake');
  assert.deepEqual(evaluate(['apps/loom-directlake'], updates).missing, ['apps/loom-directlake']);
});

test('a commented-out entry is not counted as coverage', () => {
  const yml = YML_NO_CARGO + '  # - package-ecosystem: "cargo"\n  #   directory: "/apps/loom-directlake"\n';
  // FAILS IF: the line matcher is not anchored and matches inside a comment —
  // the "raw source is satisfied by a comment" failure mode. A commented entry
  // produces no PRs, so counting it would be a guard that watches prose.
  assert.deepEqual(parseUpdates(yml).filter((u) => u.ecosystem === 'cargo'), []);
});

// ── the walker ───────────────────────────────────────────────────────────────

test('a vendored Cargo.toml under target/ is not treated as a crate', () => {
  const root = scratch({
    'apps/mine/Cargo.toml': CRATE,
    'apps/mine/target/debug/vendored/Cargo.toml': CRATE,
  });
  try {
    const dirs = findCargoManifestDirs(root);
    // Positive half — FAILS IF the walker stops descending and finds nothing.
    assert.ok(dirs.includes('apps/mine'), `expected apps/mine in ${JSON.stringify(dirs)}`);
    // Negative half — FAILS IF SKIP_DIRS loses 'target': the build directory is
    // full of dependency copies, and demanding a dependabot entry per vendored
    // manifest would make the guard permanently and uselessly red.
    assert.deepEqual(dirs, ['apps/mine']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── self-defence: a broken instrument must not read as a clean repo ──────────

test('zero crates found REFUSES to pass rather than reporting OK', () => {
  const root = scratch({ '.github/dependabot.yml': YML_NO_CARGO });
  try {
    const r = runGuard(root);
    // FAILS IF: the vacuity clause is removed. `missing.length === 0` is true
    // for "nothing to check" and for "everything checks out"; without this the
    // guard would go green the day the walker breaks.
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /REFUSING TO PASS/);
    assert.match(r.stderr, /0 Cargo\.toml manifests/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing dependabot.yml REFUSES to pass', () => {
  const root = scratch({ 'apps/mine/Cargo.toml': CRATE });
  try {
    const r = runGuard(root);
    // FAILS IF: existsSync short-circuits to "no config, nothing to enforce".
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /REFUSING TO PASS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a crate with no cargo entry exits 1 end-to-end', () => {
  const root = scratch({
    '.github/dependabot.yml': YML_NO_CARGO,
    'apps/mine/Cargo.toml': CRATE,
  });
  try {
    const r = runGuard(root);
    // FAILS IF: the CLI computes `missing` and then returns 0 anyway — a real
    // shape here, where a guard prints its finding and exits green.
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /apps\/mine\/Cargo\.toml/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the same tree WITH the entry exits 0 end-to-end', () => {
  const root = scratch({
    '.github/dependabot.yml': YML_CARGO.replace('/apps/loom-directlake', '/apps/mine'),
    'apps/mine/Cargo.toml': CRATE,
  });
  try {
    const r = runGuard(root);
    // The paired positive: FAILS IF the guard can only ever exit 1, which the
    // three assertions above would not distinguish from a working guard.
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /OK — 1 crate\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── the real tree, lifted at runtime ─────────────────────────────────────────

test('this repo\'s actual crates are all covered by actual dependabot.yml', () => {
  const dirs = findCargoManifestDirs(REPO_ROOT);
  // FAILS IF: the repo gains a second Rust crate with no cargo entry — the
  // regression this guard exists to catch. Also fails if apps/loom-directlake
  // is deleted without this test being revisited, which is the correct outcome:
  // a guard over zero crates should be reconsidered, not left green.
  assert.ok(
    dirs.includes('apps/loom-directlake'),
    `expected apps/loom-directlake among ${JSON.stringify(dirs)}`,
  );
  const updates = parseUpdates(readFileSync(join(REPO_ROOT, DEPENDABOT_PATH), 'utf8'));
  assert.deepEqual(evaluate(dirs, updates).missing, []);
});

test('the real dependabot.yml groups the arrow stack in one lockstep group', () => {
  // Not a coverage assertion — a REGRESSION PIN on the reason the group exists.
  // Measured with cargo 1.98.0 on 2026-09-18: resolving parquet 59 + datafusion
  // 55 + deltalake 0.32 together links arrow 58.4.0 AND 59.3.0, datafusion
  // 53.1.0 AND 55.1.0, parquet 58.4.0 AND 59.3.0 — two TableProvider traits, so
  // src/scan.rs stops compiling, and thrift 0.17.0 survives via parquet 58.
  // FAILS IF: someone removes a pattern, letting dependabot raise the arrow
  // stack one crate at a time.
  const yml = readFileSync(join(REPO_ROOT, DEPENDABOT_PATH), 'utf8');
  const cargoBlock = yml.slice(yml.indexOf('package-ecosystem: "cargo"'));
  assert.ok(cargoBlock.length > 0, 'no cargo entry found in the real dependabot.yml');
  for (const pattern of ['"arrow*"', '"parquet*"', '"datafusion*"', '"deltalake*"']) {
    assert.ok(
      cargoBlock.includes(pattern),
      `arrow-stack group must keep ${pattern} so the stack moves as one unit`,
    );
  }
});
