/**
 * POST /api/items/eventstream/[id]/asa-sync
 *   Body: { asaJobName: string }
 *
 * Reads the saved Eventstream topology (state.sinks / state.sink) from Cosmos
 * and materializes each destination node as a REAL Azure Stream Analytics
 * output (ARM PUT against Microsoft.StreamAnalytics/streamingjobs/{job}/outputs).
 *
 * Sink kind → ASA datasource type (Azure-native, no Fabric dependency):
 *   kusto      → Microsoft.Kusto/clusters/databases   (ADX / Eventhouse)
 *   lakehouse  → Microsoft.Storage/Blob               (ADLS Gen2)
 *   eventhub   → Microsoft.EventHub/EventHub
 *   reflex     → Microsoft.EventHub/EventHub          (Activator connects to it)
 *
 * After the job is started in the Stream Analytics editor, transformed events
 * land in ADX (rows) / ADLS (files) / the Event Hub. The route stores the
 * chosen ASA job name on state.asaJobName so the editor pre-fills it on reload.
 *
 * Honest gating: when ASA env vars are unset the underlying client throws
 * AsaNotConfiguredError and we surface a 501 MessageBar naming the bicep
 * module + LOOM_ASA_RG. No mock writes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import {
  createOrUpdateOutput,
  AsaNotConfiguredError,
  type AsaOutputCreateSpec,
} from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different). ' +
  'For ADX outputs, grant the ASA job managed identity AllDatabasesIngestor on the cluster; ' +
  'for ADLS outputs, grant it Storage Blob Data Contributor on the storage account.';

interface SinkLike {
  kind?: string;
  name?: string;
  kustoClusterUrl?: string;
  database?: string;
  table?: string;
  storageAccount?: string;
  storageAccountKey?: string;
  container?: string;
  pathPattern?: string;
  dateFormat?: string;
  timeFormat?: string;
  eventHubName?: string;
  namespace?: string;
  sharedAccessPolicyName?: string;
  sharedAccessPolicyKey?: string;
}

/** ASA output aliases must be alphanumeric + dashes/underscores. */
function aliasFor(name: string, idx: number): string {
  const cleaned = (name || '').trim().replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || `output-${idx + 1}`;
}

/** Map a designer SinkNode to an AsaOutputCreateSpec, or null if unsupported. */
function sinkToOutputSpec(sink: SinkLike, idx: number): { spec: AsaOutputCreateSpec; kind: string } | { error: string } | null {
  const kind = (sink.kind || '').toLowerCase();
  const name = aliasFor(sink.name || '', idx);

  if (kind === 'kusto') {
    const cluster = (sink.kustoClusterUrl && sink.kustoClusterUrl.trim()) ||
      process.env.LOOM_KUSTO_CLUSTER_URI ||
      'https://adx-csa-loom-shared.eastus2.kusto.windows.net';
    if (!sink.table || !sink.table.trim()) {
      return { error: `Destination "${name}" (KQL Database) needs a Table name.` };
    }
    return {
      kind,
      spec: {
        name,
        datasourceType: 'Microsoft.Kusto/clusters/databases',
        authenticationMode: 'Msi',
        kustoClusterUrl: cluster,
        kustoDatabase: (sink.database && sink.database.trim()) || 'loomdb-default',
        kustoTable: sink.table.trim(),
      },
    };
  }

  if (kind === 'lakehouse') {
    const account = (sink.storageAccount && sink.storageAccount.trim()) || process.env.LOOM_ADLS_ACCOUNT || '';
    const container = (sink.container && sink.container.trim()) || process.env.LOOM_ADLS_CONTAINER || '';
    if (!account) {
      return { error: `Destination "${name}" (Lakehouse) needs an ADLS Gen2 storage account (set it in the inspector or LOOM_ADLS_ACCOUNT).` };
    }
    if (!container) {
      return { error: `Destination "${name}" (Lakehouse) needs a container / filesystem name.` };
    }
    return {
      kind,
      spec: {
        name,
        datasourceType: 'Microsoft.Storage/Blob',
        authenticationMode: sink.storageAccountKey ? 'ConnectionString' : 'Msi',
        storageAccount: account,
        storageAccountKey: sink.storageAccountKey,
        container,
        pathPattern: sink.pathPattern || 'events/{date}/{time}',
        dateFormat: sink.dateFormat || 'yyyy/MM/dd',
        timeFormat: sink.timeFormat || 'HH',
        serialization: 'Json',
      },
    };
  }

  if (kind === 'eventhub' || kind === 'reflex') {
    // Bicep emits the SINGULAR LOOM_EVENTHUB_NAMESPACE (what eventhubs-client.ts
    // reads); the plural form is accepted for back-compat with hand-set envs.
    const namespace = (sink.namespace && sink.namespace.trim())
      || process.env.LOOM_EVENTHUBS_NAMESPACE || process.env.LOOM_EVENTHUB_NAMESPACE || '';
    if (!namespace) {
      return { error: `Destination "${name}" (${kind === 'reflex' ? 'Activator' : 'Event Hub'}) needs an Event Hubs namespace (set it in the inspector or LOOM_EVENTHUB_NAMESPACE).` };
    }
    if (!sink.eventHubName || !sink.eventHubName.trim()) {
      return { error: `Destination "${name}" needs an Event Hub name.` };
    }
    return {
      kind,
      spec: {
        name,
        datasourceType: 'Microsoft.EventHub/EventHub',
        authenticationMode: sink.sharedAccessPolicyKey ? 'ConnectionString' : 'Msi',
        namespace,
        eventHubName: sink.eventHubName.trim(),
        sharedAccessPolicyName: sink.sharedAccessPolicyName,
        sharedAccessPolicyKey: sink.sharedAccessPolicyKey,
        serialization: 'Json',
      },
    };
  }

  // derivedStream and unknown kinds have no external ASA output — skip silently.
  return null;
}

function collectSinks(state: any): SinkLike[] {
  if (Array.isArray(state?.sinks) && state.sinks.length) return state.sinks as SinkLike[];
  if (state?.sink && typeof state.sink === 'object') return [state.sink as SinkLike];
  return [];
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const asaJobName = typeof body?.asaJobName === 'string' ? body.asaJobName.trim() : '';
  if (!asaJobName) {
    return NextResponse.json({ ok: false, error: 'asaJobName is required (the ASA job that receives these outputs).' }, { status: 400 });
  }

  try {
    const id = (await ctx.params).id;
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    const sinks = collectSinks(item.state);
    if (!sinks.length) {
      return NextResponse.json({
        ok: false,
        error: 'No destinations defined. Add a destination node and Save before pushing to ASA.',
      }, { status: 400 });
    }

    const created: Array<{ name: string; type: string; id: string }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (let i = 0; i < sinks.length; i++) {
      const mapped = sinkToOutputSpec(sinks[i], i);
      if (mapped === null) {
        skipped.push({ name: sinks[i]?.name || `sink-${i + 1}`, reason: 'no external Azure output for this destination kind' });
        continue;
      }
      if ('error' in mapped) {
        return NextResponse.json({ ok: false, error: mapped.error }, { status: 400 });
      }
      const out = await createOrUpdateOutput(asaJobName, mapped.spec);
      created.push({ name: mapped.spec.name, type: mapped.spec.datasourceType, id: out.id });
    }

    // Persist the chosen ASA job name so the editor pre-fills it on reload.
    await saveItemState(item, { asaJobName });

    return NextResponse.json({ ok: true, asaJobName, outputs: created, skipped });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });
    }
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), hint: HINT }, { status });
  }
}
