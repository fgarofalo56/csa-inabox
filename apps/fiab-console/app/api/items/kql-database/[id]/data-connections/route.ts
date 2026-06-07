/**
 * /api/items/kql-database/[id]/data-connections
 * ----------------------------------------------
 * ADX (Azure Data Explorer) data connections on the KQL Database's resolved
 * database — the Azure-native 1:1 parity for a Fabric RTI Eventhouse
 * "Get data → Event hubs / IoT Hub" data connection. Works with NO Fabric
 * workspace bound (no `fabricWorkspaceId`, no LOOM_DEFAULT_FABRIC_WORKSPACE).
 * Real ARM REST only — no mocks.
 *
 *   GET    Lists existing data connections on the resolved database, AND
 *          populates the Event Hubs wizard pickers: the env-pinned namespace,
 *          its hubs, the database's tables, and (when ?hub=<name> is supplied)
 *          that hub's consumer groups. One round-trip drives the whole wizard.
 *
 *   POST   Creates a connection. Two request shapes are accepted:
 *            • Event Hubs (env-pinned namespace wizard): no `kind`, body
 *              { name?, eventHubName, consumerGroup, tableName?, mappingRuleName?,
 *                dataFormat?, compression? } — ADX authenticates with the
 *              cluster's system-assigned MI ("Azure Event Hubs Data Receiver").
 *            • Source picker wizard: body.kind ∈ { 'eventhub' | 'iothub' }
 *                eventhub : { kind:'eventhub', eventHubResourceId, consumerGroup, dataFormat, tableName, mappingRuleName? }
 *                iothub   : { kind:'iothub', iotHubResourceId, sharedAccessPolicyName, consumerGroup, dataFormat, tableName, mappingRuleName? }
 *              IoT Hub authenticates via the hub's shared-access policy (ARM
 *              reads the keys; the ADX cluster MI needs IoT Hub Contributor).
 *
 *   DELETE Removes a connection. Body { connectionName } or ?name=<name>.
 *
 * Auth: session-gated (same as all /api/items/* routes).
 * Honest gates: 503 { code:'not_configured', missing } when ADX ARM or the
 * Event Hubs namespace env is unset; a 403 from ADM (cluster MI lacks key-read
 * on the source) is surfaced as a precise role-grant gate for the editor.
 *
 * No Fabric dependency: works fully against Azure (ADX + Event Hubs / IoT Hub)
 * with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadKustoItem, resolveDatabase, listTables, KustoError,
} from '@/lib/azure/kusto-client';
import {
  readKustoArmConfig, KustoArmError, KustoNotConfiguredError,
  listDataConnections, createOrUpdateDataConnection, createIotHubDataConnection,
  deleteDataConnection,
} from '@/lib/azure/kusto-arm-client';
import {
  readEventHubsConfig, eventhubsConfigGate, listEventHubs, listConsumerGroups,
  EventHubsArmError,
} from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADX-supported data formats. RAW is valid for Event Hubs but NOT for IoT Hub
// (per ADX docs) — handleIotHub rejects RAW explicitly below.
const VALID_FORMATS = new Set([
  'MULTIJSON', 'JSON', 'CSV', 'TSV', 'SCSV', 'SOHSV', 'PSV', 'TXT', 'TSVE',
  'AVRO', 'APACHEAVRO', 'PARQUET', 'ORC', 'W3CLOGFILE', 'SINGLEJSON', 'RAW',
]);

const EVENTHUB_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.EventHub\/namespaces\/[^/]+\/eventhubs\/[^/]+$/i;
const IOTHUB_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Devices\/IotHubs\/[^/]+$/i;

function validKustoIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
}

/** Microsoft.Kusto allows letters, digits, dash and underscore in connection names. */
function validConnectionName(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s);
}

