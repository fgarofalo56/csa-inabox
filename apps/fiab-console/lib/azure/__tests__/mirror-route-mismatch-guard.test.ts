/**
 * POPULATION CONTRACT — every mirrored-database route that reads a mirror's
 * source type must consult the source-type/connection compatibility guard.
 *
 * WHY A SOURCE SCAN AND NOT PER-ROUTE RUNTIME TESTS. The defect was not one
 * route being wrong; it was that reading `sourceType` WITHOUT the connection's
 * type is the wrong shape, and that shape is copied. `connection-auth.ts`'s own
 * header records the last time this exact item type shipped a fix only ONE of
 * its call sites adopted — the guard-adoption gap this repo keeps re-learning.
 *
 * This spec is the reason the fix is complete. Written against the two
 * ENUMERATOR routes, it immediately failed on a THIRD route the author had not
 * looked at (`[id]/sources`), which PERSISTS the binding — and pulled in the
 * create and PATCH writers with it. A per-route spec would have shipped the
 * two-route version and left the mismatch storable.
 *
 * THE ASSERTION IS THE MUTATION PROOF. Delete the `mirrorBindingMismatch` call
 * from any route below — or, in an enumerator, move it BELOW the family
 * dispatch where the refusal can no longer truthfully say nothing was
 * contacted — and this goes RED naming the file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// __dirname is lib/azure/__tests__ → three levels up is the console root.
const CONSOLE_ROOT = path.resolve(__dirname, '..', '..', '..');
const MIRROR_ROUTES = path.join(CONSOLE_ROOT, 'app', 'api', 'items', 'mirrored-database');

function routeFiles(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      routeFiles(p, acc);
    } else if (e.name === 'route.ts') {
      acc.push(p);
    }
  }
  return acc;
}

interface Route { rel: string; src: string }
const ALL: Route[] = routeFiles(MIRROR_ROUTES).map((f) => ({
  rel: path.relative(MIRROR_ROUTES, f).replace(/\\/g, '/'),
  src: fs.readFileSync(f, 'utf8'),
}));

const GUARD = /mirrorBindingMismatch\s*\(/;
/**
 * The Start paths do NOT carry their own copy of the check. They call
 * `withSourceAuth`, which stamps the connection's type onto the MirrorSource,
 * and the ENGINE refuses ahead of every family branch. That is deliberate: the
 * engine is the single choke point both Start routes funnel through, and a
 * per-route copy is precisely how the last credential fix on this item type
 * half-landed. The delegation is asserted below rather than assumed.
 */
