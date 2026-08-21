#!/usr/bin/env node
/**
 * MEASUREMENT TOOL for `check-tid-boundary-chokepoint.mjs`'s declaration finder.
 *
 * WHY IT EXISTS: round 4 of that guard disclosed "17835 declarations before,
 * 21050 after, with ZERO true drops". The "after" reproduced and nothing else
 * did — the real before was 17958 rows / 17943 unique, and 137 declarations were
 * DROPPED while the net total went UP by 3092. The claim had been made by
 * comparing NET COUNTS, which cannot see a drop that a larger gain hides. This
 * script compares the SETS, keyed `(file, name)`, so the same mistake cannot be
 * made again silently.
 *
 * It runs EACH revision's OWN `mask` / `walk` / `declaredFunctions` over its OWN
 * `files` population, so neither side is measured with the other's parser.
 *
 *   node scripts/ci/measure-tid-guard-decl-sets.mjs <revA> <revB> [<revC> …]
 *   node scripts/ci/measure-tid-guard-decl-sets.mjs 8c3c4222 821de681 HEAD
 *
 * A revision is anything `git show <rev>:<path>` accepts, or `HEAD` / `WORKTREE`
 * for the working-tree copy. Prints the pairwise set differences and writes the
 * dropped keys to `temp/`. Node builtins only — no install, no dev server.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GUARD = 'scripts/ci/check-tid-boundary-chokepoint.mjs';
const SCAN_DIRS = ['apps/fiab-console/app', 'apps/fiab-console/lib'];
const OUT_DIR = 'temp';

const revs = process.argv.slice(2);
if (revs.length < 2) {
  console.error('usage: node scripts/ci/measure-tid-guard-decl-sets.mjs <revA> <revB> [<revC> …]');
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });

/**
 * A revision's guard, made importable: `process.exit(1)` neutered (the guard is a
 * script, and its own verdict is irrelevant to a declaration census) and the
 * three functions this measures exported.
 */
function harnessFor(rev) {
  const src =
    rev === 'WORKTREE'
      ? readFileSync(GUARD, 'utf8')
      : execFileSync('git', ['show', `${rev}:${GUARD}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const body =
    src.replaceAll('process.exit(1);', 'globalThis.__guardVerdict = 1;') +
    '\nexport { mask, walk, declaredFunctions };\n';
  const p = `${OUT_DIR}/tid-guard-${rev.replaceAll(/[^\w.-]/g, '_')}.mjs`;
  writeFileSync(p, body);
  return p;
}

function collect(mod) {
  const files = SCAN_DIRS.flatMap((d) => mod.walk(d));
  let rows = 0;
  const set = new Set();
  for (const f of files) {
    const rel = f.replaceAll('\\', '/');
    for (const fn of mod.declaredFunctions(mod.mask(readFileSync(f, 'utf8')))) {
      rows += 1;
      set.add(`${rel} :: ${fn.name}`);
    }
  }
  return { files: files.length, rows, set };
}

const measured = [];
for (const rev of revs) {
  const mod = await import(pathToFileURL(harnessFor(rev)).href);
  measured.push({ rev, ...collect(mod) });
}

console.log('');
console.log('=== declaration census, SET DIFF keyed (file, name) ===');
for (const m of measured) {
  console.log(`  ${m.rev.padEnd(12)} files ${m.files}   rows ${m.rows}   unique ${m.set.size}`);
}
console.log('');
for (let i = 0; i < measured.length; i += 1) {
  for (let j = 0; j < measured.length; j += 1) {
    if (i === j) continue;
    const a = measured[i];
    const b = measured[j];
    const dropped = [...a.set].filter((k) => !b.set.has(k)).sort();
    console.log(`  IN ${a.rev} AND NOT IN ${b.rev}: ${dropped.length}`);
    const p = `${OUT_DIR}/dropped-${a.rev.replaceAll(/[^\w.-]/g, '_')}-vs-${b.rev.replaceAll(/[^\w.-]/g, '_')}.txt`;
    writeFileSync(p, dropped.join('\n'));
    if (dropped.length > 0 && dropped.length <= 40) for (const d of dropped) console.log(`      ${d}`);
    else if (dropped.length > 40) console.log(`      (full list: ${p})`);
  }
}
