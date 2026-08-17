/**
 * POST /api/items/databricks-sql-warehouse/[id]/clone
 * body { warehouseId, source, target, cloneType: 'SHALLOW'|'DEEP', replace?: boolean }
 *
 * Delta CLONE on the Databricks SQL Warehouse path:
 *
 *   CREATE [OR REPLACE] TABLE <target> [SHALLOW|DEEP] CLONE <source>
 *
 * SHALLOW: zero-copy — clones metadata only; the clone references the source's
 *   existing Delta data files (NO data files duplicated). Requires Databricks
 *   Runtime 13.3 LTS+ for Unity Catalog managed tables. Running VACUUM on the
 *   source can orphan a shallow clone if it removes files the clone references.
 * DEEP: full copy — data files are duplicated; the clone is independent of the
 *   source and survives source VACUUM.
 *
 * CLONE returns a single metrics row (source_table_size, source_num_of_files,
 * num_copied_files, …). We surface numCopiedFiles + sourceSizeBytes so the UI
 * can prove SHALLOW is zero-copy (num_copied_files == 0).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * GHSA-v2g8-gp3r-rg4r — THE HOLE THIS FILE USED TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `export async function POST(req: NextRequest)` took NO `ctx`, so `[id]` was
 * never read. `getSession()` was the entire authorization, and `warehouseId`,
 * `source` and `target` all came off the body into
 *
 *     CREATE [OR REPLACE] TABLE <caller target> <TYPE> CLONE <caller source>
 *
 * executed on the shared Databricks workspace as the Console identity.
 *
 * THIS IS THE ADVISORY'S HEADLINE SHAPE — MATERIALIZE-THEN-READ — on Unity
 * Catalog, and it is the reason this route is rated with the mutations rather
 * than the reads. The pair is: CLONE any table you can name into a table you
 * can read, then read it back through the sibling `[id]/query`. A **SHALLOW**
 * clone makes that essentially free: it copies no data files, so exfiltrating a
 * large victim table costs one metadata operation.
 *
 * It is also DESTRUCTIVE in one direction that is easy to miss: `replace: true`
 * emits `CREATE OR REPLACE TABLE <caller target>`, which OVERWRITES an existing
 * table the caller names. So the same unauthenticated-by-item route both reads
 * arbitrary tables and destroys arbitrary tables.
 *
 * ── WHAT IS AND IS NOT CLOSED ───────────────────────────────────────────────
 *
 * LAYER 0 — AUTHENTICATION via the route-toolkit `withSession` wrapper, placed
 *   ABOVE the `id === 'new'` gate — the ordering defect review MEASURED on
 *   #3655 (`guardSynapseItemRequest` reads the session itself, so a gate above
 *   it answers 200 to a caller with no cookie). `apps/fiab-console` has NO
 *   `middleware.ts` (verified), so this handler is the only enforcement point.
 *
 * LAYER 1 — OWN THE ROUTE ITEM. `guardSynapseItemRequest` against the SQL
 *   warehouse item, WRITE-SCOPED — the same guard the sibling `[id]/ctas`
 *   already runs, and this route is `ctas`'s twin (both emit CREATE TABLE on a
 *   caller-named UC coordinate). The config gate now sits BELOW the guard,
 *   matching `ctas`, so a caller who cannot reach the item no longer learns the
 *   deployment's Databricks configuration state.
 *
 * LAYER 3 — NOT PRESENT, and named. `warehouseId`, `source` and `target` all
 *   remain caller-supplied. Binding `warehouseId` needs a server-attested owner
 *   marker on the warehouse (the `loom_item_id` pattern
 *   `_lib/databricks-resource-binding.ts` applies to Jobs and DLT pipelines) —
 *   SQL warehouses are never stamped today. Binding `catalog.schema.table`
 *   needs a UC three-level scoping helper that does not exist, and a
 *   state-anchored one could not work anyway:
 *   `_lib/databricks-resource-binding.ts:12-27` records that `PATCH
 *   /api/cosmos-items/[type]/[id]` replaces `state` WHOLESALE from the request
 *   body, so the caller would write the value the bound reads. Both are design
 *   work with a brownfield migration, not a mechanical adoption.
 *
 *   RESIDUAL: the materialize-then-read primitive SURVIVES for a caller who can
 *   write any `databricks-sql-warehouse` item, and creating one is
 *   SELF-SERVICE (`createOwnedItem`, `_lib/item-crud.ts:423`). LAYER 1 IS A
 *   FLOOR, NOT A BOUND — it moves the reachable population from "any
 *   authenticated session" to "any authenticated session, plus one POST".
 *   Everything is bounded by construction to this deployment's own Databricks
 *   workspace, so nothing cross-subscription survives.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { guardSynapseItemRequest, UNSAVED_ITEM_ID } from '../../../_lib/synapse-item-scope';
import { executeStatement, getWarehouse, databricksConfigGate } from '@/lib/azure/databricks-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'databricks-sql-warehouse';

/** 404 body naming BOTH causes and asserting neither (`deploy-integrity.md` R7). */
const ITEM_UNREACHABLE =
  'This SQL warehouse item is not available to you. Either it does not exist, or you have no ' +
  'role in its workspace. Ask a workspace owner to share it with you.';