/** Derive a safe (≤40 char, alnum/dash) ARM child-resource name. */
function connectionName(table: string, kind: 'iot' | 'eh', sourceName: string): string {
  return `${table}-${kind}-${sourceName}`.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Last segment of an ARM resource id (the resource's own name). */
function lastSegment(resourceId: string): string {
  const parts = resourceId.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'source';
}

function armConfiguredOr503(): NextResponse | null {
  try {
    readKustoArmConfig();
    return null;
  } catch (e: any) {
    if (e instanceof KustoNotConfiguredError) {
      return NextResponse.json({ ok: false, code: 'not_configured', missing: e.missing }, { status: 503 });
    }
    throw e;
  }
}

/** Map ARM/Kusto errors to structured JSON, incl. the honest 403 key-read gate. */
function armError(e: unknown): NextResponse {
  if (e instanceof KustoNotConfiguredError) {
    return NextResponse.json(
      { ok: false, code: 'not_configured', error: e.message, missing: e.missing },
      { status: 503 },
    );
  }
  if (e instanceof KustoArmError) {
    // 403 → ADX cluster MI lacks key-read on the source. Surface a precise,
    // actionable honest gate (no-vaporware) instead of a raw 403.
    if (e.status === 403) {
      return NextResponse.json(
        {
          ok: false,
          code: 'mi_no_key_read',
          error:
            'The ADX cluster managed identity could not read the source’s shared-access keys. ' +
            'For an IoT Hub, grant the cluster system-assigned managed identity the "IoT Hub Contributor" ' +
            'role (role ID 4763167e-fb37-48bb-8710-0fcd9d82e439) at the IoT Hub scope. ' +
            'For an Event Hub, grant "Azure Event Hubs Data Receiver" on the namespace/hub.',
          detail: typeof e.body === 'string' ? e.body.slice(0, 600) : undefined,
        },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { ok: false, error: e.message, detail: typeof e.body === 'string' ? e.body.slice(0, 600) : e.body, status: e.status },
      { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
    );
  }
  if (e instanceof EventHubsArmError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: e.status >= 400 && e.status < 600 ? e.status : 502 });
  }
  if (e instanceof KustoError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
  }
  const msg = (e as any)?.message || String(e);
  return NextResponse.json({ ok: false, error: msg }, { status: 502 });
}

async function resolveDb(id: string, oid: string): Promise<string> {
  const item = await loadKustoItem(id, 'kql-database', oid);
  if (!item) throw new KustoError('KQL database item not found', 404);
  return resolveDatabase(item);
}

/**
 * Flatten an ARM data connection into a shape that satisfies BOTH wizard
 * consumers: the source-picker table reads flat fields (name/kind/tableName/
 * provisioningState), the Event-Hubs wizard reads nested `properties`.
 */
function flattenConnection(c: any) {
  const p = c?.properties || {};
  return {
    name: c?.name,
    kind: c?.kind,
    tableName: p.tableName,
    consumerGroup: p.consumerGroup,
    dataFormat: p.dataFormat,
    provisioningState: p.provisioningState,
    source: p.iotHubResourceId || p.eventHubResourceId,
    properties: p,
  };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = armConfiguredOr503();
  if (gate) return gate;

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const database = resolveDatabase(item);

    // Existing data connections on this database (real ARM list).
    const connections = (await listDataConnections(database)).map(flattenConnection);

    // Wizard pickers: Event Hubs namespace + hubs (+ consumer groups for ?hub).
    const ehGate = eventhubsConfigGate();
    let namespace: string | null = null;
    let eventHubs: string[] = [];
    let consumerGroups: string[] = [];
    if (!ehGate) {
      const ehCfg = readEventHubsConfig();
      namespace = ehCfg.namespace;
      eventHubs = (await listEventHubs().catch(() => [])).map((h) => h.name);
      const selectedHub = req.nextUrl.searchParams.get('hub')?.trim() || '';
      if (selectedHub) {
        consumerGroups = (await listConsumerGroups(selectedHub).catch(() => [])).map((cg) => cg.name);
      }
    }

    // Target-table dropdown.
    const tables = (await listTables(database).catch(() => [])).map((t) => t.name);

    return NextResponse.json({
      ok: true,
      database,
      connections,
      namespace,
      eventHubs,
      consumerGroups,
      tables,
      ehNotConfigured: ehGate ? ehGate.missing : null,
    });
  } catch (e) {
    return armError(e);
  }
}

/** IoT Hub data connection (source-picker wizard). */
async function handleIotHub(database: string, body: any): Promise<NextResponse> {
  const iotHubResourceId = String(body?.iotHubResourceId || '').trim();
  const sharedAccessPolicyName = String(body?.sharedAccessPolicyName || '').trim();
  const consumerGroup = String(body?.consumerGroup || '').trim() || '$Default';
  const dataFormat = String(body?.dataFormat || 'MULTIJSON').trim().toUpperCase();
  const tableName = String(body?.tableName || '').trim();
  const mappingRuleName = String(body?.mappingRuleName || '').trim() || undefined;

  if (!iotHubResourceId) {
    return NextResponse.json({
      ok: false,
      code: 'no_source',
      error:
        'No IoT Hub selected. Provision a Microsoft.Devices/IotHubs resource (or grant the Loom identity ' +
        'Reader access) and choose it from the IoT Hub picker to create this data connection.',
    }, { status: 400 });
  }
  if (!IOTHUB_ID_RE.test(iotHubResourceId)) {
    return NextResponse.json({ ok: false, error: 'iotHubResourceId is not a valid Microsoft.Devices/IotHubs/... id' }, { status: 400 });
  }
  if (!sharedAccessPolicyName || !/^[A-Za-z0-9_\-]{1,128}$/.test(sharedAccessPolicyName)) {
    return NextResponse.json({ ok: false, error: 'a valid sharedAccessPolicyName is required (e.g. iothubowner or service)' }, { status: 400 });
  }
  if (!tableName || !validKustoIdent(tableName)) return NextResponse.json({ ok: false, error: 'a valid target tableName is required' }, { status: 400 });
  // IoT Hub does not support RAW; reject it explicitly (EH allows it).
  if (dataFormat === 'RAW' || !VALID_FORMATS.has(dataFormat)) return NextResponse.json({ ok: false, error: `unsupported dataFormat '${dataFormat}' (IoT Hub does not support RAW)` }, { status: 400 });

  const connName = connectionName(tableName, 'iot', lastSegment(iotHubResourceId));
  const connection = await createIotHubDataConnection(database, connName, {
    iotHubResourceId, sharedAccessPolicyName, consumerGroup, dataFormat: dataFormat as any, tableName, mappingRuleName,
  });
  return NextResponse.json({
    ok: true,
    mode: 'iothub',
    database,
    connectionName: connName,
    provisioningState: connection.properties?.provisioningState ?? 'Creating',
    connection,
  });
}

/**
 * Event Hub data connection. Two body shapes:
 *   • explicit  : { kind:'eventhub', eventHubResourceId, consumerGroup, dataFormat, tableName, mappingRuleName? }
 *   • env-pinned: { eventHubName, consumerGroup, tableName?, mappingRuleName?, dataFormat?, compression?, name? }
 * Both create an EventHub data connection authenticated by the cluster MI.
 */
async function handleEventHub(database: string, body: any, explicit: boolean): Promise<NextResponse> {
  const armCfg = readKustoArmConfig();
  const consumerGroup = String(body?.consumerGroup || '').trim() || '$Default';
  const tableName = String(body?.tableName || '').trim();
  const mappingRuleName = String(body?.mappingRuleName || '').trim() || undefined;
  const dataFormat = String(body?.dataFormat || 'JSON').trim().toUpperCase() || 'JSON';
  const compression = String(body?.compression || 'None').trim() || 'None';

  if (!VALID_FORMATS.has(dataFormat)) {
    return NextResponse.json({ ok: false, error: `unsupported dataFormat '${dataFormat}'` }, { status: 400 });
  }

  // Resolve the event hub child resource id + a connection name.
  let eventHubResourceId: string;
  let name: string;
  if (explicit) {
    eventHubResourceId = String(body?.eventHubResourceId || '').trim();
    if (!eventHubResourceId) return NextResponse.json({ ok: false, error: 'eventHubResourceId is required' }, { status: 400 });
    if (!EVENTHUB_ID_RE.test(eventHubResourceId)) {
      return NextResponse.json({ ok: false, error: 'eventHubResourceId is not a valid Microsoft.EventHub/namespaces/.../eventhubs/... id' }, { status: 400 });
    }
    if (!tableName || !validKustoIdent(tableName)) return NextResponse.json({ ok: false, error: 'a valid target tableName is required' }, { status: 400 });
    name = connectionName(tableName, 'eh', lastSegment(eventHubResourceId));
  } else {
    // env-pinned namespace wizard: compose the resource id from EH config.
    const ehGate = eventhubsConfigGate();
    if (ehGate) return NextResponse.json({ ok: false, code: 'not_configured', missing: ehGate.missing }, { status: 503 });
    const ehCfg = readEventHubsConfig();
    const eventHubName = String(body?.eventHubName || '').trim();
    if (!eventHubName) return NextResponse.json({ ok: false, error: 'eventHubName is required' }, { status: 400 });
    eventHubResourceId =
      `/subscriptions/${ehCfg.subscriptionId}/resourceGroups/${ehCfg.resourceGroup}` +
      `/providers/Microsoft.EventHub/namespaces/${ehCfg.namespace}/eventhubs/${eventHubName}`;
    name = String(body?.name || '').trim();
    if (!name) name = `loom-dc-${eventHubName}-${Date.now()}`.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '-');
    if (!validConnectionName(name)) {
      return NextResponse.json({ ok: false, error: 'name must be 1-40 chars: letters, digits, dash, underscore' }, { status: 400 });
    }
  }

  // ADX authenticates to Event Hubs via the cluster's system-assigned MI.
  const clusterResourceId =
    `/subscriptions/${armCfg.subscriptionId}/resourceGroups/${armCfg.resourceGroup}` +
    `/providers/Microsoft.Kusto/clusters/${armCfg.clusterName}`;
  const location = process.env.LOOM_KUSTO_LOCATION || 'eastus2';

  const connection = await createOrUpdateDataConnection(database, name, {
    eventHubResourceId,
    consumerGroup,
    managedIdentityResourceId: clusterResourceId,
    location,
    ...(tableName ? { tableName } : {}),
    ...(mappingRuleName ? { mappingRuleName } : {}),
    dataFormat: dataFormat as any,
    compression: compression as any,
  });

  return NextResponse.json({
    ok: true,
    mode: 'eventhub',
    database,
    connectionName: connection.name,
    provisioningState: connection.properties?.provisioningState ?? 'Creating',
    connection,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = armConfiguredOr503();
  if (gate) return gate;

  const body = await req.json().catch(() => ({}));
  const kind = String(body?.kind || '').toLowerCase();
  try {
    const database = await resolveDb((await ctx.params).id, session.claims.oid);
    if (kind === 'iothub') return await handleIotHub(database, body);
    if (kind === 'eventhub') return await handleEventHub(database, body, true);
    // No `kind` → the env-pinned Event Hubs wizard.
    return await handleEventHub(database, body, false);
  } catch (e) {
    return armError(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = armConfiguredOr503();
  if (gate) return gate;

  // Accept connectionName from the JSON body (source-picker wizard) or the
  // ?name= query param (Event Hubs wizard).
  const body = await req.json().catch(() => ({}));
  const dcName =
    String(body?.connectionName || '').trim() ||
    (req.nextUrl.searchParams.get('name')?.trim() || '');
  if (!dcName || !/^[A-Za-z0-9_\-]{1,80}$/.test(dcName)) {
    return NextResponse.json({ ok: false, error: 'valid connectionName is required' }, { status: 400 });
  }
  try {
    const database = await resolveDb((await ctx.params).id, session.claims.oid);
    await deleteDataConnection(database, dcName);
    return NextResponse.json({ ok: true, deleted: dcName });
  } catch (e) {
    return armError(e);
  }
}