const DELEGATES_TO_ENGINE = /withSourceAuth\s*\(/;

/** Reads a source type AND can reach a bound connection → must be guarded. */
const IN_SCOPE = ALL.filter((r) =>
  /\bsourceType\b/.test(r.src) && /\bconnectionId\b/.test(r.src));

/**
 * Branches into a per-family enumerator — i.e. actually DIALS the source. Keyed
 * to the enumerator calls, not to `MIRROR_SQL_FAMILY.has(...)`: `[id]/sources`
 * references that constant in a `knownSource()` validator and never contacts
 * anything, so keying on the constant misclassified it.
 */
const DIALS = /\b(listTablesWithAuth|listTables|listPostgresTables|listContainers|listSnowflakeTables)\s*\(/;
const ENUMERATORS = IN_SCOPE.filter((r) => DIALS.test(r.src));

/** Routes that must hold the check themselves (everything not engine-delegated). */
const DIRECT = IN_SCOPE.filter((r) => !DELEGATES_TO_ENGINE.test(r.src));
const DELEGATED = IN_SCOPE.filter((r) => DELEGATES_TO_ENGINE.test(r.src));

/** Cosmos item writes only — not every `.replace()` on a string. */
const COSMOS_WRITE = /items\s*\.\s*item\([^;]*?\)\s*\.\s*replace\s*\(|items\s*\.\s*items\s*\.\s*create\s*\(/s;

describe('every mirrored-database route that reads a source type is guarded', () => {
  it('EMBEDDED CONTROL: the population, split by who holds the check', () => {
    // A guard over a zero (or silently shrunken) population proves nothing. If
    // a route is added, renamed, or drops one of the two coordinates, this
    // fails LOUDLY rather than passing over a smaller set.
    expect(IN_SCOPE.map((r) => r.rel).sort()).toEqual([
      '[id]/lifecycle/route.ts', // Start — engine-delegated
      '[id]/route.ts',           // PATCH — edit-save persists the binding
      '[id]/sources/route.ts',   // POST  — sets the binding explicitly
      '[id]/state/route.ts',     // Start — engine-delegated
      '[id]/tables/route.ts',    // GET   — credential-aware enumerator
      'route.ts',                // POST  — create persists the binding
      'source-tables/route.ts',  // POST  — pre-create enumerator
    ]);
    expect(DIRECT.map((r) => r.rel).sort()).toEqual([
      '[id]/route.ts', '[id]/sources/route.ts', '[id]/tables/route.ts',
      'route.ts', 'source-tables/route.ts',
    ]);
    expect(DELEGATED.map((r) => r.rel).sort())
      .toEqual(['[id]/lifecycle/route.ts', '[id]/state/route.ts']);
    expect(ENUMERATORS.map((r) => r.rel).sort())
      .toEqual(['[id]/tables/route.ts', 'source-tables/route.ts']);
  });

  it('the engine the Start paths delegate to is itself guarded', () => {
    // Otherwise "delegated" would be a hole with a comment over it.
    const engine = fs.readFileSync(path.join(CONSOLE_ROOT, 'lib', 'azure', 'mirror-engine.ts'), 'utf8');
    const guardAt = engine.search(/describeMirrorConnMismatch\s*\(/);
    expect(guardAt, 'mirror-engine.ts no longer refuses a mismatched binding').toBeGreaterThan(-1);
    // Ahead of EVERY family branch — the ADF Copy branch returns early, so a
    // guard placed after it would cover only the SQL direction.
    const firstBranch = engine.search(/if\s*\(\s*isAdfCopy\s*\)/);
    expect(firstBranch).toBeGreaterThan(-1);
    expect(guardAt, 'the engine guard sits after a family branch that returns early')
      .toBeLessThan(firstBranch);
  });

  it.each(DIRECT.map((r) => [r.rel, r] as const))(
    '%s consults mirrorBindingMismatch',
    (_rel, r) => {
      expect(r.src, `${r.rel} reads a mirror sourceType + connectionId without the compatibility guard`)
        .toMatch(GUARD);
    },
  );

  it.each(DELEGATED.map((r) => [r.rel, r] as const))(
    '%s stamps the connection type through withSourceAuth so the engine can refuse',
    (_rel, r) => {
      expect(r.src).toMatch(DELEGATES_TO_ENGINE);
    },
  );

  it.each(ENUMERATORS.map((r) => [r.rel, r] as const))(
    '%s refuses BEFORE it dials the source, not after',
    (_rel, r) => {
      const guardAt = r.src.search(GUARD);
      const dialAt = r.src.search(DIALS);
      expect(guardAt).toBeGreaterThan(-1);
      expect(dialAt).toBeGreaterThan(-1);
      expect(
        guardAt,
        `${r.rel} checks compatibility AFTER it has already dialled the source — at ` +
        'that point the refusal can no longer truthfully say nothing was contacted (R7)',
      ).toBeLessThan(dialAt);
    },
  );

  it.each(
    DIRECT.filter((r) => COSMOS_WRITE.test(r.src)).map((r) => [r.rel, r] as const),
  )('%s refuses BEFORE it writes the binding to Cosmos', (_rel, r) => {
    // A guard that ran after the write would let the bad binding land and merely
    // complain about it afterwards.
    const guardAt = r.src.search(GUARD);
    const writeAt = r.src.search(COSMOS_WRITE);
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt, `${r.rel} persists the binding before checking it`).toBeLessThan(writeAt);
  });
});
