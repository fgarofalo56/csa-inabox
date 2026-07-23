/**
 * POST /api/items/mapping-dataflow/[id]/debug/session   — Debug-session lifecycle
 *
 * The ADF-Studio-parity Debug toggle (U7). Toggling Debug ON in the designer
 * ACQUIRES a real Azure Data Factory data-flow debug session (a short-lived
 * Spark cluster on the deployment-default factory's Managed IR) that is HELD for
 * the whole authoring loop, so subsequent per-transform previews / stats / schema
 * reads run cheaply against the SAME warm session instead of re-provisioning a
 * cluster each time. Toggling Debug OFF (or leaving the editor) RELEASES it.
 *
 *   body { action: 'acquire' }
 *     → 200 { ok, sessionId, ttlMinutes, expiresAt, integrationRuntime? }
 *       Provisions the cluster (createDataFlowDebugSession). Defaults mirror ADF
 *       Studio: General compute, 8 cores, 60-min TTL (overridable via
 *       computeType / coreCount / timeToLiveMinutes).
 *   body { action: 'release', sessionId }
 *     → 200 { ok, released:true }   (idempotent — a gone session is success)
 *
 * Honest 503 gate (svc-adf) naming LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG /
 * LOOM_ADF_NAME when the factory isn't configured — the designer still renders
 * and authoring still writes the real ADF definition (no-vaporware.md). The
 * debug session is Azure-native (Microsoft.DataFactory) — no Fabric
 * (no-fabric-dependency.md).
 *
 * Route-toolkit: withSession (R1/R3). No new env var — the debug session lives
 * under the same env-pinned factory as every other ADF op.
 *
 * Refs (MS Learn + @azure/arm-datafactory DataFlowDebugSessions):
 *   https://learn.microsoft.com/rest/api/datafactory/data-flow-debug-session/create
 *   https://learn.microsoft.com/rest/api/datafactory/data-flow-debug-session/delete
 */

import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiHonestGateError } from '@/lib/api/gate-envelope';
import {
  dataFlowDebugConfigGate,
  createDataFlowDebugSession,
  deleteDataFlowDebugSession,
  listIntegrationRuntimes,
} from '@/lib/azure/adf-client';
import { DATAFLOW_NAME_RE } from '@/lib/azure/dataflow-debug';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_TTL_MIN = 60;

export const POST = withSession<{ id: string }>(async (req, { params }) => {
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

  const { id } = params;
  if (!id || !DATAFLOW_NAME_RE.test(id)) {
    return NextResponse.json({ ok: false, error: 'invalid data flow name' }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    sessionId?: unknown;
    computeType?: unknown;
    coreCount?: unknown;
    timeToLiveMinutes?: unknown;
  };
  const action = typeof body.action === 'string' ? body.action : 'acquire';

  // ── release ──────────────────────────────────────────────────────────────
  if (action === 'release') {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (!sessionId) {
      return NextResponse.json({ ok: false, error: 'sessionId required to release' }, { status: 400 });
    }
    // Idempotent / best-effort — a gone cluster is a successful release.
    await deleteDataFlowDebugSession(sessionId).catch(() => {});
    return NextResponse.json({ ok: true, released: true });
  }

  // ── acquire ──────────────────────────────────────────────────────────────
  if (action !== 'acquire') {
    return NextResponse.json({ ok: false, error: `unknown action '${action}'` }, { status: 400 });
  }

  const computeType = typeof body.computeType === 'string' ? body.computeType : undefined;
  const coreRaw = Number(body.coreCount);
  const coreCount = Number.isFinite(coreRaw) && coreRaw > 0 ? Math.floor(coreRaw) : undefined;
  const ttlRaw = Number(body.timeToLiveMinutes);
  const ttlMinutes = Number.isFinite(ttlRaw) && ttlRaw > 0 ? Math.floor(ttlRaw) : DEFAULT_TTL_MIN;

  try {
    const { sessionId } = await createDataFlowDebugSession({
      ...(computeType ? { computeType } : {}),
      ...(coreCount !== undefined ? { coreCount } : {}),
      timeToLiveMinutes: ttlMinutes,
    });

    // Advisory only — surface a Managed (Azure) IR name if one is listed. A list
    // hiccup must never fail the acquire (AutoResolveIntegrationRuntime always
    // exists for data-flow debug).
    let integrationRuntime: string | undefined;
    try {
      const irs = await listIntegrationRuntimes();
      integrationRuntime = irs.find((ir) => ir.properties?.type === 'Managed')?.name;
    } catch {
      /* advisory only */
    }

    return NextResponse.json({
      ok: true,
      sessionId,
      ttlMinutes,
      expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
      ...(integrationRuntime ? { integrationRuntime } : {}),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
});
