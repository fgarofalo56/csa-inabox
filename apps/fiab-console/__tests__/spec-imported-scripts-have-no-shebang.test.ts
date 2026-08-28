/**
 * CLASS GUARD — a `scripts/**.mjs` that a vitest spec IMPORTS must NOT start
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
 * ── #4057: IT NOW READS IMPORTS, NOT QUOTED STRINGS ────────────────────────
 *
 * This guard used to key on
 *
 *     /['"][^'"]*?(scripts\/[A-Za-z0-9._\/-]+\.mjs)['"]/g
 *
 * scanned over RAW spec source — the PRESENCE of a quoted literal, never an
 * import specifier. It could not tell an import from a mention, so any spec that
 * legitimately NAMED a script — in an assertion, a fixture value, or a comment —
 * was treated as importing it.
 *
 * Measured in #4022: `population-contract.test.ts` asserted on a ledger entry
 * whose `subject` field is the string `scripts/ci/check-route-guards.mjs`, and
 * this guard reddened. But that spec imports only `vitest` and three `../`
 * siblings, and its 20 tests RAN AND PASSED in the same suite the guard failed —
 * which makes the guard's own error text ("the listed spec(s) are NOT RUNNING AT
 * ALL") false in that instance. An error asserting a state the run disproves is
 * the `deploy-integrity.md` R7 shape.
 *
 * The workaround both times was to SPLIT THE STRING LITERAL so the pattern no
 * longer matched — once in `join.test.ts`, once in `population-contract.test.ts`,
 * two dodges in one PR. Individually correct, collectively a slow erosion: every
 * future spec that legitimately names a script learns to split the literal and
 * the population wears away one justified dodge at a time. Both dodges are
 * reverted to single literals by this change, and that reversion IS the
 * acceptance test.
 *
 * WHAT THE POPULATION DID, and it is a DROP, stated rather than glossed:
 * the string scan matched 13 script paths over 17 entries, of which 6 exist on
 * disk and only 4 are genuinely imported. The import graph sees those 4. The two
 * real-but-dropped files were never coverage:
 *   - `scripts/csa-loom/backfill-workspace-tid.mjs` appears in five specs as a
 *     REMEDIATION STRING (`expect(j.remediation).toContain(...)`). Nothing
 *     imports it, so it cannot break a spec, so watching it protected nothing.
 *   - `scripts/ci/check-no-freeform.mjs` is SPAWNED by
 *     `wave1a-adopted-surfaces.test.tsx` (`spawnSync(process.execPath, [...])`),
 *     which is immune to the shebang problem by construction — a subprocess
 *     `node` strips `#!` itself.
 * Dropping a false positive is not the same as losing coverage, and the four
 * genuinely-importing specs — the only ones that CAN go dark — are all still
 * watched.
 *
 * A GUARD WITH NO POPULATION IS WORSE THAN THE FALSE POSITIVE, so the tree scan
 * is backed by embedded controls (P1-P5 must be SEEN, N1-N4 must NOT be) that
 * run the REAL extractor over synthetic sources, plus a positive control that
 * runs the REAL offender check over a synthetic shebang-carrying script. Those
 * controls hold the line even on a tree where every spec stops importing scripts.
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

/**
 * Blank comments and template-literal bodies, preserving offsets and newlines.
 *
 * Without this, a `// see scripts/ci/foo.mjs` in a docblock is indistinguishable
 * from an import to a regex — which is half of what #4057 is about. Ordinary
 * string bodies are LEFT INTACT because the specifier itself is a string; only
 * the containers that can hold prose are blanked.
 */
function blankProse(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (src[i] === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (src[i] === '"' || src[i] === "'") {
      // Skip over an ordinary string WITHOUT blanking it — the import specifier
      // lives inside one, and blanking it here would defeat the whole guard.
      const q = src[i];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === q) break;
        j += 1;
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Module specifiers a spec actually LOADS.
 *
 * Every form that makes vite-node evaluate the target: static `import`/`export
 * … from`, a bare side-effect `import '…'`, `require(…)`, dynamic `import(…)`,
 * and `vi.mock`/`vi.doMock` (which resolves the path even when the factory
 * replaces the module — a bad resolve there still fails collection).
 *
 * Exported so the embedded controls below run THIS function rather than a
 * paraphrase of it. A control that re-implements what it controls proves nothing.
 */
export function importSpecifiersIn(rawSource: string): string[] {
  const src = blankProse(rawSource);
  const out: string[] = [];
  const patterns = [
    /(?:^|[\s;})])(?:import|export)\s[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;})])import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bvi\s*\.\s*(?:mock|doMock)\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

