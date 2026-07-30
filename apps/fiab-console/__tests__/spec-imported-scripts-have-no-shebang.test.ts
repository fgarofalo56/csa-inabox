/**
 * CLASS GUARD — a `scripts/**.mjs` that a vitest spec imports must NOT start
 * with a shebang.
 *
 * Found 2026-07-28 (round-3 review of PR #2611). vite-node evaluates an
 * out-of-root `.mjs` through `vm.Script`, which does not strip `#!`, so the
 * importing spec dies at COLLECTION with `SyntaxError: Invalid or unexpected
 * token` — reported as "Failed Suites 1 / no tests", which is easy to scroll
 * past. THREE specs were dark this way at once:
 *
 *   - lib/azure/__tests__/unity-audit-guard.test.ts   (14 attack tests — the
 *     entire deliverable of the LU-3 audit choke point)
 *   - lib/api/__tests__/ratchet-count-helper.test.ts  (6)
 *   - lib/api/__tests__/route-toolkit-codemod.test.ts
 *
 * None of them had ever executed. Every one of these scripts is invoked as
 * `node scripts/…`, so the shebang buys nothing and costs the coverage.
 *
 * This test fails the moment a shebang comes back, or a NEW spec imports a
 * shebang'd script — so the class stays closed instead of the three instances.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(test|spec)\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Every `scripts/**.mjs` referenced by a spec, as a repo-relative path. */
function scriptsImportedBySpecs(): Map<string, string[]> {
  const byScript = new Map<string, string[]>();
  const re = /['"][^'"]*?(scripts\/[A-Za-z0-9._/-]+\.mjs)['"]/g;
  for (const spec of [...walk(path.join(APP_ROOT, 'lib')), ...walk(path.join(APP_ROOT, 'app')), ...walk(path.join(APP_ROOT, '__tests__'))]) {
    const src = fs.readFileSync(spec, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const rel = m[1];
      if (!byScript.has(rel)) byScript.set(rel, []);
      byScript.get(rel)!.push(path.relative(APP_ROOT, spec).split(path.sep).join('/'));
    }
  }
  return byScript;
}

describe('vite-node cannot parse a shebang — spec-imported scripts must not have one', () => {
  const imported = scriptsImportedBySpecs();

  it('finds the scripts specs import (the scan itself must not silently go empty)', () => {
    expect(imported.size).toBeGreaterThan(0);
  });

  it('none of them starts with #!', () => {
    const offenders: string[] = [];
    for (const [rel, specs] of imported) {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) continue;
      const firstLine = fs.readFileSync(abs, 'utf8').split('\n', 1)[0];
      if (firstLine.startsWith('#!')) {
        offenders.push(`${rel} (imported by ${specs.join(', ')}) starts with "${firstLine.trim()}"`);
      }
    }
    // A failure here means the listed spec(s) are NOT RUNNING AT ALL.
    expect(offenders).toEqual([]);
  });
});
