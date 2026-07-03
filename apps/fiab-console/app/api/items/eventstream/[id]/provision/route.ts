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
 * (saved by the visual designer via PUT), maps it onto real ARM resources, and
 * returns the ARM resource IDs of the Event Hub + Stream Analytics job as the
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
import { clusterUri, defaultDatabase } from '@/lib/azure/kusto-client';
import {
  eventhubsConfigGate,
  readEventHubsConfig,
  createEventHub,
  listEventHubs,
  createConsumerGroup,
  listConsumerGroups,
  listNamespaceKeys,
  EventHubsArmError,
} from '@/lib/azure/eventhubs-client';
import {
  readAsaConfig,
  AsaNotConfiguredError,
  createOrUpdateJob,
  createOrUpdateInput,
  createOrUpdateOutput,
  saveTransformation,
} from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Topology shapes (mirror lib/components/eventstream/visual-designer.tsx) ──
interface SourceNode { kind?: string; name?: string; namespace?: string; consumerGroup?: string; }
interface SinkNode {
  kind?: string; name?: string; database?: string; table?: string;
  kustoCluster?: string;
}
interface TransformNode {
  kind?: string; name?: string; expression?: string;
  columns?: string[]; groupBy?: string[]; window?: string;
}

/** Event Hub entity names: alnum, -, ., _ ; ≤ 250. Keep it portable. */
function safeHubName(s: string): string {
  const cleaned = (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
  return cleaned || 'loom-eventstream';
}
function safeCgName(s: string, i: number): string {
  const c = (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return c || `dest${i}`;
}

/** Resolve the topology arrays from persisted state (multi → single → none). */
function resolveTopology(state: Record<string, any> | undefined): {
  sources: SourceNode[]; sinks: SinkNode[]; transforms: TransformNode[];
} {
  const s = state || {};
  const sources: SourceNode[] = Array.isArray(s.sources) && s.sources.length
    ? s.sources
    : s.source ? [s.source] : [];
  const sinks: SinkNode[] = Array.isArray(s.sinks) && s.sinks.length
    ? s.sinks
    : s.sink ? [s.sink] : [];
  const transforms: TransformNode[] = Array.isArray(s.transforms) ? s.transforms : [];
  return { sources, sinks, transforms };
}

/**
 * Build a SAQL query from the canvas transform nodes. Filters become a WHERE
 * clause; a single aggregate/group-by node becomes a windowed GROUP BY with a
 * COUNT. Default windowing is a 30-second tumbling window — operators refine
 * the query in the Stream Analytics editor.
 */
function buildSaql(transforms: TransformNode[], inputAlias: string, outputAlias: string): string {
  const filters = transforms.filter((t) => (t.kind === 'filter') && !!t.expression);
  const groups = transforms.filter((t) => t.kind === 'aggregate' || t.kind === 'group-by');

  if (groups.length > 0) {
    const g = groups[0];
    const cols = Array.isArray(g.groupBy) && g.groupBy.length ? g.groupBy.join(', ') : null;
    const win = g.window || 'TumblingWindow(second, 30)';
    const groupCols = cols ? `${cols}, ${win}` : win;
    const selectCols = cols ? `${cols}, ` : '';
    let q = `SELECT ${selectCols}System.Timestamp() AS windowEnd, COUNT(*) AS eventCount\nINTO [${outputAlias}]\nFROM [${inputAlias}] TIMESTAMP BY EventEnqueuedUtcTime`;
    if (filters.length > 0) {
      q += `\nWHERE ${filters.map((f) => `(${f.expression})`).join('\n  AND ')}`;
    }
    q += `\nGROUP BY ${groupCols}`;
    return q;
  }

  let q = `SELECT *\nINTO [${outputAlias}]\nFROM [${inputAlias}] TIMESTAMP BY EventEnqueuedUtcTime`;
  if (filters.length > 0) {
    q += `\nWHERE ${filters.map((f) => `(${f.expression})`).join('\n  AND ')}`;
  }
  return q;
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const limited = await enforceRateLimit(session, 'provision');
  if (limited) return limited;

  const { id } = await ctx.params;
  const steps: string[] = [];

  try {
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    const { sources, sinks, transforms } = resolveTopology(item.state);
    if (sources.length === 0 || sinks.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: 'The topology needs at least one source and one destination before it can be provisioned.',
          hint: 'Add a source and a destination on the canvas, save, then provision.',
        },
        { status: 422 },
      );
    }

    // ── Event Hubs gate (Azure infra, not Fabric) ──────────────────────────
    const ehGate = eventhubsConfigGate();
    if (ehGate) {
      return NextResponse.json(
        {
          ok: false,
          code: 'not_configured',
          error: 'Azure Event Hubs namespace is not configured for this deployment.',
          hint: `Set ${ehGate.missing} (and LOOM_EVENTHUB_SUB / LOOM_EVENTHUB_RG, or LOOM_SUBSCRIPTION_ID / LOOM_DLZ_RG). Deployed by platform/fiab/bicep/modules/landing-zone/eventhubs.bicep. No Microsoft Fabric required.`,
        },
        { status: 503 },
      );
    }

    const ehCfg = readEventHubsConfig();
    const ehResId = (hub: string) =>
      `/subscriptions/${ehCfg.subscriptionId}/resourceGroups/${ehCfg.resourceGroup}/providers/Microsoft.EventHub/namespaces/${ehCfg.namespace}/eventhubs/${hub}`;

    // ── Transport hub (the stream) ─────────────────────────────────────────
    const transportHub = safeHubName(item.displayName);
    let existingHubs = new Set<string>();
    try {
      const hubs = await listEventHubs();
      existingHubs = new Set(hubs.map((h) => (h.name || '').toLowerCase()));
    } catch { /* RBAC/list miss — create will surface a real error */ }

    if (!existingHubs.has(transportHub.toLowerCase())) {
      await createEventHub({ name: transportHub, partitionCount: 4, messageRetentionInDays: 1 });
      steps.push(`Created Event Hub '${transportHub}' (4 partitions, 1-day retention).`);
    } else {
      steps.push(`Event Hub '${transportHub}' already exists; reusing.`);
    }

    // One consumer group per destination (each downstream reads independently).
    let existingCgs = new Set<string>();
    try {
      const cgs = await listConsumerGroups(transportHub);
      existingCgs = new Set(cgs.map((c) => (c.name || '').toLowerCase()));
    } catch { /* fine */ }
    for (let i = 0; i < sinks.length; i++) {
      const cg = safeCgName(sinks[i]?.name || '', i);
      if (cg === '$default' || existingCgs.has(cg.toLowerCase())) continue;
      try {
        await createConsumerGroup(transportHub, cg, `Loom eventstream destination ${sinks[i]?.name || i}`);
        existingCgs.add(cg.toLowerCase());
        steps.push(`Created consumer group '${cg}'.`);
      } catch (e: any) {
        steps.push(`Could not create consumer group '${cg}': ${e?.message || e}`);
      }
    }

    const ehId = ehResId(transportHub);

    // ── Transforms? If none, we're done — EH-only stream. ──────────────────
    if (transforms.length === 0) {
      await saveItemState(item, { ehId, asaJobId: null, provisionedAt: new Date().toISOString() });
      steps.push('No transforms in the topology — Stream Analytics job skipped.');
      return NextResponse.json({ ok: true, ehId, asaJobId: null, steps });
    }

    // ── Stream Analytics not available in DoD regions ──────────────────────
    const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
    if (cloud === 'azuredod') {
      await saveItemState(item, { ehId, asaJobId: null, provisionedAt: new Date().toISOString() });
      return NextResponse.json({
        ok: true,
        partial: true,
        ehId,
        asaJobId: null,
        steps,
        hint: 'Azure Stream Analytics is not available in DoD (IL5) regions. The Event Hub transport stream + consumer groups are provisioned; run the transform on an alternative Kafka-compatible processor (e.g. AKS + Kafka Streams).',
      });
    }

    // ── Stream Analytics gate (Azure infra, not Fabric) ────────────────────
    let asaCfgOk = true;
    try { readAsaConfig(); } catch (e) {
      if (e instanceof AsaNotConfiguredError) asaCfgOk = false; else throw e;
    }
    if (!asaCfgOk) {
      await saveItemState(item, { ehId, asaJobId: null, provisionedAt: new Date().toISOString() });
      return NextResponse.json({
        ok: true,
        partial: true,
        ehId,
        asaJobId: null,
        steps,
        hint: 'Stream Analytics is not configured (set LOOM_ASA_RG and LOOM_ASA_SUB, or LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID). Deployed by platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep (enableStreamAnalytics=true). The Event Hub transport stream is live.',
      });
    }

    // ── Provision the ASA job from the canvas topology ─────────────────────
    const jobName = `asa-loom-${id.slice(0, 8).toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
    const location = process.env.LOOM_ASA_LOCATION || process.env.LOOM_LOCATION || 'eastus';
    const job = await createOrUpdateJob({ name: jobName, location });
    steps.push(`Created Stream Analytics job '${jobName}' (${location}).`);

    // ASA needs a dedicated consumer group on the transport hub to read from.
    const asaInputCg = 'asa-input';
    if (!existingCgs.has(asaInputCg)) {
      try {
        await createConsumerGroup(transportHub, asaInputCg, `Stream Analytics input for ${jobName}`);
        steps.push(`Created consumer group '${asaInputCg}' for the ASA input.`);
      } catch { /* may already exist */ }
    }

    // SAS key for the namespace (Console UAMI Contributor grant on the ns).
    const keys = await listNamespaceKeys();

    // Input: the transport Event Hub.
    await createOrUpdateInput(jobName, {
      name: 'input-eh',
      inputType: 'Stream',
      datasourceType: 'Microsoft.EventHub/EventHub',
      eventHubName: transportHub,
      serviceBusNamespace: ehCfg.namespace,
      sharedAccessPolicyName: keys.keyName,
      sharedAccessPolicyKey: keys.primaryKey,
      consumerGroupName: asaInputCg,
      serialization: 'Json',
    });
    steps.push(`Wired ASA input 'input-eh' ← Event Hub '${transportHub}'.`);

    // Output: Kusto/ADX when the destination is a kusto sink, else a sink EH.
    const sink = sinks[0];
    const sinkKind = (sink?.kind || '').toLowerCase();
    let kustoHint: string | undefined;
    if (sinkKind === 'kusto' || sinkKind === 'eventhouse' || sinkKind === 'adx') {
      const db = (sink?.database && sink.database.trim()) || defaultDatabase();
      const table = (sink?.table && sink.table.trim()) || 'EventstreamOutput';
      await createOrUpdateOutput(jobName, {
        name: 'output-kusto',
        datasourceType: 'Microsoft.Kusto/clusters/databases',
        kustoClusterUrl: sink?.kustoCluster || clusterUri(),
        kustoDatabase: db,
        kustoTable: table,
      });
      steps.push(`Wired ASA output 'output-kusto' → ADX ${db}/${table}.`);
      kustoHint = `Grant the ASA job '${jobName}' managed identity 'Database Ingestor' (or 'Database Admin') on ADX database '${db}' so it can write the transformed stream.`;
      await saveTransformation(jobName, buildSaql(transforms, 'input-eh', 'output-kusto'));
    } else {
      // Sink Event Hub entity (idempotent), then ASA EH output.
      const sinkHub = safeHubName(`${transportHub}-out`);
      if (!existingHubs.has(sinkHub.toLowerCase())) {
        try {
          await createEventHub({ name: sinkHub, partitionCount: 2, messageRetentionInDays: 1 });
          steps.push(`Created sink Event Hub '${sinkHub}'.`);
        } catch (e: any) { steps.push(`Could not create sink hub '${sinkHub}': ${e?.message || e}`); }
      }
      await createOrUpdateOutput(jobName, {
        name: 'output-eh',
        datasourceType: 'Microsoft.EventHub/EventHub',
        eventHubName: sinkHub,
        namespace: ehCfg.namespace,
        sharedAccessPolicyName: keys.keyName,
        sharedAccessPolicyKey: keys.primaryKey,
        serialization: 'Json',
      });
      steps.push(`Wired ASA output 'output-eh' → Event Hub '${sinkHub}'.`);
      await saveTransformation(jobName, buildSaql(transforms, 'input-eh', 'output-eh'));
    }
    steps.push('Saved the SAQL transformation. Start the job from the Stream Analytics editor.');

    const asaJobId = job.id ||
      `/subscriptions/${readAsaConfig().subscriptionId}/resourceGroups/${readAsaConfig().resourceGroup}/providers/Microsoft.StreamAnalytics/streamingjobs/${jobName}`;

    await saveItemState(item, {
      ehId,
      asaJobId,
      asaJobName: jobName,
      provisionedAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, ehId, asaJobId, steps, ...(kustoHint ? { hint: kustoHint } : {}) });
  } catch (e: any) {
    if (e instanceof EventHubsArmError && (e.status === 401 || e.status === 403)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'forbidden',
          error: `Event Hubs ${e.status}: cannot manage the namespace.`,
          hint: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) "Azure Event Hubs Data Owner" + Contributor on the namespace so it can create hubs, consumer groups, and read SAS keys.',
          steps,
        },
        { status: e.status },
      );
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), steps }, { status });
  }
}
