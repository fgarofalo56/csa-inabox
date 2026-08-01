/**
 * Safe creation of the shared UAT artifact directory (CodeQL
 * js/insecure-temporary-file, alerts #323 / #330).
 *
 * WHY THE OBVIOUS FIX IS WRONG HERE. The usual remedy for a fixed `/tmp` path is
 * `fs.mkdtempSync(...)` — a unique, unguessable directory. That would break this
 * one: `/tmp/loom-uat` is a COORDINATION POINT, not scratch space.
 * `scripts/csa-loom/uat-runner-final.sh` does `mkdir -p /tmp/loom-uat && cd
 * /tmp/loom-uat`, and `docs/fiab/uat-report.md` documents it as where the
 * operator collects screenshots + the JSON result. A random directory name would
 * silently produce zero collected artifacts — a green run with nothing to show.
 *
 * WHAT THE ACTUAL RISK IS. These run on a JUMPBOX, which is multi-user, so the
 * classic `/tmp` attack applies: any other local user can pre-create
 * `/tmp/loom-uat` — as a symlink to a directory they choose, or as a directory
 * they own and can read. `mkdirSync(dir, {recursive: true})` succeeds silently
 * against BOTH, and the UAT then writes screenshots of an authenticated console
 * session through the attacker's link.
 *
 * SO: keep the well-known name, and refuse to use it if it is not ours.
 *
 *   - `lstat` (never `stat`) so a symlink is seen as a symlink instead of being
 *     followed to whatever it points at — following it is the whole bug.
 *   - mode 0700 on create, so a directory we make is not readable by other
 *     local users. Screenshots of a signed-in console are session-bearing.
 *   - on POSIX, refuse a pre-existing directory owned by another uid.
 *
 * Fails LOUD. An unusable artifact directory should stop the run, not quietly
 * downgrade it — a UAT that reports success while writing somewhere unexpected
 * is worse than one that does not start.
 */
import fs from 'node:fs';

/**
 * Ensure `dir` exists, is a real directory, and belongs to us. Returns `dir`.
 * @param {string} dir absolute path to the artifact directory
 */
export function ensureArtifactDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      // Not there — create it ourselves, private. Non-recursive on purpose:
      // `recursive: true` treats an existing path as success, which is exactly
      // the check being made here.
      fs.mkdirSync(dir, { mode: 0o700, recursive: true });
      return dir;
    }
    throw e;
  }

  if (st.isSymbolicLink()) {
    throw new Error(
      `Refusing to use ${dir}: it is a symlink. On a shared host another user ` +
      'can plant one to capture UAT screenshots of an authenticated session. ' +
      'Remove it and re-run.',
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`Refusing to use ${dir}: it exists and is not a directory.`);
  }
  // POSIX only — process.getuid is undefined on Windows, where this check has
  // no equivalent and the jumpbox threat model does not apply.
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(
      `Refusing to use ${dir}: it is owned by uid ${st.uid}, not this process ` +
      `(uid ${process.getuid()}). Remove it and re-run.`,
    );
  }
  return dir;
}
