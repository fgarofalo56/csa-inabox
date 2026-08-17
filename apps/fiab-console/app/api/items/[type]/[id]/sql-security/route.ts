/**
 * SQL granular security wizards (F11) — BFF route.
 *
 *   GET  /api/items/[type]/[id]/sql-security
 *        → returns the live security state for the wizard pickers + state panel:
 *          { principals, tables, views, columns, grants, maskedColumns,
 *            securityPolicies }
 *
 *   POST /api/items/[type]/[id]/sql-security
 *        body { wizard, params, preview?, server?, database? }
 *        - preview:true  → returns { ok, sql } WITHOUT executing (preview pane)
 *        - preview:false → executes the generated T-SQL over TDS and returns
 *                          { ok, sql, recordsAffected, executionMs }
 *        body { action:'verify', verify:{principal, schema, table, column?}, … }
 *        - runs EXECUTE AS USER + SELECT + REVERT so the masked/RLS effect is
 *          provable for the test principal (returns the rows that principal sees).
 *
 * Backends dispatched by [type] (Azure-native default, NO Microsoft Fabric):
 *   - synapse-dedicated-sql-pool  → Synapse Dedicated pool (env-bound)
 *   - synapse-serverless-sql-pool → Synapse Serverless endpoint (?database=)
 *   - azure-sql-database / warehouse → Azure SQL (server + database from the
 *     OWNED item's bound connection — never from the request)
 *
 * AUTH IS ENTRA-ONLY. Both clients build their TDS pool with
 * `authentication.type='azure-active-directory-access-token'` — there is no
 * SQL-auth (username/password) code path anywhere in this route or its clients,
 * which satisfies the "Entra-only connection enforced" acceptance criterion.
 *
 * The client NEVER sends raw SQL: it sends a structured `params` object and the
 * SQL is built server-side by lib/sql/tsql-builders.ts (bracket-quoted
 * identifiers + allowlisted verbs/masks), so there is no injection path.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v8r7-c2p5-mjf2 — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Authorization was `getSession()` and nothing else. `[id]` was destructured and
 * then never used — it reached no ownership call on either verb — while the
 * EXECUTION COORDINATES came straight off the request:
 *
 *   GET   `req.nextUrl.searchParams.get('server')` / `('database')`
 *   POST  `body?.server` / `body?.database`
 *
 * `resolveBackend(type, { server, database })` passed them into
 * `azureSqlExecute(server, database, sql)` — TDS with a Microsoft Entra access
 * token as the Console UAMI. So any authenticated session named a server and a
 * database and this route read that database's FULL SECURITY CATALOG
 * (principals, object grants, masked columns, RLS policies) and executed
 * generated DDL/DCL there — GRANT, DENY, CREATE SECURITY POLICY, ADD MASKED.
 *
 * WHY NO CONTROL SAW IT — and why the allowlist entry is DELETED rather than
 * reworded. `check-route-guards.mjs` carried this path with the reason
 *
 *     "SQL security over a shared Azure backend resolved by item-type gate"
 *
 * which is true of TWO of the branches and false of the one that matters. The
 * Synapse branches genuinely are resolved by item TYPE: they read
 * `LOOM_SYNAPSE_WORKSPACE` / `LOOM_SYNAPSE_DEDICATED_POOL` from the environment
 * and ignore `opts` entirely. The `azure-sql-database` branch took its
 * coordinates from the caller. An inherited reason is not evidence; a reason
 * that is ACCURATE ABOUT A SIBLING BRANCH and wrong about this one is worse,
 * because it reads as verified. A reworded allowlist entry would preserve
 * exactly that failure, so the entry is gone and the route now passes CHECK 2 on
 * a real guard signal.
 *
 * ── THE LAYERS, and which one is doing the work per branch ──────────────────
 *
 * LAYER 1 — OWN THE ROUTE ITEM. Every branch, both verbs. `loadOwnedSqlItem`
 *   runs the canonical `loadOwnedItem(id, type, oid, { session })` owner /
 *   workspace-ACL check per candidate type, so `[id]` finally conveys authority.
 *   404-not-403, matching `withWorkspaceOwner`, so an id cannot be probed for
 *   existence across tenants.
 *
 *   WRITE-SCOPED ON BOTH VERBS — no `allowReadRoles`, deliberately, including on
 *   the GET. The sibling `azure-sql-database/[id]/query` records the rule: this
 *   route reaches the same `executeQuery` TDS executor, and the GET's seven
 *   catalog reads return who holds which grants, which columns are masked and
 *   which RLS predicates are in force — the security posture of the database. A
 *   read-only Viewer of a shared workspace does not get that, and cannot reach
 *   the executor at all.
 *
 * LAYER 2 + LAYER 3 — AZURE SQL BRANCH ONLY. The target is resolved from the
 *   owned item's `state.connection` and admitted against
 *   `sqlAuthorizedSubscriptions()`, by the same `resolveOwnedSqlTarget` that
 *   `[id]/query` and `[id]/copilot` use. The request's `server`/`database` can
 *   now only CAUSE A REFUSAL (403 `server_mismatch` / `database_mismatch`) —
 *   they can never pick the target.
 *
 *   LAYER 2 DOES NOT 409 A LEGITIMATE FLOW HERE, checked against every caller
 *   rather than assumed. `SqlSecurityPanel` has exactly four call sites; only
 *   `unified-sql-database-editor.tsx` reaches this branch, it renders the panel
 *   ONLY when `server && database` are both set, and #3623 gave that editor a
 *   bind-on-selection effect that persists `{family, server, database}` to
 *   `state.connection` the moment the selection changes. The editor does not
 *   hydrate its pickers from item state, so a rendered panel always follows a
 *   fresh pick, which always follows a bind. The other three call sites
 *   (`synapse-sql-editors` ×2, `phase3/warehouse-editor`) are Synapse branches
 *   and never reach Layer 2 at all.
 *
 *   And when the bind has genuinely not landed, the refusal is rendered as the
 *   route's EXISTING honest gate rather than a red error — see `gateOrError`.
 *
 * LAYER 3-EQUIVALENT — SYNAPSE SERVERLESS. `opts.database` is still
 *   caller-influenced: it selects which database on the deployment's OWN
 *   env-derived serverless endpoint the query runs against. That is materially
 *   smaller than the Azure SQL branch (no other estate is reachable, and
 *   `mssql` takes the name as a discrete config field rather than interpolating
 *   it into a connection string) but it is NOT nothing, so it is bounded by
 *   shape here and the residual is stated rather than implied away:
 *
 *   RESIDUAL, RECORDED: after this change an authenticated caller who owns ANY
 *   `synapse-serverless-sql-pool` item can still name any database on this
 *   deployment's own Synapse serverless endpoint. Closing that needs a
 *   per-item binding for serverless pools that does not exist today (the
 *   serverless editor picks its database from a live `sys.databases`
 *   enumeration, not from item state), and is deliberately not attempted here.
 *
 * The Synapse DEDICATED branch (and `warehouse`) takes no caller coordinate at
 * all — pool and workspace are both env-derived — so Layer 1 is the whole fix
 * there, and that is the branch the deleted allowlist reason actually described.
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiError, apiNotFound } from '@/lib/api/respond';
import type { SessionPayload } from '@/lib/auth/session';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { SQL_EDITOR_ITEM_TYPES, loadOwnedSqlItem } from '@/app/api/items/_lib/sql-server-scope';
import { resolveOwnedSqlTarget } from '@/app/api/items/azure-sql-database/_bound-connection';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery as synapseExecute,
  type SynapseTarget,
} from '@/lib/azure/synapse-sql-client';
import { executeQuery as azureSqlExecute, AzureSqlError } from '@/lib/azure/azure-sql-client';
import {
  buildWizardSql,
  buildVerifyAs,
  splitSqlBatches,
  TsqlBuildError,
  SQL_LIST_DATABASE_PRINCIPALS,
  SQL_LIST_TABLES,
  SQL_LIST_VIEWS,
  SQL_LIST_COLUMNS,
  SQL_LIST_OBJECT_GRANTS,
  SQL_LIST_MASKED_COLUMNS,
  SQL_LIST_SECURITY_POLICIES,
  type WizardKind,
} from '@/lib/sql/tsql-builders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Backend = 'synapse-dedicated' | 'synapse-serverless' | 'azure-sql';

interface Reader {
  backend: Backend;
  serverless: boolean;
  /** Run a single-statement read and return columns + row objects. */
  run: (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>;
  /** Execute one or more T-SQL batches (split on GO) and return a receipt. */
  exec: (sql: string) => Promise<{ recordsAffected: number; executionMs: number; messages: string[] }>;
}

