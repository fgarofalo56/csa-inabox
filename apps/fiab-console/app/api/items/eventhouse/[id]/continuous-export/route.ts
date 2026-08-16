/**
 * Eventhouse ↔ ADLS Gen2 Delta endpoint. Two Azure-native, Fabric-free modes
 * share this route, dispatched on the POST body shape:
 *
 *  A) BIND mode (lakehouse/warehouse Delta → KQL)
 *     Body: { database, tableName, abfssUri, hotDays?, miObjectId?, createKqlView? }
 *     Binds an ADLS Gen2 Delta Lake source (lakehouse Bronze/Silver/Gold or a
 *     warehouse-exported Delta path) to an ADX external table and applies a
 *     query-acceleration policy. The Delta data becomes queryable via KQL within
 *     seconds — no copy, no ingestion job, no Fabric/OneLake dependency.
 *     Optionally creates a stored KQL function (the "mirrored KQL view")
 *     wrapping external_table() for clean access.
 *     Steps (all real Kusto control commands — no mocks):
 *       1. .create-or-alter external table T kind=delta (abfss://…;managed_identity=system)
 *       2. .alter external table T policy query_acceleration '{"IsEnabled":true,"Hot":"Nd"}'
 *       3. .show external table T policy query_acceleration   (receipt)
 *       4. (optional) .create-or-alter function T_view() { external_table("T") }
 *
 *  B) EXPORT mode (KQL fact table → ADLS Gen2 Delta)
 *     Body: { database, sourceTable, exportName, adlsAccount?, container, path?, interval }
 *     Creates/replaces a continuous-export job writing Delta files to ADLS Gen2.
 *       1. .create-or-alter external table ext_<exportName> kind=delta (abfss://…;impersonate)
 *       2. .create-or-alter continuous-export <exportName> over (<sourceTable>)
 *            to table ext_<exportName>
 *            with (intervalBetweenRuns=<interval>, managedIdentity=system)
 *     Honest gate: when LOOM_RTI_EXPORT_ADLS is unset POST returns
 *       { ok: false, code: 'no_adls_config', missing: 'LOOM_RTI_EXPORT_ADLS' }
 *       with HTTP 200 so the UI renders a MessageBar instead of an error boundary.
 *
 * GET /api/items/eventhouse/[id]/continuous-export?database=<db>
 *   Returns { ok, database, exports, config: { adlsAccount, containers, configured },
 *             externalTables } — the continuous-export jobs + ADLS picker config
 *   (for the export dialog) AND the Delta external tables (for the bind dialog).
 *
 * Auth: Console UAMI (AllDatabasesAdmin on the shared cluster). The ADX cluster
 * system-assigned MI must hold Storage Blob Data Reader/Contributor on the ADLS
 * account (granted in platform/fiab/bicep/modules/landing-zone/
 * synapse-storage-rbac.bicep). When it doesn't, ADX returns a clear access
 * error which we surface verbatim with a remediation hint.
 *
 * Azure-native: ADX external tables + continuous-export → ADLS Gen2 Delta. No
 * Fabric workspace, no OneLake catalog API, no LOOM_KUSTO_FABRIC_MANAGED
 * dependency. Per .claude/rules/no-vaporware.md + no-fabric-dependency.md.
 *
 * SECURITY — GHSA-v2g8-gp3r-rg4r (residual population). Every entry point in
 * this file took its coordinates from the request behind `withSession` alone;
 * `{ id }` was declared as the generic parameter and never read. Three distinct
 * primitives, all as the Console's UAMI (AllDatabasesAdmin on the shared ADX
 * cluster):
 *
 *   1. EXPORT mode was a STANDING EXFILTRATION PIPE and is the worst of the
 *      three. `database` + `sourceTable` named any table on the cluster and
 *      `adlsAccount` + `container` named the destination — and `adlsAccount`
 *      took the BODY value in preference to the configured one
 *      (`body.adlsAccount || process.env.LOOM_RTI_EXPORT_ADLS`). So a caller
 *      could point another tenant's fact table at storage they nominated, on a
 *      5-minute schedule, and ADX would keep re-exporting it. Unlike a query,
 *      it survives the request.
 *   2. BIND mode issued `.create-or-alter external table` and — via
 *      `createKqlView` — `.create-or-alter function <table>_view` against any
 *      named database. `create-or-ALTER` on a function is an overwrite of
 *      whatever body is already there.
 *   3. GET listed the continuous-export jobs and Delta external tables of any
 *      `?database`, including their `abfss://` targets.
 *
 * All three now bind through `_lib/adx-item-scope.ts`, the same contract the
 * sibling `[id]/purge` and `[id]/ingest` use:
 *   LAYER 1 — the caller is authorized against the eventhouse ITEM, WRITE-scoped
 *     on POST (both modes issue DDL) and read-scoped on the GET picker.
 *   LAYER 2 — `database` must be inside the item's own workspace ADX scope, and
 *     `sourceTable` is validated against that resolved database's OWN
 *     `.show tables` rather than passed through on a syntax check.
 *   DESTINATION — `adlsAccount` is pinned to LOOM_RTI_EXPORT_ADLS. A body value
 *     naming a DIFFERENT account is refused rather than silently replaced: the
 *     caller asked to write somewhere, and writing somewhere else instead would
 *     be a worse answer than saying no. The editor sends this field empty (its
 *     placeholder is the deployment default), so the shipped flow is unchanged.
 *
 * KNOWN RESIDUAL — A CROSS-TENANT LAKE READ THAT IS NOT CLOSED HERE. An earlier
 * revision of this comment named only BIND mode's `abfssUri` and rated it a
 * note. That understated it, and in a change whose value is an honest ledger
 * the understatement is the part that matters, so it is written out in full:
 *
 * BOTH modes end in `.create-or-alter external table … kind=delta` over a
 * CALLER-CHOSEN abfss:// location, and the route hands back
 * `sampleQuery: external_table("…") | take 5`. The table is READABLE, and it is
 * read by the cluster's managed identity — which holds Storage Blob Data Reader
 * on the deployment lake, as this file's own 403 hint states. So:
 *
 *   - EXPORT mode: the ACCOUNT is now pinned to LOOM_RTI_EXPORT_ADLS, but
 *     `container` and `path` remain caller-supplied behind a syntax check only
 *     (`validContainer` / `trimSlashes`). Any container and prefix in the
 *     deployment's own export account is therefore addressable.
 *   - BIND mode: `abfssUri` is not account-bounded at all.
 *
 * Net effect: a caller authorized for ANY eventhouse can mount a lake path they
 * do not own as an external table in a database they DO own, and query it. The
 * database binding above stops them choosing someone else's database; it does
 * not stop them choosing someone else's data.
 *
 * This is strictly BETTER than the shipped behaviour (which additionally let
 * them pick the database, and let EXPORT mode nominate the destination account),
 * so it is a narrowing, not a regression — but it is NOT closed. Closing it
 * needs an allowlist of the container/prefix roots a workspace owns, which does
 * not exist and is the same missing primitive `[id]/ingest`'s onelake handler
 * already records. Named in the PR ledger as unfixed.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createExternalDeltaTable,
  setQueryAccelerationPolicy,
  showQueryAccelerationPolicy,
  createExternalTableView,
  listExternalTables,
  listContinuousExports,
  createOrAlterExternalTableDelta,
  createOrAlterContinuousExport,
  listTables,
  KustoError,
} from '@/lib/azure/kusto-client';
import { listContainers } from '@/lib/azure/adls-client';
import { getDfsSuffix } from '@/lib/azure/cloud-endpoints';
import { trimSlashes } from '@/lib/util/trim';
import { apiServerError } from '@/lib/api/respond';
import { guardAdxItemRequest, scopeAdxDatabase, type AdxScopedDatabase } from '../../../_lib/adx-item-scope';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EVENTHOUSE_NOT_FOUND = 'eventhouse not found';

/** KQL identifier: starts with a letter, alphanumeric + underscore, 1-127 chars. */
function validIdent(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,126}$/.test(s);
}

