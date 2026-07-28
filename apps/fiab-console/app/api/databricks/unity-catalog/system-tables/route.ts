/**
 * Unity Catalog SYSTEM TABLES / AUDIT surface — wave c3, extended by loom-apex LU-3.
 *
 *   GET /api/databricks/unity-catalog/system-tables?table=audit|billing|query-history[&days=&limit=&service=&action=&status=&warehouseId=]
 *         → { ok, table, columns[], rows[], executionMs }
 *   GET /api/databricks/unity-catalog/system-tables?info=schemas
 *         → { ok, metastore, schemas:[{schema,state}] }   (enablement state)
 *   POST /api/databricks/unity-catalog/system-tables
 *         body { action:'enable-schema', schema }          → { ok }
 *
 * TWO BACKENDS, ONE CONTRACT (`lib/azure/uc-backend.ts`):
 *
 *   Databricks Unity Catalog (Commercial default) — read-only reads of the
 *   Databricks system tables over the SQL Statement Execution path
 *   (Learn-grounded SQL):
 *     system.access.audit · system.billing.usage · system.query.history
 *     https://learn.microsoft.com/azure/databricks/admin/system-tables/
 *   Enablement is confirmed / requested via the systemschemas REST
 *     GET/PUT /api/2.1/unity-catalog/metastores/{id}/systemschemas[/{schema}]
 *
 *   Loom Unity / OSS Unity Catalog (Azure Government default) — LU-3. This
 *   route used to answer EVERY Gov request with "system tables are not
 *   available at this boundary". That gate is GONE: Loom Unity now has a real
 *   `access.audit` equivalent, because every catalog call funnels through the
 *   BFF audit choke point (`ucFetch` → `recordUnityAccess`) and lands in the
 *   Cosmos `_auditLog` trail + the `LoomAudit_CL` SIEM stream. Reads come from
 *   `readUnitySystemTable()` and carry the SAME { columns, rows, executionMs }
 *   contract, so the existing UC audit dialog works unchanged in Gov.
 *
 * Honest gate when Databricks is not configured, and (from the client) when a
 * system schema isn't enabled or the Console UAMI lacks USE CATALOG/USE
 * SCHEMA/SELECT on it — the error names the exact grant. On the Loom Unity
 * backend, `billing` and `query-history` have no equivalent (there is no
 * Databricks billing meter and no warehouse query engine); those name the real
 * Loom surface that answers the question instead of pretending.
 *
 * ## AUTHORIZATION — tenant admin, org-wide
 *
 * This is an ORG-WIDE AUDIT surface. Neither backend scopes its rows to the
 * caller: `system.access.audit` is the whole metastore's activity, and the Loom
 * Unity views read every `itemType:'loom-unity'` row in `_auditLog` across every
 * user. The rows carry actor UPNs + Entra oids, securable FQNs, and DENIALS — a
 * map of what other people tried to reach and were refused. A bare session check
 * would let any signed-in user read all of it, so the whole route (GET + POST) is
 * `withTenantAdmin`, exactly like the sibling reader of the same container
 * (app/api/admin/audit-logs/route.ts).
 */

import { NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { isOssUc } from '@/lib/azure/uc-backend';
import {
  readUnitySystemTable, UNITY_SYSTEM_TABLES, type UnitySystemTable,
} from '@/lib/azure/unity-audit';
import {
  primaryWorkspaceHost, getMetastoreSummary, listSystemSchemas, enableSystemSchema,
  readAccessAudit, readBillingUsage, readQueryHistory,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string; code: string }

function resolveGate(): Gate | null {
  // LU-3 — on the Loom Unity (OSS) backend there is nothing to gate on: the
  // audit trail is Loom's own, written by the BFF choke point, and needs no
  // Databricks account, no warehouse, and no Fabric workspace.
  if (isOssUc()) return null;
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, code: 'svc-databricks', error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      code: 'uc_backend_not_oss',
      error:
        `Databricks Unity Catalog system tables (audit / billing / query history) are not available at the ${cloudBoundaryLabel()} boundary — ` +
        `they require a Commercial or GCC Databricks account. This deployment is on the Databricks backend ` +
        `(LOOM_UC_BACKEND=databricks); switch to the Loom Unity backend (LOOM_UC_BACKEND=oss + LOOM_UNITY_URL) to get the ` +
        `Loom-native access audit, which needs no Databricks account.`,
    };
  }
  return null;
}

/** Map the client's table key onto a Loom Unity system-table view. */
const OSS_TABLE_ALIASES: Record<string, UnitySystemTable> = {
  audit: 'audit',
  access: 'audit',
  denials: 'denials',
  denied: 'denials',
  summary: 'summary',
};

