/**
 * V4 — `app/**\/page.tsx` route enumeration (loom-next-level, WS-verification).
 * ---------------------------------------------------------------------------
 * Walks the App Router tree at test-collection time and derives the navigable
 * route for every page.tsx, so the route-smoke slice can never silently skip a
 * new hub page (the GuidedPickerRail-freeze class shipped precisely because
 * route components live outside vitest's reach).
 *
 * Dynamic segments: a route whose ENTIRE dynamic pattern has a deterministic
 * fixture (create-mode ids that need no seeded data) is filled and covered;
 * anything else is EXCLUDED with a reason and counted against the coverage
 * ratio in e2e/route-coverage-floor.json — so excluding a route is visible,
 * ratcheted debt, not silence.
 *
 * KEEP IN SYNC: scripts/ci/check-route-smoke-floor.mjs re-implements this walk
 * (Node .mjs cannot import this TS module); both carry this sync note.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface RouteEntry {
  /** Navigable route (dynamic segments already fixture-filled). */
  route: string;
  /** Route pattern as derived from the filesystem (with [params]). */
  pattern: string;
  /** page.tsx path relative to apps/fiab-console. */
  file: string;
}

export interface ExcludedRoute {
  pattern: string;
  file: string;
  reason: string;
}

const APP_DIR = path.join(__dirname, '..', '..', 'app');

/**
 * Deterministic fixtures for dynamic patterns — create-mode ids that need no
 * seeded data. (ItemEditorPage: `isNew = id === 'new'` renders the full editor
 * chrome without a pre-existing item.)
 */
export const DYNAMIC_FIXTURES: Record<string, string> = {
  '/items/[type]/[id]': '/items/lakehouse/new',
};

function walk(dir: string, out: string[] = []): string[] {
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

/** `app/foo/(group)/[id]/page.tsx` → `/foo/[id]` */
function toPattern(pageFile: string): string {
  const relDir = path.dirname(path.relative(APP_DIR, pageFile));
  if (relDir === '.') return '/';
  const segs = relDir.split(path.sep).filter((s) => !/^\(.*\)$/.test(s));
  return segs.length ? '/' + segs.join('/') : '/';
}

export function enumerateRoutes(): { routes: RouteEntry[]; excluded: ExcludedRoute[]; total: number } {
  const routes: RouteEntry[] = [];
  const excluded: ExcludedRoute[] = [];
  const files = walk(APP_DIR).sort();
  for (const abs of files) {
    const file = path.relative(path.join(APP_DIR, '..'), abs).split(path.sep).join('/');
    const pattern = toPattern(abs);
    if (!pattern.includes('[')) {
      routes.push({ route: pattern, pattern, file });
      continue;
    }
    const fixture = DYNAMIC_FIXTURES[pattern];
    if (fixture) {
      routes.push({ route: fixture, pattern, file });
    } else {
      excluded.push({
        pattern,
        file,
        reason: 'dynamic segment(s) with no deterministic create-mode fixture — needs a seeded id',
      });
    }
  }
  return { routes, excluded, total: files.length };
}
