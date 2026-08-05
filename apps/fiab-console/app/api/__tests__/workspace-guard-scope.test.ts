/**
 * #2947 — READ vs WRITE scope guard for the workspace authorization ladder.
 *
 * WHY THIS IS A STATIC SPEC AND NOT A PER-ROUTE ONE. #2947 migrated 87 call
 * sites off `assertOwner` (which answered "did you CREATE this workspace",
 * never "may you ACCESS it") onto `authorizeItemWorkspace` / `authorizeWorkspace`.
 * Both take `{ allowReadRoles: true }`, which admits ANY workspace role —
 * including a read-only Viewer/Contributor. Adding that ONE key to a MUTATING
 * handler silently converts a write guard into a read guard: a Viewer could then
 * run a pipeline, execute arbitrary Spark, delete an item, or PUT a schema
 * version into Event Hubs Schema Registry. A per-route spec covers a sample; a
 * source scan covers all 87 and every future one.
 *
 * THE ASSERTION IS THE MUTATION PROOF. Add `allowReadRoles: true` to ANY
 * mutating handler in `app/api/**\/route.ts` and this spec goes RED naming the
 * file + verb. Delete a `{ allowReadRoles: true }` from a read-only GET and
 * nothing here fails — that direction is a usability regression, not a security
 * one, and is deliberately not ratcheted.
 *
 * It also pins the two invariants the migration established:
 *   - `assertOwner` no longer exists anywhere (the symbol was deleted, so tsc is
 *     the primary ratchet; this catches a re-inlined local copy by name).
 *   - the skippable shape `if (workspaceId && !(await authorize…))` — the #2723
 *     class where dropping a query param skipped authorization entirely — is
 *     absent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const API_ROOT = path.resolve(__dirname, '..');

/** Every `route.ts` under app/api. */
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

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const HANDLER_RE =
  /^export\s+(?:async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b|const\s+(GET|POST|PUT|PATCH|DELETE)\s*=)/;

/**
 * GET handlers that WRITE, so they must stay write-scoped even though the verb
 * says "read". Each was read and confirmed to persist Cosmos item state:
 *   - open-mirror GET   reconciles + `.replace()`s the mirror's state
 *   - execute-spark GET polls the Livy statement and persists its result
 *   - runs/[runId] GET  polls the run and persists its terminal status
 * Listed here so the spec ASSERTS they are write-scoped rather than merely not
 * checking GETs — i.e. this list has teeth in the strict direction.
 */
const MUTATING_GETS = [
  'app/api/items/mirrored-database/[id]/open-mirror/route.ts',
  'app/api/items/notebook/[id]/execute-spark/route.ts',
  'app/api/items/notebook/[id]/runs/[runId]/route.ts',
];

/**
 * Reasoned exemptions: a handler whose verb is mutating but which legitimately
 * makes N read-scoped authorize calls (a READ that happens to sit inside a POST).
 * The COUNT is part of the contract — adding a second read-scoped call to an
 * exempted handler still fails, so the exemption cannot be widened silently.
 */
const WRITE_SCOPE_EXEMPT = new Map<string, { readCalls: number; reason: string }>([
  [
    'app/api/thread/kql-query-to-dashboard-tile/route.ts:POST',
    {
      readCalls: 1,
      // This POST authorizes TWO different workspaces. The read-scoped call
      // (line ~121) gates reading the SOURCE kql-database/eventhouse item whose
      // query is being copied — a read, correctly read-scoped. The MUTATION
      // target is gated separately and write-scoped: appending a tile to an
      // existing dashboard calls `authorizeWorkspace(session, ws)` with NO
      // allowReadRoles, and the new-dashboard path goes through
      // `createOwnedItem(session, …)`, the write chokepoint.
      reason: 'read of the SOURCE item; the tile write is separately write-scoped',
    },
  ],
]);

interface Call {
  file: string;
  verb: string;
  fn: 'authorizeItemWorkspace' | 'authorizeWorkspace';
  allowReadRoles: boolean;
}

/**
 * Split a route file into exported-handler regions and collect every
 * authorize*Workspace call with whether it passes `allowReadRoles`.
 *
 * A call's argument text is taken from the call site up to its balanced closing
 * paren, so a multi-line options object is read correctly and a sibling call
 * later in the same handler can't bleed its flag into this one.
 */
