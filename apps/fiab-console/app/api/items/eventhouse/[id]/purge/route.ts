/**
 * GET  /api/items/eventhouse/[id]/purge?database=<db>[&table=<t>]
 *   No table param → list tables in the database (table picker source).
 *   table param    → return column names + types (predicate-builder source).
 *
 * POST /api/items/eventhouse/[id]/purge
 * Body: {
 *   database: string,
 *   table: string,
 *   predicates: Array<{ column: string, op: string, value: string }>,
 *   step: 'verify' | 'commit',
 *   verificationToken?: string   // required for step='commit'
 * }
 *
 * ADX two-step predicate-based GDPR erasure (right-to-be-forgotten). Grounded
 * in Microsoft Learn (Data purge):
 *   https://learn.microsoft.com/kusto/concepts/data-purge?view=azure-data-explorer
 *
 *   Step 1 (verify) → { numRecordsToPurge, estimatedPurgeExecutionTime, verificationToken }
 *   Step 2 (commit) → { operationId, state, … } and deletion begins async.
 *
 * Commands target the Data Management endpoint (ingest-*), not the data
 * endpoint — handled inside kusto-client. Requires Database Admin on the target
 * database; the Console UAMI holds AllDatabasesAdmin. `enablePurge: true` is set
 * in platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep.
 *
 * Azure-native by default — no Fabric/OneLake dependency. Per
 * .claude/rules/no-vaporware.md, every path calls the real ADX backend or
 * returns a structured error; no mock data.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. This route ran `getSession()` and nothing
 * else: it never read `[id]`, and took `database` + `table` straight from the
 * request. `.purge` is PERMANENT ROW DELETION and it executed as the Console's
 * UAMI, which holds AllDatabasesAdmin on the shared cluster — so any signed-in
 * user, in any tenant, could erase rows from any database on it by naming one.
 *
 * Both coordinates are now bound (`_lib/adx-item-scope.ts`, the item-route form
 * of the `app/api/adx/_shared.ts::guardAdxRequest` convention):
 *   LAYER 1 — the caller is authorized against the eventhouse ITEM, WRITE-scoped
 *     on POST (a purge is a mutation; a read-only Viewer must not reach it) and
 *     read-scoped on the GET picker.
 *   LAYER 2 — `database` must be inside the eventhouse item's own workspace ADX
 *     scope: its bound database, the databases it recorded when they were
 *     created through `[id]/database`, and its kql-database siblings. A database
 *     outside that scope is REFUSED (403), never silently substituted —
 *     purging a different database than the operator selected would be worse
 *     than refusing. `table` is then validated against that database's OWN
 *     `.show tables` output rather than passed through.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listTables, getTableSchema, executeQuery,
  buildPurgeWhere, executePurgeVerify, executePurgeCommit,
  PURGE_ALLOWED_OPS,
  KustoError,
  type PurgePredicatePart,
} from '@/lib/azure/kusto-client';
import { guardAdxItemRequest, scopeAdxDatabase } from '../../../_lib/adx-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EVENTHOUSE_NOT_FOUND = 'eventhouse not found';

function validIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
}

/**
 * Resolve `table` against the database's OWN object list.
 *
 * A syntactic `validIdent` check only proves the string is well formed — it says
 * nothing about whether the database exposes that object, which is the check the
 * advisory calls for. Fails closed: an unlistable database yields a refusal, not
 * a pass-through.
 */