/**
 * The repo-relative paths of every OUT-OF-ROOT `.mjs` one spec loads.
 *
 * KEYED ON THE MECHANISM, NOT ON A DIRECTORY NAME. The breakage is that
 * vite-node evaluates a module OUTSIDE the vite root (`apps/fiab-console`)
 * through `vm.Script`, which does not strip `#!`. A `.mjs` INSIDE the app root
 * goes through the normal transform and is unaffected, and a `.mjs` outside it is
 * affected whether or not it happens to live under a directory called `scripts`.
 * The old string pattern was spelled `scripts/…`, so `sdk/scripts/…` or any
 * future sibling would have needed a second rule; this needs none.
 *
 * A bare package specifier (`vitest`, `node:fs`) resolves to a dependency rather
 * than into this repo, so it is skipped rather than guessed at — this reads the
 * import graph, it does not re-implement node resolution.
 */
export function scriptImportsIn(rawSource: string, specAbsPath: string, repoRoot: string, appRoot: string): string[] {
  const out = new Set<string>();
  for (const spec of importSpecifiersIn(rawSource)) {
    let abs: string | null = null;
    if (spec.startsWith('.')) abs = path.resolve(path.dirname(specAbsPath), spec);
    else if (spec.startsWith('@/')) abs = path.resolve(appRoot, spec.slice(2));
    if (!abs) continue;
    if (!abs.endsWith('.mjs')) continue;
    const fromRepo = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (fromRepo.startsWith('..')) continue;            // outside the repo entirely
    const fromApp = path.relative(appRoot, abs).split(path.sep).join('/');
    if (!fromApp.startsWith('..')) continue;            // inside the vite root — safe
    out.add(fromRepo);
  }
  return [...out];
}

/** Every `scripts/**.mjs` a spec IMPORTS, as a repo-relative path. */
function scriptsImportedBySpecs(): Map<string, string[]> {
  const byScript = new Map<string, string[]>();
  for (const spec of [
    ...walk(path.join(APP_ROOT, 'lib')),
    ...walk(path.join(APP_ROOT, 'app')),
    ...walk(path.join(APP_ROOT, '__tests__')),
  ]) {
    const src = fs.readFileSync(spec, 'utf8');
    for (const rel of scriptImportsIn(src, spec, REPO_ROOT, APP_ROOT)) {
      if (!byScript.has(rel)) byScript.set(rel, []);
      byScript.get(rel)!.push(path.relative(APP_ROOT, spec).split(path.sep).join('/'));
    }
  }
  return byScript;
}

/**
 * The offenders, given a population and a way to read a first line.
 *
 * Factored out so the positive control can run the REAL check over a synthetic
 * script that DOES carry a shebang — the tree cannot demonstrate that, because
 * on a healthy tree there is nothing to find.
 */
export function shebangOffenders(
  imported: Map<string, string[]>,
  firstLineOf: (rel: string) => string | null,
): string[] {
  const offenders: string[] = [];
  for (const [rel, specs] of imported) {
    const firstLine = firstLineOf(rel);
    if (firstLine === null) continue;
    if (firstLine.startsWith('#!')) {
      offenders.push(`${rel} (imported by ${specs.join(', ')}) starts with "${firstLine.trim()}"`);
    }
  }
  return offenders;
}

const firstLineOnDisk = (rel: string): string | null => {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8').split('\n', 1)[0];
};