/**
 * Which backend this item TYPE speaks. A pure function of the type, evaluated
 * BEFORE anything touches the request coordinates, so the ownership check that
 * follows cannot be steered by them.
 */
function backendKindFor(type: string): Backend {
  if (type === 'synapse-dedicated-sql-pool' || type === 'warehouse') return 'synapse-dedicated';
  if (type === 'synapse-serverless-sql-pool') return 'synapse-serverless';
  return 'azure-sql';
}

/**
 * The Cosmos itemTypes this route's `[id]` may name.
 *
 * The Azure SQL branch is resolved across {@link SQL_EDITOR_ITEM_TYPES} for the
 * reason #3639 records: `SqlSecurityPanel` is mounted by
 * `unified-sql-database-editor` with a HARD-CODED `itemType="azure-sql-database"`
 * while the editor itself is registered for several slugs, so the URL's `[type]`
 * segment is not reliably the item's own type. Resolving one type would 404 a
 * working button; resolving several cannot widen access, because every candidate
 * runs the same owner / workspace-ACL check independently and a foreign item
 * resolves for NONE of them.
 *
 * The path type is tried FIRST and always — it is the only candidate for the
 * Synapse branches, and on the Azure SQL branch it covers a slug the shared
 * constant does not yet list.
 */
function candidateItemTypes(type: string, kind: Backend): string[] {
  const candidates = kind === 'azure-sql' ? [type, ...SQL_EDITOR_ITEM_TYPES] : [type];
  return Array.from(new Set(candidates));
}

