#!/usr/bin/env node
/**
 * GUARDRAIL: no-raw-px-inline-style  (merge-blocker, ABSOLUTE)
 * ------------------------------------------------------------------------
 * RULE (web3-ui — BLOCKING GLOBAL): front-end surfaces use Loom/Fluent design
 *   tokens, never hard-coded px. "Raw numbers like `padding: 16` / `gap: 12`
 *   are a rule violation; use the spacing tokens" (`tokens.spacingVertical*` /
 *   `tokens.spacingHorizontal*`), and `fontSize` uses `tokens.fontSize*`.
 *
 * WHAT IT DOES:
 *   Scans INLINE style regions — `style={{ ... }}` JSX attributes and
 *   `: React.CSSProperties = { ... }` objects — under lib/editors, lib/panes,
 *   lib/components, and app page.tsx files, and counts numeric values on the
 *   spacing / fontSize properties (`gap`/`padding*`/`margin*`/`fontSize: 16`).
 *   Each such value is a raw-px violation.
 *
 * NO LONGER A RATCHET. This guard shipped as one, because a large backlog
 * predated the token sweep (rel-T56) and blocking on the whole backlog was not
 * viable; per-file counts were frozen in BASELINE and CI failed only on a RISE.
 * That backlog is now fully drained (18 -> B-U12 -> 7 -> C4 -> 0), BASELINE is
 * `{}`, and the guard is ABSOLUTE: the FIRST raw-px value re-introduced
 * anywhere in scope fails the build. See the BASELINE sentinel block below.
 *
 * Only INLINE-style regions are scanned, so a numeric `padding`/`fontSize`
 * consumed as a NUMBER by a chart/layout lib (recharts, react-flow) is never
 * counted. Layout TRACK sizes (`width`/`height`/`minWidth`/`maxWidth`/grid
 * templates) are deliberately out of scope — Fluent ships no token for an
 * arbitrary track dimension, so demanding one would force a fake token.
 *
 * HOW TO CLEAR A FAILURE:
 *   Map the raw value to the nearest token (Fluent spacing scale: XXS 2, XS 4,
 *   SNudge 6, S 8, MNudge 10, M 12, L 16, XL 20, XXL 24, XXXL 32; fontSize →
 *   Base 10/12/14/16/20/24, Hero 28/32/40/68). Bulk codemod:
 *     node apps/fiab-console/scripts/codemod-raw-px-to-tokens.mjs --apply
 *   DO NOT clear a failure by re-populating BASELINE — that re-grandfathers
 *   debt and lowers the ratchet. `scripts/ci/__tests__/no-raw-px-baseline-empty.test.mjs`
 *   fails if you do (and also proves this guard still fails closed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_REL = path.join('apps', 'fiab-console');
/**
 * NO_RAW_PX_APP_ROOT overrides the scanned app root. It exists for
 * `scripts/ci/__tests__/no-raw-px-baseline-empty.test.mjs`, which drives fixture
 * trees; **CI sets it nowhere**, and that test asserts the guardrails workflow
 * invokes this guard without it, so the override cannot be used to quietly
 * neuter the guard in the lane that matters. Same shape and same rationale as
 * ROUTE_SMOKE_APP_DIR in check-route-smoke-floor.mjs.
 *
 * Before this existed, the fail-closed test proved itself by MUTATING THE REAL
 * SOURCE TREE (and, in its first form, `git add -N`-ing a probe file into the
 * index). In a repo where many agents share git state that is a genuine hazard,
 * not a stylistic one: a test that dies between its write and its cleanup
 * leaves a foreign file staged in somebody else's commit, and its create/delete
 * window raced check-insecure-randomness into an ENOENT once already. A fixture
 * tree removes the whole class.
 */
const APP_ROOT = process.env.NO_RAW_PX_APP_ROOT
  ? path.resolve(process.env.NO_RAW_PX_APP_ROOT)
  : path.join(REPO_ROOT, APP_REL);
const USING_FIXTURE_ROOT = Boolean(process.env.NO_RAW_PX_APP_ROOT);
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
  // A fixture tree is not a git repo, so `git ls-files` would return nothing and
  // the scan would silently cover only app/**/page.tsx — i.e. the fail-closed
  // test would exercise half the guard while looking green. Walk the scope dirs
  // directly in that mode instead.
  if (USING_FIXTURE_ROOT) {
    for (const rel of SCOPE_DIRS) {
      const dir = path.join(APP_ROOT, rel);
      if (!fs.existsSync(dir)) continue;
      const walk = (d) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, ent.name);
          if (ent.isDirectory()) walk(full);
          else if (ent.name.endsWith('.tsx') && !full.includes('__tests__')) files.push(full);
        }
      };
      walk(dir);
    }
  } else {
    try {
      const out = execSync(`git ls-files ${SCOPE_DIRS.join(' ')}`, { cwd: APP_ROOT, encoding: 'utf8' });
      for (const f of out.split('\n').map((s) => s.trim())) {
        if (f.endsWith('.tsx') && !f.includes('__tests__')) files.push(path.join(APP_ROOT, f));
      }
    } catch { /* ignore */ }
  }
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
// EMPTY — the raw-px backlog is FULLY DRAINED (rel-T56 codemod -> B-U12 token
// sweep 18 -> 7 -> C4 final drain 7 -> 0). With an empty baseline this guard is
// no longer a ratchet, it is ABSOLUTE: any raw-px spacing/fontSize value newly
// introduced into an inline-style region under lib/editors, lib/panes,
// lib/components, or an app page.tsx fails CI immediately.
//
// The final 7 all had NO exact Fluent token (48/44/22/18/11/1 px). They were
// resolved by snapping to the nearest step on the Fluent scale, or — better —
// by deleting an override that was fighting a shared primitive:
//   health-pane score glyph        fontSize 48 -> fontSizeHero900 (40px)
//   foundry-charts KPI figure      fontSize 22 -> fontSizeBase600 (24px)
//   loom-logo tagline              fontSize 11 -> fontSizeBase200 (12px)
//   loom-logo optical nudge        marginTop 1 -> spacingVerticalXXS (2px)
//   not-configured-bar list indent paddingLeft 18 -> spacingHorizontalXL (20px)
//   data-product-detail (x2)       fontSize 44 override DELETED — EmptyState's
//                                  own .illustration slot already sets 40px, so
//                                  these were the only two call sites in the
//                                  repo overriding the shared primitive.
//
// DO NOT re-populate this object to land new raw px. Convert the value instead.
// `scripts/ci/__tests__/no-raw-px-baseline-empty.test.mjs` asserts it stays {}.
const BASELINE = {};
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
