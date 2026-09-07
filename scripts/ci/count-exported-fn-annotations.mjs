#!/usr/bin/env node
/*
 * count-exported-fn-annotations.mjs — re-derive how many exported function
 * declarations in the console carry a return-type ANNOTATION, and how many do
 * not.
 *
 * WHY THIS IS A SCRIPT AND NOT A NUMBER IN A COMMENT (#3850 residual 1)
 *
 *   check-tid-boundary-chokepoint.mjs's round-5 docblock argued that dropping a
 *   candidate for having no readable return type is a filter on a property the
 *   AUTHOR PICKS FREELY, and supported it with "2999 unannotated against 7719
 *   annotated". That figure named no population and no command, so nobody could
 *   tell whether it had gone stale — and it had: the same measurement today
 *   returns different numbers on a console that has grown by thousands of files.
 *
 *   A count asserted once and never re-derived is the same defect family as an
 *   exemption whose reason outlives the body it was written about. This makes
 *   the number reproducible instead of quoted:
 *
 *     node scripts/ci/count-exported-fn-annotations.mjs
 *
 *   It is a MEASUREMENT, not a gate. It exits 0 whatever it finds, has no
 *   threshold, and nothing in CI depends on it — a guard's supporting evidence
 *   should be re-runnable without becoming another thing that can go red.
 *
 * POPULATION (stated, because a count without one means nothing)
 *
 *   Every `export [default] [async] function <name>(…)` declaration under the
 *   given root (default `apps/fiab-console`) in *.ts / *.tsx, excluding
 *   node_modules, .next, dist, build, coverage and __generated__. A declaration
 *   is ANNOTATED when the first non-space character after the balanced closing
 *   paren of its parameter list is `:`.
 *
 *   Deliberately NOT a parser, and deliberately not counting arrow-function
 *   exports: the docblock's claim is about `export function` declarations, which
 *   is the exact shape the chokepoint derivation reads. Widening the population
 *   here would make the number stop answering the question it is cited for.
 *
 * Usage: node scripts/ci/count-exported-fn-annotations.mjs [root]
 */

import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '__generated__']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue;
      yield* walk(path.join(dir, e.name));
    } else if (/\.tsx?$/.test(e.name)) {
      yield path.join(dir, e.name);
    }
  }
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function countAnnotations(root) {
  const DECL = /\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>\s*)?\(/g;
  let annotated = 0;
  let unannotated = 0;
  let files = 0;
  for (const f of walk(root)) {
    files += 1;
    const src = fs.readFileSync(f, 'utf8');
    DECL.lastIndex = 0;
    let m;
    while ((m = DECL.exec(src)) !== null) {
      const close = closeParen(src, m.index + m[0].length - 1);
      if (close === -1) continue;
      if (src.slice(close + 1).replace(/^\s+/, '').startsWith(':')) annotated += 1;
      else unannotated += 1;
    }
  }
  return { files, annotated, unannotated, total: annotated + unannotated };
}

const root = path.resolve(process.argv[2] ?? path.join('apps', 'fiab-console'));
if (!fs.existsSync(root)) {
  // R7 — say what was actually established, which is that the path is absent.
  process.stderr.write(`count-exported-fn-annotations: no such root: ${root}\n`);
  process.exit(2);
}
const r = countAnnotations(root);
process.stdout.write(
  `root=${root}\nfiles=${r.files}\nannotated=${r.annotated}\nunannotated=${r.unannotated}\ntotal=${r.total}\n`,
);
