/**
 * POST /api/items/eventstream/[id]/source
 *
 * Provisions / resolves a REAL ingest endpoint for one Eventstream source node
 * and persists the result onto the saved topology (state.sources[nodeIdx]).
 * Every source kind yields a concrete Azure-backed endpoint — no Fabric
 * dependency (per no-fabric-dependency.md) and no mocks (per no-vaporware.md):
 *
 *   eventhub    → resolve the namespace's data-plane FQDN + entity path
 *                 (existing Event Hub, Entra auth). No ARM mutation.
 *   iothub      → resolve the IoT Hub's BUILT-IN Event Hubs-compatible endpoint
 *                 via Microsoft.Devices ARM (iothub-client).
 *   kafka       → the Event Hubs Kafka endpoint (<ns>:9093, OAUTHBEARER). Topic
 *                 = the event hub entity name.
 *   cdc-mirror  → ADF Copy pipeline (source DB linked service → EH sink linked
 *                 service) created + started via adf-client. The EH hub is the
 *                 ingest endpoint downstream operators read.
 *   custom-app  → create a dedicated Event Hub (createEventHub) + a Send SAS
 *                 rule; return the ingest endpoint (connection string only when
 *                 the namespace permits local auth — otherwise Entra/HTTPS REST).
 *
 * Body: { nodeIdx: number, kind: SourceKind, config: { ...SourceNode } }
 * 200  { ok: true, endpoint: {...}, hint?, adf? }
 * 503  { ok: false, code: 'not_configured', missing, hint } — honest infra gate
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import {
  eventhubsConfigGate,
  readEventHubsConfig,
  createEventHub,
  createEventHubAuthRule,
  listEventHubKeys,
  EventHubsArmError,
} from '@/lib/azure/eventhubs-client';
import { readEventHubsDataConfig } from '@/lib/azure/eventhubs-data-client';
import { getIoTHubEhEndpoint, iotHubConfigGate, IoTHubArmError } from '@/lib/azure/iothub-client';
import {
  adfConfigGate,
  upsertLinkedService,
  upsertPipeline,
  runPipeline,
  type AdfLinkedService,
  type AdfPipeline,
} from '@/lib/azure/adf-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type SourceKind = 'eventhub' | 'iothub' | 'sample' | 'cdc-mirror' | 'kafka' | 'custom-app';

interface ProvisionedEndpoint {
  fqdn?: string;
  entityPath?: string;
  kafkaBootstrap?: string;
  auth?: 'entra' | 'sas';
  connectionString?: string | null;
  localAuthDisabled?: boolean;
  saslConfig?: string;
}

interface SourceConfig {
  kind?: SourceKind;
  name?: string;
  namespace?: string;
  consumerGroup?: string;
  eventHubName?: string;
  topic?: string;
  iotHub?: string;
  iotHubSubscriptionId?: string;
  iotHubResourceGroup?: string;
  cdcDatabaseType?: 'sqlserver' | 'postgresql' | 'mysql' | 'cosmosdb';
  cdcServerHost?: string;
  cdcDatabase?: string;
  cdcTable?: string;
  cdcUsername?: string;
  [k: string]: unknown;
}

function gate(missing: string, hint: string) {
  return NextResponse.json({ ok: false, code: 'not_configured', missing, hint }, { status: 503 });
}

/**
 * Read the saved source node at `nodeIdx` from a persisted eventstream state.
 * Mirrors the resolution used by the events/peek route: `state.sources[idx]`
 * (canvas topology) falling back to the singular `state.source` (a freshly
 * subscribed single-source stream created by /api/realtime-hub/connect-source).
 */
function readSavedSourceNode(state: any, nodeIdx: number): { name?: string; type?: string; properties?: Record<string, unknown> } | null {
  const sources: any[] = Array.isArray(state?.sources)
    ? state.sources
    : (state?.source ? [state.source] : []);
  const node = (nodeIdx >= 0 ? sources[nodeIdx] : sources[0]);
  return node && typeof node === 'object' ? node : null;
}

