/**
 * POST /api/items/mapping-dataflow/[id]/debug/schema   — Inspect (in/out schema + drift)
 *
 * The ADF-Studio "Inspect" pane (U7 PR-2): the live in/out column metadata for a
 * transform, with schema-drift flags. Runs against an already-acquired debug
 * session (see ../session). We resolve the OUTPUT schema by previewing the
 * transform's own stream and the INPUT schema by previewing its primary upstream
 * stream (`executePreviewQuery` with a 1-row cap — cheap; we only want the DFS
 * `output(col as type, …)` schema string), parse both, and diff them so the pane
 * can badge added / removed / retyped columns.
 *
 *   body {
 *     sessionId: string,
 *     transformId: string,          // the transform whose Inspect pane this is
 *     inputId?: string,             // its PRIMARY upstream stream (omit for a Source)
 *     dataFlow?: AdfDataFlow.properties   // live authored graph (unsaved edits)
 *   }
 *   → 200 { ok, transformId, in[], out[], drift[] }
 *        in/out = { name, type }[] ; drift = { name, change, inType?, outType? }[]
 *
 * A POST (not GET) because Inspect must reflect the current, possibly-unsaved
 * graph package + the caller-computed upstream mapping — neither fits a cacheable
 * GET query string. Honest 503 gate (svc-adf); 409 when the session expired.
 * Route-toolkit: withSession. No new env var.
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
  diffSchemas,
  flowStreamNames,
  parseDfsSchema,
  resolveDebugPackage,
  type DfsColumn,
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
    inputId?: unknown;
    dataFlow?: AdfDataFlow['properties'];
  };
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return NextResponse.json({ ok: false, error: 'sessionId required — acquire a debug session first' }, { status: 400 });
  }
  const transformId = typeof body.transformId === 'string' ? body.transformId.trim() : '';
  const inputId = typeof body.inputId === 'string' ? body.inputId.trim() : '';

  try {
    const pkg = await resolveDebugPackage(id, 1, { liveFlow: body.dataFlow });
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

    // OUTPUT schema — the transform's own stream (1-row preview → schema string).
    const outPreview = await executeDataFlowDebugCommand({ sessionId, streamName: transformId, rowLimits: 1 });
    const out: DfsColumn[] = parseDfsSchema(outPreview.schema);

    // INPUT schema — the primary upstream stream, when the caller supplied one
    // (a Source has no input → empty in-schema, everything reads as "added").
    let inCols: DfsColumn[] = [];
    if (inputId && streamNames.includes(inputId) && inputId !== transformId) {
      const inPreview = await executeDataFlowDebugCommand({ sessionId, streamName: inputId, rowLimits: 1 });
      inCols = parseDfsSchema(inPreview.schema);
    }

    return NextResponse.json({
      ok: true,
      transformId,
      inputId: inputId || undefined,
      in: inCols,
      out,
      drift: diffSchemas(inCols, out),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isSessionGone(msg)) {
      return NextResponse.json({ ok: false, error: 'debug session expired — re-acquire', code: 'session_gone' }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
});
