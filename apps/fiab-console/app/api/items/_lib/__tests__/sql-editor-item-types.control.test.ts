/**
 * THE CONTROL ON `SQL_EDITOR_ITEM_TYPES` — derive, don't transcribe.
 *
 * `_lib/sql-server-scope.ts` has to name every item-type slug whose editor calls
 * a route under `/api/items/azure-sql-database/[id]/**` or
 * `/api/items/postgres-flexible-server/[id]/**`. A slug that is missing does not
 * fail loudly: `loadOwnedSqlItem` simply matches none of the candidates, returns
 * null, and the route 404s a button that worked the day before.
 *
 * That list was hand-written twice and was short BOTH times — one slug in #3623,
 * three after its review, against a true population of six. Neither `tsc` nor
 * `scripts/ci/check-route-guards.mjs` can see the gap (the routes still mention
 * `session.claims.oid`, still compile, still carry their guard), so nothing was
 * watching it. This test is what watches it.
 *
 * THE DERIVATION, which is the whole point — nothing here is transcribed from
 * the constant it checks:
 *
 *   1. Parse `lib/editors/registry.ts` for `'<slug>': reg(() => import('<mod>'), …)`.
 *   2. For each registered editor module, walk its RELATIVE import closure inside
 *      `lib/editors/` — the fetch often lives in a shared `components/*` panel
 *      (e.g. `sql-search-management.tsx` calls `/search-management`), not in the
 *      editor file itself.
 *   3. A slug qualifies when anything in that closure fetches an item-scoped path
 *      in one of the two route families.
 *
 * Closure granularity means one module's slugs qualify together, which can
 * over-include. That is the SAFE direction and is deliberate: per the constant's
 * own doc the item type is not an authorization boundary (every candidate runs
 * the same owner check, and `admitGovernedServer` is what bounds the target), so
 * a slug listed in error is inert while a slug omitted 404s a live button.
 *
 * SELF-CONTROL. A parser that silently matches nothing would let this test pass
 * against ANY constant — the `guard_with_zero_population` failure. So the
 * derivation's own inputs are asserted first: the registry must parse to a
 * plausible number of slugs, the closure walk must actually reach imported
 * files, and a known-true and a known-false slug are checked explicitly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SQL_EDITOR_ITEM_TYPES } from '../sql-server-scope';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// app/api/items/_lib/__tests__ → apps/fiab-console
const CONSOLE_ROOT = path.resolve(HERE, '../../../../..');
const EDITORS_DIR = path.join(CONSOLE_ROOT, 'lib/editors');
const REGISTRY = path.join(EDITORS_DIR, 'registry.ts');

/** `'<slug>': reg(() => import('<module>')` — the only registration form in use. */
const REGISTRATION = /'([a-z0-9][a-z0-9-]*)':\s*reg\(\s*\(\)\s*=>\s*import\('([^']+)'\)/g;

/**
 * An item-scoped fetch at one of the two route families. Requires the `${` of a
 * template interpolation right after the family segment, so this matches a call
 * carrying an item id and NOT a prose mention of the path in a comment.
 */
const ITEM_SCOPED_FETCH = /\/api\/items\/(?:azure-sql-database|postgres-flexible-server)\/\$\{/;

function resolveRelative(spec: string, fromDir: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(fromDir, spec);
  for (const ext of ['.tsx', '.ts', '/index.tsx', '/index.ts']) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
}

/** Every file reachable from `entry` through relative imports, within lib/editors. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+'(\.[^']*)'/g)) {
      const resolved = resolveRelative(m[1], path.dirname(file));
      if (resolved && resolved.startsWith(EDITORS_DIR)) stack.push(resolved);
    }
  }
  return [...seen];
}

function registeredSlugs(): Map<string, string> {
  const src = readFileSync(REGISTRY, 'utf8');
  const map = new Map<string, string>();
  for (const m of src.matchAll(REGISTRATION)) map.set(m[1], m[2]);
  return map;
}

function deriveSqlSlugs(): { slugs: string[]; closureSizes: Map<string, number> } {
  const slugs: string[] = [];
  const closureSizes = new Map<string, number>();
  for (const [slug, spec] of registeredSlugs()) {
    const entry = resolveRelative(spec, EDITORS_DIR);
    if (!entry) continue;
    const files = importClosure(entry);
    closureSizes.set(slug, files.length);
    if (files.some((f) => ITEM_SCOPED_FETCH.test(readFileSync(f, 'utf8')))) slugs.push(slug);
  }
  return { slugs: slugs.sort(), closureSizes };
}

describe('the derivation itself is alive (self-control)', () => {
  it('parses a plausible registry — not zero, not one', () => {
    const registered = registeredSlugs();
    // ~140 today. A parser that stops matching (a registration-syntax change)
    // must fail HERE, not silently derive an empty SQL set below.
    expect(registered.size).toBeGreaterThan(100);
    expect(registered.get('azure-sql-database')).toBe('./unified-sql-database-editor');
    expect(registered.get('azure-sql-server')).toBe('./azure-sql-editors');
  });

  it('the closure walk actually follows imports', () => {
    const { closureSizes } = deriveSqlSlugs();
    // A resolver that resolved nothing would report a closure of 1 (the entry
    // file) everywhere and still "pass" the equality assertion by luck.
    expect(closureSizes.get('azure-sql-database')).toBeGreaterThan(1);
  });

  it('the fetch pattern discriminates — it matches a caller and not a bystander', () => {
    expect(ITEM_SCOPED_FETCH.test('`/api/items/azure-sql-database/${id}/query`')).toBe(true);
    expect(ITEM_SCOPED_FETCH.test('`/api/items/postgres-flexible-server/${id}/firewall`')).toBe(true);
    // Prose / a collection-scoped call must NOT qualify a slug.
    expect(ITEM_SCOPED_FETCH.test(' * see /api/items/azure-sql-database/[id]/query')).toBe(false);
    expect(ITEM_SCOPED_FETCH.test("clientFetch('/api/items/azure-sql-server')")).toBe(false);
  });
});

describe('SQL_EDITOR_ITEM_TYPES equals the registry-derived population', () => {
  it('lists EXACTLY the slugs whose editor calls these routes', () => {
    const { slugs } = deriveSqlSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    expect([...SQL_EDITOR_ITEM_TYPES].sort()).toEqual(slugs);
  });

  // Named cases, so a failure reads as "which slug" rather than "two arrays differ".
  it('includes the three slugs #3623 and its review both missed', () => {
    for (const slug of ['azure-sql-server', 'azure-sql-managed-instance', 'sql-server-2025-vector-index']) {
      expect(SQL_EDITOR_ITEM_TYPES).toContain(slug);
    }
  });

  it('does NOT sweep in unrelated editors that merely live nearby', () => {
    // lakebase-postgres is a Postgres-flavoured item with its own editor and its
    // own routes; it must not be dragged in by the closure walk.
    expect(SQL_EDITOR_ITEM_TYPES).not.toContain('lakebase-postgres');
    expect(SQL_EDITOR_ITEM_TYPES).not.toContain('notebook');
  });

  it('keeps the hot path first — each miss before it is a Cosmos round-trip', () => {
    expect(SQL_EDITOR_ITEM_TYPES[0]).toBe('azure-sql-database');
  });

  it('has no duplicates', () => {
    expect(new Set(SQL_EDITOR_ITEM_TYPES).size).toBe(SQL_EDITOR_ITEM_TYPES.length);
  });
});
