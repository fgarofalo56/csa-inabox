/**
 * POST /api/items/mapping-dataflow/[id]/debug/stats   — column Statistics
 *
 * The ADF-Studio Statistics view (U7 PR-2): a per-column profile for a
 * transform's output — null %, distinct count, min/max/mean/stddev (numeric
 * columns), and top value frequencies. Computed with REAL math
 * (`computeColumnStats`) over the REAL debug-session sample rows
 * (`executePreviewQuery`) — never fabricated (no-vaporware.md). The response is
 * explicitly scoped "over the N-row debug sample" so the numbers are honest
 * about their sample (ADF Studio's preview stats are likewise over the debug
 * sample).
 *
 *   body {
 *     sessionId: string,
 *     transformId: string,
 *     sampleSize?: number,          // 1..1000 (default 1000 for a fuller profile)
 *     dataFlow?: AdfDataFlow.properties
 *   }
 *   → 200 { ok, transformId, sampleSize, rowCount, stats[] }
 *
 * Honest 503 gate (svc-adf); 409 when the session expired. Route-toolkit:
 * withSession. No new env var.
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
  DATAFLOW_DEBUG_ROW_CAP,
  clampSampleSize,
  computeColumnStats,
  flowStreamNames,
  parseDfsSchema,
  resolveDebugPackage,
} from '@/lib/azure/dataflow-debug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const transformId = typeof body.transformId === 'string' ? body.transformId.trim() : '';
  // A fuller profile than the preview grid — default to the row cap.
  const sampleSize = body.sampleSize === undefined ? DATAFLOW_DEBUG_ROW_CAP : clampSampleSize(body.sampleSize);

  try {
    const pkg = await resolveDebugPackage(id, sampleSize, { liveFlow: body.dataFlow });
    const streamNames = flowStreamNames(pkg.flow);
    if (!transformId || !streamNames.includes(transformId)) {
      return NextResponse.json({ ok: false, error: 'transformId not found in the data flow' }, { status: 400 });
    }

    await addDataFlowToDebugSession({
      sessionId,
      dataFlow: pkg.flow,
      datasets: pkg.datasets,
      linkedServices: pkg.linkedServices,
      debugSettings: pkg.debugSettings,
    });

    const preview = await executeDataFlowDebugCommand({ sessionId, streamName: transformId, rowLimits: sampleSize });

    const parsed = parseDfsSchema(preview.schema);
    const rows = preview.rows;
    let columns = parsed.map((c) => c.name);
    if (!columns.length && rows.length) {
      const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)), 0);
      columns = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    }

    return NextResponse.json({
      ok: true,
      transformId,
      sampleSize,
      rowCount: rows.length,
      stats: computeColumnStats(columns, rows),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isSessionGone(msg)) {
      return NextResponse.json({ ok: false, error: 'debug session expired — re-acquire', code: 'session_gone' }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
});