/**
 * Databricks-only families on the Loom Unity backend. Honest per
 * no-vaporware.md: name the REAL Loom surface that answers the same question
 * rather than rendering an empty grid.
 */
const OSS_UNSUPPORTED: Record<string, string> = {
  billing:
    'Loom Unity has no billing meter — there are no Databricks DBUs to bill. Cost for the Azure-native backends (ADLS, Synapse, ADX, Container Apps) is real Azure spend: see the FinOps hub at /admin/finops, which reads Azure Cost Management directly.',
  usage:
    'Loom Unity has no billing meter — there are no Databricks DBUs to bill. Cost for the Azure-native backends (ADLS, Synapse, ADX, Container Apps) is real Azure spend: see the FinOps hub at /admin/finops, which reads Azure Cost Management directly.',
  'query-history':
    'Loom Unity is a metastore, not a query engine, so it has no warehouse query history. Query history for the engines that read the catalog lives with those engines: Synapse serverless / SQL Lab under /sql, and ADX under the KQL surfaces. The catalog-call history itself is the access audit view on this pane.',
  query:
    'Loom Unity is a metastore, not a query engine, so it has no warehouse query history. Query history for the engines that read the catalog lives with those engines: Synapse serverless / SQL Lab under /sql, and ADX under the KQL surfaces. The catalog-call history itself is the access audit view on this pane.',
  history:
    'Loom Unity is a metastore, not a query engine, so it has no warehouse query history. Query history for the engines that read the catalog lives with those engines: Synapse serverless / SQL Lab under /sql, and ADX under the KQL surfaces. The catalog-call history itself is the access audit view on this pane.',
};

async function resolveWarehouseId(requested?: string): Promise<string> {
  if (requested) return requested;
  const warehouses = await listWarehouses();
  const running = warehouses.find((w) => w.state === 'RUNNING') || warehouses[0];
  if (!running) throw new Error('No SQL warehouse found. Create or start a SQL warehouse in the Databricks workspace.');
  return running.id;
}

