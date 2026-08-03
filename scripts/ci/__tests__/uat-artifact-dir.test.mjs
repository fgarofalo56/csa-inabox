/**
 * uat-artifact-dir tests — the hardening that used to be inert.
 *
 * `apps/fiab-console/tests/_artifact-dir.mjs` was written for CodeQL
 * js/insecure-temporary-file #323 / #330 and the alerts never closed, for three
 * reasons this file pins:
 *
 *   1. It kept `/tmp/loom-uat` — a fixed name in a WORLD-WRITABLE directory on
 *      a multi-user jumpbox. The default is now under `$HOME`, which removes
 *      the attack rather than auditing it.
 *   2. It created the leaf with `recursive: true` while its own comment said
 *      "Non-recursive on purpose", so a path planted between the `lstat` that
 *      returned ENOENT and the `mkdir` was adopted SILENTLY. Measured, not
 *      assumed: `recursive:true` accepts an existing path, `recursive:false`
 *      throws EEXIST.
 *   3. Its `mode: 0o700` applied only on CREATE, and the documented runner ran
 *      `mkdir -p /tmp/loom-uat` FIRST — so the directory always already existed
 *      at umask-default 0755 and the hardening never executed.
 *
 * Lives here, not under apps/fiab-console, because vitest EXCLUDES `tests/`
 * (see vitest.config.ts `exclude`) — a spec placed next to the module would
 * never run, which is the same class of defect as the bug above.
 *
 * Run: node --test scripts/ci/__tests__/uat-artifact-dir.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultArtifactDir, ensureArtifactDir } from '../../../apps/fiab-console/tests/_artifact-dir.mjs';

const POSIX = process.platform !== 'win32' && typeof process.getuid === 'function';

/** A private scratch root for these tests (mkdtemp — the correct API). */
function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loom-artifactdir-test-'));
}

/* ------------------------------ the default ------------------------------ */

test('the default artifact dir is NOT under the OS temp dir', () => {
  const prev = process.env.LOOM_UAT_ARTIFACT_DIR;
  delete process.env.LOOM_UAT_ARTIFACT_DIR;
  try {
    const d = defaultArtifactDir();
    assert.equal(d, path.join(os.homedir(), '.loom-uat'));
    // The whole point: a shared, world-writable root must not be the default.
    assert.ok(!d.startsWith(os.tmpdir() + path.sep), `${d} is under ${os.tmpdir()}`);
  } finally {
    if (prev === undefined) delete process.env.LOOM_UAT_ARTIFACT_DIR;
    else process.env.LOOM_UAT_ARTIFACT_DIR = prev;
  }
});

test('LOOM_UAT_ARTIFACT_DIR overrides, resolved to an absolute path', () => {
  const prev = process.env.LOOM_UAT_ARTIFACT_DIR;
  const root = scratch();
  process.env.LOOM_UAT_ARTIFACT_DIR = root;
  try {
    assert.equal(defaultArtifactDir(), path.resolve(root));
  } finally {
    if (prev === undefined) delete process.env.LOOM_UAT_ARTIFACT_DIR;
    else process.env.LOOM_UAT_ARTIFACT_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------- creation ------------------------------- */

test('creates a missing directory, including missing parents', () => {
  const root = scratch();
  const dir = path.join(root, 'nested', 'deeper', 'artifacts');
  try {
    assert.equal(ensureArtifactDir(dir), dir);
    assert.ok(fs.lstatSync(dir).isDirectory());
    if (POSIX) {
      assert.equal(fs.lstatSync(dir).mode & 0o777, 0o700, 'a directory we create must be private');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an existing directory of ours is accepted (it is a coordination point)', () => {
  const root = scratch();
  const dir = path.join(root, 'artifacts');
  fs.mkdirSync(dir);
  try {
    assert.equal(ensureArtifactDir(dir), dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------- refusals -------------------------------- */

test('refuses a path that exists and is not a directory', () => {
  const root = scratch();
  const p = path.join(root, 'artifacts');
  fs.writeFileSync(p, 'not a dir');
  try {
    assert.throws(() => ensureArtifactDir(p), /not a directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('REPAIRS a group/world-accessible directory instead of trusting it', { skip: !POSIX }, () => {
  const root = scratch();
  const dir = path.join(root, 'artifacts');
  // Exactly what `mkdir -p` leaves behind under the default umask, and exactly
  // the state the old code accepted because it only set mode on create.
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  try {
    assert.equal(fs.lstatSync(dir).mode & 0o077, 0o055, 'precondition: world-readable');
    ensureArtifactDir(dir);
    assert.equal(fs.lstatSync(dir).mode & 0o077, 0, 'must be repaired to private');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses a symlink rather than following it', { skip: !POSIX }, () => {
  const root = scratch();
  const target = path.join(root, 'attacker-owned');
  const link = path.join(root, 'artifacts');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link, 'dir');
  try {
    // `lstat` sees the link; `stat` would have followed it, which IS the bug.
    assert.throws(() => ensureArtifactDir(link), /symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- the recursive:true / recursive:false fact -------------- */

test('THE FACT the old comment claimed and the old code contradicted', () => {
  const root = scratch();
  const dir = path.join(root, 'raced');
  fs.mkdirSync(dir);
  try {
    // recursive:true accepts a path that already exists — so anything planted
    // between an ENOENT lstat and the mkdir is adopted without a word.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // recursive:false is LOUD, which is what the leaf create now uses.
    assert.throws(() => fs.mkdirSync(dir, { mode: 0o700 }), /EEXIST/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
