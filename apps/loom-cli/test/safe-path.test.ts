/**
 * Regression suite for the CLI's "the server told me where to write" defect
 * (CodeQL js/http-to-file-access, alert 635 — `loom apps run-local`).
 *
 * `run-local` fetches an app's build context over HTTP and writes each returned
 * file to disk. Before `containedJoin`, the returned `path` was passed straight
 * to `path.join(dir, …)`, which resolves `..` — so a response could write
 * anywhere the CLI user can write.
 *
 * MUTATION CONTRACT, verified by applying it. Restoring `join(dir, f.path)` in
 * `writeBuildContext` turns exactly THREE tests RED — `3 failed | 24 passed
 * (27)` — all of them in this block:
 *   `writeBuildContext does not write outside the output directory`
 *
 *   - a traversal entry leaves the neighbouring file byte-identical
 *     → AssertionError: expected 'PWNED' to be 'ORIGINAL'
 *   - creates NOTHING when any entry in the context is hostile (all-or-nothing)
 *     → expected [Function] to throw an error
 *   - an absolute path does not overwrite the file it names
 *     → expected 'ENOENT…' to match /Refusing to write a file/
 *
 * The `containedJoin refuses every escape a build context could carry` cases do
 * NOT go red, and cannot: they call `containedJoin` directly, so no mutation of
 * `writeBuildContext` can reach them. They are the helper's own contract; the
 * block above is the call site's. An earlier version of this comment claimed
 * both halves went red, and named a block that does not exist in this file, so
 * a reader who tried to check it found nothing to check. A proof that does not
 * hold is worse than no proof (#2869 F4). Every block and test name above is
 * quoted verbatim from a `describe`/`it` string below — grep for it.
 *
 * The `CONTROL` block passes both before and after, so a "fix" that simply
 * refuses everything is caught too.
 *
 * WHAT THIS SUITE DOES NOT CATCH, established by mutation rather than assumed:
 * emptying the `..` rejection inside `containedJoin` — leaving the `if` and
 * deleting its `refuse` — keeps all 27 tests GREEN, because the post-resolve
 * `base + sep` layer still rejects those same inputs. Defence in depth means no
 * single layer's loss is observable here. That is why the CI guard asserts each
 * layer separately AND asserts that each one actually refuses
 * (`scripts/ci/check-remote-path-containment.mjs`, M14-M16).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { containedJoin } from '../src/safe-path.js';
import { writeBuildContext } from '../src/commands/apps.js';

let root: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loom-safe-path-'));
  outDir = join(root, 'workdir', 'loom-app-abc12345');
  mkdirSync(outDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── The paths a hostile / compromised / misconfigured API could return ───────
const ESCAPES: Array<[label: string, path: string]> = [
  ['posix parent traversal', '../../../.ssh/authorized_keys'],
  ['windows parent traversal', '..\\..\\..\\evil.txt'],
  ['mixed traversal', 'app/../../../evil.txt'],
  ['single parent hop', '../escaped.txt'],
  ['posix absolute', '/etc/cron.d/evil'],
  ['double-slash absolute', '//etc/cron.d/evil'],
  ['windows drive absolute', 'C:\\Windows\\evil.bat'],
  ['windows drive forward-slash', 'C:/Windows/evil.bat'],
  ['windows drive relative', 'D:evil.txt'],
  ['UNC share', '\\\\attacker\\share\\evil'],
  ['NUL truncation', 'ok.txt\u0000/../../evil'],
  ['empty path', ''],
  ['whitespace-only path', '   '],
  ['dot only', '.'],
];

describe('containedJoin refuses every escape a build context could carry', () => {
  for (const [label, p] of ESCAPES) {
    it(`refuses ${label}`, () => {
      expect(() => containedJoin(outDir, p)).toThrow(/Refusing to write a file/);
    });
  }

  it('refuses a non-string path (a response field that is a number/object/null)', () => {
    for (const bad of [null, undefined, 42, { path: 'x' }, ['a']]) {
      expect(() => containedJoin(outDir, bad)).toThrow(/Refusing to write a file/);
    }
  });

  it('does not mistake a SIBLING directory with a shared name prefix for a child', () => {
    // resolve('/tmp/app', '../appEVIL') === '/tmp/appEVIL', which startsWith
    // '/tmp/app'. The check must compare against base + separator.
    const base = join(root, 'app');
    mkdirSync(base, { recursive: true });
    expect(() => containedJoin(base, '../appEVIL/x.txt')).toThrow(/Refusing to write a file/);
  });
});

describe('CONTROL — legitimate build-context paths still resolve and still write', () => {
  const LEGIT = [
    'app.py',
    'requirements.txt',
    'src/nested/deep/module.py',
    'Dockerfile',
    '.streamlit/config.toml',
    'a-b_c.1/file-2.json',
  ];

  for (const p of LEGIT) {
    it(`accepts ${p}`, () => {
      const abs = containedJoin(outDir, p);
      expect(abs.startsWith(resolve(outDir) + sep)).toBe(true);
    });
  }

  it('writeBuildContext materializes a normal context tree', () => {
    const n = writeBuildContext(outDir, [
      { path: 'app.py', content: 'print("hi")' },
      { path: 'src/nested/mod.py', content: 'X = 1' },
      { path: 'Dockerfile', content: 'FROM python:3.12-slim' },
    ]);
    expect(n).toBe(3);
    expect(readFileSync(join(outDir, 'app.py'), 'utf-8')).toBe('print("hi")');
    expect(readFileSync(join(outDir, 'src', 'nested', 'mod.py'), 'utf-8')).toBe('X = 1');
    expect(readFileSync(join(outDir, 'Dockerfile'), 'utf-8')).toBe('FROM python:3.12-slim');
  });
});

describe('writeBuildContext does not write outside the output directory', () => {
  it('a traversal entry leaves the neighbouring file byte-identical', () => {
    // A real-world target: a file that already exists next to the output dir.
    const victim = join(root, 'victim.txt');
    writeFileSync(victim, 'ORIGINAL', 'utf-8');

    // Deliberately NOT `expect(...).toThrow()` first: if the write happens, the
    // interesting failure is the overwrite, not the missing throw. Swallow the
    // error so the containment assertion below always runs and the failure
    // message names the actual damage.
    let threw: unknown;
    try {
      writeBuildContext(outDir, [
        { path: 'app.py', content: 'ok' },
        { path: '../../victim.txt', content: 'PWNED' },
      ]);
    } catch (e) {
      threw = e;
    }

    // THE defect. Under the pre-fix `join(dir, f.path)` this reads 'PWNED'.
    expect(readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(String((threw as Error)?.message)).toMatch(/Refusing to write a file/);
  });

  it('creates NOTHING when any entry in the context is hostile (all-or-nothing)', () => {
    // `../../` escapes outDir but lands inside `root`, which afterEach removes.
    // An escape target further up (the OS temp dir) would leak between runs and
    // make this spec order-dependent — it did, the first time it was mutated.
    const marker = join(root, 'loom-escape-marker.txt');
    expect(existsSync(marker)).toBe(false);

    expect(() =>
      writeBuildContext(outDir, [
        { path: 'app.py', content: 'ok' },
        { path: '../../loom-escape-marker.txt', content: 'PWNED' },
      ]),
    ).toThrow(/Refusing to write a file/);

    // Nothing outside …
    expect(existsSync(marker)).toBe(false);
    // … and nothing inside either, so no half-written tree gets `docker build`ed.
    expect(existsSync(join(outDir, 'app.py'))).toBe(false);
  });

  it('an absolute path does not overwrite the file it names', () => {
    const victim = join(root, 'abs-victim.txt');
    writeFileSync(victim, 'ORIGINAL', 'utf-8');
    let threw: unknown;
    try {
      writeBuildContext(outDir, [{ path: victim, content: 'PWNED' }]);
    } catch (e) {
      threw = e;
    }
    expect(readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(String((threw as Error)?.message)).toMatch(/Refusing to write a file/);
  });

  it('rejects a response whose `files` is not an array instead of crashing', () => {
    expect(() => writeBuildContext(outDir, undefined as never)).toThrow(/no `files` array/);
    expect(() => writeBuildContext(outDir, { files: [] } as never)).toThrow(/no `files` array/);
  });
});
