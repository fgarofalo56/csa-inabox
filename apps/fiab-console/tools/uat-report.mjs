#!/usr/bin/env node
/**
 * Reads test-results/uat/verdicts.ndjson and emits:
 *
 *   docs/fiab/uat-coverage.md       — A/B/C/D/F matrix per surface
 *   docs/fiab/tutorials/<slug>.md   — auto-generated walkthrough per A-grade editor
 *
 * Idempotent — overwrites existing files. Tutorials are auto-prefixed with
 * a banner so hand edits aren't lost (banner is a marker for re-gen).
 *
 * Run from the repo root (or anywhere) with:
 *   node apps/fiab-console/tools/uat-report.mjs
 * It is also invoked at the tail of the UAT sweep (`pnpm --filter
 * @csa-loom/fiab-console uat` → scripts/uat-launch.mjs).
 *
 * Per-editor tutorials INLINE the real Learn content authored on each catalog
 * entry's `learnContent` field in lib/catalog/fabric-item-types.ts (overview +
 * titled getting-started steps + Microsoft Learn link), so the published doc
 * teaches the workflow instead of deferring to the in-app Learn drawer. Items
 * with no catalog `learnContent` fall back to the legacy REGISTRY summary in
 * lib/learn/content.ts. This mirrors how the app's `getLearn()` resolves
 * content (catalog first, legacy registry second).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..', '..');
const NDJSON = path.join(REPO, 'apps', 'fiab-console', 'test-results', 'uat', 'verdicts.ndjson');
const OUT_DIR = path.join(REPO, 'docs', 'fiab');
const TUTORIALS = path.join(OUT_DIR, 'tutorials');
const CATALOG_TS = path.join(REPO, 'apps', 'fiab-console', 'lib', 'catalog', 'fabric-item-types.ts');
const CONTENT_TS = path.join(REPO, 'apps', 'fiab-console', 'lib', 'learn', 'content.ts');

// Neutral, deployment-agnostic references — never bake a specific Front Door
// host or a frozen release tag into the published docs.
const CONSOLE_HOST = 'https://<your-console-host>';
// Absolute GitHub blob base so source-file links resolve on the published docs
// site (MkDocs does not publish the app source tree).
const GH_BLOB = 'https://github.com/fgarofalo56/csa-inabox/blob/main';

if (!fs.existsSync(NDJSON)) {
  console.error('No verdicts.ndjson — run the UAT sweep first');
  process.exit(2);
}

const verdicts = fs.readFileSync(NDJSON, 'utf-8').trim().split('\n')
  .filter(Boolean).map(l => JSON.parse(l));

// ── Learn-content extraction ────────────────────────────────────────────────
// The generator is plain .mjs and cannot import the TS catalog (path aliases,
// no transpile step), so it reads the source text and extracts the strictly
// JSON-authored `learnContent` blocks. Returns slug -> { displayName,
// description, overview, steps[], docsUrl }.

/** Balanced `{...}` or `[...]` capture starting at src[start] (the open char). */
function balanced(src, start) {
  const open = src[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, q = '', esc = false;
  for (let k = start; k < src.length; k++) {
    const c = src[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
    } else {
      if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; }
      else if (c === open) depth++;
      else if (c === close) { depth--; if (depth === 0) return src.slice(start, k + 1); }
    }
  }
  return null;
}

/** Extract a single-quoted (or double-quoted) TS string field value, or ''. */
function scalarField(objText, key) {
  const re = new RegExp(`\\b${key}:\\s*(['"])((?:[^\\\\]|\\\\.)*?)\\1`);
  const m = objText.match(re);
  return m ? m[2].replace(/\\'/g, "'").replace(/\\"/g, '"') : '';
}