describe('vite-node cannot parse a shebang — spec-imported scripts must not have one', () => {
  const imported = scriptsImportedBySpecs();

  it('finds the scripts specs import (the scan itself must not silently go empty)', () => {
    expect(imported.size).toBeGreaterThan(0);
  });

  it('every entry it found is a file that EXISTS (the resolve is real, not a guess)', () => {
    // The old string scan matched 13 paths of which 7 did not exist at all —
    // fictional fixture names that were silently skipped downstream. A resolved
    // import that points at nothing means the parser produced a path no module
    // loader would, which is a broken guard rather than a small one.
    for (const rel of imported.keys()) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} was resolved but does not exist`).toBe(true);
    }
  });

  it('none of them starts with #!', () => {
    // A failure here means the listed spec(s) are NOT RUNNING AT ALL — and now
    // that claim is TRUE when it is made, because the population is what the
    // spec loads rather than what it mentions (R7, #4057).
    expect(shebangOffenders(imported, firstLineOnDisk)).toEqual([]);
  });
});

/**
 * EMBEDDED CONTROLS — the tree cannot demonstrate either direction.
 *
 * On a healthy tree there is no shebang to find, so the negative arm above is
 * green whether the extractor works or not; and the false positives #4057 is
 * about have all been removed from the tree, so nothing there exercises the
 * mention-vs-import distinction either. These run the REAL `importSpecifiersIn`
 * / `scriptImportsIn` / `shebangOffenders` over synthetic sources.
 */
const SYNTH_SPEC = path.join(APP_ROOT, 'lib', 'x', '__tests__', 'synthetic.test.ts');
// FIVE levels: __tests__ -> x -> lib -> fiab-console -> apps -> repo root. The
// first cut of this file used four and the P-controls caught it, resolving to
// `apps/scripts/...` — which is exactly the job of a control that runs the real
// extractor rather than asserting a shape by eye.
const REL = '../../../../../scripts/ci/synthetic-guard.mjs';

const LOADS: ReadonlyArray<readonly [string, string]> = [
  ['P1 static named import', `import { a } from '${REL}';`],
  ['P2 bare side-effect import', `import '${REL}';`],
  ['P3 require()', `const a = require('${REL}');`],
  ['P4 dynamic import()', `const a = await import('${REL}');`],
  ['P5 vi.mock (resolves the path even when the factory replaces it)', `vi.mock('${REL}', () => ({ a: 1 }));`],
  ['P6 export … from', `export { a } from '${REL}';`],
];

const MENTIONS: ReadonlyArray<readonly [string, string]> = [
  ['N1 an assertion on a data structure', `expect(entry.subject).toBe('scripts/ci/synthetic-guard.mjs');`],
  ['N2 a line comment', `// see scripts/ci/synthetic-guard.mjs for the rule`],
  ['N3 a block comment', `/** documented in scripts/ci/synthetic-guard.mjs */`],
  ['N4 a fixture value', `const CORPUS = [{ path: 'scripts/ci/synthetic-guard.mjs', text: '' }];`],
  ['N5 a spawnSync argv entry (a subprocess node STRIPS the shebang itself)',
   `spawnSync(process.execPath, ['scripts/ci/synthetic-guard.mjs', '--report']);`],
  ['N6 a bare package specifier', `import { describe } from 'vitest';`],
  ['N7 a template literal mentioning the path', 'const msg = `run scripts/ci/synthetic-guard.mjs`;'],
  // The mechanism, asserted in the direction that would OVER-report: a `.mjs`
  // INSIDE the vite root is transformed normally and is immune, so widening the
  // guard to "any .mjs import" would accuse a safe file.
  ['N8 an IN-ROOT .mjs import (vite transforms it; the shebang problem is out-of-root only)',
   `import { x } from '../../../scripts/copy-monaco-assets.mjs';`],
];

describe('#4057 the guard keys on the IMPORT GRAPH, not on a quoted string', () => {
  for (const [name, source] of LOADS) {
    it(`SEES ${name}`, () => {
      const found = scriptImportsIn(source, SYNTH_SPEC, REPO_ROOT, APP_ROOT);
      expect(found).toEqual(['scripts/ci/synthetic-guard.mjs']);
    });
  }

  for (const [name, source] of MENTIONS) {
    it(`IGNORES ${name}`, () => {
      const found = scriptImportsIn(source, SYNTH_SPEC, REPO_ROOT, APP_ROOT);
      expect(found).toEqual([]);
    });
  }

  it('the control counts are asserted exactly (a control that stops matching is a FAILURE)', () => {
    // Without this, deleting entries from either table shrinks the suite in
    // silence — the same zero-population defect one level up from the guard.
    expect(LOADS.length).toBe(6);
    expect(MENTIONS.length).toBe(8);
  });

  it('POSITIVE CONTROL: a genuinely imported script that HAS a shebang is reported', () => {
    // The acceptance control. The tree cannot supply this — nothing under
    // scripts/ that a spec imports carries a `#!` today, which is the whole
    // point — so the offender check is run over a synthetic population with a
    // synthetic first line.
    const imported = new Map([['scripts/ci/synthetic-guard.mjs', ['lib/x/__tests__/synthetic.test.ts']]]);
    const offenders = shebangOffenders(imported, () => '#!/usr/bin/env node');
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain('scripts/ci/synthetic-guard.mjs');
    expect(offenders[0]).toContain('lib/x/__tests__/synthetic.test.ts');
  });

  it('NEGATIVE CONTROL: the same population without a shebang is clean', () => {
    // Otherwise the positive control above is satisfied by a check that reports
    // every entry regardless of what it read.
    const imported = new Map([['scripts/ci/synthetic-guard.mjs', ['lib/x/__tests__/synthetic.test.ts']]]);
    expect(shebangOffenders(imported, () => '/** no shebang here */')).toEqual([]);
  });

  it('a script that does not exist is SKIPPED, not reported as clean or dirty', () => {
    const imported = new Map([['scripts/ci/gone.mjs', ['lib/x/__tests__/synthetic.test.ts']]]);
    expect(shebangOffenders(imported, () => null)).toEqual([]);
  });
});
