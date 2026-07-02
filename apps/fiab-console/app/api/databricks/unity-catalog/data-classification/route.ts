/**
 * Unity Catalog UC-NATIVE DATA CLASSIFICATION (auto-PII) — wave c3.
 *
 *   GET /api/databricks/unity-catalog/data-classification?[catalog=&schema=&table=&confidence=HIGH|LOW&limit=&warehouseId=]
 *         → { ok, columns[], rows[], executionMs }
 *
 * Read-only reads of column-level sensitive-class detections from the Databricks
 * system table `system.data_classification.results` over the SQL Statement
 * Execution path (Learn-grounded SQL). Complements the Purview scan path.
 *   https://learn.microsoft.com/azure/databricks/admin/system-tables/data-classification
 *
 * Honest gate when Databricks is not configured, at the GCC-High / DoD boundary,
 * and (from the client) when the `data_classification` system schema isn't
 * enabled / the Console UAMI lacks SELECT — the error names the exact remediation.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { databricksConfigGate, listWarehouses } from '@/lib/azure/databricks-client';
import { isGovCloud, cloudBoundaryLabel } from '@/lib/azure/cloud-endpoints';
import { readDataClassification } from '@/lib/azure/unity-catalog-client';

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
        `Unity Catalog data classification is not available at the ${cloudBoundaryLabel()} boundary. ` +
        `It requires a Commercial or GCC Databricks account (Microsoft Entra-connected Unity Catalog metastore). ` +
        `At this boundary use the Microsoft Purview scan path for column-level PII detection.`,
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
  let warehouseId: string;
  try {
    warehouseId = await resolveWarehouseId(sp.get('warehouseId')?.trim() || undefined);
  } catch (e: any) {
    return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
  }

  try {
    const result = await readDataClassification(warehouseId, {
      catalog: sp.get('catalog')?.trim() || undefined,
      schema: sp.get('schema')?.trim() || undefined,
      table: sp.get('table')?.trim() || undefined,
      confidence: sp.get('confidence')?.trim() || undefined,
      limit: numOr(sp.get('limit')),
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    if (e?.status === 403) return NextResponse.json({ ok: false, gated: true, error: e?.message || String(e) }, { status: 200 });
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
