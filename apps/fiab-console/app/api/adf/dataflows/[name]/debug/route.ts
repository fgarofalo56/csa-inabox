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
import { getSession } from '@/lib/auth/session';
import {
  dataFlowDebugConfigGate,
  getDataFlow,
  getDataset,
  getLinkedService,
  listIntegrationRuntimes,
  createDataFlowDebugSession,
  addDataFlowToDebugSession,
  executeDataFlowDebugCommand,
  deleteDataFlowDebugSession,
  type AdfDataset,
  type AdfLinkedService,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADF data-flow names: letters, digits, underscore (same charset the sibling
// dataflows route validates with).
const NAME_RE = /^[A-Za-z0-9_]{1,260}$/;

/** A source / sink / transformation node in a MappingDataFlow's typeProperties. */
type FlowNode = {
  name?: string;
  dataset?: { referenceName?: string };
  linkedService?: { referenceName?: string };
};

const isNonEmpty = (s: unknown): s is string => typeof s === 'string' && s.length > 0;

/**
 * GET — availability probe. The designer calls this to decide whether to enable
 * its debug toggle. Returns 200 either way (an honest "not configured" is not an
 * error the editor should throw on); when configured it best-effort surfaces a
 * data-flow-capable (Managed) Azure Integration Runtime name as advisory info.
 */
export async function GET(_req: NextRequest, _ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

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
}

/**
 * POST — real data preview against a live ADF data-flow debug session. Returns
 * { ok, streamName, schema, rows, rowCount } with rows straight from the Spark
 * debug cluster, or an honest 503 gate when the factory env isn't configured.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = dataFlowDebugConfigGate();
  if (gate) {
    return NextResponse.json(
      {
        ok: false,
        code: 'not_configured',
        error:
          `Data Factory not configured: set ${gate.missing}. A data-flow debug ` +
          `session needs an Azure Data Factory with a data-flow-capable (Managed) ` +
          `Azure Integration Runtime.`,
        missing: gate.missing,
      },
      { status: 503 },
    );
  }

  const { name } = await ctx.params;
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
  const rlRaw = Number(body.rowLimits);
  const rowLimits = Number.isFinite(rlRaw) && rlRaw > 0 ? Math.min(Math.floor(rlRaw), 1000) : 100;
  const computeType = typeof body.computeType === 'string' ? body.computeType : undefined;
  const coreRaw = Number(body.coreCount);
  const coreCount = Number.isFinite(coreRaw) && coreRaw > 0 ? Math.floor(coreRaw) : undefined;
  const ttlRaw = Number(body.timeToLiveMinutes);
  const timeToLiveMinutes = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : undefined;

  let sessionId: string | undefined;
  try {
    // Bound flow definition (real ARM GET; throws if the flow doesn't exist).
    const flow = await getDataFlow(name);

    const tp = (flow.properties?.typeProperties ?? {}) as {
      sources?: FlowNode[];
      sinks?: FlowNode[];
      transformations?: FlowNode[];
    };
    const sources: FlowNode[] = Array.isArray(tp.sources) ? tp.sources : [];
    const sinks: FlowNode[] = Array.isArray(tp.sinks) ? tp.sinks : [];
    const transformations: FlowNode[] = Array.isArray(tp.transformations) ? tp.transformations : [];

    // Every previewable stream is a named source / transformation / sink. Validate
    // BEFORE provisioning a (costly) Spark cluster so an empty flow 400s cheaply.
    const streamNames = [...sources, ...transformations, ...sinks]
      .map((n) => n?.name)
      .filter(isNonEmpty);
    if (streamNames.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'data flow has no source/transformation/sink streams to preview' },
        { status: 400 },
      );
    }
    const streamName =
      requestedStream && streamNames.includes(requestedStream) ? requestedStream : streamNames[0];

    // The debug cluster needs the datasets + linked services the flow references
    // to actually read source data. Collect them from sources/sinks (and each
    // dataset's own linked service). Per-item best-effort: a node that reads from
    // an inline source has no dataset, and a transient read miss shouldn't abort
    // the whole preview.
    const datasetNames = new Set<string>();
    const linkedServiceNames = new Set<string>();
    for (const node of [...sources, ...sinks]) {
      if (isNonEmpty(node?.dataset?.referenceName)) datasetNames.add(node.dataset!.referenceName!);
      if (isNonEmpty(node?.linkedService?.referenceName)) {
        linkedServiceNames.add(node.linkedService!.referenceName!);
      }
    }

    const datasets: AdfDataset[] = [];
    for (const dn of datasetNames) {
      try {
        const d = await getDataset(dn);
        datasets.push(d);
        const lsRef = d.properties?.linkedServiceName?.referenceName;
        if (isNonEmpty(lsRef)) linkedServiceNames.add(lsRef);
      } catch {
        /* skip a dataset that can't be read — ADF still previews inline sources */
      }
    }

    const linkedServices: AdfLinkedService[] = [];
    for (const ln of linkedServiceNames) {
      try {
        linkedServices.push(await getLinkedService(ln));
      } catch {
        /* skip a linked service that can't be read */
      }
    }

    // Cap each source's read to `rowLimits` for a fast, bounded preview.
    const sourceSettings = sources
      .map((s) => s?.name)
      .filter(isNonEmpty)
      .map((sourceName) => ({ sourceName, rowLimit: rowLimits }));
    const debugSettings = sourceSettings.length ? { sourceSettings } : undefined;

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
      dataFlow: flow,
      datasets: datasets.length ? datasets : undefined,
      linkedServices: linkedServices.length ? linkedServices : undefined,
      debugSettings,
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
}
