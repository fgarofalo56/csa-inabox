/**
 * GET /api/items/eventhouse/[id]
 * Returns cluster URI + the KQL databases THIS ITEM'S WORKSPACE is bound to
 * (with size / retention / hot-cache / table count) on the shared Loom Kusto
 * cluster.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r. This was the LAST unguarded route in the
 * eventhouse family and the one #3614 tabled with its reasoning recorded:
 *
 *   `export async function GET()` — no `ctx`, so `[id]` was not merely
 *   unenforced, it could not be read. Behind `getSession()` alone it ran
 *   `listDatabasesWithDetails()` → `.show databases details` CLUSTER-WIDE, and
 *   returned, for EVERY tenant's database: name, pretty name, total size,
 *   retention (SoftDeletePeriod), hot-cache window (DataHotSpan) and table
 *   count.
 *
 * That is the RECONNAISSANCE PRIMITIVE for the worst finding in the advisory's
 * second pass: `[id]/policies` rewrites `.alter database policy retention` on a
 * caller-named database, and ADX then ages the victim's data out on its own
 * schedule. Binding the mutation while leaving the map that names the targets —
 * and reports their CURRENT retention, i.e. exactly what to change and what it
 * was — relocates the primitive rather than removing it. #3614's own header had
 * to be corrected because it claimed nothing else enumerated the victim set;
 * this route was what it had missed.
 *
 * THE FIX, adopting `_lib/adx-item-scope.ts` rather than inventing anything:
 *   LAYER 1 — `guardAdxItemRequest` authorizes the caller against the eventhouse
 *     item (owner → tenant-admin → shared-ACL) and fails closed on an id naming
 *     no item. `allowReadRoles: true` because this handler performs NO ADX
 *     write — a Viewer must still be able to open the editor.
 *   LAYER 2 — the returned list is filtered to `workspaceAdxScope(item)`: the
 *     databases bound to ADX-backed items IN THIS ITEM'S OWN WORKSPACE. The
 *     cluster-wide call is still what ADX offers (there is no per-database
 *     `.show database details` that returns this shape in one round trip), so
 *     the narrowing is applied to the RESULT — which means a caller learns
 *     nothing about a database outside their scope, not even that it exists.
 *
 * THE BROWNFIELD RESIDUAL, recorded rather than implied absent — this is the
 * reason #3614 deferred and it is NOT fully closed by this change. A KQL
 * database created OUT OF BAND (Azure portal, `az`, or an editor session that
 * predates the `[id]/database` auto-bind) is recorded on no Loom item, so it is
 * outside `workspaceAdxScope` and DISAPPEARS from this list. It is recoverable
 * without weakening anything: bind it as a `kql-database` item in the workspace
 * that owns it, which is precisely the remediation `[id]/database`'s own 409
 * already prints. The alternative — admitting unbound cluster databases so the
 * picker stays full — is the scope-injection primitive that route exists to
 * refuse, so it is not on the table.
 *
 * `defaultDatabase` is still returned because the editor seeds its selection
 * from it, and it is inside `workspaceAdxScope` by construction
 * (`resolveItemDatabase` falls back to it). `sku` / `optimizedAutoscale` are
 * CLUSTER-level ARM: item authorization is a floor on them, not a bound — see
 * the ledger note on `updateKustoClusterAutoscale`.
 */

import { NextResponse } from 'next/server';
import { clusterUri, defaultDatabase, listDatabasesWithDetails, KustoError } from '@/lib/azure/kusto-client';
import { getKustoClusterArm } from '@/lib/azure/kusto-arm-client';
import { guardAdxItemRequest, workspaceAdxScope } from '../../_lib/adx-item-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EVENTHOUSE_NOT_FOUND = 'eventhouse not found';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await guardAdxItemRequest({
    itemId: id,
    itemType: 'eventhouse',
    notFound: EVENTHOUSE_NOT_FOUND,
    // Read-only: this handler issues no ADX write, so any workspace role opens it.
    allowReadRoles: true,
  });
  if (guard.res) return guard.res;
  const { item } = guard.ctx;

  try {
    // Databases (query plane, with details) + cluster ARM (management plane) +
    // the workspace's own ADX scope, in parallel. ARM is best-effort — if the
    // UAMI lacks read on the cluster the editor still renders databases; the
    // auto-scale dialog then shows its gate. The SCOPE is not best-effort:
    // `workspaceAdxScope` fails closed to the item's own database internally, so
    // it never rejects and never widens.
    const [dbResult, armResult, scope] = await Promise.all([
      listDatabasesWithDetails().then(
        (v) => ({ ok: true, v }) as const,
        (e) => ({ ok: false, e }) as const,
      ),
      getKustoClusterArm().then(
        (v) => v,
        () => null,
      ),
      workspaceAdxScope(item),
    ]);

    if (!dbResult.ok) {
      const e: any = dbResult.e;
      const status = e instanceof KustoError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
    }

    return NextResponse.json({
      ok: true,
      cluster: clusterUri(),
      defaultDatabase: defaultDatabase(),
      // LAYER 2 — the shared cluster's answer, narrowed to what this item's own
      // workspace is bound to. Applied to the RESULT so a caller learns nothing
      // about a database outside their scope, not even that it exists.
      databases: dbResult.v.filter((d) => scope.has(d.name)),
      sku: armResult?.sku,
      optimizedAutoscale: armResult?.optimizedAutoscale ?? null,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
