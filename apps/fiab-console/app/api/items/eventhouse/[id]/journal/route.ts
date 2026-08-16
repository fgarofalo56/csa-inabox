/**
 * GET /api/items/eventhouse/[id]/journal?limit=100&database=<optional>
 *
 * Returns the ADX schema-change journal — the metadata-operation log for the
 * eventhouse item's own KQL database. Maps to Fabric's "Eventhouse system
 * overview → schema changes" surface.
 *
 * Read-only metadata. Real backend only — no mocks.
 *
 * Journal columns (grounded in Learn — note the docs flag the column set /
 * formatting as non-contractual, so we read every column defensively):
 *   https://learn.microsoft.com/kusto/management/journal
 *   Event, EventTimestamp, Database, EntityName, UpdatedEntityName,
 *   EntityVersion, EntityContainerName, OriginalEntityState,
 *   UpdatedEntityState, ChangeCommand, Principal
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r (residual population). `params` was bound and
 * then explicitly discarded (`params; // journal is cluster/db scoped`), leaving
 * `getSession()` as the only check, and the journal command was assembled from
 * `?database` with no binding at all. Two disclosures followed, both executed as
 * the Console's UAMI:
 *
 *   - `?database=<victim>` → `.show database ["<victim>"] journal`, another
 *     tenant's full metadata history.
 *   - NO `database` param → `.show journal`, the CLUSTER-WIDE journal, i.e.
 *     every database on the shared cluster at once. That was the DEFAULT, and it
 *     is what the editor actually called.
 *
 * The journal is not a low-value log. `ChangeCommand` carries the VERBATIM DDL
 * text of every metadata operation — table and column names, retention and
 * caching policies, external-table `abfss://` targets, `.create-or-alter
 * function` bodies — and `Principal` carries the identity that issued each one.
 * So this was a schema-and-identity map of every tenant on the cluster, and the
 * reconnaissance input for the coordinate-taking siblings.
 *
 * Both layers are applied. The caller is authorized against the eventhouse item
 * (read-scoped: shared read roles may view their own journal), and the database
 * is resolved FROM THE ITEM. A `?database` value is still honoured when it is
 * inside the item's own workspace ADX scope — that is what the sibling
 * `[id]/purge` picker does — and refused otherwise.
 *
 * BEHAVIOUR CHANGE, stated rather than buried: the un-parameterised
 * cluster-wide `.show journal` is GONE. Omitting `database` now scopes to the
 * item's own resolved database, which is what the eventhouse editor's
 * schema-change pane is for. A genuine cluster-wide operational view belongs
 * behind a tenant-admin surface, not on a per-item route.
 */

import { kqlEscapeDouble } from '@/lib/azure/kql-escape';
import { NextRequest, NextResponse } from 'next/server';
import { executeMgmtCommand, KustoError } from '@/lib/azure/kusto-client';
import { apiServerError } from '@/lib/api/respond';
import { guardAdxItemRequest, scopeAdxDatabase, type AdxScopedDatabase } from '../../../_lib/adx-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** KQL bracketed-string quote for a (possibly hyphenated) db name. */
function qName(name: string): string {
  return `["${kqlEscapeDouble(name)}"]`;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // ERROR CONTRACT. This route used to run under `withSession`, whose try/catch
  // funnelled ANY unexpected throw to `apiServerError` — a structured 500
  // `{ok:false,error,code}` plus one bounded server log. Dropping the wrapper
  // for the item guard would have left the guard, the scope resolution and
  // `ctx.params` outside every catch, so a Cosmos failure would surface as
  // Next's generic HTML 500 and the editor's `await r.json()` would throw on it.
  // That regression matters MORE after this change, not less: the guard reaches
  // Cosmos, which these handlers never did before.
  try {
    const { id } = await ctx.params;
    // LAYER 1 — read-only surface, so shared read roles are admitted.
    const guard = await guardAdxItemRequest({
      itemId: id,
      itemType: 'eventhouse',
      notFound: 'eventhouse not found',
      allowReadRoles: true,
    });
    if (guard.res) return guard.res;

    const url = new URL(req.url);
    const limitRaw = parseInt(url.searchParams.get('limit') || '100', 10);
    const limit = Math.min(1000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 100));

    // LAYER 2 — an empty `?database` resolves to the item's OWN database (that is
    // `scopeAdxDatabase`'s contract), so there is no un-scoped branch left.
    const scoped = await scopeAdxDatabase(guard.ctx.item, url.searchParams.get('database'));
    if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
    const database: AdxScopedDatabase = scoped.database;

    const command = `.show database ${qName(database)} journal | take ${limit}`;

    return await runJournal(database, command);
  } catch (e) {
    return apiServerError(e);
  }
}

/**
 * Run the journal command and shape the rows. Kept as its own function so the
 * KustoError → 502 mapping stays exactly as it shipped, while the caller's outer
 * try/catch restores the `apiServerError` envelope for anything that is NOT a
 * Kusto error (a Cosmos failure inside the guard, most obviously).
 */
async function runJournal(database: string, command: string) {
  try {
    // Executed AGAINST the bound database, not the shared NetDefaultDB: the
    // connection database and the queried database are now the same thing, so
    // there is no second coordinate to disagree with the first.
    const r = await executeMgmtCommand(database, command);
    const idx = (c: string) => r.columns.indexOf(c);
    const ts = idx('EventTimestamp');
    const ev = idx('Event');
    const db = idx('Database');
    const ent = idx('EntityName');
    const upd = idx('UpdatedEntityName');
    const ver = idx('EntityVersion');
    const cont = idx('EntityContainerName');
    const cmd = idx('ChangeCommand');
    const princ = idx('Principal');
    const get = (row: unknown[], i: number) => (i >= 0 && row[i] != null ? String(row[i]) : '');

    const entries = r.rows.map((row) => ({
      event: get(row, ev),
      eventTimestamp: get(row, ts),
      database: get(row, db),
      entityName: get(row, ent),
      updatedEntityName: get(row, upd),
      entityVersion: get(row, ver),
      entityContainerName: get(row, cont),
      changeCommand: get(row, cmd),
      principal: get(row, princ),
    }));

    // Newest first so the UI log reads top-down.
    entries.sort((a, b) => {
      const ta = Date.parse(a.eventTimestamp) || 0;
      const tb = Date.parse(b.eventTimestamp) || 0;
      return tb - ta;
    });

    return NextResponse.json({ ok: true, database, entries, rowCount: entries.length });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), body: e?.body },
      { status },
    );
  }
}
