#!/usr/bin/env node
/**
 * codemod-raw-px-to-tokens (rel-T56, one-shot)
 * ---------------------------------------------------------------------------
 * Mechanically rewrites raw NUMERIC px values on the spacing / font-size
 * properties of INLINE styles to the nearest Loom/Fluent design token, per the
 * web3-ui rule ("Raw numbers like `padding: 16` / `gap: 12` are a rule
 * violation; use the spacing tokens").
 *
 * SCOPE (deliberately narrow to stay safe):
 *   - `style={{ ... }}` JSX attribute object literals, and
 *   - objects annotated `: React.CSSProperties` / `: CSSProperties`.
 *   Only inside those style regions are properties rewritten, so a numeric
 *   `padding`/`gap`/`fontSize` consumed as a NUMBER by a chart/layout lib
 *   (recharts, react-flow, dagre) is never touched.
 *
 * GATED on the file already referencing `tokens.` — guarantees the `tokens`
 * symbol is in scope, so we add no imports and cannot break resolution.
 *
 * PROPERTIES: gap/columnGap/rowGap, padding*, margin*, fontSize. Shorthand
 * `padding`/`margin`/`gap` follow the operator's convention (gap→Horizontal,
 * padding/margin→Vertical); *Left/*Right/*Inline*→Horizontal,
 * *Top/*Bottom/*Block*→Vertical. Negative values and string values are left.
 *
 * Run:  node scripts/codemod-raw-px-to-tokens.mjs [--apply]
 *       (dry-run by default; prints per-file counts)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..'); // apps/fiab-console
const APPLY = process.argv.includes('--apply');

const SCOPE_DIRS = ['lib/editors', 'lib/panes', 'lib/components'];

// px -> spacing-token suffix (Fluent v9 spacing scale)
const SPACING_SCALE = [
  [0, 'None'], [2, 'XXS'], [4, 'XS'], [6, 'SNudge'], [8, 'S'],
  [10, 'MNudge'], [12, 'M'], [16, 'L'], [20, 'XL'], [24, 'XXL'], [32, 'XXXL'],
];
// px -> fontSize token (only mapped within tolerance 1px; else left alone)
const FONT_SCALE = [
  [10, 'fontSizeBase100'], [12, 'fontSizeBase200'], [14, 'fontSizeBase300'],
  [16, 'fontSizeBase400'], [20, 'fontSizeBase500'], [24, 'fontSizeBase600'],
  [28, 'fontSizeHero700'], [32, 'fontSizeHero800'], [40, 'fontSizeHero900'],
];

const HORIZONTAL = new Set([
  'gap', 'columnGap', 'paddingLeft', 'paddingRight', 'paddingInline',
  'paddingInlineStart', 'paddingInlineEnd', 'marginLeft', 'marginRight',
  'marginInline', 'marginInlineStart', 'marginInlineEnd',
]);
const VERTICAL = new Set([
  'rowGap', 'padding', 'paddingTop', 'paddingBottom', 'paddingBlock',
  'paddingBlockStart', 'paddingBlockEnd', 'margin', 'marginTop', 'marginBottom',
  'marginBlock', 'marginBlockStart', 'marginBlockEnd',
]);
const SPACING_PROPS = new Set([...HORIZONTAL, ...VERTICAL]);

function nearestSpacing(v) {
  let best = SPACING_SCALE[0];
  let bestD = Infinity;
  for (const [px, suffix] of SPACING_SCALE) {
    const d = Math.abs(px - v);
    if (d < bestD || (d === bestD && px > best[0])) { bestD = d; best = [px, suffix]; }
  }
  return best[1];
}
function fontToken(v) {
  for (const [px, name] of FONT_SCALE) if (Math.abs(px - v) <= 1) return name;
  return null; // outside tolerance -> leave as-is
}

function spacingToken(prop, v) {
  const axis = HORIZONTAL.has(prop) ? 'Horizontal' : 'Vertical';
  return `tokens.spacing${axis}${nearestSpacing(v)}`;
}

/**
 * Return array of [start,end) spans covering style regions in `src`:
 *   style={{ ... }}   and   : React.CSSProperties = { ... }
 * Brace-matched, string/template-aware.
 */
