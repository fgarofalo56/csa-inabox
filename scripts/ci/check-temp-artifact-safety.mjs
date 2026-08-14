#!/usr/bin/env node
/**
 * temp-artifact-safety guard — bans a FIXED path in a world-writable temp dir.
 *
 * WHY THIS EXISTS (CodeQL js/insecure-temporary-file, alerts #323 / #330).
 * The UAT harness wrote full-page screenshots of an AUTHENTICATED console
 * session to `/tmp/loom-uat`. `/tmp` is world-writable and the jumpbox is
 * multi-user, so any other local user can win the race to create that exact
 * path — as a directory they own and can read, or as a symlink into one — and
 * `mkdir -p` / `mkdirSync(…, {recursive:true})` succeed silently against BOTH.
 *
 * A hardened creator (`apps/fiab-console/tests/_artifact-dir.mjs`) was written
 * for those two alerts and the alerts stayed open, because THE FIX WAS NOT ON
 * THE PATH THAT RUNS. `scripts/csa-loom/uat-runner-final.sh` — the documented
 * jumpbox runner — does not execute the file in this tree; it `base64 -d`s an
 * EMBEDDED COPY that predates the module, imports nothing, and calls
 * `fs.mkdirSync('/tmp/loom-uat', {recursive:true})` bare.
 *
 * THAT is the shape this guard is built around, and it is why the guard
 * DECODES base64 blobs inside shell scripts and scans the decoded source too.
 * A grep over the tree would have reported this repo clean on the day the
 * vulnerable code was running. #2729 was the same lesson in the Dockerfile.
 *
 * WHAT IS FLAGGED
 *   - a string literal naming a fixed path under a shared temp root
 *     (`/tmp/x`, `/var/tmp/x`, `/dev/shm/x`)
 *   - `os.tmpdir()` / `$TMPDIR` joined with a CONSTANT name
 *   - `mkdir -p /tmp/x` in shell
 *
 * WHAT IS NOT
 *   - `mkdtempSync(path.join(os.tmpdir(), 'prefix-'))` — that is the correct
 *     API; the random suffix is the whole point
 *   - comments (stripped first — a guard that counts its own explanation is a
 *     guard that gets deleted)
 *   - anything in ALLOW below, each entry carrying a reason
 *
 * FIX A HIT with `apps/fiab-console/tests/_artifact-dir.mjs`:
 *     const DIR = ensureArtifactDir(defaultArtifactDir());
 * …which resolves `LOOM_UAT_ARTIFACT_DIR` else `~/.loom-uat` — a directory
 * only this user can write — and then verifies ownership + mode 0700.
 * For genuinely disposable scratch, `fs.mkdtempSync` is correct.
 *
 * Usage: node scripts/ci/check-temp-artifact-safety.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

const SCAN = [
  { dir: 'apps/fiab-console/tests', exts: ['.mjs', '.js', '.ts'] },
  { dir: 'apps/fiab-console/e2e', exts: ['.mjs', '.js', '.ts'] },
  { dir: 'scripts', exts: ['.mjs', '.js', '.sh'] },
  { dir: 'apps/loom-cli/src', exts: ['.ts'] },
];

const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', 'test-results']);

/** Shared temp roots. A fixed child of any of these is guessable by every local user. */
const SHARED_TMP_ROOTS = ['/tmp', '/var/tmp', '/dev/shm'];

/**
 * Strip comments so the guard never fires on prose describing the bug — the
 * file you are reading is itself full of `/tmp/loom-uat`, and so are the fixed
 * sources. Line comments only; that is enough for the languages scanned and it
 * cannot accidentally swallow code the way a naive block-comment regex can.
 *
 * @param {string} src
 * @returns {string[]} lines with comment bodies blanked (indices preserved)
 */
export function stripComments(src) {
  // PHYSICAL-LINES-OK: the shell-side patterns (`mkdir -p /tmp/...`, a fixed /tmp
  // path) are single tokens, so presence is the whole question. The two-token rule
  // (`os.tmpdir()` + a join) is JavaScript, which has no line continuation (#3420).
  return src.split('\n').map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')
      || trimmed.startsWith('/*')) return '';
    // Trailing comment on a code line. Not string-aware on purpose: blanking a
    // little too much can only ever make the guard quieter on that ONE line,
    // and the patterns below are re-checked on the untouched line for shell.
    const idx = line.indexOf(' //');
    if (idx > -1) return line.slice(0, idx);
    const hash = line.indexOf(' #');
    if (hash > -1 && !line.slice(0, hash).includes('"')) return line.slice(0, hash);
    return line;
  });
}

/**
 * A fixed path under a shared temp root, e.g. '/tmp/loom-uat'. The bare root
 * itself is not flagged — `/tmp` as a value is usually a base being combined
 * with something random, and flagging it produces noise that gets the guard
 * switched off.
 */
const FIXED_TMP_PATH = new RegExp(
  `(['"\`])(${SHARED_TMP_ROOTS.map((r) => r.replace('/', '\\/')).join('|')})\\/[A-Za-z0-9._-]+`,
  'g',
);

/** `mkdir -p /tmp/thing` / `mkdir /var/tmp/thing` in shell. */
const SHELL_MKDIR_TMP = new RegExp(
  `\\bmkdir\\b[^\\n]*\\s(${SHARED_TMP_ROOTS.join('|')})\\/[A-Za-z0-9._-]+`,
);