function extractCatalog() {
  const src = fs.readFileSync(CATALOG_TS, 'utf-8');
  const map = {};
  const decl = src.indexOf('FABRIC_ITEM_TYPES');
  const arrStart = src.indexOf('[', src.indexOf('= [', decl));
  const arrText = balanced(src, arrStart);
  let depth = 0, inStr = false, q = '', esc = false;
  for (let k = 0; k < arrText.length; k++) {
    const c = arrText[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === q) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '{' && depth === 1) {
      const objText = balanced(arrText, k);
      // The item's OWN slug/displayName are the FIRST such fields in the object;
      // nested createConfig choices carry their own slug — ignore those by
      // taking the first match only.
      const slug = scalarField(objText, 'slug');
      if (slug) {
        const entry = { displayName: scalarField(objText, 'displayName'), description: scalarField(objText, 'description') };
        const lcIdx = objText.indexOf('learnContent:');
        if (lcIdx !== -1) {
          const lcText = balanced(objText, objText.indexOf('{', lcIdx + 'learnContent:'.length));
          try {
            const lc = JSON.parse(lcText);
            entry.overview = lc.overview || '';
            entry.steps = Array.isArray(lc.steps) ? lc.steps : [];
            entry.docsUrl = lc.docsUrl || '';
          } catch (e) {
            console.warn(`  ! could not parse learnContent for ${slug}: ${e.message}`);
          }
        }
        map[slug] = entry;
      }
      k += objText.length - 1;
    }
  }
  return map;
}

