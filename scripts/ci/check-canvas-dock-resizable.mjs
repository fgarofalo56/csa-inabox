#!/usr/bin/env node
/**
 * GUARDRAIL: canvas-dock-resizable  (merge-blocker, RATCHET)  -- #3699, #4957
 * ------------------------------------------------------------------------
 * RULE (ux-baseline.md G3): every canvas dock / output / validation / bottom
 * panel is user-resizable through a sanctioned primitive (SplitPane,
 * ResizableCanvasRegion, StackedSplit). A new dock must not ship fixed-height,
 * and nobody hand-rolls a resize handle.
 *
 * !! BEST-EFFORT PATTERN MATCHING, NOT A COMPREHENSIVE GUARANTEE !!
 * This is a line/regex heuristic over source text, not an AST or a render. It
 * WILL miss: a dock named something the name pattern does not cover, a height
 * set through a variable/token/inline style, a handle built from non-listed
 * cursors, a dock in a directory outside SCAN_ROOTS, and a file that merely
 * mentions a primitive without wrapping the dock in it. A clean run means "no
 * KNOWN-SHAPE violation was added", NOT "every dock is resizable". Hardening
 * is tracked in #4957; pre-existing surfaces are #4952-#4957 and are not fixed
 * here.
 *
 * WHAT IT FLAGS (in SCAN_ROOTS, excluding tests):
 *   R1 FIXED_DOCK   a makeStyles class whose name looks like a dock/output/
 *                   validation/bottom panel and whose block sets a hard-coded
 *                   `height: <number>` or `height: '<n>px'` (min/max-height are
 *                   fine), in a file that does not reference any sanctioned
 *                   primitive.
 *   R2 HANDROLLED   `cursor: 'row-resize'|'ns-resize'|'col-resize'|'ew-resize'`
 *                   or an element with role="separator" AND onPointerDown,
 *                   outside the sanctioned primitives' own files.
 *
 * RATCHET: ALLOWLIST holds the pre-existing hits as `rule|file` -> count.
 * A hit beyond its allowance fails; an allowlist entry that no longer hits
 * fails too (lower/delete it -- the ratchet only tightens).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONSOLE = 'apps/fiab-console';
export const SCAN_ROOTS = [
  `${CONSOLE}/lib/editors`,
  `${CONSOLE}/lib/components/canvas`,
  `${CONSOLE}/lib/components/pipeline`,
];
export const PRIMITIVE_RE = /\b(?:SplitPane|ResizableCanvasRegion|StackedSplit)\b/;
// The primitives' own files may hand-roll handles (that is their job).
export const SANCTIONED_FILES = new Set([
  `${CONSOLE}/lib/components/shared/split-pane.tsx`,
  `${CONSOLE}/lib/components/shared/stacked-split.tsx`,
  `${CONSOLE}/lib/components/canvas/resizable-canvas.tsx`,
]);
const DOCK_NAME_RE = /dock|(?:output|validation|bottom|results?)(?:panel|pane|strip|drawer|stack|region)/i;
const FIXED_HEIGHT_RE = /(?<![A-Za-z])height\s*:\s*(?:\d+|['"`]\d+px['"`])\s*[,}\n]/;
const RESIZE_CURSOR_RE = /cursor\s*:\s*['"`](?:row|ns|col|ew)-resize['"`]/;
const SKIP_DIRS = new Set(['node_modules', '.next', '__tests__', '__fixtures__']);

// Pre-existing hits at the time of writing (measured). Ratchet: counts only go down.
export const ALLOWLIST = new Map([
  // Report-visual element resize handles (n/e/s/w), not a dock: a known false
  // positive of the cursor heuristic, allowlisted rather than special-cased.
  ['R2|apps/fiab-console/lib/editors/report/free-form-canvas.tsx', 4],
]);

function stripComments(src) {
  // Keep newlines so line numbers survive.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

/** Pure detector: returns [{rule, line, detail}] for one file's text. */
export function scanSource(relPath, rawSrc) {
  const src = stripComments(rawSrc);
  const hits = [];
  if (SANCTIONED_FILES.has(relPath)) return hits;
  const lines = src.split('\n');
  if (!PRIMITIVE_RE.test(src)) {
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*([A-Za-z_]\w*)\s*:\s*\{/.exec(lines[i]);
      const name = m && m[1];
      if (!name || !DOCK_NAME_RE.test(name)) continue;
      let depth = 0;
      let block = '';
      for (let j = i; j < lines.length; j++) {
        const seg = j === i ? lines[j].slice(lines[j].indexOf('{')) : lines[j];
        block += seg + '\n';
        for (const ch of seg) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
        if (depth <= 0) break;
      }
      if (FIXED_HEIGHT_RE.test(block)) {
        hits.push({ rule: 'R1', line: i + 1, detail: `fixed-height dock class "${name}"` });
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (RESIZE_CURSOR_RE.test(lines[i])) {
      hits.push({ rule: 'R2', line: i + 1, detail: 'hand-rolled resize cursor' });
    }
    if (/role\s*=\s*["']separator["']/.test(lines[i])) {
      const win = lines.slice(i, i + 8).join('\n');
      if (/onPointerDown/.test(win)) {
        hits.push({ rule: 'R2', line: i + 1, detail: 'role=separator with onPointerDown' });
      }
    }
  }
  return hits;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Scan a repo root; returns {scanned, counts: Map<'R|file', n>, hits}. */
export function scanTree(root = REPO_ROOT) {
  const files = SCAN_ROOTS.flatMap((r) => walk(path.join(root, r)));
  const counts = new Map();
  const hits = [];
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    for (const h of scanSource(rel, fs.readFileSync(f, 'utf8'))) {
      const key = `${h.rule}|${rel}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      hits.push({ ...h, file: rel });
    }
  }
  return { scanned: files.length, counts, hits };
}

/** Compare counts to the allowlist; returns problem strings. */
export function evaluate(counts, allow = ALLOWLIST) {
  const problems = [];
  for (const [key, n] of counts) {
    const cap = allow.get(key) ?? 0;
    if (n > cap) problems.push(`NEW ${key}: ${n} hit(s), allowlist permits ${cap}`);
  }
  for (const [key, cap] of allow) {
    if ((counts.get(key) ?? 0) < cap) {
      problems.push(`STALE allowlist ${key}: allows ${cap}, found ${counts.get(key) ?? 0} -- lower or delete it`);
    }
  }
  return problems;
}

function main() {
  const { scanned, counts, hits } = scanTree();
  console.log(`[canvas-dock-resizable] scanned ${scanned} files (best-effort heuristic; see header)`);
  if (scanned === 0) {
    console.error('[canvas-dock-resizable] FAIL: scanned 0 files -- SCAN_ROOTS are wrong; an empty scan is not clean.');
    process.exit(1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  console.log(`[canvas-dock-resizable] hits: ${total}, allowlisted keys: ${ALLOWLIST.size}`);
  const problems = evaluate(counts);
  if (problems.length) {
    console.error('\n[canvas-dock-resizable] FAIL:');
    for (const p of problems) console.error(`  - ${p}`);
    for (const h of hits) console.error(`    ${h.file}:${h.line} [${h.rule}] ${h.detail}`);
    console.error('\nFix: wrap the dock in StackedSplit / SplitPane / ResizableCanvasRegion (ux-baseline.md G3).');
    process.exit(1);
  }
  console.log('[canvas-dock-resizable] OK -- no new fixed-height docks or hand-rolled resize handles (best-effort).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
