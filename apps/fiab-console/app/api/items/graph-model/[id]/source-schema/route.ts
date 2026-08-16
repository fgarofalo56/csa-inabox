/**
 * GET /api/items/graph-model/[id]/source-schema
 *   Live ADX source-schema browser for the graph-model type designer's
 *   Source-binding pickers (P0 table-mapping parity).
 *     (no params)                 → { ok, databases: [{name,prettyName}] }
 *     ?database=DB                 → { ok, database, tables: [{name,folder}] }
 *     ?database=DB&table=T         → { ok, database, table, columns: [{name,type}] }
 *
 *   Azure-native, NO Fabric: every list comes from the env-configured ADX
 *   cluster via `.show databases` / `.show tables` / `.show table … schema`.
 *   When ADX isn't configured we return an honest gate (HTTP 200, ok:false,
 *   gate.remediation) naming the exact env var to set — never a Fabric prompt.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r (residual population). This is the
 * RECONNAISSANCE half of the primitive the advisory describes, and #3600 fixed
 * the consumer without fixing the picker that feeds it. `_ctx` was accepted and
 * never read and `getSession()` was the only check, so as the Console's UAMI it
 * answered three questions for any signed-in user in any tenant:
 *
 *   - no params   → `.show databases`: the name of every database on the shared
 *     cluster.
 *   - ?database   → `.show tables` for any one of them.
 *   - ?database&?table → the full COLUMN SCHEMA of any table on the cluster.
 *
 * Those three outputs are precisely the `sourceDatabase` / `sourceTable` /
 * `sourceColumn` inputs that `[id]/materialize` consumes to build
 * `.set-or-append <t> <| database('<db>').['<table>'] | project …`. #3600 bound
 * materialize's source coordinates to `workspaceAdxScope`; leaving this route
 * open left the picker offering choices its own consumer would now refuse — a
 * UI that hands the user a 403.
 *
 * WHAT THIS DOES **NOT** DO. An earlier revision of this comment asserted that
 * "nothing else in the item routes enumerates the victim set; an attacker had to
 * guess a database name before this, and did not after." THAT WAS FALSE, and it
 * is corrected here rather than quietly deleted because a security comment that
 * overstates its own fix is the same defect class as an error message asserting
 * a cause it never established (deploy-integrity.md R7).
 *
 * `GET /api/items/eventhouse/[id]` is `export async function GET()` — it takes
 * no `ctx` at all, never reads `[id]`, checks only `getSession()`, and calls
 * `listDatabasesWithDetails()` → `.show databases details` CLUSTER-WIDE. That
 * returns every database name PLUS its size, retention policy, caching policy
 * and table count, for every tenant. It is strictly RICHER than the
 * `.show databases` removed here, and it is the exact reconnaissance for the
 * retention rewrite that `[id]/policies` (fixed in the same change) allowed.
 *
 * So for the ENUMERATION primitive specifically, this change RELOCATES rather
 * than removes — the identical failure mode the advisory records for the
 * graph-model / gql-graph query pair, and the reason the three tapestry panes
 * were bound together in one change rather than one at a time.
 *
 * It is disclosed rather than fixed here because narrowing `eventhouse/[id]` is
 * BROWNFIELD-VISIBLE: databases predating the `[id]/database` auto-bind were
 * never recorded on any item, so the eventhouse editor's picker would silently
 * shrink on existing estates. That needs the auto-bind backfill first. It is
 * named in the PR ledger as unfixed, not implied fixed.
 *
 * What this change DOES do is make picker and consumer agree by construction:
 *   LAYER 1 — the caller is authorized against the graph-model ITEM (read-scoped:
 *     this is a picker).
 *   LAYER 2 — the database list is `workspaceAdxScope(item)` — the databases
 *     bound to items in this graph model's own workspace — not `.show
 *     databases`. A `?database` outside that scope is refused, and `?table` is
 *     answered only for a database that survived the scope check. That is the
 *     same set `[id]/materialize` admits, resolved through the same call.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  listTables, getTableSchema, defaultDatabase, kustoConfigGate, KustoError,
} from '@/lib/azure/kusto-client';
import {
  guardAdxItemRequest, scopeAdxDatabase, workspaceAdxScope, type AdxScopedDatabase,
} from '../../../_lib/adx-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Normalize `.show table … schema as json` into [{name, type}] column rows. */
function columnsFromSchema(schema: unknown): Array<{ name: string; type: string }> {
  const s = schema as any;
  const cols = Array.isArray(s?.OrderedColumns) ? s.OrderedColumns
    : Array.isArray(s?.Columns) ? s.Columns : [];
  return cols.map((c: any) => ({
    name: String(c?.Name ?? c?.name ?? ''),
    type: String(c?.CslType ?? c?.Type ?? c?.type ?? 'string').replace(/^System\./, '').toLowerCase(),
  })).filter((c: { name: string }) => c.name);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // LAYER 1 — a picker, so shared read roles are admitted, matching the sibling
  // `[id]/query` pane.
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'graph-model',
    notFound: 'graph model not found',
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      gate: { remediation: `Azure Data Explorer is not configured. Set ${gate.missing} to bind source tables.` },
      error: `ADX not configured (${gate.missing})`,
    });
  }

  const requested = req.nextUrl.searchParams.get('database') || '';
  const table = req.nextUrl.searchParams.get('table') || '';

  try {
    // LAYER 2 — the addressable set, resolved from Cosmos, is the SAME set
    // `[id]/materialize` admits as a `sourceDatabase`. Computed once and reused
    // as the scope argument so the two answers cannot drift.
    const scope = await workspaceAdxScope(item);

    if (!requested) {
      // `.show databases` is deliberately NOT called: enumerating the cluster is
      // the disclosure. The list is the workspace's own bound databases.
      const databases = [...scope].sort().map((name) => ({ name, prettyName: name }));
      return NextResponse.json({ ok: true, defaultDatabase: defaultDatabase(), databases });
    }

    const scoped = await scopeAdxDatabase(item, requested, scope);
    if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
    const database: AdxScopedDatabase = scoped.database;

    if (table) {
      const schema = await getTableSchema(database, table).catch(() => null);
      return NextResponse.json({ ok: true, database, table, columns: columnsFromSchema(schema) });
    }
    const tables = await listTables(database);
    return NextResponse.json({ ok: true, database, tables });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
