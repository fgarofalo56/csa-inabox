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
const API_ROOT = path.join(CONSOLE_ROOT, 'app', 'api');
const MIRROR_ROUTES = path.join(API_ROOT, 'items', 'mirrored-database');

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
const rel = (f: string) => path.relative(API_ROOT, f).replace(/\\/g, '/');

const MIRROR: Route[] = routeFiles(MIRROR_ROUTES)
  .map((f) => ({ rel: rel(f), src: fs.readFileSync(f, 'utf8') }));

/**
 * The mirror ENGINE is shared beyond the mirrored-database item type — the CDC
 * connector control plane runs the very same `runMirrorSnapshot`. Scoping this
 * spec to `items/mirrored-database` is what let a SIXTH surface exist: the CDC
 * Start route called `captureSourceSchema` unconditionally AFTER a `Gated`
 * verdict, dialling the source the engine had just refused to contact — which
 * made the refusal message's "no request was sent" claim false on that path.
 *
 * So the population is every route that runs the engine, wherever it lives.
 */
const ENGINE_RUNNERS: Route[] = routeFiles(API_ROOT)
  .map((f) => ({ rel: rel(f), src: fs.readFileSync(f, 'utf8') }))
  .filter((r) => /runMirrorSnapshot\s*\(/.test(r.src));

const ALL: Route[] = [
  ...MIRROR,
  ...ENGINE_RUNNERS.filter((e) => !MIRROR.some((m) => m.rel === e.rel)),
];

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

/**
 * In scope: reads a source type AND can reach a bound connection, OR runs the
 * engine at all.
 *
 * The second arm is load-bearing. The CDC connector Start route builds its
 * source through `connectorToEngineSource(state)` and never contains the literal
 * `sourceType`, so a name-based filter alone silently dropped it — which is how
 * it stayed a sixth, unguarded surface. An engine runner is in scope by virtue
 * of running the engine, whatever its local vocabulary.
 */
const IN_SCOPE = ALL.filter((r) =>
  (/\bsourceType\b/.test(r.src) && /\bconnectionId\b/.test(r.src))
  || ENGINE_RUNNERS.some((e) => e.rel === r.rel));

/**
 * Branches into a per-family enumerator — i.e. actually DIALS the source. Keyed
 * to the enumerator calls, not to `MIRROR_SQL_FAMILY.has(...)`: `[id]/sources`
 * references that constant in a `knownSource()` validator and never contacts
 * anything, so keying on the constant misclassified it.
 */
const DIALS = /\b(listTablesWithAuth|listTables|listPostgresTables|listContainers|listSnowflakeTables)\s*\(/;
const ENUMERATORS = IN_SCOPE.filter((r) => DIALS.test(r.src));

/** Routes that must hold the check themselves (everything not engine-delegated). */
const DELEGATED = IN_SCOPE.filter((r) => DELEGATES_TO_ENGINE.test(r.src));
/**
 * Engine runners that bind NO Loom Connection at all — there is nothing that
 * could contradict the source type, so there is nothing to check.
 *
 * `items/azure-sql-database/[id]/mirroring` is the case: it hardcodes
 * `sourceType: 'AzureSqlDatabase'` and takes server/database from the ITEM'S
 * admitted binding via `withBoundSqlServer`, never from a connection or the
 * request body. A Snowflake account identifier cannot reach it.
 *
 * This class is asserted, not assumed: the membership test below re-checks that
 * these routes really do read no `connectionId`. Add connection binding to one
 * and it falls out of this class into DIRECT, which requires the guard — so the
 * exemption cannot silently outlive its reason.
 */
const UNBOUND = IN_SCOPE.filter((r) =>
  !DELEGATES_TO_ENGINE.test(r.src) && !/\bconnectionId\b/.test(r.src));
const DIRECT = IN_SCOPE.filter((r) =>
  !DELEGATES_TO_ENGINE.test(r.src) && /\bconnectionId\b/.test(r.src));

/** Cosmos item writes only — not every `.replace()` on a string. */
const COSMOS_WRITE = /items\s*\.\s*item\([^;]*?\)\s*\.\s*replace\s*\(|items\s*\.\s*items\s*\.\s*create\s*\(/s;

/**
 * Anything that contacts the source AFTER the engine has returned a verdict.
 * `captureSourceSchema` is the one that existed; the list is the shape, so a new
 * post-run source read joins the contract instead of slipping past it.
 */
const POST_RUN_DIAL = /\b(captureSourceSchema)\s*\(/;

describe('every route that binds or runs a mirror source is guarded', () => {
  it('EMBEDDED CONTROL: the population, split by who holds the check', () => {
    // A guard over a zero (or silently shrunken) population proves nothing. If
    // a route is added, renamed, or drops one of the two coordinates, this
    // fails LOUDLY rather than passing over a smaller set.
    expect(IN_SCOPE.map((r) => r.rel).sort()).toEqual([
      'cdc/connectors/[id]/state/route.ts',               // Start — engine-delegated (the SIXTH surface)
      'items/azure-sql-database/[id]/mirroring/route.ts', // Start — binds NO connection
      'items/mirrored-database/[id]/lifecycle/route.ts',  // Start — engine-delegated
      'items/mirrored-database/[id]/route.ts',            // PATCH — edit-save persists the binding
      'items/mirrored-database/[id]/sources/route.ts',    // POST  — sets the binding explicitly
      'items/mirrored-database/[id]/state/route.ts',      // Start — engine-delegated
      'items/mirrored-database/[id]/tables/route.ts',     // GET   — credential-aware enumerator
      'items/mirrored-database/route.ts',                 // POST  — create persists the binding
      'items/mirrored-database/source-tables/route.ts',   // POST  — pre-create enumerator
    ]);
    expect(DIRECT.map((r) => r.rel).sort()).toEqual([
      'items/mirrored-database/[id]/route.ts',
      'items/mirrored-database/[id]/sources/route.ts',
      'items/mirrored-database/[id]/tables/route.ts',
      'items/mirrored-database/route.ts',
      'items/mirrored-database/source-tables/route.ts',
    ]);
    expect(DELEGATED.map((r) => r.rel).sort()).toEqual([
      'cdc/connectors/[id]/state/route.ts',
      'items/mirrored-database/[id]/lifecycle/route.ts',
      'items/mirrored-database/[id]/state/route.ts',
    ]);
    expect(UNBOUND.map((r) => r.rel).sort())
      .toEqual(['items/azure-sql-database/[id]/mirroring/route.ts']);
    expect(ENUMERATORS.map((r) => r.rel).sort()).toEqual([
      'items/mirrored-database/[id]/tables/route.ts',
      'items/mirrored-database/source-tables/route.ts',
    ]);
    // Every engine runner must land in exactly one class — an engine runner in
    // none of them would silently drop out of this contract entirely.
    expect(ENGINE_RUNNERS.map((r) => r.rel).sort())
      .toEqual([...DELEGATED, ...UNBOUND].map((r) => r.rel).sort());
  });

  it.each(UNBOUND.map((r) => [r.rel, r] as const))(
    '%s is exempt ONLY because it binds no connection — re-checked, not assumed',
    (_rel, r) => {
      expect(
        r.src,
        `${r.rel} now reads a connectionId, so "nothing can contradict the source type" ` +
        'is no longer true — it must consult mirrorBindingMismatch or delegate to the engine',
      ).not.toMatch(/\bconnectionId\b/);
    },
  );

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
    '%s obtains its source from withSourceAuth (which carries the connType stamp)',
    (_rel, r) => {
      // NOTE — this asserts PRESENCE of the call, not that the stamp survives.
      // The name used to claim it "stamps the connection type", which overstated
      // what a regex can see, and a mutation deleting the stamp escaped through
      // exactly that gap. The stamp's ANSWER is pinned behaviourally in
      // mirror-binding-mismatch.test.ts + mirror-source-mismatch-engine.test.ts.
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
    DELEGATED.filter((r) => POST_RUN_DIAL.test(r.src)).map((r) => [r.rel, r] as const),
  )('%s does not dial the source after a Gated verdict', (_rel, r) => {
    // THE SIXTH SURFACE. `captureSourceSchema` ran unconditionally after the
    // engine returned Gated, reaching azure-sql-client's hostname-constructing
    // ternary — which made the refusal's "no request was sent to either system"
    // claim FALSE on this path.
    //
    // Keyed to the SAFE spelling, so it fails CLOSED: any rewording of the guard
    // turns this red and the author must re-establish the property deliberately.
    // The point-of-dial refusal inside captureSourceSchema is the structural
    // backstop, pinned behaviourally in lib/cdc/__tests__/schema-capture-mismatch.
    const guardAt = r.src.search(/run\.status\s*!==\s*'Gated'/);
    const dialAt = r.src.search(POST_RUN_DIAL);
    expect(
      guardAt,
      `${r.rel} calls captureSourceSchema with no \`run.status !== 'Gated'\` guard — ` +
      'a Gated verdict means nothing was contacted, and this would contact it',
    ).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(dialAt);
  });

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
