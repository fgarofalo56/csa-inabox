/**
 * Unity Catalog LAKEHOUSE / DATA-QUALITY MONITORING — wave c3 finish.
 *
 *   GET /api/databricks/unity-catalog/quality-monitors
 *         [?catalog=&schema=&table=&status=Unhealthy|Healthy|Unknown&limit=&warehouseId=]
 *         → { ok, columns[], rows[], executionMs }   (latest status per monitored table)
 *   GET /api/databricks/unity-catalog/quality-monitors?info=monitor&table=c.s.t
 *         → { ok, monitor }                            (classic per-table monitor config)
 *
 * Two real backends, no mocks:
 *   1. "List monitors + their latest status" reads the documented system table
 *      `system.data_quality_monitoring.table_results` (latest row per table) over
 *      the SQL Statement Execution path.
 *      https://learn.microsoft.com/azure/databricks/admin/system-tables/data-quality-monitoring
 *   2. The per-table monitor CONFIG is GET /api/2.1/unity-catalog/quality-monitors/
 *      {table_full_name} (classic Lakehouse Monitoring REST).
 *      https://learn.microsoft.com/azure/databricks/lakehouse-monitoring/
 *
 * Honest gate when Databricks is not configured, at the GCC-High / DoD boundary,
 * and (from the client) when the `data_quality_monitoring` system schema isn't
 * enabled / the Console UAMI lacks SELECT (only account admins can read it by
 * default) — the error names the exact remediation. CREATE / run-refresh of a
 * monitor is intentionally not wired here (a notebook / dashboards-side flow);
 * the UI surfaces that as an honest note.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import {
  primaryWorkspaceHost, getQualityMonitor, readDataQualityMonitorResults,
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
        `Unity Catalog data-quality monitoring is not available at the ${cloudBoundaryLabel()} boundary. ` +
        `It requires a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore). ` +
        `At this boundary use Azure Monitor / Log Analytics on the Databricks diagnostic logs for table-quality checks.`,
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

const numOr = (v: string | null): number | undefined => {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const gate = resolveGate();
  if (gate) return NextResponse.json({ ok: false, gated: true, error: gate.error }, { status: 200 });

  const sp = req.nextUrl.searchParams;

  // ---- Per-table monitor config (classic Lakehouse Monitoring REST) ----
  if (sp.get('info') === 'monitor') {
    const table = sp.get('table')?.trim();
    if (!table || table.split('.').length !== 3) {
      return NextResponse.json({ ok: false, error: 'table must be catalog.schema.table' }, { status: 400 });
    }
    try {
      const host = await primaryWorkspaceHost();
      const monitor = await getQualityMonitor(host, table);
      return NextResponse.json({ ok: true, monitor });
    } catch (e: any) {
      // 404 = the table simply has no monitor attached; surface honestly (not a 500).
      if (e?.status === 404) {
        return NextResponse.json({ ok: true, monitor: null, message: `No Lakehouse Monitor is attached to ${table}. Create one from a Databricks notebook or the Catalog Explorer "Quality" tab.` });
      }
      return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
    }
  }

  // ---- List monitors + latest status (system.data_quality_monitoring) ----
  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(sp.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    const result = await readDataQualityMonitorResults(warehouseId, {
      catalog: sp.get('catalog')?.trim() || undefined,
      schema: sp.get('schema')?.trim() || undefined,
      table: sp.get('table')?.trim() || undefined,
      status: sp.get('status')?.trim() || undefined,
      limit: numOr(sp.get('limit')),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    if (e?.status === 403) return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
