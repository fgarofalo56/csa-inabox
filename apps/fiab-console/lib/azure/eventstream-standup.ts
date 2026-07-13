/**
 * Shared Azure-native Eventstream stand-up — the SINGLE code path that turns a
 * saved/streaming topology into REAL Azure resources, per
 * .claude/rules/no-fabric-dependency.md (Azure Event Hubs + Stream Analytics,
 * NO Microsoft Fabric required).
 *
 *   source ─▶ [Azure Event Hub]  (the transport stream)
 *               │
 *               ▼  (when transforms exist and ASA is configured)
 *          [Stream Analytics job]  (the transform)
 *               │
 *               ▼
 *          destination  (ADX/Eventhouse or a sink Event Hub)
 *
 * Extracted from app/api/items/eventstream/[id]/provision/route.ts so BOTH the
 * editor's "Provision to Azure" button (that route) AND the install-time
 * provisioner (lib/install/provisioners/eventstream.ts) call the EXACT same
 * logic — a bundle-installed eventstream stands up its live backend identically
 * to one an operator provisions by hand (no duplication, no draft-only install).
 *
 * Gates are honest Azure infra-gates (never Fabric):
 *   - Event Hubs namespace unset → throws EventstreamConfigGateError(missing).
 *   - Stream Analytics unset / DoD region → the Event Hub stream still stands up
 *     and the result is `partial:true` with a precise hint (EH side is live).
 *   - EH 401/403 → EventHubsArmError propagates for the caller to map.
 */
import {
  eventhubsConfigGate,
  readEventHubsConfig,
  createEventHub,
  listEventHubs,
  createConsumerGroup,
  listConsumerGroups,
  listNamespaceKeys,
} from './eventhubs-client';
import {
  readAsaConfig,
  AsaNotConfiguredError,
  createOrUpdateJob,
  createOrUpdateInput,
  createOrUpdateOutput,
  saveTransformation,
} from './stream-analytics-client';
import { clusterUri, defaultDatabase } from './kusto-client';

// ── Topology shapes (mirror the visual designer + bundle EventstreamContent) ──
export interface EsSourceNode { kind?: string; name?: string; namespace?: string; consumerGroup?: string; }
export interface EsSinkNode {
  kind?: string; name?: string; database?: string; table?: string; kustoCluster?: string;
}
export interface EsTransformNode {
  kind?: string; name?: string; expression?: string;
  columns?: string[]; groupBy?: string[]; window?: string;
}
export interface EsTopology {
  sources: EsSourceNode[];
  sinks: EsSinkNode[];
  transforms: EsTransformNode[];
}

/** Thrown when the Event Hubs namespace env isn't configured (Azure infra-gate,
 *  NOT a Fabric gate). Callers map to a 503 (route) / remediation (install). */
export class EventstreamConfigGateError extends Error {
  missing: string;
  constructor(missing: string) {
    super('Azure Event Hubs namespace is not configured for this deployment.');
    this.name = 'EventstreamConfigGateError';
    this.missing = missing;
  }
}

export interface EsStandUpResult {
  /** ARM resource id of the transport Event Hub (the stream). */
  ehId: string;
  /** Transport Event Hub entity name. */
  transportHub: string;
  /** ARM resource id of the Stream Analytics job (when transforms were wired). */
  asaJobId: string | null;
  /** Stream Analytics job name (when transforms were wired). */
  asaJobName: string | null;
  /** ISO timestamp the stand-up completed. */
  provisionedAt: string;
  /** True when the transform side could not be fully wired (ASA unset / DoD). */
  partial: boolean;
  /** Precise hint when partial (names the exact Azure prerequisite). */
  hint?: string;
  /** ADX grant hint when the sink is a Kusto/Eventhouse destination. */
  kustoHint?: string;
  /** Human-readable step log. */
  steps: string[];
}