/**
 * `os.tmpdir()` / `tmpdir()` COMBINED with a constant name, without mkdtemp.
 *
 * The combination matters. An early version fired on any line mentioning
 * `os.tmpdir()`, which flagged
 *     assert.ok(!d.startsWith(os.tmpdir() + path.sep))
 * — an assertion that the default is NOT in the temp dir, i.e. the guard
 * reporting the code that proves the guard's own property. Allowlisting that
 * would have hidden a real over-broad heuristic behind an exception, so the
 * heuristic is narrowed instead: a path is only being BUILT when the line joins
 * or concatenates a literal onto it.
 */
const TMPDIR_CONST = /(?:os\.)?tmpdir\(\)/;
const TMPDIR_COMBINED = /(?:join\s*\(|\+\s*['"`])/;
const MKDTEMP = /mkdtemp(Sync)?\s*\(/;

/**
 * Allowed hits, each a CLAIM with a reason — never "trust me".
 * @type {{file: string, why: string}[]}
 */
const ALLOW = [
  {
    file: 'scripts/ci/check-temp-artifact-safety.mjs',
    why: 'this guard; its patterns necessarily contain the shapes it bans',
  },
  {
    file: 'scripts/ci/__tests__/temp-artifact-safety.test.mjs',
    why: 'the guard self-test; its fixtures are deliberately vulnerable strings',
  },
];

/**
 * Scan one source text. Exported so the self-test can drive it with fixtures
 * rather than needing files on disk.
 *
 * @param {string} src
 * @param {string} rel repo-relative path, used for reporting
 * @returns {{file:string,line:number,snippet:string,why:string}[]}
 */
export function scanSource(src, rel) {
  const out = [];
  const lines = stripComments(src);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    FIXED_TMP_PATH.lastIndex = 0;
    if (FIXED_TMP_PATH.test(line)) {
      out.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 120), why: 'fixed path under a shared temp root' });
      return;
    }
    if (SHELL_MKDIR_TMP.test(line)) {
      out.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 120), why: 'mkdir of a fixed path under a shared temp root' });
      return;
    }
    if (TMPDIR_CONST.test(line) && TMPDIR_COMBINED.test(line) && !MKDTEMP.test(line)) {
      out.push({ file: rel, line: i + 1, snippet: line.trim().slice(0, 120), why: 'os.tmpdir() with a constant name — use mkdtempSync' });
    }
  });
  return out;
}

/**
 * Pull base64-embedded payloads out of a shell script and decode them.
 *
 * THIS IS THE POINT OF THE GUARD. The vulnerable code that shipped was not
 * visible to any grep over the tree — it lived inside a base64 literal in
 * `uat-runner-final.sh`. A check that only reads what it can already see would
 * have called this repo clean while the bug ran.
 *
 * @param {string} src shell source
 * @returns {{payload: string, index: number}[]}
 */
export function decodeEmbeddedPayloads(src) {
  const out = [];
  // Long single-quoted base64 runs. 200+ chars so ordinary strings, hashes and
  // tokens are not mistaken for an embedded program.
  const re = /'([A-Za-z0-9+/=]{200,})'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let decoded;
    try {
      decoded = Buffer.from(m[1], 'base64').toString('utf8');
    } catch {
      continue;
    }
    // Only treat it as source if it decodes to something text-shaped.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0e-\x1f]/.test(decoded.slice(0, 400))) continue;
    out.push({ payload: decoded, index: m.index });
  }
  return out;
}

function walk(dir, exts, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function main() {
  const violations = [];
  for (const { dir, exts } of SCAN) {
    for (const file of walk(join(ROOT, dir), exts)) {
      const rel = relative(ROOT, file).split(sep).join('/');
      if (ALLOW.some((a) => a.file === rel)) continue;
      const src = readFileSync(file, 'utf8');
      violations.push(...scanSource(src, rel));
      if (rel.endsWith('.sh')) {
        for (const { payload } of decodeEmbeddedPayloads(src)) {
          violations.push(
            ...scanSource(payload, `${rel} (base64-embedded payload)`),
          );
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log('[temp-artifact-safety] OK — no fixed shared-temp artifact paths (embedded payloads decoded and scanned too).');
    process.exit(0);
  }

  console.error(`\n[temp-artifact-safety] FAIL — ${violations.length} unsafe temp path(s).\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}`);
    console.error(`    ${v.why}. A shared temp root is world-writable: another local`);
    console.error('    user can pre-create this exact path, or symlink it, and reads what you write.\n');
  }
  console.error("  Fix: import { ensureArtifactDir, defaultArtifactDir } from 'apps/fiab-console/tests/_artifact-dir.mjs'");
  console.error('       const DIR = ensureArtifactDir(defaultArtifactDir());   // LOOM_UAT_ARTIFACT_DIR else ~/.loom-uat');
  console.error('  Or, for true scratch, fs.mkdtempSync(path.join(os.tmpdir(), "prefix-")).\n');
  process.exit(1);
}

// Only run when invoked directly, so the self-test can import the helpers.
if (process.argv[1] && process.argv[1].endsWith('check-temp-artifact-safety.mjs')) main();