/**
 * Map a saved Eventstream source node (its Fabric source `type` enum +
 * connection `properties`) to the source-route `{ kind, config }` that
 * provisions / resolves its REAL Azure ingest endpoint — no extra operator
 * input required. Used by the in-place "Provision ingest endpoint" affordance
 * (the catalog → Subscribe → Test loop) so a newly-subscribed stream can be
 * made testable without re-opening the canvas.
 *
 * Source types whose ingest endpoint genuinely needs more config than a
 * subscribe pre-fill carries (CDC needs DB host/database/table; Blob Storage
 * events flow through an Event Grid system topic bound in the editor) return an
 * honest `{ gate }` message instead of a half-provisioned endpoint
 * (no-vaporware.md). Every branch stays Azure-native (no-fabric-dependency.md).
 */
function deriveProvisionFromSaved(
  node: { name?: string; type?: string; properties?: Record<string, unknown> },
): { kind: SourceKind; config: SourceConfig } | { gate: string } {
  const type = String(node?.type || '').trim();
  const props = (node?.properties && typeof node.properties === 'object') ? node.properties : {};
  const name = String(node?.name || '').trim();
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? undefined : String(v));
  switch (type) {
    case 'AzureEventHub':
      return { kind: 'eventhub', config: {
        name, eventHubName: s(props.eventHubName) || name,
        namespace: s(props.namespace), consumerGroup: s(props.consumerGroupName),
      } };
    case 'AzureIoTHub':
      return { kind: 'iothub', config: {
        name, iotHub: s(props.iotHubName) || name,
        iotHubSubscriptionId: s(props.subscriptionId), iotHubResourceGroup: s(props.resourceGroup),
      } };
    case 'CustomEndpoint':
      // A dedicated ingest Event Hub (custom-app). Covers Loom-item chaining
      // and Event Grid custom-topic ingest (eventHubName pre-filled by the
      // RTI hub catalog).
      return { kind: 'custom-app', config: {
        name, eventHubName: s(props.eventHubName) || safeName(name, '') || `custom-${name}`,
      } };
    case 'SampleData':
      return { kind: 'sample', config: { name } };
    case 'AzureSQLDBCDC':
    case 'AzureSQLMIDBCDC':
    case 'PostgreSQLCDC':
    case 'MySQLCDC':
    case 'AzureCosmosDBCDC':
      return { gate: 'This change-data-capture source needs its database connection (server host, database, table) set in the eventstream editor before an ingest endpoint can be provisioned.' };
    case 'AzureBlobStorageEvents':
      return { gate: 'Blob Storage events flow through an Event Grid system topic bound in the eventstream editor — there is no standalone ingest endpoint to provision here. Open the editor to connect the storage account.' };
    default:
      return { gate: `Source type "${type || 'unknown'}" must be configured in the eventstream editor before it can receive test events.` };
  }
}