function callsIn(abs: string): Call[] {
  const rel = path.relative(path.resolve(API_ROOT, '..', '..'), abs).replace(/\\/g, '/');
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  const bounds: Array<{ i: number; verb: string }> = [];
  lines.forEach((l, i) => {
    const m = l.match(HANDLER_RE);
    if (m) bounds.push({ i, verb: (m[1] || m[2])! });
  });
  const out: Call[] = [];
  bounds.forEach((b, k) => {
    const end = k + 1 < bounds.length ? bounds[k + 1].i : lines.length;
    const region = lines.slice(b.i, end).join('\n');
    for (const fn of ['authorizeItemWorkspace', 'authorizeWorkspace'] as const) {
      let at = region.indexOf(`${fn}(`);
      while (at !== -1) {
        // balanced-paren scan from the call's open paren
        let depth = 0;
        let j = at + fn.length;
        for (; j < region.length; j++) {
          if (region[j] === '(') depth++;
          else if (region[j] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        const args = region.slice(at, j + 1);
        out.push({ file: rel, verb: b.verb, fn, allowReadRoles: /allowReadRoles/.test(args) });
        at = region.indexOf(`${fn}(`, j);
      }
    }
  });
  return out;
}

const ALL_ROUTES = routeFiles(API_ROOT);
const ALL_CALLS = ALL_ROUTES.flatMap(callsIn);

describe('#2947 the migration actually happened', () => {
  it('finds authorize*Workspace calls across many route families (the scan is not vacuous)', () => {
    // A scan that silently matched nothing would pass every assertion below.
    expect(ALL_ROUTES.length).toBeGreaterThan(500);
    expect(ALL_CALLS.length).toBeGreaterThan(60);
    const families = new Set(ALL_CALLS.map((c) => c.file.split('/').slice(0, 5).join('/')));
    expect(families.size).toBeGreaterThan(10);
  });

  it('`assertOwner` exists nowhere in app/ or lib/ (the symbol was deleted)', () => {
    const roots = [API_ROOT, path.resolve(API_ROOT, '..', '..', 'lib')];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules') continue;
          walk(p);
        } else if (/\.tsx?$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          // Identifier use only. The name survives on purpose in the
          // deleted-on-purpose doc block and in `#2941`/`#2947` history
          // comments, so strip comment lines before matching.
          const code = src
            .split(/\r?\n/)
            .filter((l) => {
              const t = l.trim();
              return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
            })
            .join('\n');
          if (/(?:^|[^\w.])assertOwner\s*[(=:]/m.test(code)) {
            hits.push(path.relative(API_ROOT, p).replace(/\\/g, '/'));
          }
        }
      }
    };
    roots.forEach(walk);
    expect(hits, `assertOwner re-introduced in:\n${hits.join('\n')}`).toEqual([]);
  });

  it('no route makes authorization optional at the caller\'s discretion (#2723 shape)', () => {
    const bad: string[] = [];
    for (const abs of ALL_ROUTES) {
      const src = fs.readFileSync(abs, 'utf8');
      if (/\bworkspaceId\s*&&\s*!?\(?\s*await\s+(authorize|assert)/.test(src)) {
        bad.push(path.relative(API_ROOT, abs).replace(/\\/g, '/'));
      }
    }
    expect(bad, `skippable authorization in:\n${bad.join('\n')}`).toEqual([]);
  });
});

describe('#2947 read-only roles are never admitted to a mutation', () => {
  it('no POST/PUT/PATCH/DELETE handler passes allowReadRoles', () => {
    const perHandler = new Map<string, number>();
    for (const c of ALL_CALLS) {
      if (!MUTATING.has(c.verb) || !c.allowReadRoles) continue;
      const k = `${c.file}:${c.verb}`;
      perHandler.set(k, (perHandler.get(k) ?? 0) + 1);
    }
    const violations: string[] = [];
    for (const [k, n] of perHandler) {
      const ex = WRITE_SCOPE_EXEMPT.get(k);
      if (ex && n === ex.readCalls) continue;
      violations.push(
        ex
          ? `${k} → ${n} read-scoped calls, exemption allows ${ex.readCalls} (${ex.reason})`
          : `${k} → ${n} read-scoped call(s) in a MUTATING handler`,
      );
    }
    expect(
      violations.sort(),
      'A read-only Viewer/Contributor would be admitted to these MUTATIONS:\n' + violations.join('\n'),
    ).toEqual([]);
  });

  it('every write-scope exemption is real (an unused exemption is dead weight)', () => {
    for (const [k, ex] of WRITE_SCOPE_EXEMPT) {
      const [file, verb] = k.split(':');
      const n = ALL_CALLS.filter((c) => c.file === file && c.verb === verb && c.allowReadRoles).length;
      expect(n, `stale exemption ${k} (${ex.reason})`).toBe(ex.readCalls);
    }
  });

  it('the three GET handlers that WRITE are write-scoped too', () => {
    for (const file of MUTATING_GETS) {
      const gets = ALL_CALLS.filter((c) => c.file === file && c.verb === 'GET');
      expect(gets.length, `${file}: expected a GET authorize call`).toBeGreaterThan(0);
      for (const c of gets) {
        expect(
          c.allowReadRoles,
          `${file} GET persists item state — it must NOT pass allowReadRoles`,
        ).toBe(false);
      }
    }
  });

  it('read-only GETs DO opt in, so the migration did not silently lock every reader out', () => {
    // The bug #2947 fixes is "non-creators cannot read". If every call were
    // write-scoped the suite above would pass while the feature stayed broken.
    const readScoped = ALL_CALLS.filter(
      (c) => c.verb === 'GET' && c.allowReadRoles && !MUTATING_GETS.includes(c.file),
    );
    expect(readScoped.length).toBeGreaterThan(25);
  });
});
