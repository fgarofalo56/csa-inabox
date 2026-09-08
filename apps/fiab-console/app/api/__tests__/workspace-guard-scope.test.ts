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
 * WHAT A DERIVED POPULATION CANNOT SEE, stated because it was measured and not
 * anticipated (#4357 review finding 2). Everything above pins SCOPE over a
 * population this file derives by scanning, and every count is a LOWER BOUND.
 * Deleting the authorize call from a route does not trip a lower bound — it
 * SHRINKS the population the bound is taken over, so the suite goes green over a
 * route with no authorization left. The `MIGRATED` declaration below is the
 * complementary instrument: a hardcoded membership list, which cannot see a NEW
 * migrated route but is exactly the right shape for a REMOVED one. Both are
 * kept; neither replaces the other.
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

  // ── GHSA-hf73-rp4q-66pf: POST-shaped READS on the Power BI family ──────────
  // These nine routes were previously UNAUTHORIZED — id-addressed, consuming the
  // id, with no item-level check at all — and the advisory fix gave them the
  // canonical ladder. They are POSTs by HTTP verb only: none writes Loom item
  // state, and each is something a read-only Viewer must be able to do or the
  // item cannot be VIEWED. Denying read roles here would 404 legitimate viewers,
  // which is the failure the copy-job/[id]/watermark fix already had to undo.
  //
  // THE LINE, applied case by case rather than as a blanket: a POST is exempt
  // when it is REQUIRED TO VIEW the item and runs no caller-authored code as an
  // authoring affordance. `semantic-model/[id]/measures` was in the first cut of
  // this list and was REMOVED — its only caller is the Validate button on the
  // measure-authoring form, so it is now write-scoped in the route. That is the
  // direction this exemption list is allowed to move.
  [
    'app/api/items/dashboard/[id]/embed-token/route.ts:POST',
    { readCalls: 1, reason: "mints a Power BI 'View'-scope embed token; a Viewer sees nothing without it" },
  ],
  [
    'app/api/items/dashboard/[id]/tile-embed-token/route.ts:POST',
    { readCalls: 1, reason: "mints a per-tile 'View'-scope embed token; same viewing requirement" },
  ],
  [
    'app/api/items/dashboard/[id]/tile-query/route.ts:POST',
    {
      readCalls: 1,
      // A dashboard's tiles cannot render without running their queries, so this
      // IS viewing. Disclosed: the ADX database / PBI dataset still come from the
      // request body, so this scopes the ITEM, not the query target — recorded in
      // the route and in the advisory as an unfixed, separate class.
      reason: 'runs a tile query — a dashboard cannot render without it; the query TARGET is a separate unfixed scope',
    },
  ],
  [
    'app/api/items/report/[id]/embed-token/route.ts:POST',
    {
      readCalls: 1,
      // The flag is CONDITIONAL in the source — `accessLevel === 'Edit' ? {} :
      // { allowReadRoles: true }` — so an Edit-scope token stays write-scoped and
      // a Viewer cannot obtain an editing credential. This scan is static and
      // sees the token either way, hence the exemption; the conditional itself is
      // pinned by report/[id]/__tests__/ghsa-item-authz.test.ts.
      reason: "'View' token admits read roles; the 'Edit' branch is write-scoped (conditional, pinned by test)",
    },
  ],
  [
    'app/api/items/report/[id]/paginated-embed-token/route.ts:POST',
    { readCalls: 1, reason: 'mints a paginated embed token with allowEdit:false — read-only by construction' },
  ],
  [
    'app/api/items/report/[id]/export/route.ts:POST',
    { readCalls: 1, reason: 'renders content the caller can already read; Power BI grants export to its Viewer role too' },
  ],
  [
    'app/api/items/paginated-report/[id]/export/route.ts:POST',
    { readCalls: 1, reason: 'renders the RDL to a document; a read of content the caller can already open' },
  ],
  [
    'app/api/items/semantic-model/[id]/embed-token/route.ts:POST',
    { readCalls: 1, reason: "mints a Power BI 'View'-scope dataset token for the Q&A pane" },
  ],
  [
    'app/api/items/semantic-model/[id]/direct-lake/route.ts:POST',
    {
      readCalls: 1,
      // Surfaced only once this spec learned to follow module-local guard helpers
      // (see callsIn) — it was invisible before. It is the Direct Lake data-preview
      // tab (`executeDlQuery`), and it is called with `[id] === '_'` when no
      // dataset is bound, which is also why the route threads
      // `authorizeItemWorkspace` rather than `withWorkspaceOwner`.
      reason: 'Direct Lake data preview (DirectQuery read); PUT on the same route writes the shim config and IS write-scoped',
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
 * Does this call site GRANT read roles?
 *
 * NOT a bare `/allowReadRoles/` substring test — that was the defect this
 * function replaces (#4357 round 2, found by CI, not by review). A call site
 * that writes `{ allowReadRoles: false }` MENTIONS the flag while explicitly
 * REFUSING it, and the substring form counted that as a grant. Ten write-scoped
 * mutations across `items/[type]/[id]/**` went red for being MORE explicit than
 * the ones that simply omit the key. A guard that punishes the auditable
 * spelling teaches people to write the unauditable one, which is the opposite
 * of what this file is for.
 *
 * THE DECISION, in order:
 *
 *   1. a SPREAD anywhere in the stripped call args → GRANT, whatever else the
 *      text resolves to. A spread can reinstate the key at runtime: in
 *      `{ allowReadRoles: false, ...widen }` the spread wins and the literal
 *      `false` beside it is dead. This scan cannot evaluate it, so it assumes
 *      the worst.
 *   2. no `allowReadRoles` mention and no spread → no grant.
 *   3. a mention with NO resolvable `key: value` (shorthand, a forwarded value)
 *      → GRANT — statically unknowable, assume the worst.
 *   4. otherwise → GRANT unless EVERY resolved value is the literal `false`.
 *
 * WHAT IS ASSERTED — the enumeration, and deliberately nothing beyond it. Two
 * earlier revisions of this comment each claimed an exhaustiveness the code did
 * not have ("fail closed on anything that is not a literal `false`"; "every shape
 * that actually passes a value stays a grant"), and a reviewer defeated each by
 * constructing a shape it had not considered — the second time with
 * `{ allowReadRoles: false, ...widen }`, which admitted a read-only Viewer to a
 * POST with this suite green. Under `deploy-integrity.md` R7 an assertion the
 * code did not establish is a defect on its own, so this comment now lists the
 * shapes pinned by the `grantsReadRoles` describe block below and stops:
 *
 *   absent                                 → no grant
 *   `allowReadRoles: false`                → no grant, explicitly refused
 *   `allowReadRoles: true`                 → grant
 *   `: someVar` / `: o.flag` / `: o?.flag` → grant  (rule 3/4, unknowable)
 *   `{ allowReadRoles }` shorthand         → grant  (rule 3)
 *   `...(opts?.allowReadRoles ? … : {})`   → grant  (rule 1)
 *   `{ allowReadRoles: false, ...widen }`  → grant  (rule 1)
 *   `{ ...base, itemId }`, no mention      → grant  (rule 1)
 *   two option objects, one `false` one `true` → grant
 *   a value surviving only in a COMMENT or string → not read at all (the strip)
 *
 * MEASURED over the whole population before rule 1 was added — every `route.ts`
 * under `app/api` (1692 of them) run through the same `callsIn` scan this file
 * uses, 159 authorize call sites, classified by whether the stripped args carry
 * a spread; the output is in the PR #4357 review thread:
 *   - exactly ONE call site carries a spread at all
 *     (`items/report/[id]/embed-token:POST`), and it already resolved to a grant
 *     via `allowReadRoles: true`. So rule 1 changed no verdict in-tree; it is a
 *     ratchet against the NEXT one. The precondition is real: this PR made
 *     `{ allowReadRoles: false }` the spelling at ten MUTATING handlers, so a
 *     later `...opts` added beside one of them is now the cheap way through.
 *   - ZERO call sites carry a spread with no `allowReadRoles` mention.
 *
 * RESIDUAL CLASS, named rather than claimed away: an options object referenced
 * by IDENTIFIER — `loadItem(id, t, s, o)` where `o` is built above the call —
 * mentions nothing and spreads nothing, so it reads as "no grant" and is NOT
 * ratcheted. Measured: 24 call sites pass no object literal at all; all 24 were
 * read and every one passes only positional non-options arguments, so the
 * population of this shape is currently zero. A future call site of that shape
 * would be invisible here.
 *
 * Two behaviours changed versus the substring test, and NEITHER is a grant that
 * stopped being reported:
 *
 *   1. a resolvable literal `false` with no spread beside it — provably
 *      write-scoped, the false positive this replaced;
 *   2. a mention that survives only inside a COMMENT or a string literal — that
 *      is prose about the flag, not an argument passed to the guard.
 *
 * The stripping in (2) is load-bearing in the OTHER direction too, and that is
 * why it exists: matching the RAW argument text let a comment reading
 * `// allowReadRoles: false` MASK a real shorthand grant in the same call args
 * (`{ allowReadRoles }` resolves to no captured value → grant, unless the
 * comment supplies a `false` for `.some()` to fall through on). Measured on
 * `export-check:POST` before this fix: a read-only Viewer admitted to a mutation
 * with the suite green. Pinned below by the MASKING spec, plus the two that
 * mutate a mutating handler to `true` and to a variable and require both to go
 * red.
 */
/**
 * Blank out block comments, line comments and string/template literals so a
 * value that appears ONLY in prose cannot decide the outcome. Length and line
 * structure are preserved (each stripped char becomes a space) so nothing else
 * in the scan shifts.
 */
function stripCommentsAndStrings(args: string): string {
  return args.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (m) => m.replace(/[^\n]/g, ' '),
  );
}

function grantsReadRoles(rawArgs: string): boolean {
  const args = stripCommentsAndStrings(rawArgs);
  // RULE 1 — a SPREAD wins at runtime over anything written beside it, and this
  // static scan cannot evaluate what it carries. `{ allowReadRoles: false,
  // ...widen }` passes `true` when `widen` says so; before this line the literal
  // `false` was the only resolvable value and `.some()` fell through to "no
  // grant", admitting a read-only Viewer to a POST with this suite green.
  // Measured over 159 call sites: exactly one carries a spread and it already
  // granted, so this is a ratchet on the next one, not a reclassification.
  if (/\.\.\./.test(args)) return true;
  if (!/allowReadRoles/.test(args)) return false;
  const values = Array.from(
    args.matchAll(/allowReadRoles\s*:\s*([A-Za-z0-9_$.?![\]]+)/g),
    (m) => m[1],
  );
  // A mention with no resolvable `key: value` — ES shorthand — is a forwarded
  // value this static scan cannot evaluate. Grant.
  if (values.length === 0) return true;
  return values.some((v) => v !== 'false');
}
/**
 * Split a route file into exported-handler regions and collect every
 * authorize*Workspace call with whether it passes `allowReadRoles`.
 *
 * A call's argument text is taken from the call site up to its balanced closing
 * paren, so a multi-line options object is read correctly and a sibling call
 * later in the same handler can't bleed its flag into this one.
 *
 * MODULE-LOCAL GUARD HELPERS ARE FOLLOWED (GHSA-hf73-rp4q-66pf). Until this, the
 * scan only saw a LITERAL `authorize*Workspace(` inside a handler region — so the
 * widespread idiom
 *
 *   async function denyUnlessAuthorized(session, id, opts?) {
 *     return authorizeItemWorkspace(session, { …, ...(opts?.allowReadRoles ? … ) });
 *   }
 *   export const PUT = withSession(async (req, { session, params }) => {
 *     const denied = await denyUnlessAuthorized(session, params.id);   // ← invisible
 *
 * was INVISIBLE to it: the real call sits at module scope, above the first
 * handler, so it was attributed to no handler at all. `dashboard/[id]`,
 * `databricks-notebook/[id]/versions` and four semantic-model routes all use that
 * shape, so the population this spec watches excluded them — the same
 * guard-can't-see-what-it-should class this file exists to prevent, one level up.
 *
 * `allowReadRoles` is read from the HELPER CALL SITE, not the helper body. The
 * body necessarily mentions the flag (it forwards it conditionally), so reading
 * it there would mark every caller read-scoped — including the mutations, which
 * is precisely backwards. The call site is where the decision is actually made,
 * and `grantsReadRoles` above decides what that site actually says.
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

  // Module-scope helpers (declared at column 0) that reach an authorize call.
  // Their NAME becomes a scannable proxy for the call they perform.
  const helperNames: Array<{ name: string; fn: Call['fn'] }> = [];
  const helperDecl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let hm: RegExpExecArray | null;
  const preHandlers = bounds.length ? lines.slice(0, bounds[0].i).join('\n') : src;
  while ((hm = helperDecl.exec(preHandlers))) {
    const from = hm.index;
    // The helper's text runs to the next column-0 declaration or the end.
    const nextDecl = preHandlers.slice(from + hm[0].length).search(/^(?:export\s+)?(?:async\s+)?(?:function|const)\s/m);
    const body = nextDecl === -1
      ? preHandlers.slice(from)
      : preHandlers.slice(from, from + hm[0].length + nextDecl);
    for (const fn of ['authorizeItemWorkspace', 'authorizeWorkspace'] as const) {
      if (body.includes(`${fn}(`)) helperNames.push({ name: hm[1], fn });
    }
  }

  const out: Call[] = [];
  bounds.forEach((b, k) => {
    const end = k + 1 < bounds.length ? bounds[k + 1].i : lines.length;
    const region = lines.slice(b.i, end).join('\n');
    const scan = (token: string, fn: Call['fn']) => {
      let at = region.indexOf(`${token}(`);
      while (at !== -1) {
        // balanced-paren scan from the call's open paren
        let depth = 0;
        let j = at + token.length;
        for (; j < region.length; j++) {
          if (region[j] === '(') depth++;
          else if (region[j] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        const args = region.slice(at, j + 1);
        out.push({ file: rel, verb: b.verb, fn, allowReadRoles: grantsReadRoles(args) });
        at = region.indexOf(`${token}(`, j);
      }
    };
    for (const fn of ['authorizeItemWorkspace', 'authorizeWorkspace'] as const) scan(fn, fn);
    for (const h of helperNames) scan(h.name, h.fn);
  });
  return out;
}

const ALL_ROUTES = routeFiles(API_ROOT);
const ALL_CALLS = ALL_ROUTES.flatMap(callsIn);

/**
 * #3941's TEN MIGRATED ROUTES, DECLARED BY NAME — the instrument for a REMOVAL.
 *
 * WHY THIS BLOCK EXISTS (#4357 review finding 2). Every other assertion in this
 * file is a LOWER BOUND over a population the scan DERIVES: `ALL_ROUTES.length >
 * 500`, `ALL_CALLS.length > 60`, `families.size > 10`, read-scoped GETs `> 25`,
 * grants `> 25`. That shape cannot see a deletion, because a deletion shrinks
 * the population being counted.
 *
 * MEASURED, not argued. Removing the `authorizeItemWorkspace` call and its
 * `if (denied)` line from `sensitivity-label/route.ts`'s `loadItem` makes that
 * route stop being a recognized module-local guard helper, so its FOUR call
 * sites vanish from `ALL_CALLS` entirely. `vitest run` on this file with that
 * mutation applied: **1 failed / 18 passed** — and the one failure is the
 * assertion below. Every pre-existing assertion in this file stayed green over
 * a route whose authorization had been deleted.
 *
 * A HARDCODED POPULATION IS THE WRONG INSTRUMENT FOR GROWTH AND THE RIGHT ONE
 * FOR SHRINKAGE, and both halves are true here. It cannot see a NEW migrated
 * route — the `> N` thresholds above stay, and they are what watches growth.
 * What it CAN see is one of these eighteen handlers losing its call, or having
 * its scope flipped.
 *
 * THE MUTATION IT IS BUILT FOR, so it can be re-run: in any listed file, delete
 * the `const denied = await authorizeItemWorkspace(session, {…})` call and the
 * `if (denied)` line from `loadItem`, returning `{ item, denied: null }`
 * unconditionally. This block then fails naming the file and verb. The runtime
 * counterpart lives in `app/api/items/[type]/[id]/__tests__/workspace-authz.test.ts`,
 * which executes the real ladder and watches it REFUSE; this one is static and
 * covers all eighteen handlers, that one is behavioural and covers three.
 *
 * `true` = `allowReadRoles` granted (read-only workspace roles admitted, correct
 * for a strictly read-only GET). `false` = write-scoped (Owner/Admin/Member).
 */
const MIGRATED: Array<{ file: string; handlers: Array<{ verb: string; allowReadRoles: boolean }> }> = [
  {
    // The BASE route — backs GET/PATCH/DELETE for every item type that has no
    // dedicated `[id]/route.ts`, so it is the widest blast radius of the ten.
    file: 'app/api/items/[type]/[id]/route.ts',
    handlers: [
      { verb: 'GET', allowReadRoles: true },
      { verb: 'PATCH', allowReadRoles: false },
      { verb: 'DELETE', allowReadRoles: false },
    ],
  },
  {
    file: 'app/api/items/[type]/[id]/access-mode/route.ts',
    handlers: [{ verb: 'PATCH', allowReadRoles: false }],
  },
  {
    file: 'app/api/items/[type]/[id]/business-metadata/route.ts',
    handlers: [
      { verb: 'GET', allowReadRoles: true },
      { verb: 'POST', allowReadRoles: false },
    ],
  },
  {
    file: 'app/api/items/[type]/[id]/classifications/route.ts',
    handlers: [
      { verb: 'GET', allowReadRoles: true },
      { verb: 'PUT', allowReadRoles: false },
    ],
  },
  {
    file: 'app/api/items/[type]/[id]/export-check/route.ts',
    handlers: [{ verb: 'POST', allowReadRoles: false }],
  },
  {
    file: 'app/api/items/[type]/[id]/impact/route.ts',
    handlers: [{ verb: 'GET', allowReadRoles: true }],
  },
  {
    file: 'app/api/items/[type]/[id]/lineage/route.ts',
    handlers: [{ verb: 'GET', allowReadRoles: true }],
  },
  {
    file: 'app/api/items/[type]/[id]/pbids/route.ts',
    handlers: [{ verb: 'GET', allowReadRoles: true }],
  },
  {
    file: 'app/api/items/[type]/[id]/sensitivity/route.ts',
    handlers: [
      { verb: 'GET', allowReadRoles: true },
      { verb: 'PUT', allowReadRoles: false },
    ],
  },
  {
    file: 'app/api/items/[type]/[id]/sensitivity-label/route.ts',
    handlers: [
      { verb: 'GET', allowReadRoles: true },
      { verb: 'PUT', allowReadRoles: false },
      { verb: 'PATCH', allowReadRoles: false },
      { verb: 'DELETE', allowReadRoles: false },
    ],
  },
];

describe('#3941 the ten migrated routes are STILL guarded (declared membership)', () => {
  it('every declared handler still reaches the ladder — a deleted call is named, not absorbed', () => {
    const missing: string[] = [];
    for (const { file, handlers } of MIGRATED) {
      for (const { verb } of handlers) {
        const calls = ALL_CALLS.filter((c) => c.file === file && c.verb === verb);
        if (calls.length === 0) missing.push(`${file}:${verb}`);
      }
    }
    expect(
      missing.sort(),
      'These handlers no longer reach authorizeItemWorkspace/authorizeWorkspace.\n' +
        'Either the authorization was deleted, or `loadItem` stopped being a\n' +
        'recognized module-local guard helper (which has the same effect):\n' +
        missing.join('\n'),
    ).toEqual([]);
  });

  it('every declared handler still carries the SCOPE it was migrated with', () => {
    const wrong: string[] = [];
    for (const { file, handlers } of MIGRATED) {
      for (const { verb, allowReadRoles } of handlers) {
        for (const c of ALL_CALLS.filter((x) => x.file === file && x.verb === verb)) {
          if (c.allowReadRoles !== allowReadRoles) {
            wrong.push(
              `${file}:${verb} → allowReadRoles=${c.allowReadRoles}, declared ${allowReadRoles}` +
                (allowReadRoles === false ? ' (a read-only Viewer would reach this MUTATION)' : ''),
            );
          }
        }
      }
    }
    expect(wrong.sort(), 'Scope drift on a migrated handler:\n' + wrong.join('\n')).toEqual([]);
  });

  it('the declaration itself is the shape #3941 landed — 10 files, 18 handlers', () => {
    // Guards the declaration against being quietly emptied to make the two
    // assertions above vacuous. A NEW migrated route is invisible here by
    // construction (see the block comment); the `> N` thresholds watch growth.
    //
    // EIGHTEEN, NOT SEVENTEEN. The #4357 review's per-route table says "All 17
    // handlers across the 10 files"; summing its own rows gives 3+1+2+2+1+1+1+
    // 1+2+4 = 18, and the same count comes out of the tree:
    //   grep -cE "^export (async function|const) (GET|POST|PUT|PATCH|DELETE)\b"
    // over the ten files returns 3 1 2 2 1 1 1 1 2 4. Every one of the 18 is
    // present in `ALL_CALLS` (the two assertions above), so the review's figure
    // was an arithmetic slip in the summary line, not a missing handler.
    expect(MIGRATED).toHaveLength(10);
    expect(MIGRATED.reduce((n, m) => n + m.handlers.length, 0)).toBe(18);
    // Every mutating verb in the declaration is write-scoped, and every GET is
    // read-scoped. If a future edit flips a declared value to match a regressed
    // route, this fails instead of ratifying it.
    for (const { file, handlers } of MIGRATED) {
      for (const { verb, allowReadRoles } of handlers) {
        expect(allowReadRoles, `${file}:${verb} declared with the wrong scope`).toBe(
          !MUTATING.has(verb),
        );
      }
    }
  });
});

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

/**
 * The scanner's own discriminator, asserted directly.
 *
 * The suites above measure the REPO. They would all stay green if
 * `grantsReadRoles` were quietly relaxed to `() => false`, because a scanner
 * that grants nothing reports no violations — the classic hollow control. These
 * assert the function itself, so the relaxation that fixed the false positive
 * cannot be widened into a real hole without a test going red.
 */
describe('grantsReadRoles — the value is read, and everything unresolvable FAILS CLOSED', () => {
  it('a literal false is NOT a grant — the false positive this replaced', () => {
    expect(grantsReadRoles('loadItem(id, type, session, { allowReadRoles: false })')).toBe(false);
    expect(grantsReadRoles('authorizeItemWorkspace(s, { workspaceId, allowReadRoles : false })')).toBe(false);
  });

  it('a literal true IS a grant', () => {
    expect(grantsReadRoles('authorizeItemWorkspace(s, { workspaceId, allowReadRoles: true })')).toBe(true);
  });

  it('no mention at all is not a grant', () => {
    expect(grantsReadRoles('authorizeItemWorkspace(s, { workspaceId, itemId })')).toBe(false);
  });

  it('FAILS CLOSED on every shape it cannot evaluate', () => {
    // A forwarded variable — the value lives at another call site.
    expect(grantsReadRoles('guard(s, { allowReadRoles: allowReadRoles })')).toBe(true);
    expect(grantsReadRoles('guard(s, { allowReadRoles: opts.allowReadRoles })')).toBe(true);
    expect(grantsReadRoles('guard(s, { allowReadRoles: opts?.readOk })')).toBe(true);
    // ES shorthand.
    expect(grantsReadRoles('guard(s, { workspaceId, allowReadRoles })')).toBe(true);
    // The GHSA-hf73-rp4q-66pf conditional-spread helper idiom.
    expect(grantsReadRoles('guard(s, { ...(opts?.allowReadRoles ? { allowReadRoles: true } : {}) })')).toBe(true);
  });

  it('a COMMENT or string literal cannot MASK a real grant (#4357 re-review item 1)', () => {
    // Measured on the real thing before the strip landed: an ES-shorthand grant
    // inside a MUTATING handler went unreported because a comment in the same
    // call args read `allowReadRoles: false`, which `.some()` then fell through
    // on. A read-only Viewer was admitted to a POST with the suite green.
    expect(
      grantsReadRoles(
        'loadItem(id, type, session, {\n  // scope stays as it was: allowReadRoles: false\n  allowReadRoles,\n})',
      ),
    ).toBe(true);
    expect(
      grantsReadRoles('guard(s, { /* allowReadRoles: false */ allowReadRoles: opts.readOk })'),
    ).toBe(true);
    expect(
      grantsReadRoles("guard(s, { reason: 'allowReadRoles: false', allowReadRoles: true })"),
    ).toBe(true);
    // ...and a mention that lives ONLY in prose is not an argument at all.
    expect(grantsReadRoles('guard(s, { workspaceId }) // allowReadRoles is not passed')).toBe(false);
  });

  it('ANY grant in a multi-flag call site wins', () => {
    // A call passing two option objects must not be excused by the false one.
    expect(
      grantsReadRoles('guard(s, { allowReadRoles: false }, { allowReadRoles: true })'),
    ).toBe(true);
  });

  it('a SPREAD is a grant even beside a literal false (#4357 review 4)', () => {
    // The hole this closes, constructed by a reviewer on `export-check:POST`:
    //   const widen = { allowReadRoles: true } as const;
    //   loadItem(id, type, session, { allowReadRoles: false, ...widen });
    // At runtime the spread wins, so a read-only Viewer is admitted to a POST.
    // The scan captured only the literal `false`, so `.some()` fell through to
    // "no grant" and the suite stayed green — the same masking shape the comment
    // strip fixed, with a real `false` instead of a commented one.
    expect(
      grantsReadRoles('loadItem(id, type, session, { allowReadRoles: false, ...widen })'),
    ).toBe(true);
    expect(
      grantsReadRoles('loadItem(id, type, session, { ...widen, allowReadRoles: false })'),
    ).toBe(true);
    // A spread that never names the flag is equally unevaluable — it can carry
    // the key without the call text ever saying so.
    expect(grantsReadRoles('authorizeItemWorkspace(s, { ...base, itemId })')).toBe(true);
  });

  it('the spread rule did NOT swallow the false-positive fix it sits on top of', () => {
    // Guards the direction that matters in the other direction: the ten
    // MUTATING handlers this PR wrote `{ allowReadRoles: false }` into carry no
    // spread, and must stay unreported. If rule 1 ever widened to "any object
    // literal", these would go red and the ten explicit refusals would be
    // punished again for being auditable.
    expect(grantsReadRoles('loadItem(id, type, session, { allowReadRoles: false })')).toBe(false);
    expect(
      grantsReadRoles('authorizeItemWorkspace(s, {\n  workspaceId,\n  itemId,\n  allowReadRoles: false,\n  notFound: x,\n})'),
    ).toBe(false);
  });

  it('POSITIVE CONTROL — the real repo scan still finds grants, so the fix did not empty it', () => {
    // If `grantsReadRoles` regressed to always-false, every suite above would go
    // green over a scanner watching nothing. This is the population check.
    expect(ALL_CALLS.filter((c) => c.allowReadRoles).length).toBeGreaterThan(25);
  });
});
