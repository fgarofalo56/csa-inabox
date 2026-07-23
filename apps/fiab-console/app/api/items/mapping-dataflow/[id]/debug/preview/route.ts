/**
 * POST /api/items/mapping-dataflow/[id]/debug/preview   — per-transform Data Preview
 *
 * Executes a REAL ADF data-flow debug preview for ONE transform's output stream
 * against an already-acquired debug session (see ../session). Runs the SAME DFS
 * the flow's run path executes — `addDataFlowToDebugSession` (refresh the
 * in-memory package so the preview reflects the current, possibly-unsaved graph)
 * then `executeDataFlowDebugCommand(executePreviewQuery)`. Rows come straight
 * from the Spark debug cluster — never fabricated (no-vaporware.md). Azure-native
 * (no-fabric-dependency.md).
 *
 *   body {
 *     sessionId: string,            // from POST ../session { action:'acquire' }
 *     transformId: string,          // the output-stream name to preview
 *     sampleSize?: number,          // 1..1000 (default 100)
 *     dataFlow?: AdfDataFlow.properties  // live authored graph (unsaved edits)
 *   }
 *   → 200 { ok, streamName, columns[], rows[][], rowCount, schema, elapsedMs }
 *
 * `columns` is derived from the debug command's DFS schema string when present
 * (type-badged headers downstream), else back-filled from row width. Honest 503
 * gate (svc-adf) when the factory isn't configured; 409 when the session is
 * missing/expired so the client re-acquires.
 *
 * Route-toolkit: withSession (R1/R3). No new env var.
 */

import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import {
  dataFlowDebugConfigGate,
  addDataFlowToDebugSession,
  executeDataFlowDebugCommand,
  type AdfDataFlow,
} from '@/lib/azure/adf-client';
import {
  DATAFLOW_NAME_RE,
  clampSampleSize,
  flowStreamNames,
  parseDfsSchema,
  resolveDebugPackage,
} from '@/lib/azure/dataflow-debug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A gone/expired session surfaces from ADF as a 404/NotFound on add/execute. */
function isSessionGone(msg: string): boolean {
  return /\b404\b|not\s*found|session.*(expired|not\s*exist)|expired/i.test(msg);
}

export const POST = withSession<{ id: string }>(async (req, { params }) => {
  const gate = dataFlowDebugConfigGate();
  if (gate) {
    return apiHonestGateError('svc-adf', {
      missing: [gate.missing],
      message: `Data Factory not configured: set ${gate.missing}.`,
    });
  }

  const { id } = params;
  if (!id || !DATAFLOW_NAME_RE.test(id)) {
    return NextResponse.json({ ok: false, error: 'invalid data flow name' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    sessionId?: unknown;
    transformId?: unknown;
    sampleSize?: unknown;
    dataFlow?: AdfDataFlow['properties'];
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId required — acquire a debug session first' }, { status: 400 });
  }
  const requestedStream = typeof body.transformId === 'string' ? body.transformId.trim() : '';
  const sampleSize = clampSampleSize(body.sampleSize);

  const startedAt = Date.now();
  try {
    // Resolve the debug package from the LIVE authored graph when the client
    // sends it (preview unsaved edits — ADF Studio parity), else the saved flow.
    const pkg = await resolveDebugPackage(id, sampleSize, { liveFlow: body.dataFlow });

    const streamNames = flowStreamNames(pkg.flow);
    if (streamNames.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'data flow has no source/transformation/sink streams to preview' },
        { status: 400 },
      );
    }
    const streamName =
      requestedStream && streamNames.includes(requestedStream) ? requestedStream : streamNames[0];

    // Refresh the in-memory package on the held session (cheap; ADF versions it),
    // then run the preview query for the chosen stream.
    await addDataFlowToDebugSession({
      sessionId,
      dataFlow: pkg.flow,
      datasets: pkg.datasets,
      linkedServices: pkg.linkedServices,
      debugSettings: pkg.debugSettings,
    });

    const preview = await executeDataFlowDebugCommand({ sessionId, streamName, rowLimits: sampleSize });

    const parsed = parseDfsSchema(preview.schema);
    const rows = preview.rows;
    let columns = parsed.map((c) => c.name);
    if (!columns.length && rows.length) {
      const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 0);
      columns = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    }

    return NextResponse.json({
      ok: true,
      streamName,
      columns,
      rows,
      rowCount: rows.length,
      schema: preview.schema,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isSessionGone(msg)) {
      // The held cluster expired / was reaped — the client re-acquires.
      return NextResponse.json({ ok: false, error: 'debug session expired — re-acquire', code: 'session_gone' }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
});
