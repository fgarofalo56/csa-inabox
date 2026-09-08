/**
 * POST /api/items/azure-sql-database/[id]/query
 *   body { sql, requestId? } — runs T-SQL on the Azure SQL database THIS item is
 *   bound to, via TDS + AAD MI.
 *
 * AUTHORITY (#2723): the target server + database are NOT taken from the request
 * body. The caller must OWN the `[id]` item (withWorkspaceOwner → 404 otherwise),
 * and the server/database are DERIVED from that owned item's bound connection
 * (`state.connection`, persisted by POST /connect). A body that names a different
 * server/database is rejected. So the id conveys authority: a caller can only run
 * SQL against the database their own item is bound to — no longer an arbitrary
 * server/database the Console managed identity happens to reach.
 *
 * Returns the full multi-result-set shape so the editor's results pane can offer
 * SSMS / Azure Data Studio parity: every batch result set (`recordsets[]`), every
 * in-band message (`messages[]` — PRINT / RAISERROR / row counts), and the
 * per-statement `rowsAffected[]`. The first result set is also promoted to the
 * legacy top-level `columns/rows/rowCount/truncated` fields so the schema browser
 * + INFORMATION_SCHEMA grid keep working.
 * ITEM TYPE IS RESOLVED, NOT ASSUMED. This route was `withWorkspaceOwner(
 * 'azure-sql-database', …)` from #2920 until the SQL_EDITOR_ITEM_TYPES audit —
 * but THREE registry slugs drive this exact URL with their own item's id:
 * `azure-sql-database` (UnifiedSqlDatabaseEditor), `sql-server-2025-vector-index`
 * (the CREATE VECTOR INDEX / VECTOR_DISTANCE probe) and
 * `azure-sql-managed-instance`. For the latter two the single hard-coded type
 * meant `loadOwnedItem` matched nothing and the Run button 404'd. Resolution now
 * runs across `SQL_EDITOR_ITEM_TYPES`, which is derived from the editor registry
 * and held there by a build-time control.
 *
 * Trying several types cannot widen access: each candidate runs the SAME
 * write-scoped `loadOwnedItem` owner / workspace-ACL check, so a foreign item
 * resolves for none of them.
 */

import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiNotFound } from '@/lib/api/respond';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { executeQueryBatch, AzureSqlError } from '@/lib/azure/azure-sql-client';
import { resolveOwnedSqlTarget } from '@/app/api/items/azure-sql-database/_bound-connection';
import { SQL_EDITOR_ITEM_TYPES, loadOwnedSqlItem } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req, { session, params }) => {
  const id = (params as { id?: string })?.id;
  if (!id) return apiNotFound();
  // Owner-scoped across every slug that drives this route. Write-scoped (no
  // allowReadRoles): running T-SQL is a write, and a read-only viewer of a
  // shared workspace must never reach the executor.
  const item = await loadOwnedSqlItem(id, session, SQL_EDITOR_ITEM_TYPES);
  // 404-not-403, matching withWorkspaceOwner, so an id cannot be probed for
  // existence across tenants.
  if (!item) return apiNotFound();

  const limited = await enforceRateLimit(session, 'query');
  if (limited) return limited;

  const body = await req.json().catch(() => ({}));
  const sqlText = String(body?.sql || '').trim();
  // Optional cancel token: registered in liveRequests so /query/cancel can send
  // a TDS ATTENTION packet to this exact in-flight request.
  const requestId = String(body?.requestId || '').trim() || undefined;

  // Authority comes from the OWNED item's bound connection — NOT the body. The
  // body's server/database are only used to reject a mismatch (#2723).
  const target = resolveOwnedSqlTarget(item, { server: body?.server, database: body?.database });
  if (!target.ok) {
    return NextResponse.json({ ok: false, error: target.error, code: target.code }, { status: target.status });
  }
  const { server, database } = target;

  if (!sqlText) return NextResponse.json({ ok: false, error: 'sql is required' }, { status: 400 });
  if (sqlText.length > 65_536) return NextResponse.json({ ok: false, error: 'sql too large (>64KB)' }, { status: 413 });

  try {
    const result = await executeQueryBatch(server, database, sqlText, requestId ? { requestId } : undefined);
    // Backward-compat single-recordset fields = first result set (or empty).
    const first = result.recordsets[0] ?? { columns: [], rows: [], rowCount: 0, truncated: false };
    return NextResponse.json({
      ok: true,
      // ── Multi-recordset shape (new) ──
      recordsets: result.recordsets,
      messages: result.messages,
      rowsAffected: result.rowsAffected,
      executionMs: result.executionMs,
      // ── Backward-compat single-recordset fields ──
      columns: first.columns,
      rows: first.rows,
      rowCount: first.rowCount,
      truncated: first.truncated,
      executedBy: session.claims.upn,
    });
  } catch (e: any) {
    // #3400 — a cancellation is not a backend fault. tedious rejects a
    // cancelled request with RequestError('Canceled.', 'ECANCEL'), and THIS
    // response is the only thing that establishes that the query actually
    // stopped (the cancel route can only establish that the signal was sent —
    // for a cross-replica cancel it never observes the request at all).
    //
    // The shape is the one the rest of the SQL family already publishes, field
    // for field: warehouse/[id]/query:142-151, synapse-dedicated-sql-pool
    // /[id]/query:140-150, synapse-serverless-sql-pool/[id]/query:88-99 and
    // databricks-sql-warehouse/[id]/query:266-274 all return `canceled: true`
    // (ONE l), `error: 'Query canceled by user.'` and HTTP 200. Their editors
    // read exactly that field — lib/editors/phase3/warehouse-editor.tsx:89/826,
    // lib/editors/synapse-sql-editors.tsx:92/142 and
    // lib/editors/databricks/shared.tsx:162/256 render a warning MessageBar
    // "Query canceled" off `result.canceled`.
    //
    // R7 — WHAT THIS DOES **NOT** ESTABLISH. This route's own front end does
    // not consume the flag yet. lib/state/jobs-store.ts:336 branches on `j.ok`
    // alone, so a cancelled query still lands in the jobs list as status
    // 'error'; :356 forwards only `code` to onDone, and
    // unified-sql-database-editor.tsx:927-934 stores that code without ever
    // comparing it. Both files are outside this change's file ownership, so
    // this is NOT a claim that a cancel now renders as a cancellation in the
    // SQL editor. What it does claim, and all it claims: the response carries
    // the family's field and the human message instead of the raw driver text
    // 'Canceled.', so the editors that already read `canceled` are correct and
    // the remaining consumer change is a one-line follow-up on #3400 rather
    // than a second spelling nobody reads.
    if (e?.code === 'ECANCEL') {
      return NextResponse.json({
        ok: false,
        canceled: true,
        error: 'Query canceled by user.',
        code: 'ECANCEL',
        sqlNumber: e?.number,
      }, { status: 200 });
    }
    const status = e instanceof AzureSqlError ? e.status : 502;
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      code: e?.code,
      sqlNumber: e?.number,
    }, { status });
  }
});
