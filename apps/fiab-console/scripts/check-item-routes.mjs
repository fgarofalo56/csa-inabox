#!/usr/bin/env node
/**
 * no-vaporware guard: every editor that drives persistence through
 * `useItemState('<type>', …)` MUST have a matching
 * `app/api/items/<type>/[id]/route.ts` exporting GET + PATCH — otherwise the
 * editor PATCHes a 404 and silently loses every edit while showing a "Saved"
 * badge (the exact grade-F class the 2026-06-04 audit caught across the
 * Phase-4 editors). This script fails CI if any slug is missing its route.
 *
 * Run: node scripts/check-item-routes.mjs   (from apps/fiab-console)
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const EDITORS_DIR = join(ROOT, 'lib', 'editors');
const ITEMS_DIR = join(ROOT, 'app', 'api', 'items');

/** Recursively collect *.tsx/*.ts files under a dir. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// 1. Find every useItemState('<slug>' …) across the editors.
const slugRe = /useItemState\s*(?:<[^>]*>)?\s*\(\s*['"]([a-z0-9-]+)['"]/g;
const slugs = new Set();
for (const file of walk(EDITORS_DIR)) {
  const src = readFileSync(file, 'utf8');
  let m;
  while ((m = slugRe.exec(src))) slugs.add(m[1]);
}

// 2. For each slug, assert the route file exists and exports GET + PATCH.
const failures = [];
for (const slug of [...slugs].sort()) {
  const routeFile = join(ITEMS_DIR, slug, '[id]', 'route.ts');
  if (!existsSync(routeFile)) {
    failures.push(`${slug}: missing app/api/items/${slug}/[id]/route.ts (useItemState persists here)`);
    continue;
  }
  const src = readFileSync(routeFile, 'utf8');
  const hasGet = /export\s+(async\s+)?function\s+GET\b|export\s+const\s+GET\b/.test(src);
  const hasPatch = /export\s+(async\s+)?function\s+PATCH\b|export\s+const\s+PATCH\b/.test(src);
  if (!hasGet || !hasPatch) {
    failures.push(`${slug}: route.ts exists but is missing ${[!hasGet && 'GET', !hasPatch && 'PATCH'].filter(Boolean).join(' + ')}`);
  }
}

if (failures.length) {
  console.error(`\n✗ item-route guard failed — ${failures.length} useItemState slug(s) without a persistence route:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('\nEvery editor using useItemState(<type>) needs app/api/items/<type>/[id]/route.ts with GET + PATCH,');
  console.error('or its edits are silently lost on reload (no-vaporware grade F).\n');
  process.exit(1);
}

console.log(`✓ item-route guard: all ${slugs.size} useItemState slug(s) have a GET+PATCH persistence route.`);
