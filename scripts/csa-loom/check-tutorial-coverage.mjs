#!/usr/bin/env node
/**
 * Audit visual-tutorial coverage (B-9).
 *
 * Compares what's PUBLISHED under docs/fiab/tutorials/items/<slug>/tutorial.md
 * against the EXPECTED set of surfaces, across all three dimensions:
 *   - items    : every editor in apps/fiab-console/lib/editors/registry.ts
 *   - features : every top-level nav page (NAV_PAGES in e2e/_lib/uat.ts)
 *   - apps     : every curated app — dynamic, so only audited when an
 *                apps-catalog JSON is supplied (live catalog or saved export):
 *                  --apps-catalog <path-to-json>   (shape: { "apps": [{ "id": ... }] })
 *
 * Both expected sets are PARSED from source (registry.ts, uat.ts) so this never
 * drifts from a hand-maintained list — same source-of-truth contract the
 * capture UAT uses.
 *
 * Usage:
 *   node scripts/csa-loom/check-tutorial-coverage.mjs                 # report only (exit 0)
 *   node scripts/csa-loom/check-tutorial-coverage.mjs --strict        # exit 1 if any missing
 *   node scripts/csa-loom/check-tutorial-coverage.mjs --apps-catalog apps.json --strict
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const DOCS = path.join(repo, 'docs', 'fiab', 'tutorials', 'items');
const REGISTRY = path.join(repo, 'apps', 'fiab-console', 'lib', 'editors', 'registry.ts');
const UAT_LIB = path.join(repo, 'apps', 'fiab-console', 'e2e', '_lib', 'uat.ts');

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const catalogIdx = args.indexOf('--apps-catalog');
const catalogPath = catalogIdx >= 0 ? args[catalogIdx + 1] : null;

/** Parse `'<slug>': reg(` item types from registry.ts. */
function loadEditorTypes() {
  return fs.readFileSync(REGISTRY, 'utf-8')
    .split('\n')
    .map((l) => l.match(/^\s*['"]([a-z][a-z0-9-]+)['"]\s*:\s*reg\(/))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Parse the NAV_PAGES string array out of e2e/_lib/uat.ts. */
function loadNavPages() {
  const src = fs.readFileSync(UAT_LIB, 'utf-8');
  const block = src.match(/export const NAV_PAGES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return [];
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

function pageSlug(p) {
  const t = p.replace(/^\/+/, '').replace(/\/+$/, '');
  return t === '' ? 'home' : t.replace(/\//g, '-');
}

function loadAppIds() {
  if (!catalogPath) return null; // apps dimension not auditable offline
  const j = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
  return (j.apps || []).map((a) => a.id);
}

const publishedSlugs = new Set(
  fs.existsSync(DOCS)
    ? fs.readdirSync(DOCS, { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(DOCS, d.name, 'tutorial.md')))
        .map((d) => d.name)
    : [],
);

const expected = [];
for (const t of loadEditorTypes()) expected.push({ dim: 'items', slug: `item-${t}`, label: t });
for (const p of loadNavPages()) expected.push({ dim: 'features', slug: `feature-${pageSlug(p)}`, label: p });
const appIds = loadAppIds();
if (appIds) for (const id of appIds) expected.push({ dim: 'apps', slug: `app-${id}`, label: id });

const missing = expected.filter((e) => !publishedSlugs.has(e.slug));
const byDim = (dim) => expected.filter((e) => e.dim === dim);
const missDim = (dim) => missing.filter((e) => e.dim === dim);

console.log('Visual-tutorial coverage (docs/fiab/tutorials/items/)');
console.log('====================================================');
for (const dim of ['items', 'features', 'apps']) {
  const exp = byDim(dim);
  if (!exp.length) {
    if (dim === 'apps') console.log(`apps     : not audited (pass --apps-catalog <json> from a live catalog)`);
    continue;
  }
  const have = exp.length - missDim(dim).length;
  console.log(`${dim.padEnd(8)} : ${have}/${exp.length} published`);
}
console.log(`total    : ${expected.length - missing.length}/${expected.length} published`);

if (missing.length) {
  console.log('\nMissing tutorials:');
  for (const m of missing) console.log(`  - [${m.dim}] ${m.slug}  (${m.label})`);
  console.log('\nGenerate with: pnpm exec playwright test --project=uat e2e/tutorial-capture.uat.ts');
  console.log('then publish:  node scripts/csa-loom/publish-tutorials.mjs');
}

if (strict && missing.length) {
  console.error(`\nFAIL (--strict): ${missing.length} surface(s) without a published tutorial.`);
  process.exit(1);
}