const numOr = (v: string | null, def?: number): number | undefined => {
  if (v == null || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/**
 * A window must look BACKWARD. `days=-30` would compute a `since` 30 days in the
 * FUTURE, `c.at >= @since` would match nothing, and the pane would render its
 * "no catalog activity in this window" empty state — an audit surface reporting
 * "nothing happened" for a malformed input is the same false-negative class the
 * rest of this route is built to avoid. Reject it instead.
 */
function invalidWindow(days: number | undefined, limit: number | undefined): string | null {
  if (days !== undefined && !(days > 0)) return 'days must be a positive number of days to look back';
  if (limit !== undefined && !(limit > 0)) return 'limit must be a positive number of rows';
  return null;
}

export const GET = withTenantAdmin(async (req) => {
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, code: gate.code, error: gate.error }, { status: 200 });

  const sp = req.nextUrl.searchParams;
  const oss = isOssUc();

  // ---- Enablement state ----
  if (sp.get('info') === 'schemas') {
    // LU-3 — Loom Unity's "system schemas" need no enablement: the access trail
    // is written by the BFF choke point on every call, so it is always on. Report
    // the real views rather than a Databricks enablement handshake that does not
    // exist on this backend.
    if (oss) {
      return NextResponse.json({
        ok: true,
        backend: 'oss',
        metastore: { name: 'Loom Unity', metastoreId: 'loom-unity' },
        schemas: UNITY_SYSTEM_TABLES.map((t) => ({ schema: t.id, state: 'ENABLE_COMPLETED', label: t.label, description: t.description })),
      });
    }
    try {
      const host = await primaryWorkspaceHost();
      const summary = await getMetastoreSummary(host);
      let schemas: Array<{ schema: string; state?: string }> = [];
      if (summary.metastoreId) {
        try { schemas = await listSystemSchemas(host, summary.metastoreId); }
        catch (e: any) {
          // Listing requires metastore/account admin — surface honestly, don't 500.
          return NextResponse.json({ ok: true, backend: 'databricks', metastore: summary, schemas: [], schemasError: e?.message || String(e) });
        }
      }
      return NextResponse.json({ ok: true, backend: 'databricks', metastore: summary, schemas });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
    }
  }

  // ---- System table read ----
  const table = (sp.get('table') || 'audit').toLowerCase().trim();
  const days = numOr(sp.get('days'));
  const limit = numOr(sp.get('limit'));
  const badWindow = invalidWindow(days, limit);
  if (badWindow) return NextResponse.json({ ok: false, error: badWindow }, { status: 400 });

  // ---- Loom Unity (OSS) backend — the Loom-native access audit ----
  if (oss) {
    const unsupported = OSS_UNSUPPORTED[table];
    if (unsupported) return NextResponse.json({ ok: false, gated: true, backend: 'oss', code: 'not_applicable', error: unsupported }, { status: 200 });
    const view = OSS_TABLE_ALIASES[table];
    if (!view) {
      return NextResponse.json({
        ok: false,
        error: `table must be one of: ${Object.keys(OSS_TABLE_ALIASES).join(', ')} on the Loom Unity backend`,
      }, { status: 400 });
    }
    try {
      const since = days ? new Date(Date.now() - days * 24 * 3600 * 1000).toISOString() : undefined;
      const result = await readUnitySystemTable(view, {
        since,
        limit,
        operation: sp.get('action')?.trim() || undefined,
        securable: sp.get('securable')?.trim() || undefined,
        actor: sp.get('service')?.trim() || undefined,
      });
      return NextResponse.json({ ok: true, backend: 'oss', table: view, ...result });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
    }
  }

  // ---- Databricks backend ----
  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(sp.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, code: 'svc-databricks-sql', error: e?.message || String(e) }, { status: 200 });
  }

  try {
    let result;
    if (table === 'audit') {
      result = await readAccessAudit(warehouseId, { days, limit, service: sp.get('service')?.trim() || undefined, action: sp.get('action')?.trim() || undefined });
    } else if (table === 'billing' || table === 'usage') {
      result = await readBillingUsage(warehouseId, { days, limit });
    } else if (table === 'query-history' || table === 'query' || table === 'history') {
      result = await readQueryHistory(warehouseId, { days, limit, status: sp.get('status')?.trim() || undefined });
    } else {
      return NextResponse.json({ ok: false, error: "table must be one of: audit, billing, query-history" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, backend: 'databricks', table, ...result });
  } catch (e: any) {
    // The client throws a typed gate (schema not enabled / UAMI missing grants)
    // with a 403; surface it as a gated MessageBar rather than a hard error.
    if (e?.status === 403) return NextResponse.json({ ok: false, gated: true, code: 'uc_system_schema_grant', error: e?.message || String(e) }, { status: 200 });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

export const POST = withTenantAdmin(async (req, { session }) => {
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, code: gate.code, error: gate.error }, { status: 200 });

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const action = String(body?.action || '');
  if (action !== 'enable-schema') return NextResponse.json({ ok: false, error: "unsupported action; expected 'enable-schema'" }, { status: 400 });
  const schema = String(body?.schema || '').toLowerCase().trim();
  if (!schema) return NextResponse.json({ ok: false, error: 'schema is required (e.g. access, billing, query, data_classification)' }, { status: 400 });

  // LU-3 — nothing to enable on Loom Unity: the access trail is always on
  // because the BFF choke point writes it. Answer truthfully instead of
  // pretending to run a Databricks enablement handshake.
  if (isOssUc()) {
    const known = UNITY_SYSTEM_TABLES.some((t) => t.id === schema);
    return NextResponse.json({
      ok: known,
      backend: 'oss',
      schema,
      alreadyEnabled: known,
      ...(known
        ? { note: 'Loom Unity system tables need no enablement — every catalog call is recorded by the BFF audit choke point as it happens.' }
        : { error: `Loom Unity has no '${schema}' system view. Available: ${UNITY_SYSTEM_TABLES.map((t) => t.id).join(', ')}.` }),
    }, { status: known ? 200 : 400 });
  }

  try {
    const host = await primaryWorkspaceHost();
    const summary = await getMetastoreSummary(host);
    if (!summary.metastoreId) return NextResponse.json({ ok: false, error: 'could not resolve the metastore id from this workspace' }, { status: 502 });
    await enableSystemSchema(host, summary.metastoreId, schema);
    return NextResponse.json({ ok: true, schema, enabledBy: session.claims.upn });
  } catch (e: any) {
    // Enabling needs metastore/account admin — a 403 is an honest admin-action gate.
    if (e?.status === 403) {
      return NextResponse.json({
        ok: false, gated: true, code: 'uc_system_schema_grant',
        error: `Enabling the system.${schema} schema requires a metastore or account admin. The Console UAMI is not one — ask an admin to run \`databricks system-schemas enable <metastore_id> system.${schema}\` (or PUT /api/2.1/unity-catalog/metastores/{id}/systemschemas/${schema}).`,
      }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});