function styleRegions(src) {
  const spans = [];
  const pushBalanced = (openIdx) => {
    // openIdx points at the FIRST '{' of the object literal we want to scan.
    let depth = 0, inStr = null, i = openIdx;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) {
        if (c === '\\') { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { spans.push([openIdx, i + 1]); return i + 1; } }
    }
    return src.length;
  };
  // style={{ ... }}  -> the object literal starts at the 2nd '{'
  const styleRe = /style\s*=\s*\{\s*\{/g;
  let m;
  while ((m = styleRe.exec(src))) {
    const secondBrace = src.indexOf('{', src.indexOf('{', m.index) + 1);
    if (secondBrace >= 0) { const end = pushBalanced(secondBrace); styleRe.lastIndex = end; }
  }
  // : React.CSSProperties = {   and  : CSSProperties = {
  const cssRe = /:\s*(?:React\.)?CSSProperties\s*=\s*\{/g;
  while ((m = cssRe.exec(src))) {
    const brace = src.indexOf('{', m.index);
    if (brace >= 0) { const end = pushBalanced(brace); cssRe.lastIndex = end; }
  }
  return spans;
}

function transform(src) {
  const spans = styleRegions(src);
  if (!spans.length) return { out: src, count: 0 };
  // Property occurrence: `<prop>: <int>` (not negative, not followed by more
  // digits/px/%/'). Capture only bare integer literals used as a value.
  const propRe = /\b(gap|columnGap|rowGap|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingInline|paddingInlineStart|paddingInlineEnd|paddingBlock|paddingBlockStart|paddingBlockEnd|margin|marginTop|marginBottom|marginLeft|marginRight|marginInline|marginInlineStart|marginInlineEnd|marginBlock|marginBlockStart|marginBlockEnd|fontSize)\s*:\s*(\d+)(?=\s*[,}\n])/g;
  let count = 0;
  // Process spans right-to-left so indices stay valid.
  let out = src;
  const sortedSpans = spans.slice().sort((a, b) => b[0] - a[0]);
  for (const [s, e] of sortedSpans) {
    const region = out.slice(s, e);
    const replaced = region.replace(propRe, (full, prop, numStr) => {
      const v = parseInt(numStr, 10);
      if (SPACING_PROPS.has(prop)) { count++; return `${prop}: ${spacingToken(prop, v)}`; }
      if (prop === 'fontSize') {
        const t = fontToken(v);
        if (t) { count++; return `${prop}: tokens.${t}`; }
      }
      return full;
    });
    out = out.slice(0, s) + replaced + out.slice(e);
  }
  return { out, count };
}

function listFiles() {
  const files = [];
  try {
    const out = execSync(`git ls-files ${SCOPE_DIRS.join(' ')}`, { cwd: APP_ROOT, encoding: 'utf8' });
    for (const f of out.split('\n').map((s) => s.trim())) {
      if (f.endsWith('.tsx') && !f.includes('__tests__')) files.push(path.join(APP_ROOT, f));
    }
  } catch { /* ignore */ }
  // app/**/page.tsx
  const appDir = path.join(APP_ROOT, 'app');
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'node_modules' && ent.name !== '.next') walk(full); }
      else if (ent.name === 'page.tsx') files.push(full);
    }
  };
  if (fs.existsSync(appDir)) walk(appDir);
  return files;
}

let totalFiles = 0, totalRepl = 0, skippedNoTokens = 0;
for (const file of listFiles()) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\btokens\./.test(src)) { if (/style\s*=\s*\{\s*\{/.test(src)) skippedNoTokens++; continue; }
  const { out, count } = transform(src);
  if (count > 0) {
    totalFiles++; totalRepl += count;
    if (APPLY) fs.writeFileSync(file, out);
    console.log(`${count.toString().padStart(4)}  ${path.relative(APP_ROOT, file).split(path.sep).join('/')}`);
  }
}
console.log(`\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${totalRepl} replacements across ${totalFiles} files (skipped ${skippedNoTokens} styled files not referencing tokens).`);