/** Lowercase, hyphenated, hub-name-safe slug (Event Hub entity names: a-z0-9-._). */
function safeName(raw: string, fallback: string): string {
  const s = (raw || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** Bare namespace FQDN host (no scheme). */
function nsFqdn(): string {
  return readEventHubsDataConfig().fullyQualifiedNamespace;
}

/** Token endpoint host for the Kafka OAUTHBEARER SASL config, by cloud. */
function oauthLoginHost(): string {
  switch ((process.env.AZURE_CLOUD || 'AzureCloud').toLowerCase()) {
    case 'azureusgovernment':
    case 'azuredod':
      return 'login.microsoftonline.us';
    default:
      return 'login.microsoftonline.com';
  }
}

/** CDC source-DB linked-service shape, by database type. */
function cdcSourceLinkedService(name: string, cfg: SourceConfig): AdfLinkedService {
  const host = cfg.cdcServerHost || '';
  const db = cfg.cdcDatabase || '';
  const user = cfg.cdcUsername || '';
  // On-prem / VM-hosted SQL Server routes through the Loom self-hosted IR;
  // Azure-native PaaS databases use the auto-resolve managed IR.
  const domainName = process.env.LOOM_DOMAIN_NAME || process.env.LOOM_DLZ_RG || '';
  const shir = `shir-loom-${domainName}`;
  switch (cfg.cdcDatabaseType) {
    case 'postgresql':
      return { name, properties: { type: 'PostgreSql', typeProperties: {
        connectionString: `Host=${host};Port=5432;Database=${db};Username=${user};SslMode=Require`,
      } } };
    case 'mysql':
      return { name, properties: { type: 'MySql', typeProperties: {
        connectionString: `Server=${host};Port=3306;Database=${db};UserName=${user};SslMode=Required`,
      } } };
    case 'cosmosdb':
      return { name, properties: { type: 'CosmosDb', typeProperties: {
        accountEndpoint: host, database: db,
      } } };
    case 'sqlserver':
    default:
      // SQL Server (on-prem) via SHIR; AAD/MSI is not assumable on-prem so the
      // username drives integrated/SQL auth — password lives in the factory KV
      // (referenced by the operator after creation, per no-vaporware infra gate).
      return { name, properties: {
        type: 'SqlServer',
        connectVia: { referenceName: shir, type: 'IntegrationRuntimeReference' },
        typeProperties: { connectionString: `Data Source=${host};Initial Catalog=${db};User ID=${user};Integrated Security=False;Encrypt=True` },
      } };
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  let kind: SourceKind = (body?.kind || body?.config?.kind || 'eventhub') as SourceKind;
  let cfg: SourceConfig = (body?.config && typeof body.config === 'object') ? body.config : {};
  const nodeIdx: number = Number.isInteger(body?.nodeIdx) ? body.nodeIdx : -1;
  // `fromSaved`: provision the saved source node in place (the catalog →
  // Subscribe → Test loop). We derive {kind, config} from the persisted
  // topology so the client doesn't have to re-supply connection details.
  const fromSaved: boolean = body?.fromSaved === true;

  try {
    const id = (await ctx.params).id;
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    if (fromSaved) {
      const node = readSavedSourceNode(item.state, nodeIdx);
      if (!node) return NextResponse.json({ ok: false, error: 'source node not found on the saved topology' }, { status: 404 });
      const derived = deriveProvisionFromSaved(node);
      if ('gate' in derived) {
        return NextResponse.json(
          { ok: false, code: 'needs_editor', error: derived.gate, link: `/items/eventstream/${id}` },
          { status: 422 },
        );
      }
      kind = derived.kind;
      cfg = { ...derived.config };
    }

    let endpoint: ProvisionedEndpoint;
    let hint: string | undefined;
    let adf: { pipelineName: string; runId?: string } | undefined;

    if (kind === 'sample') {
      return NextResponse.json({
        ok: true,
        endpoint: { auth: 'entra' },
        hint: 'Sample data needs no ingest endpoint — events are generated by the stream runtime.',
      });
    }

    if (kind === 'eventhub') {
      const g = eventhubsConfigGate();
      if (g) return gate(g.missing, `Set ${g.missing} so the Eventstream source can resolve the Event Hubs namespace.`);
      const fqdn = nsFqdn();
      const entityPath = safeName(cfg.eventHubName || cfg.topic || '', '') || (cfg.eventHubName || cfg.topic || '');
      if (!entityPath) {
        return NextResponse.json({ ok: false, error: 'Event Hub name is required for an Event Hubs source.' }, { status: 422 });
      }
      endpoint = {
        fqdn, entityPath,
        kafkaBootstrap: `${fqdn}:9093`,
        auth: 'entra', connectionString: null, localAuthDisabled: true,
      };
      hint = 'The Loom preview can send/receive events only if the Console UAMI (LOOM_UAMI_CLIENT_ID) holds Azure Event Hubs Data Owner on this namespace.';
    } else if (kind === 'iothub') {
      const g = iotHubConfigGate({ subscriptionId: cfg.iotHubSubscriptionId, resourceGroup: cfg.iotHubResourceGroup });
      if (g) return gate(g.missing, `Set ${g.missing} so the IoT Hub source can resolve the built-in Event Hubs endpoint via ARM.`);
      if (!cfg.iotHub) {
        return NextResponse.json({ ok: false, error: 'IoT Hub name is required for an IoT Hub source.' }, { status: 422 });
      }
      const eh = await getIoTHubEhEndpoint(cfg.iotHub, {
        subscriptionId: cfg.iotHubSubscriptionId,
        resourceGroup: cfg.iotHubResourceGroup,
      });
      endpoint = { fqdn: eh.fqdn, entityPath: eh.entityPath, auth: 'entra', connectionString: null };
      hint = 'Reading the IoT Hub built-in endpoint requires the Console UAMI to hold a data-receive role on the hub. Use consumer group "$Default" or a dedicated one.';
    } else if (kind === 'kafka') {
      const g = eventhubsConfigGate();
      if (g) return gate(g.missing, `Set ${g.missing} so the Kafka source can resolve the Event Hubs Kafka endpoint.`);
      const fqdn = nsFqdn();
      const topic = safeName(cfg.topic || cfg.eventHubName || '', '') || (cfg.topic || cfg.eventHubName || '');
      if (!topic) {
        return NextResponse.json({ ok: false, error: 'Topic (Event Hub name) is required for a Kafka source.' }, { status: 422 });
      }
      endpoint = {
        fqdn, entityPath: topic,
        kafkaBootstrap: `${fqdn}:9093`,
        auth: 'entra', connectionString: null, localAuthDisabled: true,
        saslConfig: `sasl.mechanism=OAUTHBEARER; security.protocol=SASL_SSL; oauth token endpoint=https://${oauthLoginHost()}/<tenant>/oauth2/v2.0/token`,
      };
      hint = 'Event Hubs Kafka with disableLocalAuth uses OAUTHBEARER (MSAL). SASL/PLAIN with $ConnectionString is disabled on the secure-default namespace.';
    } else if (kind === 'cdc-mirror') {
      const g = adfConfigGate();
      if (g) return gate(g.missing, `Set ${g.missing} so the CDC source can build the Azure Data Factory copy pipeline.`);
      const ehGate = eventhubsConfigGate();
      if (ehGate) return gate(ehGate.missing, `Set ${ehGate.missing} so the CDC sink Event Hub can be resolved.`);
      if (!cfg.cdcServerHost || !cfg.cdcDatabase || !cfg.cdcTable) {
        return NextResponse.json({ ok: false, error: 'CDC source requires server host, database, and table.' }, { status: 422 });
      }
      const fqdn = nsFqdn();
      const tableSafe = safeName(cfg.cdcTable, 'table');
      const sinkHub = safeName(`loom-cdc-${id}-${tableSafe}`, `loom-cdc-${tableSafe}`).slice(0, 50);
      // 1) Provision the EH sink hub (idempotent) — this IS the real ingest
      //    endpoint downstream operators read; it exists regardless of pipeline state.
      await createEventHub({ name: sinkHub, partitionCount: 4, messageRetentionInDays: 1 });
      endpoint = { fqdn, entityPath: sinkHub, kafkaBootstrap: `${fqdn}:9093`, auth: 'entra', connectionString: null };
      // 2-4) Build + start the ADF copy pipeline (source DB → EH sink). The
      //    linked services + pipeline are real ARM mutations; if the run can't
      //    start yet (SHIR offline / source secret unset), the endpoint is still
      //    provisioned and we surface a precise gate instead of a 500.
      const srcLs = `loom-cdc-src-${tableSafe}`.slice(0, 60);
      const sinkLs = `loom-cdc-sink-${tableSafe}`.slice(0, 60);
      const pipelineName = `loom-cdc-${id}-${tableSafe}`.slice(0, 60);
      try {
        await upsertLinkedService(srcLs, cdcSourceLinkedService(srcLs, cfg));
        // EH sink linked service (system-assigned MI auth — the ADF factory MI
        // holds Azure Event Hubs Data Sender, granted in eventhubs.bicep).
        await upsertLinkedService(sinkLs, {
          name: sinkLs,
          properties: {
            type: 'AzureEventHubs',
            typeProperties: { fullyQualifiedNamespace: fqdn, eventHubName: sinkHub },
          },
        });
        const pipeline: AdfPipeline = {
          name: pipelineName,
          properties: {
            description: `CSA Loom Eventstream CDC source → Event Hub ${sinkHub}`,
            activities: [
              {
                name: 'CdcCopyToEventHub',
                type: 'Copy',
                typeProperties: {
                  source: { type: cfg.cdcDatabaseType === 'sqlserver' ? 'SqlServerSource' : 'RelationalSource' },
                  sink: { type: 'AzureEventHubsSink' },
                },
              },
            ],
            annotations: ['csa-loom', 'eventstream-cdc'],
          },
        };
        await upsertPipeline(pipelineName, pipeline);
        const run = await runPipeline(pipelineName);
        adf = { pipelineName, runId: run.runId };
        hint = `CDC pipeline ${pipelineName} started (runId ${run.runId}). Event Hub sink "${sinkHub}" is the live ingest endpoint. Set the source DB password as a factory Key Vault secret if the run reports an auth error.`;
      } catch (e: any) {
        adf = { pipelineName };
        hint = `Event Hub sink "${sinkHub}" is provisioned and ready. The ADF copy pipeline could not start yet: ${e?.message || e}. Verify the self-hosted IR is online (on-prem SQL Server) and the source DB password is set as a factory Key Vault secret.`;
      }
      cfg.cdcAdfPipelineName = pipelineName;
    } else if (kind === 'custom-app') {
      const g = eventhubsConfigGate();
      if (g) return gate(g.missing, `Set ${g.missing} so a custom-app ingest Event Hub can be provisioned.`);
      const hubName = safeName(cfg.eventHubName || cfg.name || '', '') || safeName(cfg.name || `custom-${id}`, `custom-${id}`);
      // 1) Provision the dedicated ingest Event Hub (idempotent PUT).
      await createEventHub({ name: hubName, partitionCount: 4, messageRetentionInDays: 1 });
      const fqdn = nsFqdn();
      // 2) Optional Send SAS rule — keys only usable when local auth is enabled.
      let connectionString: string | null = null;
      let localAuthDisabled = true;
      try {
        await createEventHubAuthRule(hubName, 'loom-sender', ['Send']);
        const keys = await listEventHubKeys(hubName, 'loom-sender');
        localAuthDisabled = keys.localAuthDisabled;
        connectionString = keys.primaryConnectionString ?? null;
      } catch (e) {
        // SAS rule creation can fail on a locked-down namespace; Entra path still works.
        if (!(e instanceof EventHubsArmError)) throw e;
      }
      endpoint = {
        fqdn, entityPath: hubName,
        kafkaBootstrap: `${fqdn}:9093`,
        auth: localAuthDisabled ? 'entra' : 'sas',
        connectionString,
        localAuthDisabled,
      };
      hint = localAuthDisabled
        ? `The namespace has disableLocalAuth: true — push events to https://${fqdn}/${hubName}/messages with an Entra bearer token (or Kafka OAUTHBEARER). Set disableLocalAuth=false in eventhubs.bicep (Commercial only) to enable SAS connection strings.`
        : 'A Send SAS connection string was issued. Prefer Entra auth where possible.';
      cfg.eventHubName = hubName;
    } else {
      return NextResponse.json({ ok: false, error: `unsupported source kind: ${kind}` }, { status: 400 });
    }

    // Persist the resolved endpoint onto the saved topology so the designer
    // re-hydrates it on next GET without re-provisioning.
    const sources: any[] = Array.isArray(item.state?.sources)
      ? [...(item.state!.sources as any[])]
      : (item.state?.source ? [item.state.source] : []);
    if (nodeIdx >= 0 && nodeIdx < sources.length) {
      sources[nodeIdx] = { ...sources[nodeIdx], ...cfg, kind, provisionedEndpoint: endpoint };
      await saveItemState(item, { sources, source: sources[0] });
    }

    return NextResponse.json({ ok: true, endpoint, ...(hint ? { hint } : {}), ...(adf ? { adf } : {}) });
  } catch (e: any) {
    if (e instanceof IoTHubArmError || e instanceof EventHubsArmError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