/**
 * Synapse database names accepted on the SERVERLESS branch.
 *
 * A SHAPE bound, not an authorization bound — see the residual in this file's
 * header. It exists so a value that could never name a real database (a path
 * separator, a `;`, a quote, a bracket, a control character, a 4 KB string) is
 * refused before it reaches `serverlessTarget()` and the connection-pool cache
 * key.
 *
 * DEFINED BY EXCLUSION, and that is a deliberate correction. The first version
 * of this was an ALLOWLIST — `[\p{L}\p{N}_ .-]` — whose own doc-comment argued
 * for Unicode-awareness "so the class does not 400 a legitimately-named
 * database", and which then omitted `@`, `$` and `#`. SQL Server permits those
 * in an identifier, so `sales#2024` and `db$archive` were refused: the exact
 * defect the comment claimed to be avoiding, one line below the claim.
 *
 * Writing a correct allowlist means encoding SQL Server's identifier grammar,
 * and I could not reach Microsoft Learn from this execution context to ground
 * it. Transcribing it from memory is what produced the bug in the first place,
 * so this does not try: it **excludes** the characters that make a value
 * implausible as a database name or hazardous in a connection context, and
 * nothing else. Whatever the grammar's exact edges are, this cannot refuse a
 * legal name that avoids separators, quotes, brackets and control characters.
 *
 * Excluded: `\p{C}` (control / format / surrogate / unassigned), `\p{Zl}`+`\p{Zp}`
 * (line + paragraph separators), `/` `\` (path separators), `;` (statement /
 * connection-string separator), `'` `"` and `[` `]` (SQL quoting). Length is
 * capped at 128, SQL Server's `sysname` limit.
 *
 * NO LEADING-CHARACTER RESTRICTION, declined on purpose. Review suggested
 * keeping `@`/`#` out of the leading class to stay clear of `@variable` /
 * `#temp` shapes. Those are T-SQL STATEMENT constructs; this value is passed as
 * the discrete `database` field of an `mssql.ConnectionPool` config
 * (`synapse-sql-client.ts:152`), never concatenated into a statement or a
 * connection string, so a leading `@` or `#` carries no special meaning on this
 * path. Adding the restriction would re-import grammar folklore for no gain.
 */
