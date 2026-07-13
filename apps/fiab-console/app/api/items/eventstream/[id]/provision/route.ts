/**
 * POST /api/items/eventstream/[id]/provision
 *
 * Provisions the saved canvas topology onto the Azure-native Eventstream
 * backend — **no Microsoft Fabric required** (per no-fabric-dependency.md):
 *
 *   source ─▶ [Azure Event Hub]  (the transport stream)
 *               │
 *               ▼
 *          [Stream Analytics job]  (the transform, when transforms exist)
 *               │
 *               ▼
 *          destination  (Kusto/ADX or a sink Event Hub)
 *
 * Reads the persisted `{ sources, transforms, sinks }` topology from Cosmos
 * (saved by the visual designer via PUT) and delegates to the SHARED
 * standUpEventstreamAzure() in lib/azure/eventstream-standup.ts — the SAME
 * function the install-time provisioner calls, so an operator-provisioned
 * eventstream and a bundle-installed one stand up the identical Azure backend.
 * Returns the ARM resource IDs of the Event Hub + Stream Analytics job as the
 * provisioning receipt.
 *
 * Honest gates (no vaporware): when the Event Hubs namespace env is unset the
 * route 503s with the exact missing var; when Stream Analytics env is unset but
 * the topology has transforms, the EH side still provisions and the response is
 * `partial:true` with a precise hint naming LOOM_ASA_RG. Stream Analytics is
 * not offered in DoD regions — there the EH side provisions and the response
 * discloses that the transform must run on an alternative processor.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import { EventHubsArmError } from '@/lib/azure/eventhubs-client';
import {
  standUpEventstreamAzure,
  EventstreamConfigGateError,
  type EsSourceNode,
  type EsSinkNode,
  type EsTransformNode,
} from '@/lib/azure/eventstream-standup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Resolve the topology arrays from persisted state (multi → single → none). */
function resolveTopology(state: Record<string, any> | undefined): {
  sources: EsSourceNode[]; sinks: EsSinkNode[]; transforms: EsTransformNode[];
} {
  const s = state || {};
  const sources: EsSourceNode[] = Array.isArray(s.sources) && s.sources.length
    ? s.sources
    : s.source ? [s.source] : [];
  const sinks: EsSinkNode[] = Array.isArray(s.sinks) && s.sinks.length
    ? s.sinks
    : s.sink ? [s.sink] : [];
  const transforms: EsTransformNode[] = Array.isArray(s.transforms) ? s.transforms : [];
  return { sources, sinks, transforms };
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'provision');
  if (limited) return limited;

  const { id } = await ctx.params;

  try {
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    const topology = resolveTopology(item.state);
    if (topology.sources.length === 0 || topology.sinks.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The topology needs at least one source and one destination before it can be provisioned.',
          hint: 'Add a source and a destination on the canvas, save, then provision.',
        },
        { status: 422 },
      );
    }

    // Shared Azure-native stand-up (Event Hub + optional Stream Analytics).
    const result = await standUpEventstreamAzure(item.displayName, id, topology);

    // Persist the backend refs so GET reports runtimeStatus:'live' (not draft).
    await saveItemState(item, {
      ehId: result.ehId,
      asaJobId: result.asaJobId,
      asaJobName: result.asaJobName,
      provisionedAt: result.provisionedAt,
    });

    return NextResponse.json({
      ok: true,
      ehId: result.ehId,
      asaJobId: result.asaJobId,
      steps: result.steps,
      ...(result.partial ? { partial: true } : {}),
      ...(result.hint ? { hint: result.hint } : {}),
      ...(result.kustoHint ? { hint: result.kustoHint } : {}),
    });
  } catch (e: any) {
    if (e instanceof EventstreamConfigGateError) {
      return NextResponse.json(
        {
          ok: false,
          code: 'not_configured',
          error: 'Azure Event Hubs namespace is not configured for this deployment.',
          hint: `Set ${e.missing} (and LOOM_EVENTHUB_SUB / LOOM_EVENTHUB_RG, or LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG). Deployed by platform/fiab/bicep/modules/landing-zone/eventhubs.bicep. No Microsoft Fabric required.`,
        },
        { status: 503 },
      );
    }
    if (e instanceof EventHubsArmError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'forbidden',
          error: `Event Hubs ${e.status}: cannot manage the namespace.`,
          hint: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) "Azure Event Hubs Data Owner" + Contributor on the namespace so it can create hubs, consumer groups, and read SAS keys.',
        },
        { status: e.status },
      );
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
