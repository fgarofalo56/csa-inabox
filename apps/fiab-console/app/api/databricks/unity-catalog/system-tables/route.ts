/**
 * Unity Catalog SYSTEM TABLES / AUDIT surface — wave c3.
 *
 *   GET /api/databricks/unity-catalog/system-tables?table=audit|billing|query-history[&days=&limit=&service=&action=&status=&warehouseId=]
 *         → { ok, backend, table, columns[], rows[], executionMs }
 *   GET /api/databricks/unity-catalog/system-tables?info=schemas
 *         → { ok, backend, metastore, schemas:[{schema,state}] }   (enablement state)
 *   POST /api/databricks/unity-catalog/system-tables
 *         body { action:'enable-schema', schema }          → { ok }
 *
 * Read-only reads of the Databricks system tables over the SQL Statement
 * Execution path (Learn-grounded SQL):
 *   system.access.audit · system.billing.usage · system.query.history
 *   https://learn.microsoft.com/azure/databricks/admin/system-tables/
 * Enablement is confirmed / requested via the systemschemas REST
 *   GET/PUT /api/2.1/unity-catalog/metastores/{id}/systemschemas[/{schema}]
 *
 * Honest gate when Databricks is not configured, at the GCC-High / DoD boundary,
 * and (from the client) when a system schema isn't enabled or the Console UAMI
 * lacks USE CATALOG/USE SCHEMA/SELECT on it — the error names the exact grant.
 *
 * ## AUTHORIZATION — tenant admin, org-wide  (loom-apex LU-3)
 *
 * This is an ORG-WIDE AUDIT surface: `system.access.audit` is the whole
 * metastore's activity, not the caller's. The rows carry actor UPNs + Entra
 * oids, securable FQNs, and DENIALS — a map of what other people tried to reach
 * and were refused. It used to be a bare `getSession()` check, so ANY signed-in
 * user could read all of it. The whole route (GET + POST) is now
 * `withTenantAdmin`, exactly like the sibling reader of the same trail
 * (app/api/admin/audit-logs/route.ts). Attack-tested in `__tests__/route.test.ts`.
 *
 * ## The Loom Unity (OSS) backend is NOT served here yet
 *
 * LU-3 also builds a Loom-native `access.audit` equivalent for the OSS backend —
 * every catalog call funnels through the BFF audit choke point
 * (`ucFetch`/`dbxFetch` → `recordUnityAccess`, `lib/azure/unity-audit.ts`) and
 * lands in the Cosmos `_auditLog` trail + the `LoomAudit_CL` SIEM stream. Those
 * WRITES ship in this PR. The READER and the `/catalog/unity` System-tables pane
 * that surface them are SPLIT OUT to a follow-up PR, because they have no
 * in-browser E2E receipt and `ux-baseline.md` G1 makes that blocking. Until then
 * the Gov gate below stands (unchanged from before LU-3), and the trail is read
 * with `unityAuditKql()` against Log Analytics / Sentinel.
 */

import { NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { buildGateEnvelope } from '@/lib/api/gate-envelope';
import { availabilityFor } from '@/lib/gates/registry';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost, getMetastoreSummary, listSystemSchemas, enableSystemSchema,
  readAccessAudit, readBillingUsage, readQueryHistory,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The registry gate that owns this surface's two bespoke codes (issue #2624). */
export const SYSTEM_TABLES_GATE_ID = 'svc-databricks-system-tables';

interface Gate {
  gated: true;
  error: string;
  /** Back-compat machine-readable code (unchanged on the wire). */
  code: string;
  /** The registry gate the code maps to — drives the inline Fix-it (G2). */
  gateId: string;
  /**
   * True when the backing capability does not EXIST in the active cloud (vs a
   * config miss). HonestGate then drops the Fix-it and names the fallback —
   * prompting for an env var that cannot help would be dishonest.
   */
  cloudUnavailable?: boolean;
}

/**
 * Serialize a gate as the WS-D2 normalized envelope.
 *
 * Before #2624 this route returned a bare `{ ok:false, gated:true, code, error }`.
 * The code was machine-readable but resolved to NOTHING: the only consumer
 * (`AuditSystemDialog`) dropped it and rendered a bare MessageBar, and
 * `HonestGate` resolves a gate by id, so even a wired consumer would have hit
 * its "not in the registry" branch. The `gate` block below is ADDITIVE — every
 * pre-existing top-level field keeps its exact value and HTTP 200 — so old
 * clients are byte-compatible while the pane can now drive a real Fix-it.
 */
function gatedJson(gate: Gate): NextResponse {
  // `missing` is deliberately NOT overridden: buildGateEnvelope defaults it to
  // the LIVE gateStatus(id).missing, so the not-configured case names
  // LOOM_DATABRICKS_HOSTNAME while the grant / boundary cases (where the var IS
  // set) correctly report nothing missing.
  const env = buildGateEnvelope(gate.gateId, { code: gate.code, message: gate.error });
  return NextResponse.json(
    {
      ...env,
      gate: gate.cloudUnavailable
        ? {
            ...env.gate,
            state: 'cloud-unavailable' as const,
            // Sourced from the gate's own X-MATRIX declaration rather than
            // restated here, so the note can never drift from the registry.
            fallbackNote: availabilityFor(gate.gateId)?.fallbackNote ?? env.gate.fallbackNote,
          }
        : env.gate,
    },
    // Deliberately 200, not GATE_HTTP_STATUS (503): this surface's gates have
    // always been 200 + `gated:true`, and the dialog branches on `j.gated`.
    { status: 200 },
  );
}

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, code: 'svc-databricks', gateId: 'svc-databricks', error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      code: 'uc_system_tables_boundary',
      gateId: SYSTEM_TABLES_GATE_ID,
      // Not a config miss — Databricks Unity Catalog has no Azure Government
      // endpoint, so no env value can unblock this. (Nor does LOOM_UC_BACKEND=oss:
      // Loom Unity has no system schemas either — ossUcUnsupportedPath gates them.)
      cloudUnavailable: true,
      error:
        `Unity Catalog system tables (audit / billing / query history) are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore). ` +
        `At this boundary use Azure Monitor / Log Analytics on the Databricks diagnostic logs instead — and for Loom's own ` +
        `catalog access trail, the LoomAudit_CL stream written by the LU-3 BFF audit choke point (unityAuditKql()).`,
    };
  }
  return null;
}

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
 * A window must look BACKWARD. `days=-30` would compute a lower bound 30 days in
 * the FUTURE, the predicate would match nothing, and the surface would render
 * "no activity in this window" — an audit surface reporting "nothing happened"
 * for a malformed input is a false negative, which is the failure class this
 * whole item exists to avoid. Reject it instead.
 */
function invalidWindow(days: number | undefined, limit: number | undefined): string | null {
  if (days !== undefined && !(days > 0)) return 'days must be a positive number of days to look back';
  if (limit !== undefined && !(limit > 0)) return 'limit must be a positive number of rows';
  return null;
}

export const GET = withTenantAdmin(async (req) => {
  const gate = resolveGate();
  if (gate) return gatedJson(gate);

  const sp = req.nextUrl.searchParams;

  // ---- Enablement state (systemschemas REST) ----
  if (sp.get('info') === 'schemas') {
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

  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(sp.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return gatedJson({ gated: true, code: 'svc-databricks-sql', gateId: 'svc-databricks-sql', error: e?.message || String(e) });
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
      return NextResponse.json({ ok: false, error: 'table must be one of: audit, billing, query-history' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, backend: 'databricks', table, ...result });
  } catch (e: any) {
    // The client throws a typed gate (schema not enabled / UAMI missing grants)
    // with a 403; surface it as a gated MessageBar rather than a hard error.
    if (e?.status === 403) return gatedJson({ gated: true, code: 'uc_system_schema_grant', gateId: SYSTEM_TABLES_GATE_ID, error: e?.message || String(e) });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});

export const POST = withTenantAdmin(async (req, { session }) => {
  const gate = resolveGate();
  if (gate) return gatedJson(gate);

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 }); }
  const action = String(body?.action || '');
  if (action !== 'enable-schema') return NextResponse.json({ ok: false, error: "unsupported action; expected 'enable-schema'" }, { status: 400 });
  const schema = String(body?.schema || '').toLowerCase().trim();
  if (!schema) return NextResponse.json({ ok: false, error: 'schema is required (e.g. access, billing, query, data_classification)' }, { status: 400 });

  try {
    const host = await primaryWorkspaceHost();
    const summary = await getMetastoreSummary(host);
    if (!summary.metastoreId) return NextResponse.json({ ok: false, error: 'could not resolve the metastore id from this workspace' }, { status: 502 });
    await enableSystemSchema(host, summary.metastoreId, schema);
    return NextResponse.json({ ok: true, schema, enabledBy: session.claims.upn });
  } catch (e: any) {
    // Enabling needs metastore/account admin — a 403 is an honest admin-action gate.
    if (e?.status === 403) {
      return gatedJson({
        gated: true, code: 'uc_system_schema_grant', gateId: SYSTEM_TABLES_GATE_ID,
        error: `Enabling the system.${schema} schema requires a metastore or account admin. The Console UAMI is not one — ask an admin to run \`databricks system-schemas enable <metastore_id> system.${schema}\` (or PUT /api/2.1/unity-catalog/metastores/{id}/systemschemas/${schema}).`,
      });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
});
