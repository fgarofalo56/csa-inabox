/**
 * safe-path — containment for filesystem paths whose segments came off the wire.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `loom apps run-local` downloads an app's assembled build context from the
 * Loom API and writes each returned file to the developer's disk:
 *
 *     for (const f of ctx.files) writeFileSync(join(dir, f.path), f.content)
 *
 * `f.path` is a value the CLI received over HTTP. `path.join` happily resolves
 * `..` segments, so a response carrying `../../../.ssh/authorized_keys` writes
 * outside `dir` with the CLI user's privileges — the tar-slip / zip-slip class.
 *
 * The console's `assembleBuildContext()` does sanitize those paths today, and
 * every escape vector tested against it is blocked. That is NOT a reason for
 * the client to skip the check:
 *
 *   - The API base URL is operator-supplied (`loom auth login --api-url …`).
 *     A typo'd, hostile, or MITM'd host is a plain HTTP response as far as the
 *     CLI is concerned, and the CLI cannot observe that the peer sanitized.
 *   - The server guard lives in one function on the other side of a network
 *     boundary and a version skew. A client that writes wherever the server
 *     points is one server-side regression away from arbitrary file write on
 *     every developer workstation that runs the command.
 *
 * So containment is asserted HERE, by the process that owns the filesystem.
 *
 * KNOWN LIMIT (stated rather than papered over): this validates the path, not
 * the filesystem. A pre-existing symlink *inside* `baseDir` that points out of
 * it would still be followed by a subsequent write. `run-local` targets a fresh
 * output directory, so there is no attacker-placed symlink to follow; a caller
 * that writes into a directory an attacker can pre-populate needs `O_NOFOLLOW`
 * semantics on top of this.
 */
import { resolve, sep } from 'node:path';
import { CliError } from './errors.js';

/**
 * Join an UNTRUSTED relative path onto a local base directory, refusing
 * anything that could land outside it.
 *
 * Returns the absolute path to write. Throws `CliError` — never returns a
 * path the caller must remember to re-check — when `untrustedRelPath` is
 * empty, absolute, contains a `..` segment, smuggles a Windows separator or
 * drive letter, contains a NUL, or resolves outside `baseDir`.
 */
export function containedJoin(baseDir: string, untrustedRelPath: unknown): string {
  const base = resolve(baseDir);
  const rel = typeof untrustedRelPath === 'string' ? untrustedRelPath.trim() : '';

  const refuse = (why: string): never => {
    throw new CliError(
      `Refusing to write a file the server named "${String(untrustedRelPath)}": ${why}. ` +
        'A build context may only contain relative paths inside the output directory. ' +
        'Check that --api-url points at your Loom console.',
    );
  };

  if (!rel) refuse('the path is empty');
  // NUL truncates the path in some syscalls — "a.txt\0../../evil" is two paths.
  if (rel.includes('\0')) refuse('it contains a NUL byte');
  // Backslash is a separator on Windows and a literal elsewhere, so a path
  // containing one means something different depending on where the CLI runs.
  // A build context is always POSIX-relative; refuse rather than guess.
  if (rel.includes('\\')) refuse('it contains a backslash');
  if (rel.startsWith('/')) refuse('it is an absolute path');
  // `C:\…`, `C:/…` and the drive-RELATIVE `C:file` form.
  if (/^[A-Za-z]:/.test(rel)) refuse('it names a Windows drive');
  if (rel.split('/').some((s) => s === '..')) refuse('it contains a ".." segment');

  const abs = resolve(base, rel);

  // FINAL containment assertion. The syntactic rules above are the readable
  // part; this is the one that holds even for a normalization quirk none of
  // them anticipated. `base + sep` (not `base`) so a sibling directory whose
  // name merely starts with the base name — `/tmp/appX` vs `/tmp/app` — is not
  // mistaken for a child.
  if (!abs.startsWith(base + sep)) refuse('it resolves outside the output directory');

  return abs;
}
