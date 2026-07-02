/**
 * Unity Catalog SYSTEM TABLES / AUDIT surface — wave c3.
 *
 *   GET /api/databricks/unity-catalog/system-tables?table=audit|billing|query-history[&days=&limit=&service=&action=&status=&warehouseId=]
 *         → { ok, table, columns[], rows[], executionMs }
 *   GET /api/databricks/unity-catalog/system-tables?info=schemas
 *         → { ok, metastore, schemas:[{schema,state}] }   (enablement state)
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
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost, getMetastoreSummary, listSystemSchemas, enableSystemSchema,
  readAccessAudit, readBillingUsage, readQueryHistory,
} from '@/lib/azure/unity-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Gate { gated: true; error: string }

function resolveGate(): Gate | null {
  const cfg = databricksConfigGate();
  if (cfg) {
    return { gated: true, error: `Databricks is not configured in this deployment. Set ${cfg.missing} on the Console (landing-zone bicep deploys the Databricks workspace).` };
  }
  if (isGovCloud()) {
    return {
      gated: true,
      error:
        `Unity Catalog system tables (audit / billing / query history) are not available at the ${cloudBoundaryLabel()} boundary. ` +
        `They require a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore). ` +
        `At this boundary use Azure Monitor / Log Analytics on the Databricks diagnostic logs instead.`,
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

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

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
          return NextResponse.json({ ok: true, metastore: summary, schemas: [], schemasError: e?.message || String(e) });
        }
      }
      return NextResponse.json({ ok: true, metastore: summary, schemas });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
    }
  }

  // ---- System table read ----
  const table = (sp.get('table') || 'audit').toLowerCase().trim();
  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(sp.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  const days = numOr(sp.get('days'));
  const limit = numOr(sp.get('limit'));
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
    return NextResponse.json({ ok: true, table, ...result });
  } catch (e: any) {
    // The client throws a typed gate (schema not enabled / UAMI missing grants)
    // with a 403; surface it as a gated MessageBar rather than a hard error.
    if (e?.status === 403) return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

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
      return NextResponse.json({
        ok: false, gated: true,
        error: `Enabling the system.${schema} schema requires a metastore or account admin. The Console UAMI is not one — ask an admin to run \`databricks system-schemas enable <metastore_id> system.${schema}\` (or PUT /api/2.1/unity-catalog/metastores/{id}/systemschemas/${schema}).`,
      }, { status: 200 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
