/**
 * Route boundary completeness (apex A2).
 *
 * Pins the guarantee from research/page-errors.md finding #2: EVERY
 * first-level app route group ships an error.tsx AND a loading.tsx, and the
 * root ships error.tsx + global-error.tsx. A new route group added without
 * boundaries fails this test - the 0-boundary regression cannot come back.
 *
 * Filesystem-only assertions (no rendering) so the pin is cheap and exact.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Dirs under app/ that are not page route groups (handlers / tests only). */
const NON_ROUTE_DIRS = new Set(['api', '.well-known', '__tests__']);

function hasPage(dir: string): boolean {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (hasPage(full)) return true;
    } else if (ent.name === 'page.tsx') return true;
  }
  return false;
}

const groups = fs
  .readdirSync(APP_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !NON_ROUTE_DIRS.has(e.name))
  .map((e) => e.name)
  .filter((name) => hasPage(path.join(APP_DIR, name)))
  .sort();

describe('route error/loading boundary completeness (apex A2)', () => {
  it('sanity: the first-level route groups were enumerated (40 as of 2026-07)', () => {
    // If this ever drops sharply, the enumeration broke - do not "fix" by
    // narrowing the assertion; the guarantee below depends on it.
    expect(groups.length).toBeGreaterThanOrEqual(40);
  });

  it('root ships error.tsx and global-error.tsx', () => {
    expect(fs.existsSync(path.join(APP_DIR, 'error.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, 'global-error.tsx'))).toBe(true);
  });

  it('every first-level route group ships error.tsx AND loading.tsx', () => {
    const missing: string[] = [];
    for (const g of groups) {
      if (!fs.existsSync(path.join(APP_DIR, g, 'error.tsx'))) missing.push(`app/${g}/error.tsx`);
      if (!fs.existsSync(path.join(APP_DIR, g, 'loading.tsx'))) missing.push(`app/${g}/loading.tsx`);
    }
    expect(
      missing,
      `Route groups missing boundaries (add a 3-line wrapper around ` +
        `lib/components/route-error.tsx / route-loading.tsx):\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every group error.tsx is a client component delegating to the shared RouteError', () => {
    for (const g of groups) {
      const src = fs.readFileSync(path.join(APP_DIR, g, 'error.tsx'), 'utf8');
      expect(src, `app/${g}/error.tsx must be a client component`).toContain("'use client'");
      expect(src, `app/${g}/error.tsx must delegate to the shared RouteError`).toContain(
        '@/lib/components/route-error',
      );
    }
  });
});