/** Event Hub entity names: alnum, -, ., _ ; ≤ 250. Keep it portable. */
export function safeHubName(s: string): string {
  const cleaned = (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
  return cleaned || 'loom-eventstream';
}
export function safeCgName(s: string, i: number): string {
  const c = (s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return c || `dest${i}`;
}

/**
 * Build a SAQL query from the canvas transform nodes. Filters become a WHERE
 * clause; a single aggregate/group-by node becomes a windowed GROUP BY with a
 * COUNT. Default windowing is a 30-second tumbling window — operators refine
 * the query in the Stream Analytics editor.
 */
export function buildSaql(transforms: EsTransformNode[], inputAlias: string, outputAlias: string): string {
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

// ── Bundle EventstreamContent → designer topology ───────────────────────────
// App-install stamps a rich `EventstreamContent` ({ sources, destinations,
// transforms } of { id, type, config }) onto state.content. The stand-up path
// reads the designer shape ({ sources, sinks, transforms } of { kind, name }).
// Map bundle node types onto the recognized kinds so a bundle-installed
// Eventstream stands up its FULL topology (this mirrors configFromContent in
// the [id] route's GET so the editor and the install path agree on the mapping).
function mapSourceKind(t: string): string {
  const k = (t || '').toLowerCase();
  if (k.includes('iot')) return 'iothub';
  if (k.includes('kafka')) return 'kafka';
  if (k.includes('sample')) return 'sample';
  if (k.includes('cdc') || k.includes('mirror')) return 'cdc-mirror';
  if (k.includes('custom')) return 'custom-app';
  return 'eventhub';
}
function mapSinkKind(t: string): string {
  const k = (t || '').toLowerCase();
  if (k.includes('kql') || k.includes('kusto') || k.includes('eventhouse') || k.includes('adx')) return 'kusto';
  if (k.includes('lakehouse')) return 'lakehouse';
  if (k.includes('reflex') || k.includes('activator')) return 'reflex';
  if (k.includes('derived') || k.includes('stream')) return 'derivedStream';
  return 'eventhub';
}
function mapTransformKind(t: string): string {
  const k = (t || '').toLowerCase();
  if (k.includes('filter')) return 'filter';
  if (k.includes('aggregate')) return 'aggregate';
  if (k.includes('group')) return 'group-by';
  if (k.includes('project') || k.includes('enrich')) return 'project';
  if (k.includes('union')) return 'union';
  if (k.includes('join')) return 'join';
  return 'filter';
}

/** Normalize a bundle EventstreamContent (or an already-designer topology) into
 *  the EsTopology the stand-up path consumes. */
export function bundleContentToTopology(content: any): EsTopology {
  const sources: EsSourceNode[] = Array.isArray(content?.sources)
    ? content.sources.map((n: any) => ({
        kind: mapSourceKind(n?.type ?? n?.kind),
        name: String(n?.id || n?.name || n?.type || 'source'),
        ...(n?.config && typeof n.config === 'object' ? n.config : {}),
      }))
    : [];
  const sinks: EsSinkNode[] = Array.isArray(content?.destinations)
    ? content.destinations.map((n: any) => ({
        kind: mapSinkKind(n?.type ?? n?.kind),
        name: String(n?.id || n?.name || n?.type || 'destination'),
        ...(n?.config && typeof n.config === 'object' ? n.config : {}),
      }))
    : Array.isArray(content?.sinks)
      ? content.sinks
      : [];
  const transforms: EsTransformNode[] = Array.isArray(content?.transforms)
    ? content.transforms.map((n: any) => ({
        kind: mapTransformKind(n?.type ?? n?.kind),
        name: String(n?.id || n?.name || n?.type || 'transform'),
        ...(n?.config && typeof n.config === 'object' ? n.config : {}),
      }))
    : [];
  return { sources, sinks, transforms };
}

/**
 * Stand up the Azure-native Eventstream backend for `topology`.
 *
 * Idempotent: reuses an existing transport hub / consumer groups / ASA job.
 * Throws EventstreamConfigGateError (EH namespace unset) and EventHubsArmError
 * (401/403) for the caller to map; returns `partial:true` when only the ASA
 * transform side is un-provisionable (EH stream is always stood up first).
 *
 * @param displayName item display name (→ transport hub name)
 * @param id          Cosmos item id (→ deterministic ASA job name)
 * @param topology    normalized { sources, sinks, transforms }
 * @param steps       running step log (appended to; also returned)
 */
export async function standUpEventstreamAzure(
  displayName: string,
  id: string,
  topology: EsTopology,
  steps: string[] = [],
): Promise<EsStandUpResult> {
  // ── Event Hubs gate (Azure infra, not Fabric) ──────────────────────────
  const ehGate = eventhubsConfigGate();
  if (ehGate) throw new EventstreamConfigGateError(ehGate.missing);

  const { sinks, transforms } = topology;
  const ehCfg = readEventHubsConfig();
  const ehResId = (hub: string) =>
    `/subscriptions/${ehCfg.subscriptionId}/resourceGroups/${ehCfg.resourceGroup}/providers/Microsoft.EventHub/namespaces/${ehCfg.namespace}/eventhubs/${hub}`;

  // ── Transport hub (the stream) ─────────────────────────────────────────
  const transportHub = safeHubName(displayName);
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
  const provisionedAt = new Date().toISOString();

  // ── Transforms? If none, we're done — EH-only stream. ──────────────────
  if (transforms.length === 0) {
    steps.push('No transforms in the topology — Stream Analytics job skipped.');
    return { ehId, transportHub, asaJobId: null, asaJobName: null, provisionedAt, partial: false, steps };
  }

  // ── Stream Analytics not available in DoD regions ──────────────────────
  const cloud = (process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase();
  if (cloud === 'azuredod') {
    return {
      ehId, transportHub, asaJobId: null, asaJobName: null, provisionedAt, partial: true,
      hint: 'Azure Stream Analytics is not available in DoD (IL5) regions. The Event Hub transport stream + consumer groups are provisioned; run the transform on an alternative Kafka-compatible processor (e.g. AKS + Kafka Streams).',
      steps,
    };
  }

  // ── Stream Analytics gate (Azure infra, not Fabric) ────────────────────
  let asaCfgOk = true;
  try { readAsaConfig(); } catch (e) {
    if (e instanceof AsaNotConfiguredError) asaCfgOk = false; else throw e;
  }
  if (!asaCfgOk) {
    return {
      ehId, transportHub, asaJobId: null, asaJobName: null, provisionedAt, partial: true,
      hint: 'Stream Analytics is not configured (set LOOM_ASA_RG and LOOM_ASA_SUB, or LOOM_DLZ_RG / LOOM_SUBSCRIPTION_ID). Deployed by platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep (enableStreamAnalytics=true). The Event Hub transport stream is live.',
      steps,
    };
  }

  // ── Provision the ASA job from the topology ────────────────────────────
  const jobName = `asa-loom-${(id || '').slice(0, 8).toLowerCase().replace(/[^a-z0-9-]/g, '')}` || 'asa-loom';
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

  const asaCfg = readAsaConfig();
  const asaJobId = job.id ||
    `/subscriptions/${asaCfg.subscriptionId}/resourceGroups/${asaCfg.resourceGroup}/providers/Microsoft.StreamAnalytics/streamingjobs/${jobName}`;

  return {
    ehId, transportHub, asaJobId, asaJobName: jobName, provisionedAt,
    partial: false, ...(kustoHint ? { kustoHint } : {}), steps,
  };
}
