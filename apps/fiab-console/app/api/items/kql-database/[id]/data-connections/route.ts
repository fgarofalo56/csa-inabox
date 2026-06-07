/**
 * Event Hubs streaming data connections for a KQL database (Azure Data
 * Explorer-backed). The Azure-native 1:1 parity for a Fabric RTI Eventhouse
 * "Get data → Event hubs" data connection.
 *
 *   GET    /api/items/kql-database/[id]/data-connections
 *     Lists existing data connections on the resolved database, AND populates
 *     the wizard pickers: the env-pinned Event Hubs namespace, its hubs, the
 *     database's tables, and (when ?hub=<name> is supplied) that hub's
 *     consumer groups. One round-trip drives the whole wizard.
 *
 *   POST   /api/items/kql-database/[id]/data-connections
 *     Body: { name?, eventHubName, consumerGroup, tableName?, mappingRuleName?,
 *             dataFormat?, compression? }
 *     Creates (PUT) an EventHub data connection via ARM. ADX authenticates to
 *     Event Hubs with the cluster's system-assigned MI (which must hold
 *     "Azure Event Hubs Data Receiver" on the namespace — granted by
 *     eventhubs.bicep). Returns the connection + provisioningState.
 *
 *   DELETE /api/items/kql-database/[id]/data-connections?name=<name>
 *     Deletes the named data connection.
 *
 * Auth: session-gated (same as all /api/items/* routes).
 * Backend: real ARM REST via kusto-arm-client + eventhubs-client. No mocks.
 * Honest gates: 503 { code:'not_configured', missing } when ADX ARM or the
 * Event Hubs namespace env is unset — the wizard renders the missing env var.
 *
 * No Fabric dependency: works fully against Azure (ADX + Event Hubs) with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  loadKustoItem, resolveDatabase, listTables, KustoError,
} from '@/lib/azure/kusto-client';
import {
  readKustoArmConfig, KustoArmError, KustoNotConfiguredError,
  listDataConnections, createOrUpdateDataConnection, deleteDataConnection,
} from '@/lib/azure/kusto-arm-client';
import {
  readEventHubsConfig, eventhubsConfigGate, listEventHubs, listConsumerGroups,
  EventHubsArmError,
} from '@/lib/azure/eventhubs-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Microsoft.Kusto allows letters, digits, dash and underscore in connection names. */
function validConnectionName(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(s);
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
    const connections = await listDataConnections(database);

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
  } catch (e: any) {
    const status = e instanceof KustoArmError ? e.status
      : e instanceof EventHubsArmError ? e.status
      : e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const eventHubName = String(body?.eventHubName || '').trim();
  const consumerGroup = String(body?.consumerGroup || '').trim();
  const tableName = String(body?.tableName || '').trim();
  const mappingRuleName = String(body?.mappingRuleName || '').trim();
  const dataFormat = String(body?.dataFormat || 'JSON').trim() || 'JSON';
  const compression = String(body?.compression || 'None').trim() || 'None';
  let name = String(body?.name || '').trim();
  if (!eventHubName) return NextResponse.json({ ok: false, error: 'eventHubName is required' }, { status: 400 });
  if (!consumerGroup) return NextResponse.json({ ok: false, error: 'consumerGroup is required' }, { status: 400 });
  // Auto-generate a valid, unique connection name when blank.
  if (!name) name = `loom-dc-${eventHubName}-${Date.now()}`.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '-');
  if (!validConnectionName(name)) {
    return NextResponse.json({ ok: false, error: 'name must be 1-40 chars: letters, digits, dash, underscore' }, { status: 400 });
  }

  const armGate = armConfiguredOr503();
  if (armGate) return armGate;
  const ehGate = eventhubsConfigGate();
  if (ehGate) return NextResponse.json({ ok: false, code: 'not_configured', missing: ehGate.missing }, { status: 503 });

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const database = resolveDatabase(item);

    const armCfg = readKustoArmConfig();
    const ehCfg = readEventHubsConfig();

    // Plain ARM resource paths — cloud-agnostic (no servicebus suffix needed).
    const eventHubResourceId =
      `/subscriptions/${ehCfg.subscriptionId}/resourceGroups/${ehCfg.resourceGroup}` +
      `/providers/Microsoft.EventHub/namespaces/${ehCfg.namespace}/eventhubs/${eventHubName}`;
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

    return NextResponse.json({ ok: true, connection });
  } catch (e: any) {
    const status = e instanceof KustoArmError ? e.status
      : e instanceof EventHubsArmError ? e.status
      : e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const dcName = req.nextUrl.searchParams.get('name')?.trim() || '';
  if (!dcName) return NextResponse.json({ ok: false, error: 'name query param required' }, { status: 400 });

  const gate = armConfiguredOr503();
  if (gate) return gate;

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const database = resolveDatabase(item);
    await deleteDataConnection(database, dcName);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e instanceof KustoArmError ? e.status
      : e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