const SERVERLESS_DATABASE_RE = /^[^\p{C}\p{Zl}\p{Zp}/\\;'"[\]]{1,128}$/u;

function synapseReader(backend: Backend, target: SynapseTarget, serverless = false): Reader {
  return {
    backend,
    serverless,
    run: async (sql: string) => {
      const r = await synapseExecute(target, sql);
      return { columns: r.columns, rows: r.rows };
    },
    exec: async (sql: string) => {
      const started = Date.now();
      let recordsAffected = 0;
      const messages: string[] = [];
      for (const batch of splitSqlBatches(sql)) {
        const r = await synapseExecute(target, batch);
        recordsAffected += r.recordsAffected;
        messages.push(...r.messages);
      }
      return { recordsAffected, executionMs: Date.now() - started, messages };
    },
  };
}

function azureSqlReader(server: string, database: string): Reader {
  return {
    backend: 'azure-sql',
    serverless: false,
    run: async (sql: string) => {
      const r = await azureSqlExecute(server, database, sql);
      return { columns: r.columns, rows: r.rows };
    },
    exec: async (sql: string) => {
      const started = Date.now();
      let recordsAffected = 0;
      for (const batch of splitSqlBatches(sql)) {
        const r = await azureSqlExecute(server, database, batch);
        recordsAffected += r.rowCount;
      }
      return { recordsAffected, executionMs: Date.now() - started, messages: [] };
    },
  };
}

/** The outcome of authorize + resolve: a usable Reader, or the response to send. */
type Resolved = { ok: true; reader: Reader } | { ok: false; res: NextResponse };

/** The route's existing honest-gate shape: 200 + `gated:true`, rendered by the
 *  panel as a warning MessageBar with a Refresh action. */
function gate(error: string): NextResponse {
  return NextResponse.json({ ok: false, gated: true, error }, { status: 200 });
}

/**
 * Turn a target refusal into a response.
 *
 * `no_bound_connection` becomes the route's EXISTING gate (200 + `gated:true`),
 * not a 409. It is not an authorization refusal of a hostile request — it is
 * "you have not picked a server yet", which is precisely what this route already
 * said in that situation ("Pick a server and database on the Connect tab
 * first"). Returning a red error banner instead would be a new day-one failure
 * state on a freshly created item, which `ux-baseline.md` forbids, and it would
 * be less true than the gate.
 *
 * Every OTHER refusal — `server_mismatch`, `database_mismatch`,
 * `server_not_governed`, `malformed_server_name` — keeps its real status. Those
 * ARE refusals of a request that named something it may not name, and they must
 * not be laundered into a 200.
 */
function gateOrError(refusal: { status: number; code: string; error: string }): NextResponse {
  if (refusal.code === 'no_bound_connection') {
    return gate(
      'Pick a server and database on the Connect tab first — the SQL security ' +
        'wizards run against that Azure SQL database via TDS + Microsoft Entra token.',
    );
  }
  return apiError(refusal.error, refusal.status, { code: refusal.code });
}

/**
 * The route id an UNSAVED editor carries. `/items/<type>/new` is the create
 * route, so `[id]` is the literal string `new` until the item is first saved.
 *
 * It can NEVER collide with a real item: `createOwnedItem` mints ids with
 * `crypto.randomUUID()` (`_lib/item-crud.ts:467`, and :275 records the same
 * invariant), so special-casing it downgrades nothing.
 */
const UNSAVED_ITEM_ID = 'new';

/**
 * The 404 body for an item the caller cannot reach — deliberately naming BOTH
 * causes and asserting NEITHER.
 *
 * `loadOwnedItem` returns `null` for two different situations (`_lib/item-crud.ts`
 * :286 `if (!item) return null` and :289 `if (!opts.allowReadRoles &&
 * !access.canWrite) return null`), and this route CANNOT tell them apart without
 * a second read — which is precisely the cross-tenant existence probe the
 * 404-not-403 convention exists to prevent. So the status stays 404 and the
 * message states the disjunction rather than picking a side, per
 * `deploy-integrity.md` R7: an error must not assert a cause it did not
 * establish.
 *
 * The read-role half is a REAL consequence of this PR's write-scoping, raised in
 * review: a Viewer/Contributor of a shared workspace can open the item and its
 * Security tab, and previously reached the route (that was the vulnerability).
 * Keeping them out is correct — the wizards execute DDL/DCL and the GET reaches
 * the same TDS executor — but a bare "not found" gave them nothing to act on.
 */
const ITEM_UNREACHABLE =
  'This item is not available to you. Either it does not exist, or your role in ' +
  'its workspace is read-only — the SQL security wizards read and execute T-SQL ' +
  'against the database, so they require write access. Ask a workspace owner for ' +
  'a Contributor-or-higher role if you need them.';

/**
 * LAYER 1 → LAYER 2/3 → a Reader. The single authorization path for both verbs.
 *
 * `submitted` is the request's own `server`/`database` (query string on GET,
 * body on POST). It is passed ONLY so a mismatch can be refused; no branch of
 * this function ever uses it to choose a target.
 */
async function authorizeAndResolve(
  session: SessionPayload,
  type: string,
  id: string,
  submitted: { server?: unknown; database?: unknown },
): Promise<Resolved> {
  const kind = backendKindFor(type);

  // ── UNSAVED ITEM — the honest gate, NOT a 404. ───────────────────────────
  //
  // FOUND IN REVIEW OF THIS FIX, and it is the case the ownership check would
  // otherwise get wrong. An unsaved item has no Cosmos row to own, so
  // `loadOwnedSqlItem` returns null and the route 404s — and the panel renders a
  // 404 as a RED "Could not load security state — not found" banner
  // (`lib/panes/sql-security-panel.tsx:109`, the `!j.gated && !j.ok` branch).
  //
  // That is reachable in four clicks from a create page, because THREE of the
  // four editors that mount `SqlSecurityPanel` do not condition their trigger on
  // the item being saved:
  //
  //   unified-sql-database-editor.tsx:1449  — enabled on
  //     `server && database && family === 'azure-sql'`, no `id !== 'new'`; and
  //     :1992-1995 mounts the panel on the same predicate. The bind-on-selection
  //     effect this route's Layer 2 relies on returns early for an unsaved item
  //     (`:792  if (!server || !id || id === 'new') return;`), so the item is not
  //     merely unowned — it is unbindable.
  //   synapse-sql-editors.tsx:392           — the SERVERLESS trigger is
  //     UNCONDITIONAL (`onClick: () => setSecOpen(true)`).
  //   synapse-sql-editors.tsx:932           — the DEDICATED trigger gates on
  //     `isOnline`, which comes from `synapse-dedicated-sql-pool/[id]/state`
  //     (`export async function GET()` — no `ctx` at all, session-only and
  //     env-derived), so it reports Online for `id === 'new'` too.
  //
  //   phase3/warehouse-editor.tsx:459 is the one that is SAFE: `canRun` derives
  //   from `ready`, whose query carries `enabled: !isNew` (:142).
  //
  // A red error banner on a freshly created item is exactly what
  // `ux-baseline.md` forbids ("new-item first-open is clean"), and a dead end
  // with no route forward is what `auto-bind-by-default.md` forbids. So this
  // returns the route's EXISTING gate shape with the one action that actually
  // resolves it. Deliberately BEFORE the ownership call and branch-agnostic, so
  // all three reachable editors get it.
  if (id === UNSAVED_ITEM_ID) {
    return {
      ok: false,
      res: gate(
        'Save this item first — the SQL security wizards run against the saved ' +
          "item's bound database, and an unsaved item has nothing to bind to yet.",
      ),
    };
  }

  // ── LAYER 1 — the caller must own the route item. ────────────────────────
  // Write-scoped (no allowReadRoles) on BOTH verbs; see the header.
  const item: WorkspaceItem | null = await loadOwnedSqlItem(id, session, candidateItemTypes(type, kind));
  if (!item) return { ok: false, res: apiNotFound(ITEM_UNREACHABLE) };

  if (kind === 'synapse-dedicated') {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE || !process.env.LOOM_SYNAPSE_DEDICATED_POOL) {
      return {
        ok: false,
        res: gate(
          'Synapse Dedicated SQL pool is not configured. Set LOOM_SYNAPSE_WORKSPACE and ' +
            'LOOM_SYNAPSE_DEDICATED_POOL (admin-plane bicep deploys the Synapse workspace + pool).',
        ),
      };
    }
    // No caller coordinate reaches this branch at all — workspace AND pool are
    // env-derived. Layer 1 is the whole boundary here.
    return { ok: true, reader: synapseReader('synapse-dedicated', dedicatedTarget()) };
  }

  if (kind === 'synapse-serverless') {
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      return {
        ok: false,
        res: gate(
          'Synapse Serverless SQL endpoint is not configured. Set LOOM_SYNAPSE_WORKSPACE ' +
            '(admin-plane bicep deploys the Synapse workspace).',
        ),
      };
    }
    const requested = typeof submitted.database === 'string' ? submitted.database.trim() : '';
    const database = requested || 'master';
    if (!SERVERLESS_DATABASE_RE.test(database)) {
      return {
        ok: false,
        res: apiError('The requested database is not a valid Synapse database name.', 400, {
          code: 'malformed_database_name',
        }),
      };
    }
    return { ok: true, reader: synapseReader('synapse-serverless', serverlessTarget(database), true) };
  }

  // ── LAYER 2 + LAYER 3 — Azure SQL. The target is the OWNED item's binding,
  // admitted against the authorized subscription set. The request's coordinates
  // can only trigger a refusal. Same resolver `[id]/query` and `[id]/copilot`
  // use, so there is one implementation of this rule, not two.
  const target = resolveOwnedSqlTarget(item, submitted);
  if (!target.ok) return { ok: false, res: gateOrError(target) };
  return { ok: true, reader: azureSqlReader(target.server, target.database) };
}

