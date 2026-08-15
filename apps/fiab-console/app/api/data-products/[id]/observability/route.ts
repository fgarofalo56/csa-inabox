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
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getLineageSubgraph,
  isPurviewConfigured,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { adxConfigGate, computeDqScore, runHealthCharts } from '@/lib/azure/data-quality-client';
import { resolveDqTarget, DQ_GATE, DQ_MEASURE_CONCURRENCY } from '@/lib/dataproducts/certification-dq';
import { resolveOwnerTenantId } from '@/lib/dataproducts/owner-tenant';
import { apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';

interface Dataset { name?: string; guid?: string; qualifiedName?: string }

export const GET = withSession<{ id: string }>(async (_req: NextRequest, { session, params }) => {

  const { id } = params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'data-product item not found' }, { status: 404 });

  const state = (item.state || {}) as Record<string, unknown>;
  const datasets = (Array.isArray(state.datasets) ? state.datasets : []) as Dataset[];
  const purviewDataProductId = (state.purviewDataProductId as string) || '';
  const firstDatasetGuid = datasets[0]?.guid || purviewDataProductId || '';
  // ONE shared derivation of the ADX target (certification-dq.resolveDqTarget) —
  // this route's own copy passed a whitespace-only databaseName straight into KQL
  // instead of falling back to the default database. `databaseTable` had the same
  // bug one field over, so it is trimmed here too.
  const { database, tableNames } = resolveDqTarget(item);
  const boundTable = typeof state.databaseTable === 'string' ? state.databaseTable.trim() : '';
  const tableName = boundTable || tableNames[0] || undefined;

  const gate: Record<string, { missing: string }> = {};
  // Per-section failure reasons (a slow/failing ADX read degrades only itself).
  const sectionErrors: Record<'healthCharts' | 'dqScore', string> = {} as Record<'healthCharts' | 'dqScore', string>;

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
        return apiServerError(e);
      }
    }
  }

  // ---- Health charts + DQ score (ADX) ----
  let healthCharts: Awaited<ReturnType<typeof runHealthCharts>> | null = null;
  let dqScore: Awaited<ReturnType<typeof computeDqScore>> | null = null;
  const adxGate = adxConfigGate();
  // WHOSE rules. `loadOwnedItem` gates on workspace WRITE access, not ownership,
  // so `session.claims.oid` here made a collaborator's Observability tab score
  // the OWNER's tables against the COLLABORATOR's (usually empty) rule set.
  const ownerTenantId = await resolveOwnerTenantId(item.workspaceId);
  if (adxGate) {
    gate.adx = { missing: adxGate.missing };
  } else if (!ownerTenantId) {
    // Health charts do not depend on the rule store, so they still run; only the
    // score is withheld, with the reason (never a fabricated empty breakdown).
    healthCharts = await runHealthCharts(database, tableName).catch((e) => {
      sectionErrors.healthCharts = e?.message || String(e);
      return null;
    });
    sectionErrors.dqScore = DQ_GATE.ownerTenant;
  } else {
    // Health charts and the DQ score are INDEPENDENT ADX reads. Settle them
    // separately so one slow / failing KQL query degrades only its own section
    // (honest per-section error) instead of 502-ing the whole report.
    //
    // BOUNDED. This is the one measuring route left, `useObservability` fires it
    // on MOUNT from two editors, and a tenant with 200 rules would otherwise
    // serialise 200 KQL queries on a 30 s Kusto budget behind a 30 s client
    // abort: the gauge times out on every open and the cluster runs them anyway.
    const [healthR, dqR] = await Promise.allSettled([
      runHealthCharts(database, tableName),
      computeDqScore(ownerTenantId, database, tableNames, { concurrency: DQ_MEASURE_CONCURRENCY }),
    ]);
    if (healthR.status === 'fulfilled') healthCharts = healthR.value;
    else sectionErrors.healthCharts = healthR.reason?.message || String(healthR.reason);
    if (dqR.status === 'fulfilled') dqScore = dqR.value;
    else sectionErrors.dqScore = dqR.reason?.message || String(dqR.reason);
    // Only if BOTH ADX reads failed do we treat it as a hard ADX error.
    if (healthR.status === 'rejected' && dqR.status === 'rejected') {
      return NextResponse.json(
        { ok: false, error: `ADX observability failed: ${healthR.reason?.message || String(healthR.reason)}` },
        { status: 502 },
      );
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
    sectionErrors: Object.keys(sectionErrors).length ? sectionErrors : undefined,
  });
});
