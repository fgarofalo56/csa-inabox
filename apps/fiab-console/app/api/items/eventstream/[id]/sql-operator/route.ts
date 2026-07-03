/**
 * Eventstream — code-first T-SQL (SAQL) operator with multiple named sinks.
 *
 * GET  /api/items/eventstream/[id]/sql-operator
 *   Read the persisted T-SQL operator from Cosmos state:
 *     { ok, sqlOperator: { query, sinks[], asaJobName } }
 *
 * POST /api/items/eventstream/[id]/sql-operator
 *   Body: { action, ... } — five actions, all real ARM (no mocks):
 *
 *   action='save'     { query, sinks[], asaJobName? }
 *     Persists the T-SQL + named sinks to Cosmos. When an ASA job name is
 *     present, also pushes the query to the live ASA job transformation
 *     (Microsoft.StreamAnalytics/streamingjobs/{job}/transformations — real PUT).
 *
 *   action='compile'  { query }
 *     Real ASA compileQuery (subscription-scoped action). Returns genuine
 *     compiler diagnostics for the WHOLE multi-INTO query. Always available
 *     with the Query Tester / Contributor role — no result storage needed.
 *
 *   action='test'     { query, outputAlias, sampleInput[] }
 *     PER-OUTPUT test. Rewrites the multi-INTO query down to ONLY the
 *     statements that write to `outputAlias`, then runs ASA testQuery over the
 *     sample events and returns just that sink's produced rows. Needs
 *     LOOM_ASA_TEST_WRITE_URI — honest 501 gate otherwise.
 *
 *   action='apply-sinks' { asaJobName, sinks[] }
 *     Materializes each named sink as a real ASA output (ARM PUT against
 *     .../streamingjobs/{job}/outputs). The query's `INTO [alias]` targets
 *     each output. Azure-native: ADX / ADLS Gen2 / Event Hub — no Fabric.
 *
 * Honest gating: AsaNotConfiguredError → 501 naming the bicep module +
 * LOOM_ASA_RG; AsaTestNotAvailableError → 501 naming LOOM_ASA_TEST_WRITE_URI.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadKustoItem, saveItemState, KustoError } from '@/lib/azure/kusto-client';
import {
  compileQuery,
  testTransformation,
  saveTransformation,
  createOrUpdateOutput,
  AsaNotConfiguredError,
  AsaTestNotAvailableError,
  type AsaOutputCreateSpec,
} from '@/lib/azure/stream-analytics-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HINT =
  'Provision an ASA job (bicep: platform/fiab/bicep/modules/landing-zone/stream-analytics.bicep, ' +
  'flag enableStreamAnalytics=true) and set LOOM_ASA_RG (and LOOM_ASA_SUB if different). ' +
  'Compile/Test Query use subscription-scoped actions Microsoft.StreamAnalytics/locations/*Query/action — ' +
  'grant the Loom Console UAMI the "Stream Analytics Query Tester" role ' +
  '(1ec5b3c1-b17e-4e25-8312-2acb3c3c5abf) at SUBSCRIPTION scope (one-time tenant action).';

/** One named sink ("INTO [alias]") of the T-SQL operator. */
interface SqlSink {
  /** ASA output alias referenced by `INTO [alias]` in the query. */
  alias?: string;
  /** kusto | lakehouse | eventhub | reflex */
  kind?: string;
  // kusto (ADX / Eventhouse)
  kustoClusterUrl?: string;
  database?: string;
  table?: string;
  // lakehouse (ADLS Gen2 Blob)
  storageAccount?: string;
  storageAccountKey?: string;
  container?: string;
  pathPattern?: string;
  dateFormat?: string;
  timeFormat?: string;
  // eventhub / reflex
  namespace?: string;
  eventHubName?: string;
  sharedAccessPolicyName?: string;
  sharedAccessPolicyKey?: string;
}

interface SqlOperator {
  query: string;
  sinks: SqlSink[];
  asaJobName?: string;
}

const DEFAULT_QUERY = `-- Code-first T-SQL (Stream Analytics SAQL) operator.
-- Write one SELECT ... INTO [<sink alias>] per named destination.
-- Each [alias] below must match a sink declared on the right.

SELECT *
INTO [hot-path]
FROM [eventstream-input]
WHERE [eventType] = 'order';

SELECT
  System.Timestamp() AS windowEnd,
  COUNT(*)           AS orders
INTO [aggregates]
FROM [eventstream-input]
GROUP BY TumblingWindow(minute, 5);`;

