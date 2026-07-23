/**
 * Data-flow data preview for the Mapping Data Flow designer — a REAL Azure Data
 * Factory data-flow debug session (no mocks, no Fabric). Backs the per-transform
 * "Data preview" surface the designer already renders
 * (lib/components/pipeline/dataflow/mapping-dataflow-designer.tsx): the editor
 * supplies the callback + `debugClusterAvailable` flag and renders the rows this
 * route returns in its own Fluent results panel.
 *
 *   GET  /api/adf/dataflows/{name}/debug
 *        Availability probe. 200 + { ok:true, available:true } when the default
 *        Data Factory is configured (so the editor can flip `debugClusterAvailable`
 *        without a thrown error); 200 + { ok:false, available:false, missing }
 *        with the exact missing env var when it is not.
 *
 *   POST /api/adf/dataflows/{name}/debug   body { streamName?, rowLimits?,
 *        computeType?, coreCount?, timeToLiveMinutes? }
 *        Real preview. Runs the full Az.DataFactory debug sequence against the
 *        bound flow and returns the live rows for the requested (or first) stream:
 *          1. createDataFlowDebugSession  → { sessionId }     (provisions Spark)
 *          2. addDataFlowToDebugSession    → adds the flow + its datasets /
 *             linked services + per-source row limits
 *          3. executeDataFlowDebugCommand  → { schema, rows } (executePreviewQuery)
 *          4. deleteDataFlowDebugSession   (always, in finally — releases Spark)
 *
 * The session lives under the deployment-default Data Factory (Azure-native; the
 * Fabric-free backend the flagship pipeline run/debug routes use). Honest 503
 * gate naming LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG / LOOM_ADF_NAME when the factory
 * isn't configured — never fabricated rows.
 *
 * Refs (grounded in MS Learn + @azure/arm-datafactory DataFlowDebugSessions):
 *   https://learn.microsoft.com/rest/api/datafactory/data-flow-debug-session/create
 *   https://learn.microsoft.com/rest/api/datafactory/data-flow-debug-session/add-data-flow
 *   https://learn.microsoft.com/rest/api/datafactory/data-flow-debug-session/execute-command
 *   https://learn.microsoft.com/powershell/module/az.datafactory/invoke-azdatafactoryv2dataflowdebugsessioncommand
 *
 * Per no-vaporware.md (real backend or honest gate), no-fabric-dependency.md
 * (Azure-native ADF), and the structured {ok,data,error} BFF contract.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import { withSession } from '@/lib/api/route-toolkit';
import {
  dataFlowDebugConfigGate,
  listIntegrationRuntimes,
  createDataFlowDebugSession,
  addDataFlowToDebugSession,
  executeDataFlowDebugCommand,
  deleteDataFlowDebugSession,
} from '@/lib/azure/adf-client';
import {
  DATAFLOW_NAME_RE as NAME_RE,
  clampSampleSize,
  flowStreamNames,
  resolveDebugPackage,
} from '@/lib/azure/dataflow-debug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET — availability probe. The designer calls this to decide whether to enable
 * its debug toggle. Returns 200 either way (an honest "not configured" is not an
 * error the editor should throw on); when configured it best-effort surfaces a
 * data-flow-capable (Managed) Azure Integration Runtime name as advisory info.
 */
export const GET = withSession<{ name: string }>(async () => {
  const gate = dataFlowDebugConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        available: false,
        missing: gate.missing,
        reason: `Data Factory not configured: set ${gate.missing}.`,
      },
      { status: 200 },
    );
  }

  // Advisory only: name a Managed (Azure) IR if one is listed. Data-flow debug
  // always has the implicit AutoResolveIntegrationRuntime, so a list hiccup or an
  // empty Managed-IR set must NOT flip availability false (avoids a false gate).
  let integrationRuntime: string | undefined;
  try {
    const irs = await listIntegrationRuntimes();
    integrationRuntime = irs.find((ir) => ir.properties?.type === 'Managed')?.name;
  } catch {
    /* advisory only — never block availability on a list failure */
  }

  return NextResponse.json({ ok: true, available: true, integrationRuntime }, { status: 200 });
});

/**
 * POST — real data preview against a live ADF data-flow debug session. Returns
 * { ok, streamName, schema, rows, rowCount } with rows straight from the Spark
 * debug cluster, or an honest 503 gate when the factory env isn't configured.
 */
export const POST = withSession<{ name: string }>(async (req, { params }) => {
  const gate = dataFlowDebugConfigGate();
  if (gate) {
    return apiHonestGateError('svc-adf', {
      missing: [gate.missing],
      message:
        `Data Factory not configured: set ${gate.missing}. A data-flow debug ` +
        `session needs an Azure Data Factory with a data-flow-capable (Managed) ` +
        `Azure Integration Runtime.`,
    });
  }

  const { name } = params;
  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json({ ok: false, error: 'invalid data flow name' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    streamName?: unknown;
    rowLimits?: unknown;
    computeType?: unknown;
    coreCount?: unknown;
    timeToLiveMinutes?: unknown;
  };
  const requestedStream = typeof body.streamName === 'string' ? body.streamName.trim() : '';
  const rowLimits = clampSampleSize(body.rowLimits);
  const computeType = typeof body.computeType === 'string' ? body.computeType : undefined;
  const coreRaw = Number(body.coreCount);
  const coreCount = Number.isFinite(coreRaw) && coreRaw > 0 ? Math.floor(coreRaw) : undefined;
  const ttlRaw = Number(body.timeToLiveMinutes);
  const timeToLiveMinutes = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : undefined;

  let sessionId: string | undefined;
  try {
    // Bound flow + its datasets / linked services + per-source row cap (shared
    // helper — the same package the /api/items/mapping-dataflow debug routes use).
    const pkg = await resolveDebugPackage(name, rowLimits);

    // Every previewable stream is a named source / transformation / sink. Validate
    // BEFORE provisioning a (costly) Spark cluster so an empty flow 400s cheaply.
    const streamNames = flowStreamNames(pkg.flow);
    if (streamNames.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'data flow has no source/transformation/sink streams to preview' },
        { status: 400 },
      );
    }
    const streamName =
      requestedStream && streamNames.includes(requestedStream) ? requestedStream : streamNames[0];

    // 1) Provision the short-lived Spark debug cluster.
    const created = await createDataFlowDebugSession({
      ...(computeType ? { computeType } : {}),
      ...(coreCount !== undefined ? { coreCount } : {}),
      ...(timeToLiveMinutes !== undefined ? { timeToLiveMinutes } : {}),
    });
    sessionId = created.sessionId;

    // 2) Add the in-memory flow package (flow + datasets + linked services + limits).
    await addDataFlowToDebugSession({
      sessionId,
      dataFlow: pkg.flow,
      datasets: pkg.datasets,
      linkedServices: pkg.linkedServices,
      debugSettings: pkg.debugSettings,
    });

    // 3) Execute the preview query for the chosen stream → real rows + schema.
    const preview = await executeDataFlowDebugCommand({ sessionId, streamName, rowLimits });

    return NextResponse.json({
      ok: true,
      streamName,
      schema: preview.schema,
      rows: preview.rows,
      rowCount: preview.rows.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // A missing flow surfaces as a 404 from getDataFlow; everything else is an
    // upstream ARM / debug-session failure.
    const status = /\b404\b/.test(msg) ? 404 : 502;
    return NextResponse.json({ ok: false, error: msg }, { status });
  } finally {
    // 4) Always release the Spark cluster (best-effort; idempotent).
    if (sessionId) await deleteDataFlowDebugSession(sessionId).catch(() => {});
  }
});