/**
 * The unsaved-item honest gate — after authentication, before the guard.
 *
 * REACHABLE, checked at the call site: `app/items/[type]/[id]/page.tsx:164`
 * renders the editor unconditionally, so `/items/databricks-sql-warehouse/new`
 * mounts it with `id="new"`; `sql-warehouse-editor.tsx` has NO `isNew` anywhere
 * (measured: `grep -c isNew` = 0), and `submitClone` (:861) gates only on
 * `cloneSource`/`cloneTarget` — not even on `warehouseId` — so the Clone dialog
 * is submittable on an unsaved item. `submitClone` renders `j.error` verbatim
 * as the dialog's error text, so a bare 404 would be a dead end
 * (`auto-bind-by-default.md`) and a day-one red state (`ux-baseline.md`).
 *
 * Exact match only — real ids are `crypto.randomUUID()`
 * (`_lib/item-crud.ts:467`), so a substring test would let a real id skip the
 * ownership check.
 */
function unsavedItemGate(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'unsaved_item',
    error:
      'Save this SQL warehouse item first — a clone runs in the name of the saved item, and an ' +
      'unsaved item has no owner to check that against yet.',
  }, { status: 200 });
}

export const POST = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const { id: itemId } = params;
  if (itemId === UNSAVED_ITEM_ID) return unsavedItemGate();

  // LAYER 1. WRITE-SCOPED — CLONE creates a table, and `replace` overwrites one.
  const guard = await guardSynapseItemRequest({
    itemId,
    itemType: ITEM_TYPE,
    notFound: ITEM_UNREACHABLE,
  });
  if (guard.res) return guard.res;
  const { session } = guard.ctx;

  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, error: `Databricks not configured: ${gate.missing}`, code: 'not_configured' },
      { status: 503 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const warehouseId = (body?.warehouseId || '').toString().trim();
  const source = (body?.source || '').toString().trim();
  const target = (body?.target || '').toString().trim();
  const cloneType = body?.cloneType === 'DEEP' ? 'DEEP' : 'SHALLOW';
  const replace = !!body?.replace;

  if (!warehouseId) return NextResponse.json({ ok: false, error: 'warehouseId is required' }, { status: 400 });
  if (!source) return NextResponse.json({ ok: false, error: 'source is required' }, { status: 400 });
  if (!target) return NextResponse.json({ ok: false, error: 'target is required' }, { status: 400 });

  // Bail fast with 409 if the warehouse isn't RUNNING so the UI can prompt Start.
  const w = await getWarehouse(warehouseId).catch(() => null);
  if (w && w.state !== 'RUNNING') {
    return NextResponse.json(
      { ok: false, error: `Warehouse is ${w.state}. Start it first.`, state: w.state },
      { status: 409 },
    );
  }

  const createClause = replace ? 'CREATE OR REPLACE TABLE' : 'CREATE TABLE IF NOT EXISTS';
  const cloneSql = `${createClause} ${target} ${cloneType} CLONE ${source}`;

  try {
    const result = await executeStatement(warehouseId, cloneSql);
    // CLONE returns a single metrics row keyed by column name.
    const idx = (name: string) => result.columns.findIndex((c) => c === name);
    const row = result.rows?.[0] ?? [];
    const num = (name: string) => {
      const i = idx(name);
      return i >= 0 ? Number(row[i] ?? 0) : 0;
    };
    return NextResponse.json({
      ok: true,
      source,
      target,
      cloneType,
      numCopiedFiles: num('num_copied_files'),
      sourceNumFiles: num('source_num_of_files'),
      sourceSizeBytes: num('source_table_size'),
      executionMs: result.executionMs,
      executedBy: session.claims?.upn,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), code: e?.code },
      { status: 502 },
    );
  }
});
