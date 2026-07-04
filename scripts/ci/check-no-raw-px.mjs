#!/usr/bin/env node
/**
 * GUARDRAIL: no-raw-px-inline-style  (merge-blocker, RATCHETING)
 * ------------------------------------------------------------------------
 * RULE (web3-ui — BLOCKING GLOBAL): front-end surfaces use Loom/Fluent design
 *   tokens, never hard-coded px. "Raw numbers like `padding: 16` / `gap: 12`
 *   are a rule violation; use the spacing tokens" (`tokens.spacingVertical*` /
 *   `tokens.spacingHorizontal*`), and `fontSize` uses `tokens.fontSize*`.
 *
 * WHAT IT DOES (ratchet, not full-clean):
 *   Scans INLINE style regions — `style={{ ... }}` JSX attributes and
 *   `: React.CSSProperties = { ... }` objects — under lib/editors, lib/panes,
 *   lib/components, and app page.tsx files, and counts numeric values on the
 *   spacing / fontSize properties (`gap`/`padding*`/`margin*`/`fontSize: 16`).
 *   Each such value is a raw-px violation. A large BACKLOG of these predates
 *   the token sweep (rel-T56); rather than block on the whole backlog, this
 *   guard RATCHETS: the current per-file counts are frozen as BASELINE, and CI
 *   fails only when a file's count RISES above its baseline (i.e. NEW raw-px
 *   was introduced). Migrate a file's remaining px to tokens and its baseline
 *   drops — the ratchet only tightens.
 *
 * Only INLINE-style regions are scanned, so a numeric `padding`/`fontSize`
 * consumed as a NUMBER by a chart/layout lib (recharts, react-flow) is never
 * counted.
 *
 * HOW TO CLEAR A NEW FAILURE:
 *   Map the raw value to the nearest token (Fluent spacing scale: XXS 2, XS 4,
 *   SNudge 6, S 8, MNudge 10, M 12, L 16, XL 20, XXL 24, XXXL 32; fontSize →
 *   tokens.fontSizeBase* / Hero*). Run the one-shot codemod for the bulk:
 *     node apps/fiab-console/scripts/codemod-raw-px-to-tokens.mjs --apply
 *   then refresh the baseline:
 *     node scripts/ci/check-no-raw-px.mjs --update-baseline
 *   and paste the emitted JSON into BASELINE below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_REL = path.join('apps', 'fiab-console');
const APP_ROOT = path.join(REPO_ROOT, APP_REL);
const SCOPE_DIRS = ['lib/editors', 'lib/panes', 'lib/components'];

const SPACING_PROPS = [
  'gap', 'columnGap', 'rowGap', 'padding', 'paddingTop', 'paddingBottom',
  'paddingLeft', 'paddingRight', 'paddingInline', 'paddingInlineStart',
  'paddingInlineEnd', 'paddingBlock', 'paddingBlockStart', 'paddingBlockEnd',
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'marginInline', 'marginInlineStart', 'marginInlineEnd', 'marginBlock',
  'marginBlockStart', 'marginBlockEnd', 'fontSize',
];
const PROP_RE = new RegExp(`\\b(${SPACING_PROPS.join('|')})\\s*:\\s*(\\d+)(?=\\s*[,}\\n])`, 'g');

/** Brace-matched, string-aware style regions: style={{...}} and CSSProperties objects. */
function styleRegions(src) {
  const spans = [];
  const pushBalanced = (openIdx) => {
    let depth = 0, inStr = null, i = openIdx;
    for (; i < src.length; i++) {
      const c = src[i];
      if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { spans.push([openIdx, i + 1]); return i + 1; } }
    }
    return src.length;
  };
  const styleRe = /style\s*=\s*\{\s*\{/g;
  let m;
  while ((m = styleRe.exec(src))) {
    const secondBrace = src.indexOf('{', src.indexOf('{', m.index) + 1);
    if (secondBrace >= 0) styleRe.lastIndex = pushBalanced(secondBrace);
  }
  const cssRe = /:\s*(?:React\.)?CSSProperties\s*=\s*\{/g;
  while ((m = cssRe.exec(src))) {
    const brace = src.indexOf('{', m.index);
    if (brace >= 0) cssRe.lastIndex = pushBalanced(brace);
  }
  return spans;
}

function countViolations(src) {
  let n = 0;
  for (const [s, e] of styleRegions(src)) {
    const region = src.slice(s, e);
    PROP_RE.lastIndex = 0;
    while (PROP_RE.exec(region)) n++;
  }
  return n;
}

function listFiles() {
  const files = [];
  try {
    const out = execSync(`git ls-files ${SCOPE_DIRS.join(' ')}`, { cwd: APP_ROOT, encoding: 'utf8' });
    for (const f of out.split('\n').map((s) => s.trim())) {
      if (f.endsWith('.tsx') && !f.includes('__tests__')) files.push(path.join(APP_ROOT, f));
    }
  } catch { /* ignore */ }
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

function rel(f) {
  return path.relative(REPO_ROOT, f).split(path.sep).join('/');
}

function scan() {
  const counts = {};
  for (const f of listFiles()) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const n = countViolations(src);
    if (n > 0) counts[rel(f)] = n;
  }
  return counts;
}

// __BASELINE_START__  (regenerate with --update-baseline)
// 5 files, 18 grandfathered raw-px inline-style values remaining after the
// rel-T56 codemod. These are no-token files (SVG sizing in loom-logo, the
// not-configured-bar) or out-of-tolerance display values (a 48px score glyph).
const BASELINE = {
  "apps/fiab-console/lib/components/admin-security/not-configured-bar.tsx": 7,
  "apps/fiab-console/lib/components/admin/health-pane.tsx": 1,
  "apps/fiab-console/lib/components/foundry/foundry-charts.tsx": 1,
  "apps/fiab-console/lib/components/loom-logo.tsx": 7,
  "apps/fiab-console/lib/editors/data-product-detail.tsx": 2,
};
// __BASELINE_END__

function main() {
  const counts = scan();
  if (process.argv.includes('--update-baseline')) {
    const ordered = Object.keys(counts).sort().reduce((o, k) => { o[k] = counts[k]; return o; }, {});
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`// ${Object.keys(counts).length} files, ${total} grandfathered raw-px inline-style values`);
    console.log(JSON.stringify(ordered, null, 2));
    process.exit(0);
  }

  const regressions = [];
  for (const [file, n] of Object.entries(counts)) {
    const allowed = BASELINE[file] ?? 0;
    if (n > allowed) regressions.push({ file, n, allowed });
  }
  const totalNow = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalBase = Object.values(BASELINE).reduce((a, b) => a + b, 0);
  console.log(`[no-raw-px] scanned lib/editors + lib/panes + lib/components + app/**/page.tsx`);
  console.log(`[no-raw-px] grandfathered baseline: ${totalBase} raw-px inline-style values across ${Object.keys(BASELINE).length} files`);
  console.log(`[no-raw-px] current: ${totalNow} across ${Object.keys(counts).length} files`);
  if (regressions.length) {
    console.error('\n[no-raw-px] FAIL — NEW raw-px inline-style values above the ratchet baseline:');
    for (const r of regressions) console.error(`  - ${r.file}: ${r.n} (baseline ${r.allowed})`);
    console.error('\nFix: map the new raw px to a Loom token (tokens.spacing*/tokens.fontSize*).');
    console.error('Bulk codemod: node apps/fiab-console/scripts/codemod-raw-px-to-tokens.mjs --apply');
    console.error('If you legitimately REDUCED a file, refresh the baseline:');
    console.error('  node scripts/ci/check-no-raw-px.mjs --update-baseline  (paste JSON into BASELINE)');
    process.exit(1);
  }
  console.log('[no-raw-px] OK — no new raw-px inline-style values above baseline.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
