/**
 * Safe resolution + creation of the UAT artifact directory (CodeQL
 * js/insecure-temporary-file, alerts #323 / #330).
 *
 * ── THE FIRST FIX WAS INERT. ────────────────────────────────────────────────
 *
 * This file already existed, written for these exact two alerts, and it kept
 * `/tmp/loom-uat` on the argument that the well-known name is a COORDINATION
 * POINT. Three things were wrong with that, and all three are why the alerts
 * never closed:
 *
 *   1. THE HARDENING NEVER RAN ON THE PATH THAT MATTERS.
 *      `scripts/csa-loom/uat-runner-final.sh` is the documented jumpbox runner.
 *      It does not execute the file in this tree — it `base64 -d`s an EMBEDDED
 *      COPY of `uat-console-smoke.mjs` that predates this module, imports
 *      nothing, and calls `fs.mkdirSync('/tmp/loom-uat', {recursive:true})`
 *      bare. Every guarantee written below was unreachable from the only
 *      command an operator actually types. Same shape as #2729, where CVE
 *      floors were declared in a file the shipped image never read.
 *
 *   2. `recursive: true` RE-OPENED THE RACE THE COMMENT CLAIMED TO CLOSE.
 *      The old comment read "Non-recursive on purpose: `recursive: true` treats
 *      an existing path as success, which is exactly the check being made
 *      here" — and the call three lines under it passed `recursive: true`.
 *      Measured, not assumed: with `recursive:true` a pre-existing path is
 *      accepted silently; with `recursive:false` it throws EEXIST. So anything
 *      planted between the `lstat` that returned ENOENT and this `mkdir` was
 *      adopted without a word.
 *
 *   3. mode 0700 APPLIED ONLY ON CREATE, AND WE NEVER CREATED.
 *      `uat-runner-final.sh` runs `mkdir -p /tmp/loom-uat` FIRST, so by the
 *      time node started the directory always existed — same uid, so every
 *      check passed — at umask-default 0755. World-readable. The artifacts are
 *      full-page screenshots of an AUTHENTICATED console session.
 *
 * ── THE FIX: LEAVE THE SHARED DIRECTORY. ───────────────────────────────────
 *
 * The vulnerability is not the fixed *name*, it is the fixed name being in a
 * WORLD-WRITABLE directory. `/tmp` is shared by every local user on the
 * jumpbox, so any of them can win the race to create `/tmp/loom-uat` — as a
 * symlink to somewhere they read, or as a directory they own. No amount of
 * checking after the fact removes that; it only narrows the window.
 *
 * `$HOME` is not world-writable, so the entire attack class disappears rather
 * than being audited. The coordination point is preserved — it is still ONE
 * well-known path, just a private one — and `LOOM_UAT_ARTIFACT_DIR` lets a
 * caller (CI, a container job with a mounted volume) name its own.
 *
 * The checks below are kept anyway as defence in depth, and repaired:
 *   - `lstat`, never `stat`, so a symlink is SEEN rather than followed.
 *   - leaf created NON-recursively, so a planted path throws EEXIST loudly.
 *   - mode forced to 0700 on an EXISTING directory too, not just on create.
 *   - on POSIX, refuse a directory owned by another uid.
 *
 * Fails LOUD. A UAT that reports success while writing somewhere unexpected is
 * worse than one that refuses to start.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Bits that must not be set on the artifact directory: group/other, anything. */
const FORBIDDEN_MODE_BITS = 0o077;

/**
 * The artifact directory this run should use.
 *
 * `LOOM_UAT_ARTIFACT_DIR` wins when set (CI, or a container job with a mounted
 * results volume). Otherwise a well-known path under the CURRENT USER'S HOME —
 * deliberately not `os.tmpdir()`, which is shared with every other local user.
 *
 * @returns {string} absolute path
 */
export function defaultArtifactDir() {
  const override = (process.env.LOOM_UAT_ARTIFACT_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.loom-uat');
}

/** POSIX-only checks are meaningless on Windows, where mode bits are not enforced. */
function isPosix() {
  return process.platform !== 'win32' && typeof process.getuid === 'function';
}

/**
 * Ensure `dir` exists, is a real directory we own, and is private to us.
 *
 * @param {string} dir absolute path to the artifact directory
 * @returns {string} `dir`, for `const D = ensureArtifactDir(defaultArtifactDir())`
 */
export function ensureArtifactDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // Parents may legitimately be missing (an operator-supplied override).
      // Create THOSE recursively, but the leaf strictly non-recursively: the
      // leaf is the thing that can be raced, and `recursive:true` would adopt a
      // path planted since the lstat above without raising anything.
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (mkErr) {
        if (mkErr && mkErr.code === 'EEXIST') {
          throw new Error(
            `Refusing to use ${dir}: it did not exist a moment ago and does now. ` +
            'Something else created it between the check and the create. Remove it and re-run.',
          );
        }
        throw mkErr;
      }
      return dir;
    }
    throw e;
  }

  if (st.isSymbolicLink()) {
    throw new Error(
      `Refusing to use ${dir}: it is a symlink. Another user can plant one to ` +
      'capture UAT screenshots of an authenticated session. Remove it and re-run.',
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`Refusing to use ${dir}: it exists and is not a directory.`);
  }

  if (isPosix()) {
    if (st.uid !== process.getuid()) {
      throw new Error(
        `Refusing to use ${dir}: it is owned by uid ${st.uid}, not this process ` +
        `(uid ${process.getuid()}). Remove it and re-run.`,
      );
    }
    // REPAIR, not just report. A directory created by `mkdir -p` in a shell
    // inherits umask (0755 by default) and every check above still passes,
    // because it IS ours — it is simply readable by everyone. That is the
    // information disclosure the alert is about, so fix it rather than warn.
    if ((st.mode & FORBIDDEN_MODE_BITS) !== 0) {
      fs.chmodSync(dir, 0o700);
      const after = fs.lstatSync(dir);
      if ((after.mode & FORBIDDEN_MODE_BITS) !== 0) {
        throw new Error(
          `Refusing to use ${dir}: it is group/world accessible (mode ` +
          `${(after.mode & 0o777).toString(8)}) and chmod 700 did not take.`,
        );
      }
    }
  }

  return dir;
}