/** Sanitize a SqlSink from untrusted input. */
function cleanSink(raw: any): SqlSink {
  const out: SqlSink = {};
  const str = (v: any) => (typeof v === 'string' ? v : undefined);
  out.alias = str(raw?.alias);
  out.kind = str(raw?.kind);
  out.kustoClusterUrl = str(raw?.kustoClusterUrl);
  out.database = str(raw?.database);
  out.table = str(raw?.table);
  out.storageAccount = str(raw?.storageAccount);
  out.storageAccountKey = str(raw?.storageAccountKey);
  out.container = str(raw?.container);
  out.pathPattern = str(raw?.pathPattern);
  out.dateFormat = str(raw?.dateFormat);
  out.timeFormat = str(raw?.timeFormat);
  out.namespace = str(raw?.namespace);
  out.eventHubName = str(raw?.eventHubName);
  out.sharedAccessPolicyName = str(raw?.sharedAccessPolicyName);
  out.sharedAccessPolicyKey = str(raw?.sharedAccessPolicyKey);
  return out;
}

/** ASA output aliases must be alphanumeric + dashes/underscores. */
function aliasFor(name: string, idx: number): string {
  const cleaned = (name || '').trim().replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || `output-${idx + 1}`;
}

/** Map a named sink to an AsaOutputCreateSpec, or return a validation error. */
function sinkToOutputSpec(sink: SqlSink, idx: number): { spec: AsaOutputCreateSpec } | { error: string } {
  const kind = (sink.kind || '').toLowerCase();
  const name = aliasFor(sink.alias || '', idx);

  if (kind === 'kusto') {
    const cluster =
      (sink.kustoClusterUrl && sink.kustoClusterUrl.trim()) ||
      process.env.LOOM_KUSTO_CLUSTER_URI ||
      'https://adx-csa-loom-shared.eastus2.kusto.windows.net';
    if (!sink.table || !sink.table.trim()) {
      return { error: `Sink "${name}" (KQL Database) needs a Table name.` };
    }
    return {
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
    if (!account) return { error: `Sink "${name}" (Lakehouse) needs an ADLS Gen2 storage account (set it here or LOOM_ADLS_ACCOUNT).` };
    if (!container) return { error: `Sink "${name}" (Lakehouse) needs a container / filesystem name.` };
    return {
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
    // Bicep emits the SINGULAR LOOM_EVENTHUB_NAMESPACE (what eventhubs-client.ts reads).
    const namespace = (sink.namespace && sink.namespace.trim())
      || process.env.LOOM_EVENTHUB_NAMESPACE || '';
    if (!namespace) return { error: `Sink "${name}" (${kind === 'reflex' ? 'Activator' : 'Event Hub'}) needs an Event Hubs namespace (set it here or LOOM_EVENTHUB_NAMESPACE).` };
    if (!sink.eventHubName || !sink.eventHubName.trim()) return { error: `Sink "${name}" needs an Event Hub name.` };
    return {
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

  return { error: `Sink "${name}" has an unsupported kind "${sink.kind}". Use kusto, lakehouse, eventhub, or reflex.` };
}

/**
 * Reduce a multi-INTO SAQL query to ONLY the statements that write to the
 * given output alias, for per-output testing. SAQL statements are
 * semicolon-separated; each `SELECT ... INTO [alias] ...` is one statement.
 * We keep statements whose INTO target (case-insensitive, bracket-agnostic)
 * matches `alias`, plus any leading WITH common-table statements (no INTO).
 */
function filterQueryToOutput(query: string, alias: string): string {
  const target = alias.replace(/[[\]]/g, '').trim().toLowerCase();
  const statements = query.split(';').map((s) => s.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const stmt of statements) {
    const m = stmt.match(/\binto\s+\[?([A-Za-z0-9_-]+)\]?/i);
    if (!m) {
      // WITH / sub-query helpers with no INTO are shared scaffolding — keep them.
      if (/^\s*with\b/i.test(stmt)) kept.push(stmt);
      continue;
    }
    if (m[1].trim().toLowerCase() === target) kept.push(stmt);
  }
  return kept.length ? kept.join(';\n') + ';' : query;
}

/** Distinct INTO aliases referenced by the query. */
function aliasesInQuery(query: string): string[] {
  const out = new Set<string>();
  const re = /\binto\s+\[?([A-Za-z0-9_-]+)\]?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) out.add(m[1].trim());
  return [...out];
}

function readOperator(state: any): SqlOperator {
  const op = state?.sqlOperator;
  if (op && typeof op === 'object') {
    return {
      query: typeof op.query === 'string' && op.query.trim() ? op.query : DEFAULT_QUERY,
      sinks: Array.isArray(op.sinks) ? op.sinks.map(cleanSink) : [],
      asaJobName: typeof op.asaJobName === 'string' ? op.asaJobName : (state?.asaJobName ?? undefined),
    };
  }
  return { query: DEFAULT_QUERY, sinks: [], asaJobName: state?.asaJobName ?? undefined };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const id = (await ctx.params).id;
    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, sqlOperator: readOperator(item.state) });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === 'string' ? body.action : '';

  try {
    const id = (await ctx.params).id;

    // -------- compile: no Cosmos record needed, validate raw text --------
    if (action === 'compile') {
      const query = typeof body?.query === 'string' ? body.query : '';
      if (!query.trim()) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });
      const inputNames: string[] = Array.isArray(body?.inputNames)
        ? body.inputNames.filter((s: any) => typeof s === 'string')
        : ['eventstream-input'];
      const res = await compileQuery(query, { inputNames });
      return NextResponse.json({
        ok: true,
        valid: res.ok,
        errors: res.errors,
        warnings: res.warnings,
        outputs: res.outputs.length ? res.outputs : aliasesInQuery(query),
        inputs: res.inputs,
        functions: res.functions,
      });
    }

    const item = await loadKustoItem(id, 'eventstream', session.claims.oid);
    if (!item) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    // -------- save: persist query + named sinks; push to ASA if job set ----
    if (action === 'save') {
      const query = typeof body?.query === 'string' && body.query.trim() ? body.query : DEFAULT_QUERY;
      const sinks: SqlSink[] = Array.isArray(body?.sinks) ? body.sinks.map(cleanSink) : [];
      const asaJobName = typeof body?.asaJobName === 'string' ? body.asaJobName.trim() : '';
      const op: SqlOperator = { query, sinks, asaJobName: asaJobName || undefined };

      let asaPushed = false;
      let asaPushHint: string | null = null;
      if (asaJobName) {
        try {
          await saveTransformation(asaJobName, query);
          asaPushed = true;
        } catch (e: any) {
          if (e instanceof AsaNotConfiguredError) {
            asaPushHint = `Saved locally, but the ASA transformation was not updated: ${e.message}`;
          } else {
            asaPushHint = `Saved locally, but the ASA transformation push failed: ${e?.message || String(e)}`;
          }
        }
      }

      await saveItemState(item, { sqlOperator: op, ...(asaJobName ? { asaJobName } : {}) });
      return NextResponse.json({ ok: true, sqlOperator: op, asaPushed, hint: asaPushHint });
    }

    // -------- apply-sinks: materialize each named sink as an ASA output ----
    if (action === 'apply-sinks') {
      const asaJobName = typeof body?.asaJobName === 'string' ? body.asaJobName.trim() : '';
      if (!asaJobName) return NextResponse.json({ ok: false, error: 'asaJobName is required' }, { status: 400 });
      const sinks: SqlSink[] = Array.isArray(body?.sinks) ? body.sinks.map(cleanSink) : readOperator(item.state).sinks;
      if (!sinks.length) {
        return NextResponse.json({ ok: false, error: 'No named sinks defined. Add at least one sink.' }, { status: 400 });
      }
      const created: Array<{ name: string; type: string; id: string }> = [];
      for (let i = 0; i < sinks.length; i++) {
        const mapped = sinkToOutputSpec(sinks[i], i);
        if ('error' in mapped) return NextResponse.json({ ok: false, error: mapped.error }, { status: 400 });
        const out = await createOrUpdateOutput(asaJobName, mapped.spec);
        created.push({ name: mapped.spec.name, type: mapped.spec.datasourceType, id: out.id });
      }
      await saveItemState(item, { asaJobName });
      return NextResponse.json({ ok: true, asaJobName, outputs: created });
    }

    // -------- test: per-output test of the multi-INTO query ----------------
    if (action === 'test') {
      const query = typeof body?.query === 'string' ? body.query : '';
      const outputAlias = typeof body?.outputAlias === 'string' ? body.outputAlias.trim() : '';
      if (!query.trim()) return NextResponse.json({ ok: false, error: 'query is required' }, { status: 400 });
      if (!outputAlias) return NextResponse.json({ ok: false, error: 'outputAlias is required for per-output test' }, { status: 400 });
      const op = readOperator(item.state);
      const asaJobName = (typeof body?.asaJobName === 'string' && body.asaJobName.trim()) || op.asaJobName || '';
      if (!asaJobName) {
        return NextResponse.json({ ok: false, error: 'asaJobName is required to run a test (the ASA job whose topology backs the test).' }, { status: 400 });
      }
      const sampleInput = Array.isArray(body?.sampleInput) ? body.sampleInput : [];
      const scoped = filterQueryToOutput(query, outputAlias);
      const res = await testTransformation(asaJobName, scoped, sampleInput);
      return NextResponse.json({
        ok: true,
        outputAlias,
        status: res.status,
        outputUri: res.outputUri,
        rows: res.outputRows,
        errors: res.errors,
      });
    }

    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: HINT }, { status: 501 });
    }
    if (e instanceof AsaTestNotAvailableError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint || HINT }, { status: 501 });
    }
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), hint: HINT }, { status });
  }
}