function rowsToObjects(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

// ============================================================
// GET — live security state for the pickers + state panel
// ============================================================

export const GET = withSession<{ type: string; id: string }>(async (req: NextRequest, { session, params }) => {
  const { type, id } = params;
  if (!id) return apiNotFound();

  const resolved = await authorizeAndResolve(session, type, id, {
    server: req.nextUrl.searchParams.get('server') ?? undefined,
    database: req.nextUrl.searchParams.get('database') ?? undefined,
  });
  if (!resolved.ok) return resolved.res;
  const backend = resolved.reader;

  // Each catalog read is independently try/caught so one failure (e.g. no
  // masked columns yet) degrades to a partial-but-honest result.
  async function safe(label: string, sql: string) {
    try {
      const r = await backend.run(sql);
      return { rows: rowsToObjects(r.columns, r.rows), error: undefined as string | undefined };
    } catch (e: any) {
      return { rows: [] as Record<string, unknown>[], error: `${label}: ${e?.message || String(e)}` };
    }
  }

  try {
    const [principals, tables, views, columns, grants, masked, policies] = await Promise.all([
      safe('principals', SQL_LIST_DATABASE_PRINCIPALS),
      safe('tables', SQL_LIST_TABLES),
      safe('views', SQL_LIST_VIEWS),
      safe('columns', SQL_LIST_COLUMNS),
      safe('grants', SQL_LIST_OBJECT_GRANTS),
      safe('maskedColumns', SQL_LIST_MASKED_COLUMNS),
      safe('securityPolicies', SQL_LIST_SECURITY_POLICIES),
    ]);

    // Group columns by `schema.object` for the wizard pickers.
    const columnsByObject: Record<string, { name: string; dataType: string }[]> = {};
    for (const r of columns.rows) {
      const key = `${String(r.schema_name)}.${String(r.object_name)}`;
      (columnsByObject[key] ||= []).push({ name: String(r.column_name), dataType: String(r.data_type) });
    }

    const warnings = [principals.error, tables.error, views.error, columns.error, grants.error, masked.error, policies.error]
      .filter(Boolean) as string[];

    return NextResponse.json({
      ok: true,
      backend: backend.backend,
      serverless: backend.serverless,
      principals: principals.rows,
      tables: tables.rows,
      views: views.rows,
      columnsByObject,
      grants: grants.rows,
      maskedColumns: masked.rows,
      securityPolicies: policies.rows,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
});

// ============================================================
// POST — preview / execute a wizard, or verify (EXECUTE AS)
// ============================================================

export const POST = withSession<{ type: string; id: string }>(async (req: NextRequest, { session, params }) => {
  const { type, id } = params;
  if (!id) return apiNotFound();

  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || 'wizard');

  const resolved = await authorizeAndResolve(session, type, id, {
    server: body?.server,
    database: body?.database,
  });
  if (!resolved.ok) return resolved.res;
  const backend = resolved.reader;

  // ---- Verification: run a SELECT as the test principal (EXECUTE AS) ----
  if (action === 'verify') {
    const v = body?.verify || {};
    let sql: string;
    try {
      sql = buildVerifyAs({
        principal: String(v.principal || ''),
        schema: String(v.schema || ''),
        table: String(v.table || ''),
        column: v.column ? String(v.column) : undefined,
        top: v.top,
      });
    } catch (e: any) {
      const status = e instanceof TsqlBuildError ? 400 : 500;
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
    }
    if (!v.principal || !v.schema || !v.table) {
      return NextResponse.json({ ok: false, error: 'verify requires principal, schema and table' }, { status: 400 });
    }
    try {
      const r = await backend.run(sql);
      return NextResponse.json({ ok: true, sql, columns: r.columns, rows: r.rows, executedBy: session.claims.upn });
    } catch (e: any) {
      const status = e instanceof AzureSqlError ? e.status : 502;
      return NextResponse.json({ ok: false, sql, error: e?.message || String(e) }, { status });
    }
  }

  // ---- Wizard: build SQL from structured params ----
  const wizard = String(body?.wizard || '') as WizardKind;
  const preview = body?.preview === true;
  const wizardParams = body?.params ?? {};

  // Serverless does NOT support RLS — honest functional gate (Learn: serverless
  // T-SQL feature matrix). No SQL is executed; the UI disables the Execute btn.
  if (backend.serverless && wizard === 'rls') {
    return NextResponse.json({
      ok: false,
      gated: true,
      error:
        'Row-level security is not supported on Synapse Serverless SQL pools. ' +
        'Apply RLS on a Dedicated SQL pool / Azure SQL database, or use a view-based ' +
        'workaround over the serverless dataset.',
    }, { status: 200 });
  }

  let sql: string;
  try {
    sql = buildWizardSql(wizard, wizardParams);
  } catch (e: any) {
    const status = e instanceof TsqlBuildError ? 400 : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }

  // Preview pane: return the generated SQL without touching the database.
  if (preview) {
    return NextResponse.json({ ok: true, preview: true, sql });
  }

  try {
    const receipt = await backend.exec(sql);
    return NextResponse.json({
      ok: true,
      sql,
      recordsAffected: receipt.recordsAffected,
      executionMs: receipt.executionMs,
      messages: receipt.messages,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({
      ok: false,
      sql,
      error: e?.message || String(e),
      code: e?.code,
      sqlNumber: e?.number,
    }, { status });
  }
});