const ALLOWED_INTERVALS = new Set(['5m', '10m', '15m', '30m', '1h', '2h', '6h', '12h', '24h']);

function validKustoIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
}

function validContainer(s: string): boolean {
  return /^[a-z0-9][a-z0-9\-]{1,62}$/.test(s);
}

type Step = { step: string; ok: boolean; detail?: string };

/**
 * Resolve an export SOURCE table against the resolved database's OWN object
 * list, the same check `[id]/purge::scopeTable` runs before a `.purge`.
 *
 * `validKustoIdent` only proves the string is well formed. Fails closed: if the
 * table list cannot be read the export is refused, because "I could not verify"
 * must never render as "it is fine" (deploy-integrity.md R7).
 */
async function scopeSourceTable(
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
    return { ok: false, status: 404, error: `sourceTable "${table}" does not exist in database "${database}".` };
  }
  return { ok: true };
}

/** Best-effort: real visible ADLS containers for the picker. Never throws. */
async function pickerContainers(): Promise<string[]> {
  try {
    const c = await listContainers();
    if (Array.isArray(c) && c.length) return c.map((x) => x.name);
  } catch {
    /* fall through to the canonical medallion set */
  }
  return ['bronze', 'silver', 'gold', 'landing'];
}

/**
 * POST — dispatched on body shape:
 *   { tableName, abfssUri }            → BIND mode (Delta source → KQL external table)
 *   { sourceTable, exportName, container } → EXPORT mode (continuous-export → ADLS Delta)
 *
 * Both mode handlers receive an AUTHORIZED ITEM, not an id. That signature is
 * the fix, not decoration around one: with no id-shaped parameter in scope there
 * is nothing left for a handler to accept and ignore, which is exactly how
 * `handleFile(_id, req)` on the sibling ingest route stayed broken.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // ERROR CONTRACT — this route used to run under `withSession`, whose try/catch
  // funnelled any unexpected throw to `apiServerError` (structured 500 + one
  // bounded server log). The item guard reaches Cosmos, which this handler never
  // did before, so the envelope matters more here than it did, not less.
  try {
    const { id } = await ctx.params;
    // LAYER 1 — WRITE-scoped: both modes issue `.create-or-alter` DDL.
    const guard = await guardAdxItemRequest({
      itemId: id,
      itemType: 'eventhouse',
      notFound: EVENTHOUSE_NOT_FOUND,
    });
    if (guard.res) return guard.res;
    const { item } = guard.ctx;

    const body = await req.json().catch(() => ({}));

    // BIND mode: an ADLS Delta source bound directly as a KQL external table.
    if (body?.tableName || body?.abfssUri) {
      return await bindDelta(item, body);
    }

    // EXPORT mode (default): a continuous-export job writing Delta to ADLS.
    return await continuousExport(item, body);
  } catch (e) {
    return apiServerError(e);
  }
}

/** BIND mode — ADLS Delta source → ADX external table + query acceleration. */
async function bindDelta(item: WorkspaceItem, body: any) {
  const requested = String(body?.database || '').trim();
  const tableName = String(body?.tableName || '').trim();
  const abfssUri = String(body?.abfssUri || '').trim();
  const hotDays = Math.max(1, Math.floor(Number(body?.hotDays) || 7));
  const miObjectId = body?.miObjectId ? String(body.miObjectId).trim() : undefined;
  const createKqlView = !!body?.createKqlView;

  if (!requested) return NextResponse.json({ ok: false, error: 'database required' }, { status: 400 });
  if (!tableName) return NextResponse.json({ ok: false, error: 'tableName required' }, { status: 400 });
  if (!abfssUri) return NextResponse.json({ ok: false, error: 'abfssUri required' }, { status: 400 });
  if (!validIdent(requested)) {
    return NextResponse.json({ ok: false, error: 'invalid database name' }, { status: 400 });
  }
  if (!validIdent(tableName)) {
    return NextResponse.json({
      ok: false,
      error: 'invalid tableName (KQL identifier: letter then alphanumeric/underscore, 1-127 chars)',
    }, { status: 400 });
  }
  if (!/^abfss:\/\//i.test(abfssUri)) {
    return NextResponse.json({
      ok: false,
      error: 'abfssUri must be an abfss:// URI (e.g. abfss://bronze@account.dfs.core.windows.net/path/to/delta)',
    }, { status: 400 });
  }

  // LAYER 2 — bind the database the external table + view are created in, before
  // any DDL is built. `.create-or-alter function` overwrites an existing body,
  // so this is a write even when it looks like a bind.
  const scoped = await scopeAdxDatabase(item, requested);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  const database: AdxScopedDatabase = scoped.database;

  const steps: Step[] = [];

  // Step 1: create (or update) the external Delta table. Schema is auto-inferred
  // from the delta log — no schema param needed. Failure here is fatal.
  try {
    await createExternalDeltaTable(database, tableName, abfssUri, {
      folder: 'Loom Delta',
      docString: `ADLS Delta source bound via CSA Loom (${new Date().toISOString()})`,
      miObjectId,
    });
    steps.push({ step: 'create_external_table', ok: true });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const denied = /StorageAccessDenied|Forbidden|AuthorizationFailure|403/i.test(msg);
    return NextResponse.json({
      ok: false,
      error: msg,
      steps,
      hint: denied
        ? 'The ADX cluster managed identity lacks Storage Blob Data Reader on the ADLS account. Grant the role (bicep: landing-zone/synapse-storage-rbac.bicep adxClusterPrincipalId) and retry.'
        : undefined,
    }, { status: e instanceof KustoError ? e.status : 502 });
  }

  // Step 2: apply the query-acceleration policy. Non-fatal — the table is
  // queryable without it, just not cached for sub-second latency.
  try {
    await setQueryAccelerationPolicy(database, tableName, hotDays);
    steps.push({ step: 'set_query_acceleration', ok: true, detail: `hot=${hotDays}d` });
  } catch (e: any) {
    steps.push({ step: 'set_query_acceleration', ok: false, detail: e?.message || String(e) });
  }

  // Step 3: show the policy (the receipt — proves what was applied).
  let accelerationPolicy: unknown = null;
  try {
    const pol = await showQueryAccelerationPolicy(database, tableName);
    accelerationPolicy = pol?.policy ?? null;
    steps.push({ step: 'show_acceleration_policy', ok: true });
  } catch (e: any) {
    steps.push({ step: 'show_acceleration_policy', ok: false, detail: e?.message || String(e) });
  }

  // Step 4 (optional): the mirrored KQL view wrapping external_table().
  let kqlViewName: string | undefined;
  if (createKqlView) {
    const candidate = `${tableName}_view`;
    try {
      await createExternalTableView(database, candidate, tableName);
      kqlViewName = candidate;
      steps.push({ step: 'create_kql_view', ok: true, detail: candidate });
    } catch (e: any) {
      steps.push({ step: 'create_kql_view', ok: false, detail: e?.message || String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    database,
    externalTableName: tableName,
    abfssUri,
    hotDays,
    accelerationPolicy,
    kqlViewName,
    sampleQuery: `external_table("${tableName}") | take 5`,
    steps,
    createdAt: new Date().toISOString(),
  });
}

/** EXPORT mode — create or replace a continuous Delta-export job (KQL → ADLS). */
async function continuousExport(item: WorkspaceItem, body: any) {
  // Honest gate — ADLS export is opt-in; must be wired in Bicep.
  const configuredAccount = (process.env.LOOM_RTI_EXPORT_ADLS || '').trim();
  if (!configuredAccount) {
    return NextResponse.json({
      ok: false,
      code: 'no_adls_config',
      missing: 'LOOM_RTI_EXPORT_ADLS',
      hint: [
        'Set LOOM_RTI_EXPORT_ADLS to the ADLS Gen2 storage account name and redeploy.',
        'The ADX cluster system-assigned MI must hold Storage Blob Data Contributor on that account.',
        'See platform/fiab/bicep/modules/admin-plane/adx-cluster.bicep (exportAdlsAccountName param).',
      ].join(' '),
    });
  }

  const requested   = String(body?.database    || '').trim();
  const sourceTable = String(body?.sourceTable || '').trim();
  const exportName  = String(body?.exportName  || '').trim();
  const container   = String(body?.container   || '').trim();
  const path        = trimSlashes(String(body?.path        || '').trim());
  const interval    = String(body?.interval    || '1h').trim();
  // DESTINATION BINDING. The body value used to WIN over the configured account,
  // which made the export destination caller-chosen. It is now pinned to the
  // deployment's own account; a body value naming a different one is refused,
  // not quietly rewritten. Empty is the editor's normal case.
  const askedAccount = String(body?.adlsAccount || '').trim();
  if (askedAccount && askedAccount !== configuredAccount) {
    return NextResponse.json({
      ok: false,
      error:
        `adlsAccount "${askedAccount}" is not this deployment's export account. ` +
        `Continuous export writes to "${configuredAccount}" (LOOM_RTI_EXPORT_ADLS) only. ` +
        'Leave adlsAccount empty to use it.',
    }, { status: 403 });
  }
  const adlsAccount = configuredAccount;

  if (!requested || !validKustoIdent(requested)) {
    return NextResponse.json({ ok: false, error: 'database required (valid KQL identifier)' }, { status: 400 });
  }
  if (!sourceTable || !validKustoIdent(sourceTable)) {
    return NextResponse.json({ ok: false, error: 'sourceTable required (valid KQL identifier)' }, { status: 400 });
  }
  if (!exportName || !validKustoIdent(exportName)) {
    return NextResponse.json({ ok: false, error: 'exportName required (valid KQL identifier)' }, { status: 400 });
  }
  if (!container || !validContainer(container)) {
    return NextResponse.json({ ok: false, error: 'container required (valid ADLS filesystem name)' }, { status: 400 });
  }
  if (!/^[a-z0-9]{3,24}$/.test(adlsAccount)) {
    return NextResponse.json({ ok: false, error: 'adlsAccount required (valid storage account name)' }, { status: 400 });
  }
  if (!ALLOWED_INTERVALS.has(interval)) {
    return NextResponse.json(
      { ok: false, error: `interval must be one of: ${[...ALLOWED_INTERVALS].join(', ')}` },
      { status: 400 },
    );
  }

  // LAYER 2 — the database the export READS FROM. A continuous export is a
  // standing job, so this binding is what stops the pipe being created at all
  // rather than merely returning fewer rows once.
  const scoped = await scopeAdxDatabase(item, requested);
  if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
  const database: AdxScopedDatabase = scoped.database;
  // …and the TABLE it reads, against that database's own object list. Fails
  // closed: an unlistable database refuses rather than falling through.
  const scopedTable = await scopeSourceTable(database, sourceTable);
  if (!scopedTable.ok) {
    return NextResponse.json({ ok: false, error: scopedTable.error }, { status: scopedTable.status });
  }

  // Build the sovereign-cloud-correct abfss:// URI.
  const suffix     = getDfsSuffix();
  const cleanPath  = path ? `/${path}` : '';
  const abfssUri   = `abfss://${container}@${adlsAccount}.${suffix}${cleanPath}`;
  // Naming convention: external table = ext_<exportName> to avoid collision with regular tables.
  const extTableName = `ext_${exportName}`;

  try {
    // Step 1: Create / idempotently update the Delta external table.
    await createOrAlterExternalTableDelta(database, extTableName, abfssUri);

    // Step 2: Create / idempotently update the continuous-export job.
    await createOrAlterContinuousExport(database, exportName, sourceTable, extTableName, interval);

    return NextResponse.json({
      ok:            true,
      database,
      exportName,
      externalTable: extTableName,
      abfssPath:     abfssUri,
      interval,
      sourceTable,
      // receipt: the _delta_log/ path is proof that Delta files landed.
      // Caller can also verify with: .show continuous-export <exportName>
      receipt:       `${abfssUri}/_delta_log/`,
      verify:        `.show continuous-export ["${exportName}"]`,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

/**
 * GET — continuous-export jobs + ADLS picker config (for the export dialog) AND
 * the Delta external tables (for the bind dialog). Both are best-effort: a
 * failure in one does not blank the other.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // ERROR CONTRACT — see POST above.
  try {
    const { id } = await ctx.params;
    // LAYER 1 — read-only picker, so shared read roles are admitted.
    const guard = await guardAdxItemRequest({
      itemId: id,
      itemType: 'eventhouse',
      notFound: EVENTHOUSE_NOT_FOUND,
      allowReadRoles: true,
    });
    if (guard.res) return guard.res;

    const { searchParams } = new URL(req.url);
    const requested = (searchParams.get('database') || '').trim();
    if (!requested || !validKustoIdent(requested)) {
      return NextResponse.json(
        { ok: false, error: 'database query param required and must be a valid KQL identifier' },
        { status: 400 },
      );
    }
    // LAYER 2 — no export job or external-table target is disclosed for a
    // database outside this item's workspace scope.
    const scoped = await scopeAdxDatabase(guard.ctx.item, requested);
    if (!scoped.ok) return NextResponse.json({ ok: false, error: scoped.error }, { status: scoped.status });
    const database: AdxScopedDatabase = scoped.database;

    const adlsAccount = (process.env.LOOM_RTI_EXPORT_ADLS || '').trim();
    const containers = await pickerContainers();

    let exports: Awaited<ReturnType<typeof listContinuousExports>> = [];
    let exportsError: string | undefined;
    try {
      exports = await listContinuousExports(database);
    } catch (e: any) {
      exportsError = e?.message || String(e);
    }

    // Delta external tables (the lakehouse-binding kind). Tables with an
    // unknown/empty TableType are included so nothing is silently hidden.
    let externalTables: Array<{ name: string; tableType: string; folder?: string }> = [];
    try {
      const all = await listExternalTables(database);
      externalTables = all
        .filter((t) => !t.tableType || t.tableType.toLowerCase() === 'delta')
        .map((t) => ({ name: t.name, tableType: t.tableType || 'Delta', folder: t.folder }));
    } catch {
      /* best-effort — the export view does not need external tables */
    }

    return NextResponse.json({
      ok: true,
      database,
      exports,
      externalTables,
      config: { adlsAccount, containers, configured: !!adlsAccount },
      ...(exportsError ? { exportsError } : {}),
    });
  } catch (e) {
    return apiServerError(e);
  }
}