/** Legacy REGISTRY (lib/learn/content.ts) title/summary fallback for a slug. */
function extractLegacy() {
  const src = fs.readFileSync(CONTENT_TS, 'utf-8');
  const map = {};
  const re = /^\s{2}'([a-z0-9-]+)':\s*\{/gm;
  let m;
  while ((m = re.exec(src))) {
    const objText = balanced(src, src.indexOf('{', m.index));
    if (!objText) continue;
    map[m[1]] = { title: scalarField(objText, 'title'), summary: scalarField(objText, 'summary') };
  }
  return map;
}

const CATALOG = extractCatalog();
const LEGACY = extractLegacy();
console.log(`✓ Loaded learnContent for ${Object.keys(CATALOG).filter(s => CATALOG[s].overview).length} catalog items`);

// === Coverage matrix ===
fs.mkdirSync(OUT_DIR, { recursive: true });

const bySurfaceFamily = new Map();
for (const v of verdicts) {
  const fam = v.surface.split(':')[0];
  if (!bySurfaceFamily.has(fam)) bySurfaceFamily.set(fam, []);
  bySurfaceFamily.get(fam).push(v);
}

const verdictCount = (arr, k) => arr.filter(v => v.verdict === k).length;

const lines = [
  '# CSA Loom — UAT Coverage Matrix',
  '',
  `> Auto-generated from \`apps/fiab-console/test-results/uat/verdicts.ndjson\` on ${new Date().toISOString().slice(0, 19)}Z.`,
  '> Reflects the most recent UAT sweep against the deployment under test.',
  '',
  '## Grading rubric',
  '',
  '- **A** — renders cleanly, all backend calls succeed (real data flowing)',
  '- **B** — renders cleanly, some calls hit documented "not configured in this env" gates (e.g. Power Platform Default env without Copilot Studio)',
  '- **C** — renders, but has unexpected console or network errors that need investigation',
  '- **D** — renders but every interactive action is fake or wrong',
  '- **F** — crashes on load, or is pure vaporware (placeholder only)',
  '',
  '## Roll-up',
  '',
  '| Family | Total | A | B | C | D | F |',
  '|---|---:|---:|---:|---:|---:|---:|',
];

for (const [fam, arr] of [...bySurfaceFamily.entries()].sort()) {
  lines.push(`| ${fam} | ${arr.length} | ${verdictCount(arr, 'A')} | ${verdictCount(arr, 'B')} | ${verdictCount(arr, 'C')} | ${verdictCount(arr, 'D')} | ${verdictCount(arr, 'F')} |`);
}

lines.push('', '## Detail');

for (const [fam, arr] of [...bySurfaceFamily.entries()].sort()) {
  lines.push('', `### ${fam}`, '');
  lines.push('| Surface | Verdict | Status | Notes |');
  lines.push('|---|:---:|---|---|');
  for (const v of arr.sort((a, b) => a.surface.localeCompare(b.surface))) {
    const slug = v.surface.replace(/:/g, '\\:');
    lines.push(`| ${slug} | ${v.verdict} | ${v.status} | ${(v.notes || '').slice(0, 100)} |`);
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'uat-coverage.md'), lines.join('\n'));
console.log(`✓ Wrote ${path.relative(REPO, path.join(OUT_DIR, 'uat-coverage.md'))}`);

// === Tutorials — one per A-grade editor ===
fs.mkdirSync(TUTORIALS, { recursive: true });
fs.mkdirSync(path.join(TUTORIALS, 'img'), { recursive: true });

/** Resolve the human/label + inline Learn content for an editor type. */
function resolveLearn(type) {
  const cat = CATALOG[type] || {};
  const leg = LEGACY[type] || {};
  const displayName = cat.displayName || leg.title || type.replace(/-/g, ' ');
  const overview = cat.overview || leg.summary || cat.description || '';
  const steps = (cat.steps && cat.steps.length) ? cat.steps : [];
  const docsUrl = cat.docsUrl || '';
  return { displayName, overview, steps, docsUrl };
}

const editorAs = verdicts.filter(v => v.surface.startsWith('editor:') && v.verdict === 'A');
let written = 0;
for (const v of editorAs) {
  const type = v.surface.replace('editor:', '');
  const slug = `editor-${type}`;
  const { displayName, overview, steps, docsUrl } = resolveLearn(type);
  // Copy screenshot if it exists
  let imgRel = '';
  if (v.screenshot && fs.existsSync(v.screenshot)) {
    const dst = path.join(TUTORIALS, 'img', `${slug}.png`);
    try { fs.copyFileSync(v.screenshot, dst); imgRel = `./img/${slug}.png`; } catch {}
  }
  const md = [
    '<!-- auto-generated by tools/uat-report.mjs — edits below this line are preserved on re-gen -->',
    `# Tutorial: ${displayName} editor`,
    '',
    `> CSA Loom \`${type}\` editor — verified working against a live console by the UAT harness on ${new Date().toISOString().slice(0, 10)}.`,
    '',
    '## Open the editor',
    '',
    `1. Sign in to your **CSA Loom Console** (for example \`${CONSOLE_HOST}\`).`,
    '2. Open or create a workspace from the **Workspaces** page.',
    `3. Click **+ New item** and choose **${displayName}** from the catalog.`,
    `4. The editor opens at \`/items/${type}/<id>\`:`,
    '',
    imgRel ? `![${displayName} editor](${imgRel})` : '',
    '',
    '## What this editor does',
    '',
    overview || `The **${displayName}** editor runs against a real Azure-native backend. Open the in-editor **Learn** drawer for the full description and step-by-step guidance.`,
  ];
  if (steps.length) {
    md.push('', '## Getting started', '');
    steps.forEach((s, i) => md.push(`${i + 1}. **${s.title}** — ${s.body}`));
  }
  if (docsUrl) {
    md.push('', '## Learn more', '', `- Microsoft Learn reference: [${docsUrl}](${docsUrl})`);
  }
  md.push(
    '',
    '## Verified by the UAT harness',
    '',
    `- Tested at: \`${v.ts}\``,
    `- Verdict: **${v.verdict}** (${v.notes})`,
    `- Test source: [\`apps/fiab-console/e2e/editors.uat.ts\`](${GH_BLOB}/apps/fiab-console/e2e/editors.uat.ts)`,
    '',
    '<!-- end auto-generated -->',
  );
  fs.writeFileSync(path.join(TUTORIALS, `${slug}.md`), md.join('\n'));
  written++;
}
console.log(`✓ Wrote ${written} tutorial(s) to ${path.relative(REPO, TUTORIALS)}`);

// Index
const indexLines = [
  '# CSA Loom — Tutorials',
  '',
  '> Auto-generated index of per-editor tutorials. One entry per editor that passes UAT with verdict A.',
  '',
  '## Editors',
  '',
];
for (const v of editorAs.sort((a, b) => a.surface.localeCompare(b.surface))) {
  const type = v.surface.replace('editor:', '');
  indexLines.push(`- [${type}](./editor-${type}.md)`);
}
fs.writeFileSync(path.join(TUTORIALS, 'README.md'), indexLines.join('\n'));
console.log(`✓ Wrote tutorial index`);
