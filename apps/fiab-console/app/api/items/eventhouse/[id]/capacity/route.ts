/**
 * GET  /api/items/eventhouse/[id]/capacity
 * POST /api/items/eventhouse/[id]/capacity
 *
 * The Eventhouse "Capacity / throttle" panel backend. Azure-native default —
 * the shared Azure Data Explorer (ADX) cluster is the eventhouse capacity
 * backend (NO Microsoft Fabric / OneLake dependency; per
 * .claude/rules/no-fabric-dependency.md).
 *
 * GET returns:
 *   - capacityPolicy : parsed `.show cluster policy capacity` JSON object
 *                      (IngestionCapacity, ExportCapacity, …)
 *   - liveCapacity   : `.show capacity` rows (Resource/Total/Consumed/Remaining/Origin)
 *   - metrics        : Azure Monitor cluster metrics for the throttle dashboard
 *                      (throttled queries/commands, ingestion/cache util, CPU,
 *                      concurrent queries) over the last PT15M. Wrapped in
 *                      try/catch — when ARM is unreachable (e.g. sovereign cloud
 *                      without LOOM_ARM_ENDPOINT, or missing Monitoring Reader)
 *                      `metrics` is omitted and `metricsGate` names the fix. The
 *                      Kusto data-plane results still render.
 *
 * POST applies a patch to the cluster ingestion capacity policy via
 * `.alter-merge cluster policy capacity ```{...}```` (AllDatabasesAdmin).
 *
 * Real backend, no mocks. Per .claude/rules/no-vaporware.md.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  showClusterCapacityPolicy,
  showCapacitySlots,
  alterMergeCapacityPolicy,
  CAPACITY_POLICY_COMPONENTS,
  kustoConfigGate,
  KustoError,
} from '@/lib/azure/kusto-client';
import { fetchMetrics, type MetricResult } from '@/lib/azure/monitor-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Construct the ARM resource id for the shared ADX cluster from env. */
function kustoClusterArmId(): { id: string | null; missing: string[] } {
  const sub = process.env.LOOM_SUBSCRIPTION_ID;
  const rg = process.env.LOOM_KUSTO_RG || 'rg-csa-loom-admin-eastus2';
  const cluster = process.env.LOOM_KUSTO_CLUSTER_NAME || 'adx-csa-loom-shared';
  const missing: string[] = [];
  if (!sub) missing.push('LOOM_SUBSCRIPTION_ID');
  if (!sub) return { id: null, missing };
  return {
    id: `/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.Kusto/clusters/${cluster}`,
    missing,
  };
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  // Honest data-plane gate: ADX cluster URI not configured at all.
  const gate = kustoConfigGate();
  if (gate) {
    return NextResponse.json({
      ok: false,
      error: `Azure Data Explorer is not configured in this deployment. Set ${gate.missing} to the cluster data-plane URI (e.g. https://adx-csa-loom-shared.eastus2.kusto.windows.net).`,
      configGate: gate.missing,
    }, { status: 200 });
  }

  try {
    const [capacityPolicy, liveCapacity] = await Promise.all([
      showClusterCapacityPolicy(),
      showCapacitySlots(),
    ]);

    // Azure Monitor metrics for the throttle dashboard. Best-effort: an ARM
    // gate (sovereign cloud, missing role) must not block the Kusto results.
    let metrics: MetricResult[] | undefined;
    let metricsGate: string | undefined;
    const arm = kustoClusterArmId();
    if (!arm.id) {
      metricsGate = `Live throttle metrics require ${arm.missing.join(', ')} to construct the ADX cluster resource id. The capacity policy + live slot table below are unaffected.`;
    } else {
      try {
        // fetchMetrics applies one aggregation per call → group by aggregation.
        const [avgMetrics, totalMetrics] = await Promise.all([
          fetchMetrics({
            resourceId: arm.id,
            metricNames: ['CPU', 'IngestionUtilization', 'CacheUtilizationFactor', 'TotalNumberOfConcurrentQueries'],
            timespan: 'PT15M',
            interval: 'PT1M',
            aggregation: 'Average',
          }),
          fetchMetrics({
            resourceId: arm.id,
            metricNames: ['TotalNumberOfThrottledQueries', 'TotalNumberOfThrottledCommands'],
            timespan: 'PT15M',
            interval: 'PT1M',
            aggregation: 'Total',
          }),
        ]);
        metrics = [...avgMetrics, ...totalMetrics];
      } catch (e: any) {
        const usingPublicArm = !process.env.LOOM_ARM_ENDPOINT;
        metricsGate = `Live throttle metrics unavailable: ${e?.message || String(e)}. ${
          usingPublicArm
            ? 'For sovereign clouds set LOOM_ARM_ENDPOINT (e.g. https://management.usgovcloudapi.net). '
            : ''
        }The UAMI also needs "Monitoring Reader" on the ADX cluster. Capacity policy + live slots below are unaffected.`;
      }
    }

    return NextResponse.json({
      ok: true,
      kustoClusterArmId: arm.id,
      capacityPolicy,
      liveCapacity,
      metrics,
      metricsGate,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const patch = body?.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return NextResponse.json({ ok: false, error: 'patch object required, e.g. { "IngestionCapacity": { "ClusterMaximumConcurrentOperations": 512 } }' }, { status: 400 });
  }

  const keys = Object.keys(patch);
  if (!keys.length) {
    return NextResponse.json({ ok: false, error: 'patch must contain at least one capacity component' }, { status: 400 });
  }
  for (const k of keys) {
    if (!(CAPACITY_POLICY_COMPONENTS as readonly string[]).includes(k)) {
      return NextResponse.json({
        ok: false,
        error: `Unsupported capacity component "${k}". Allowed: ${CAPACITY_POLICY_COMPONENTS.join(', ')}.`,
      }, { status: 400 });
    }
    const comp = (patch as Record<string, unknown>)[k];
    if (!comp || typeof comp !== 'object' || Array.isArray(comp)) {
      return NextResponse.json({ ok: false, error: `Component "${k}" must be an object of policy properties.` }, { status: 400 });
    }
    // Numeric guard: every property must be a finite number (capacity props are long/real).
    for (const [pk, pv] of Object.entries(comp as Record<string, unknown>)) {
      if (typeof pv !== 'number' || !Number.isFinite(pv)) {
        return NextResponse.json({ ok: false, error: `Property "${k}.${pk}" must be a finite number.` }, { status: 400 });
      }
    }
  }

  try {
    const result = await alterMergeCapacityPolicy(patch as Record<string, unknown>);
    const json = JSON.stringify(patch);
    const applied = `.alter-merge cluster policy capacity \`\`\`${json}\`\`\``;
    // Surface the new effective policy (first cell of the result row) as receipt.
    const policyCell = result.rows?.[0]?.find((c) => typeof c === 'string' && (c as string).trim().startsWith('{'));
    return NextResponse.json({
      ok: true,
      applied,
      effectivePolicy: typeof policyCell === 'string' ? policyCell.slice(0, 2000) : undefined,
      columns: result.columns,
      rowCount: result.rowCount,
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
