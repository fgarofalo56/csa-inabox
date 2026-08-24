/**
 * POST /api/data-products/[id]/health-actions  (F20)
 *
 * Actionable data-health remediations for a `data-product`. Each action calls a
 * REAL Azure backend — no stubs:
 *   - refresh-lineage → re-pull the Purview classic Data Map Atlas lineage
 *                       subgraph (`getLineageSubgraph`); effect = fresh
 *                       node/edge counts returned to the card.
 *   - rerun-dq-check  → recompute the DQ score from live ADX KQL
 *                       (`measureCertificationDq`) AND persist it to
 *                       `state.dqMeasurement`; effect = updated gauge/score on
 *                       every read surface, not just this response (#3493 — the
 *                       GET paths read that record instead of re-running rules).
 *   - trigger-scan    → kick a Purview scan run (`triggerScanRun`) for the
 *                       `source`/`scan` the card supplies; effect = a runId.
 *
 * Body: { action, source?, scan? }. Unknown actions → 400.
 * Honest gates: Purview unset → 501 (LOOM_PURVIEW_ACCOUNT); ADX unset → 503
 * (LOOM_KUSTO_CLUSTER_URI). NO Microsoft Fabric dependency on any path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadOwnedItem, updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getLineageSubgraph,
  triggerScanRun,
  isPurviewConfigured,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { prewarmPurviewShirForScan } from '@/lib/azure/shir-autoscale';
import { adxConfigGate } from '@/lib/azure/data-quality-client';
import {
  measureCertificationDq, dqMeasurementPatch,
} from '@/lib/dataproducts/certification-dq';
import { upsertDataProductDoc, docForDataProduct } from '@/lib/azure/loom-data-products-search';
import { resolveDataProductDocTenant } from '@/lib/dataproducts/owner-tenant';
import { apiServerError } from '@/lib/api/respond';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const ACTIONS = ['refresh-lineage', 'rerun-dq-check', 'trigger-scan'] as const;
type HealthAction = (typeof ACTIONS)[number];

interface Dataset { name?: string; guid?: string }

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {

  const { id } = params;
  const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'data-product item not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = body?.action as HealthAction;
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ ok: false, error: `action must be one of: ${ACTIONS.join(', ')}` }, { status: 400 });
  }

  const state = (item.state || {}) as Record<string, unknown>;
  const datasets = (Array.isArray(state.datasets) ? state.datasets : []) as Dataset[];
  const purviewDataProductId = (state.purviewDataProductId as string) || '';
  const firstDatasetGuid = datasets[0]?.guid || purviewDataProductId || '';
  const timestamp = new Date().toISOString();

  try {
    if (action === 'refresh-lineage') {
      if (!isPurviewConfigured()) {
        return NextResponse.json({ ok: false, error: 'Purview not provisioned', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } }, { status: 501 });
      }
      if (!firstDatasetGuid) {
        return NextResponse.json({ ok: false, error: 'Register a dataset (or the data product with Purview) first — lineage centers on an Atlas entity GUID.' }, { status: 400 });
      }
      const g = await getLineageSubgraph(firstDatasetGuid);
      const nodeCount = Object.keys(g.guidEntityMap).length;
      const edgeCount = g.relations.length;
      return NextResponse.json({
        ok: true,
        result: { action, outcome: `Lineage refreshed: ${nodeCount} nodes, ${edgeCount} edges.`, nodeCount, edgeCount, baseEntityGuid: g.baseEntityGuid, timestamp },
      });
    }

    if (action === 'rerun-dq-check') {
      const gate = adxConfigGate();
      if (gate) {
        return NextResponse.json({ ok: false, error: 'ADX not provisioned', gate }, { status: 503 });
      }
      // Same measurement the certification gate consumes (rules EXECUTED, scored
      // on the ones that PASSED), and the same record it writes — so a rerun here
      // moves the badge the marketplace card and the certification panel show,
      // instead of producing a number that dies with this response.
      const dq = await measureCertificationDq(item);
      // The SAME patch POST /certify `measure-dq` applies — the reading plus the
      // reconciled discovery badge — so the two measuring writes cannot leave a
      // product in different states depending on which button the user pressed.
      const patch = dqMeasurementPatch(item, dq, session.claims.oid);
      const updated = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, {
        state: { ...state, ...patch },
      });
      if (updated) {
        try {
          // #3501 — the OWNER's tenant, not the caller's (see owner-tenant.ts).
          const ownerTid = await resolveDataProductDocTenant(updated);
          if (ownerTid) await upsertDataProductDoc(docForDataProduct(updated, ownerTid));
        } catch { /* derived */ }
      }
      const score = dq.dqResult;
      const measured = dq.dqGate
        ? dq.dqGate
        : `DQ score recomputed: ${dq.dqScore} (${score?.passingRules ?? 0}/${score?.ruleCount ?? 0} rules passing).`;
      // The card renders `outcome` and nothing else, so a failed persist has to
      // be IN it — otherwise the user reads "recomputed" for a number the read
      // surfaces never received.
      const persistNote = updated
        ? ''
        : ' The measurement ran but could NOT be written to the item — the product card and certification panel still show the previous reading.';
      return NextResponse.json({
        ok: true,
        result: {
          action,
          outcome: `${measured}${persistNote}`,
          dqScore: score,
          certificationDqScore: dq.dqScore,
          certificationState: patch.certificationState,
          persisted: !!updated,
          measuredAt: patch.dqMeasurement.measuredAt,
          timestamp,
        },
      });
    }

    // trigger-scan
    {
      if (!isPurviewConfigured()) {
        return NextResponse.json({ ok: false, error: 'Purview not provisioned', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } }, { status: 501 });
      }
      const source = (body?.source as string) || '';
      const scan = (body?.scan as string) || '';
      if (!source || !scan) {
        return NextResponse.json({ ok: false, error: 'source and scan are required for trigger-scan (pick them in the card).' }, { status: 400 });
      }
      // Scale the shared Purview SHIR VMSS up first if this scan runs on a
      // SelfHosted IR (fail-open — never blocks the scan).
      const shir = await prewarmPurviewShirForScan(source, scan);
      const run = await triggerScanRun(source, scan);
      return NextResponse.json({ ok: true, result: { action, outcome: `Scan run triggered on ${source}/${scan} (runId ${run.runId}).`, runId: run.runId, timestamp, ...(shir ? { shir } : {}) } });
    }
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json({ ok: false, error: 'Purview not provisioned', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } }, { status: 501 });
    }
    if (e instanceof PurviewError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 502 });
    }
    return apiServerError(e);
  }
});