async function scopeTable(
  database: string,
  table: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  let names: string[];
  try {
    names = (await listTables(database)).map((t) => t.name);
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return { ok: false, status, error: `could not verify tables in "${database}": ${e?.message || String(e)}` };
  }
  if (!names.includes(table)) {
    return { ok: false, status: 404, error: `table "${table}" does not exist in database "${database}".` };
  }
  return { ok: true };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'eventhouse',
    notFound: EVENTHOUSE_NOT_FOUND,
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;

  const requested = req.nextUrl.searchParams.get('database') || '';
  const table = req.nextUrl.searchParams.get('table') || '';

  if (!requested || !validIdent(requested)) {
    return NextResponse.json({ ok: false, error: 'database query param required and must be a valid identifier' }, { status: 400 });
  }
  const scoped = await scopeAdxDatabase(guard.ctx.item, requested);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  const database = scoped.database;

  try {
    if (!table) {
      const tables = await listTables(database);
      return NextResponse.json({ ok: true, database, tables });
    }
    if (!validIdent(table)) {
      return NextResponse.json({ ok: false, error: 'invalid table name' }, { status: 400 });
    }
    // getTableSchema parses `.show table T schema as json`; the object carries
    // `OrderedColumns: [{ Name, CslType }]`.
    const schema = await getTableSchema(database, table);
    const columns = (((schema as any)?.OrderedColumns) || []).map((c: any) => ({
      name: String(c.Name || c.name || ''),
      type: String(c.CslType || c.Type || c.type || 'string'),
    })).filter((c: { name: string }) => c.name);
    return NextResponse.json({ ok: true, database, table, columns });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // WRITE-scoped deliberately: `allowReadRoles` is NOT passed. A purge deletes
  // rows permanently, so a shared read-only role must never reach it.
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'eventhouse',
    notFound: EVENTHOUSE_NOT_FOUND,
  });
  if (guard.res) return guard.res;

  const body = await req.json().catch(() => ({}));
  const requested = String(body?.database || '').trim();
  const table = String(body?.table || '').trim();
  const step = String(body?.step || '').toLowerCase();
  const rawPredicates: any[] = Array.isArray(body?.predicates) ? body.predicates : [];
  const verificationToken = String(body?.verificationToken || '').trim();

  if (!requested || !validIdent(requested)) {
    return NextResponse.json({ ok: false, error: 'database is required and must be a valid identifier' }, { status: 400 });
  }
  if (!table || !validIdent(table)) {
    return NextResponse.json({ ok: false, error: 'table is required and must be a valid identifier' }, { status: 400 });
  }
  if (!['verify', 'commit'].includes(step)) {
    return NextResponse.json({ ok: false, error: 'step must be "verify" or "commit"' }, { status: 400 });
  }
  if (step === 'commit' && !verificationToken) {
    return NextResponse.json({ ok: false, error: 'verificationToken required for commit step' }, { status: 400 });
  }
  if (!rawPredicates.length) {
    return NextResponse.json({ ok: false, error: 'predicates array is required and must be non-empty' }, { status: 400 });
  }

  // LAYER 2 — bind BOTH coordinates before anything reaches the DM endpoint.
  const scoped = await scopeAdxDatabase(guard.ctx.item, requested);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  const database = scoped.database;
  const scopedTable = await scopeTable(database, table);
  if (!scopedTable.ok) {
    return NextResponse.json({ ok: false, error: scopedTable.error }, { status: scopedTable.status });
  }

  const predicates: PurgePredicatePart[] = [];
  for (const p of rawPredicates) {
    const col = String(p?.column || '').trim();
    const op = String(p?.op || '').trim();
    const val = String(p?.value ?? '');
    if (!col) return NextResponse.json({ ok: false, error: 'each predicate must have a column' }, { status: 400 });
    if (!(PURGE_ALLOWED_OPS as readonly string[]).includes(op)) {
      return NextResponse.json({
        ok: false,
        error: `unsupported operator "${op}"; allowed: ${PURGE_ALLOWED_OPS.join(', ')}`,
      }, { status: 400 });
    }
    predicates.push({ column: col, op: op as PurgePredicatePart['op'], value: val });
  }

  let predicateWhere: string;
  try {
    predicateWhere = buildPurgeWhere(predicates);
  } catch (e: any) {
    // buildPurgeWhere throws PurgePredicateError ({ status: 400 }).
    const status = typeof e?.status === 'number' ? e.status : 400;
    return NextResponse.json({ ok: false, error: e?.message || 'predicate build failed' }, { status });
  }

  try {
    if (step === 'verify') {
      const result = await executePurgeVerify(database, table, predicateWhere);
      return NextResponse.json({
        ok: true, step: 'verify',
        database, table, predicateWhere,
        numRecordsToPurge: result.numRecordsToPurge,
        estimatedPurgeExecutionTime: result.estimatedPurgeExecutionTime,
        verificationToken: result.verificationToken,
      });
    }

    // step === 'commit'
    const commit = await executePurgeCommit(database, table, predicateWhere, verificationToken);

    // Best-effort post-purge count of rows still matching the predicate. ADX
    // purge is async — Phase 1 (soft-delete; rows become invisible) completes in
    // minutes to hours, Phase 2 (hard-delete) within 5–30 days — so a non-zero
    // count immediately after commit is expected; it reaches 0 once Phase 1
    // finishes. The receipt records the operation id + this count.
    let postPurgeCount: number | null = null;
    try {
      const qr = await executeQuery(database, `["${table}"] | ${predicateWhere} | count`);
      postPurgeCount = qr.rows.length > 0 ? Number(qr.rows[0][0]) : 0;
    } catch { /* non-blocking — purge already scheduled */ }

    return NextResponse.json({
      ok: true, step: 'commit',
      database, table, predicateWhere,
      operationId: commit.operationId,
      state: commit.state,
      scheduledTime: commit.scheduledTime,
      postPurgeCount,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
