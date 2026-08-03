#!/usr/bin/env node
/**
 * GUARDRAIL: route-smoke coverage floor (merge-blocker, RATCHETING) — V4
 * (loom-next-level, WS-verification).
 * ---------------------------------------------------------------------------
 * OWNER: platform-verification (loom-next-level WS-V, V4).
 * WHY:   app/**\/page.tsx client routes are vitest's dark zone (the
 *        GuidedPickerRail freeze shipped through green CI). The route-smoke
 *        Playwright slice (apps/fiab-console/e2e/route-smoke.spec.ts) mounts
 *        every enumerable route; THIS script pins the covered/total ratio in
 *        apps/fiab-console/e2e/route-coverage-floor.json and fails CI when it
 *        DROPS — a new dynamic route with no fixture, or a new knownIssues
 *        baseline entry, is visible ratcheted debt, never silence.
 * UNBLOCK (uniform escape hatch): run in the blocked PR with a one-line
 *        justification and commit the regenerated floor file:
 *          node scripts/ci/check-route-smoke-floor.mjs --update-baseline
 *
 * WHAT IT CHECKS (static — no live run needed, so it can gate every PR):
 *   1. total      = count of app/**\/page.tsx (filesystem walk).
 *   2. enumerable = total - dynamic patterns without a deterministic fixture.
 *   3. covered    = enumerable - knownIssues entries in the floor file.
 *   4. FAIL if covered/total < the committed floorRatio (ratchet regression).
 *   5. FAIL if a knownIssues/excluded entry references a route that no longer
 *      exists (stale baseline — ratchet down instead).
 *
 * KEEP IN SYNC: apps/fiab-console/e2e/_lib/route-enum.ts implements the same
 * walk + fixture map for the Playwright slice; both files carry this note.
 *
 * SELF-DEFENCE (added 2026-08-02, refs #2860). This script called itself a
 * merge-blocker in the header above and was invoked by NO workflow — it had
 * never run. Reading it before wiring surfaced two ways it passes while
 * measuring nothing, both of which follow from IEEE-754 comparison rules:
 *   - APP_DIR walks to zero pages  → total=0 → ratio = 0/0 = NaN, and
 *     `NaN < floorRatio` is FALSE, so the ratchet reports OK on an empty tree.
 *   - floorRatio missing from the JSON → `ratio < undefined` is also FALSE.
 * Both now fail closed. Same class as the 2026-07-28 "gates that measure
 * nothing" sweep.
 *
 * ROUTE_SMOKE_APP_DIR / ROUTE_SMOKE_FLOOR_FILE override the two paths. They
 * exist for scripts/ci/__tests__/ratchet-fail-closed.test.mjs, which drives
 * fixture trees; CI sets neither.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = process.env.ROUTE_SMOKE_APP_DIR
  ? path.resolve(process.env.ROUTE_SMOKE_APP_DIR)
  : path.join(REPO_ROOT, 'apps', 'fiab-console', 'app');
const FLOOR_PATH = process.env.ROUTE_SMOKE_FLOOR_FILE
  ? path.resolve(process.env.ROUTE_SMOKE_FLOOR_FILE)
  : path.join(REPO_ROOT, 'apps', 'fiab-console', 'e2e', 'route-coverage-floor.json');

/** KEEP IN SYNC with e2e/_lib/route-enum.ts DYNAMIC_FIXTURES. */
const DYNAMIC_FIXTURES = {
  '/items/[type]/[id]': '/items/lakehouse/new',
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'api') continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.name === 'page.tsx') {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function toPattern(pageFile) {
  const relDir = path.dirname(path.relative(APP_DIR, pageFile));
  if (relDir === '.') return '/';
  const segs = relDir.split(path.sep).filter((s) => !/^\(.*\)$/.test(s));
  return segs.length ? '/' + segs.join('/') : '/';
}

function enumerate() {
  const patterns = walk(APP_DIR).sort().map(toPattern);
  const enumerable = [];
  const excludedDynamic = [];
  for (const p of patterns) {
    if (!p.includes('[')) enumerable.push(p);
    else if (DYNAMIC_FIXTURES[p]) enumerable.push(p);
    else excludedDynamic.push(p);
  }
  return { patterns, enumerable, excludedDynamic };
}

function loadFloor() {
  return JSON.parse(fs.readFileSync(FLOOR_PATH, 'utf8'));
}

function main() {
  if (!fs.existsSync(APP_DIR) || !fs.statSync(APP_DIR).isDirectory()) {
    console.error(`[route-smoke-floor] REFUSING TO PASS — APP_DIR does not exist: ${APP_DIR}`);
    console.error('  The walk cannot enumerate routes, so the ratio is meaningless. Fix the path.');
    process.exit(1);
  }

  const { patterns, enumerable, excludedDynamic } = enumerate();
  const total = patterns.length;

  // total===0 makes ratio NaN, and `NaN < floorRatio` is FALSE — the ratchet
  // would report OK having enumerated nothing. Fail closed instead.
  if (total === 0) {
    console.error(`[route-smoke-floor] REFUSING TO PASS — walked ${APP_DIR} and found ZERO page.tsx files.`);
    console.error('  This repo has >100. The walk has stopped matching (App Router layout change?).');
    process.exit(1);
  }

  if (process.argv.includes('--update-baseline')) {
    let prev = {};
    try { prev = loadFloor(); } catch { /* first capture */ }
    const knownIssues = (prev.knownIssues ?? []).filter((k) => enumerable.includes(k.route));
    const covered = enumerable.length - knownIssues.length;
    const next = {
      _owner: 'platform-verification (loom-next-level WS-V, V4)',
      _why:
        'Ratchet: every app/**/page.tsx route must stay under route-smoke coverage; ' +
        'the covered/total ratio may only move toward 1.0.',
      _unblock:
        'node scripts/ci/check-route-smoke-floor.mjs --update-baseline (commit the ' +
        'regenerated file with a one-line justification in the PR).',
      capturedAt: new Date().toISOString(),
      total,
      enumerable: enumerable.length,
      covered,
      floorRatio: Math.floor((covered / total) * 10000) / 10000,
      excludedDynamic: excludedDynamic.map((p) => ({
        route: p,
        reason: 'dynamic segment(s) with no deterministic create-mode fixture — needs a seeded id',
      })),
      knownIssues,
    };
    fs.writeFileSync(FLOOR_PATH, JSON.stringify(next, null, 2) + '\n');
    console.log(`[route-smoke-floor] baseline updated: covered=${covered}/${total} (ratio ${next.floorRatio})`);
    process.exit(0);
  }

  let floor;
  try {
    floor = loadFloor();
  } catch {
    console.error(`[route-smoke-floor] FAIL — missing ${path.relative(REPO_ROOT, FLOOR_PATH)}.`);
    console.error('  Capture it: node scripts/ci/check-route-smoke-floor.mjs --update-baseline');
    process.exit(1);
  }

  const failures = [];
  const knownIssues = floor.knownIssues ?? [];
  const covered = enumerable.length - knownIssues.length;
  const ratio = covered / total;

  // `ratio < undefined` and `ratio < NaN` are both FALSE, so a floor file that
  // lost its floorRatio (hand-edit, bad merge, truncated write) would disable
  // the comparison while still printing OK. Validate before comparing.
  if (typeof floor.floorRatio !== 'number' || !Number.isFinite(floor.floorRatio) || floor.floorRatio <= 0) {
    console.error(
      `[route-smoke-floor] REFUSING TO PASS — floorRatio in ${path.relative(REPO_ROOT, FLOOR_PATH)} is ` +
        `${JSON.stringify(floor.floorRatio)}, not a positive number. The ratchet would compare against nothing.`,
    );
    console.error('  Re-capture it: node scripts/ci/check-route-smoke-floor.mjs --update-baseline');
    process.exit(1);
  }

  if (ratio < floor.floorRatio) {
    failures.push(
      `coverage ratio dropped: covered=${covered}/${total} (${ratio.toFixed(4)}) < floor ${floor.floorRatio}.\n` +
        '      A new dynamic route needs a DYNAMIC_FIXTURES entry (route-enum.ts + this script),\n' +
        '      or justify + re-baseline via --update-baseline.',
    );
  }
  for (const k of knownIssues) {
    if (!enumerable.includes(k.route)) {
      failures.push(`stale knownIssues entry ${k.route} — route no longer exists; re-baseline to ratchet down.`);
    }
  }
  for (const e of floor.excludedDynamic ?? []) {
    if (!excludedDynamic.includes(e.route)) {
      failures.push(`stale excludedDynamic entry ${e.route} — pattern gone or now fixtured; re-baseline to ratchet down.`);
    }
  }

  console.log(
    `[route-smoke-floor] total=${total} enumerable=${enumerable.length} ` +
      `excludedDynamic=${excludedDynamic.length} knownIssues=${knownIssues.length} ` +
      `covered=${covered} ratio=${ratio.toFixed(4)} floor=${floor.floorRatio}`,
  );

  if (failures.length) {
    console.error('\n[route-smoke-floor] FAIL — coverage ratchet regression:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('[route-smoke-floor] OK — coverage at or above the committed floor.');
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
