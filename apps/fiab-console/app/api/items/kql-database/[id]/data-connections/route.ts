/**
 * /api/items/kql-database/[id]/data-connections
 * ----------------------------------------------
 * Manage ADX (Azure Data Explorer) data connections on the KQL Database's
 * resolved database. Azure-native parity for a Fabric Eventhouse data
 * connection — works with NO Fabric workspace bound (no `fabricWorkspaceId`,
 * no LOOM_DEFAULT_FABRIC_WORKSPACE). Real ARM REST via kusto-arm-client.
 *
 *   GET    → list existing data connections on the database
 *   POST   → create a connection; body.kind ∈ { 'eventhub' | 'iothub' }
 *   DELETE → remove a connection; body { connectionName }
 *
 * EventHub body  : { kind:'eventhub', eventHubResourceId, consumerGroup, dataFormat, tableName, mappingRuleName? }
 * IotHub body    : { kind:'iothub', iotHubResourceId, sharedAccessPolicyName, consumerGroup, dataFormat, tableName, mappingRuleName? }
 *
 * Per .claude/rules/no-vaporware.md — no mock arrays. Every path either calls
 * the real Microsoft.Kusto ARM API or returns a structured error. A 403 from
 * ADM (the cluster MI lacks key-read on the source) is surfaced verbatim so
 * the editor can render the honest role-grant gate.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, resolveDatabase, KustoError } from '@/lib/azure/kusto-client';
import {
  createDataConnection, listDataConnections, deleteDataConnection,
  KustoArmError, KustoNotConfiguredError,
} from '@/lib/azure/kusto-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ADX-supported data formats. IoT Hub does NOT support RAW (per ADX docs), so
// it is intentionally absent — the UI dropdown offers the same curated set.
const VALID_FORMATS = new Set([
  'MULTIJSON', 'JSON', 'CSV', 'TSV', 'SCSV', 'SOHSV', 'PSV', 'TXT', 'TSVE',
  'AVRO', 'APACHEAVRO', 'PARQUET', 'ORC', 'W3CLOGFILE', 'SINGLEJSON',
]);

const EVENTHUB_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.EventHub\/namespaces\/[^/]+\/eventhubs\/[^/]+$/i;
const IOTHUB_ID_RE =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Devices\/IotHubs\/[^/]+$/i;

function validKustoIdent(s: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_\-]{0,127}$/.test(s);
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
  const msg = (e as any)?.message || String(e);
  return NextResponse.json({ ok: false, error: msg }, { status: 502 });
}

async function resolveDb(id: string, oid: string): Promise<string> {
  const item = await loadKustoItem(id, 'kql-database', oid);
  if (!item) throw new KustoError('KQL database item not found', 404);
  return resolveDatabase(item);
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const database = await resolveDb((await ctx.params).id, session.claims.oid);
    const connections = await listDataConnections(database);
    return NextResponse.json({ ok: true, database, connections });
  } catch (e) {
    if (e instanceof KustoError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return armError(e);
  }
}

async function handleEventHub(database: string, body: any): Promise<NextResponse> {
  const eventHubResourceId = String(body?.eventHubResourceId || '').trim();
  const consumerGroup = String(body?.consumerGroup || '').trim() || '$Default';
  const dataFormat = String(body?.dataFormat || 'JSON').trim().toUpperCase();
  const tableName = String(body?.tableName || '').trim();
  const mappingRuleName = String(body?.mappingRuleName || '').trim() || undefined;

  if (!eventHubResourceId) return NextResponse.json({ ok: false, error: 'eventHubResourceId is required' }, { status: 400 });
  if (!EVENTHUB_ID_RE.test(eventHubResourceId)) {
    return NextResponse.json({ ok: false, error: 'eventHubResourceId is not a valid Microsoft.EventHub/namespaces/.../eventhubs/... id' }, { status: 400 });
  }
  if (!tableName || !validKustoIdent(tableName)) return NextResponse.json({ ok: false, error: 'a valid target tableName is required' }, { status: 400 });
  if (!VALID_FORMATS.has(dataFormat)) return NextResponse.json({ ok: false, error: `unsupported dataFormat '${dataFormat}'` }, { status: 400 });

  const connName = connectionName(tableName, 'eh', lastSegment(eventHubResourceId));
  const conn = await createDataConnection(database, connName, {
    kind: 'EventHub', eventHubResourceId, consumerGroup, dataFormat, tableName, mappingRuleName,
  });
  return NextResponse.json({ ok: true, mode: 'eventhub', database, connectionName: connName, ...conn });
}

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
  // IoT Hub does not support RAW; VALID_FORMATS already excludes it.
  if (!VALID_FORMATS.has(dataFormat)) return NextResponse.json({ ok: false, error: `unsupported dataFormat '${dataFormat}' (IoT Hub does not support RAW)` }, { status: 400 });

  const connName = connectionName(tableName, 'iot', lastSegment(iotHubResourceId));
  const conn = await createDataConnection(database, connName, {
    kind: 'IotHub', iotHubResourceId, sharedAccessPolicyName, consumerGroup, dataFormat, tableName, mappingRuleName,
  });
  return NextResponse.json({ ok: true, mode: 'iothub', database, connectionName: connName, ...conn });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const kind = String(body?.kind || '').toLowerCase();
  try {
    const database = await resolveDb((await ctx.params).id, session.claims.oid);
    if (kind === 'eventhub') return await handleEventHub(database, body);
    if (kind === 'iothub') return await handleIotHub(database, body);
    return NextResponse.json({ ok: false, error: "unknown kind; expected 'eventhub' or 'iothub'" }, { status: 400 });
  } catch (e) {
    if (e instanceof KustoError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return armError(e);
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const connectionName = String(body?.connectionName || '').trim();
  if (!connectionName || !/^[A-Za-z0-9_\-]{1,80}$/.test(connectionName)) {
    return NextResponse.json({ ok: false, error: 'valid connectionName is required' }, { status: 400 });
  }
  try {
    const database = await resolveDb((await ctx.params).id, session.claims.oid);
    await deleteDataConnection(database, connectionName);
    return NextResponse.json({ ok: true, deleted: connectionName });
  } catch (e) {
    if (e instanceof KustoError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
    }
    return armError(e);
  }
}
