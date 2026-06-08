/**
 * GET /api/data-products/[id]/observability  (F19 / F20)
 *
 * Data Observability for a `data-product` item. Azure-native, NO Microsoft
 * Fabric dependency:
 *   - Lineage graph    ← Microsoft Purview CLASSIC Data Map Atlas lineage
 *                         (`getLineageSubgraph`, `/datamap/api/atlas/v2/lineage`).
 *   - Health charts     ← Azure Data Explorer (ADX) live KQL (`runHealthCharts`).
 *   - DQ score          ← Loom-native DQ rules scored with live ADX KQL
 *                         (`computeDqScore`).
 *
 * Honest gates (no fake data) — each section degrades independently:
 *   - ADX unset (`LOOM_KUSTO_CLUSTER_URI`)   → `gate.adx`, health + dqScore null.
 *   - Purview unset (`LOOM_PURVIEW_ACCOUNT`) → `gate.purview`, lineage null.
 *
 * Response: { ok, lineage, healthCharts, dqScore, gate, database, tableName }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getLineageSubgraph,
  isPurviewConfigured,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { adxConfigGate, computeDqScore, runHealthCharts } from '@/lib/azure/data-quality-client';
import { defaultDatabase } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

interface Dataset { name?: string; guid?: string; qualifiedName?: string }

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'data-product item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const datasets = (Array.isArray(state.datasets) ? state.datasets : []) as Dataset[];
  const purviewDataProductId = (state.purviewDataProductId as string) || '';
  const firstDatasetGuid = datasets[0]?.guid || purviewDataProductId || '';
  const tableName = (state.databaseTable as string) || datasets[0]?.name || undefined;
  const database = (state.databaseName as string) || defaultDatabase();

  const gate: Record<string, { missing: string }> = {};

  // ---- Lineage (Purview classic Data Map) ----
  let lineage: { nodes: any[]; edges: any[]; baseEntityGuid: string } | null = null;
  if (!isPurviewConfigured()) {
    gate.purview = { missing: 'LOOM_PURVIEW_ACCOUNT' };
  } else if (!firstDatasetGuid) {
    // Purview is configured but the product has no Atlas entity yet — surface a
    // precise, actionable note (not a fake graph).
    lineage = { nodes: [], edges: [], baseEntityGuid: '' };
  } else {
    try {
      const g = await getLineageSubgraph(firstDatasetGuid);
      const nodes = Object.values(g.guidEntityMap).map((n) => ({ id: n.guid, label: n.displayText || n.guid, type: n.typeName || '—' }));
      const edges = g.relations.map((r) => ({ from: r.fromEntityId, to: r.toEntityId, label: r.relationshipType }));
      lineage = { nodes, edges, baseEntityGuid: g.baseEntityGuid };
    } catch (e: any) {
      if (e instanceof PurviewNotConfiguredError) {
        gate.purview = { missing: 'LOOM_PURVIEW_ACCOUNT' };
      } else if (e instanceof PurviewError) {
        return NextResponse.json({ ok: false, error: `Purview lineage failed: ${e.message}` }, { status: 502 });
      } else {
        return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
      }
    }
  }

  // ---- Health charts + DQ score (ADX) ----
  let healthCharts: Awaited<ReturnType<typeof runHealthCharts>> | null = null;
  let dqScore: Awaited<ReturnType<typeof computeDqScore>> | null = null;
  const adxGate = adxConfigGate();
  if (adxGate) {
    gate.adx = { missing: adxGate.missing };
  } else {
    try {
      const tableNames = datasets.map((d) => d.name).filter((n): n is string => !!n);
      [healthCharts, dqScore] = await Promise.all([
        runHealthCharts(database, tableName),
        computeDqScore(session.claims.oid, database, tableNames),
      ]);
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: `ADX observability failed: ${e?.message || String(e)}` }, { status: 502 });
    }
  }

  return NextResponse.json({
    ok: true,
    lineage,
    healthCharts,
    dqScore,
    database,
    tableName: tableName || null,
    gate: Object.keys(gate).length ? gate : undefined,
  });
}
