/**
 * POST /api/data-products/[id]/health-actions  (F20)
 *
 * Actionable data-health remediations for a `data-product`. Each action calls a
 * REAL Azure backend — no stubs:
 *   - refresh-lineage → re-pull the Purview classic Data Map Atlas lineage
 *                       subgraph (`getLineageSubgraph`); effect = fresh
 *                       node/edge counts returned to the card.
 *   - rerun-dq-check  → recompute the DQ score from live ADX KQL
 *                       (`computeDqScore`); effect = updated gauge/score.
 *   - trigger-scan    → kick a Purview scan run (`triggerScanRun`) for the
 *                       `source`/`scan` the card supplies; effect = a runId.
 *
 * Body: { action, source?, scan? }. Unknown actions → 400.
 * Honest gates: Purview unset → 501 (LOOM_PURVIEW_ACCOUNT); ADX unset → 503
 * (LOOM_KUSTO_CLUSTER_URI). NO Microsoft Fabric dependency on any path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  getLineageSubgraph,
  triggerScanRun,
  isPurviewConfigured,
  PurviewNotConfiguredError,
  PurviewError,
} from '@/lib/azure/purview-client';
import { adxConfigGate, computeDqScore } from '@/lib/azure/data-quality-client';
import { defaultDatabase } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'data-product';
const ACTIONS = ['refresh-lineage', 'rerun-dq-check', 'trigger-scan'] as const;
type HealthAction = (typeof ACTIONS)[number];

interface Dataset { name?: string; guid?: string }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { id } = await ctx.params;
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
  const database = (state.databaseName as string) || defaultDatabase();
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
      const tableNames = datasets.map((d) => d.name).filter((n): n is string => !!n);
      const score = await computeDqScore(session.claims.oid, database, tableNames);
      const outcome = score.score == null
        ? `No applicable data-quality rules — add rules in Governance → Data quality.`
        : `DQ score recomputed: ${score.score} (${score.passingRules}/${score.ruleCount} rules passing).`;
      return NextResponse.json({ ok: true, result: { action, outcome, dqScore: score, timestamp } });
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
      const run = await triggerScanRun(source, scan);
      return NextResponse.json({ ok: true, result: { action, outcome: `Scan run triggered on ${source}/${scan} (runId ${run.runId}).`, runId: run.runId, timestamp } });
    }
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError) {
      return NextResponse.json({ ok: false, error: 'Purview not provisioned', gate: { missing: 'LOOM_PURVIEW_ACCOUNT' } }, { status: 501 });
    }
    if (e instanceof PurviewError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
