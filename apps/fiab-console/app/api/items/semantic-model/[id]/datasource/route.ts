/**
 * GET  /api/items/semantic-model/[id]/datasource?workspaceId=...&itemId=...
 *   Returns the persisted DirectQuery source config (from the Loom item's
 *   `state.dqSource`, looked up by `itemId` cross-partition) — or null.
 *
 * PUT  /api/items/semantic-model/[id]/datasource?workspaceId=...&itemId=...
 *   Body: { action, sourceType, server, database, secretRef?, tables[] }
 *     action='test'   → probe the source (SELECT 1 / print 1 / .show cluster)
 *     action='tables' → list base tables on the source
 *     action='apply'  → push DirectQuery TMSL to the AAS model (real XMLA write)
 *                        + persist config to Cosmos
 *     action='save'   → persist config to Cosmos only (no AAS call)
 *
 *   Azure-native by default (no-fabric-dependency.md): source reached via the
 *   Synapse / Azure SQL TDS clients or the ADX REST client — NO Fabric / Power
 *   BI host on the default path, and the DirectQuery write targets Azure
 *   Analysis Services (aas-client), not a Fabric capacity.
 *
 *   Honest gates (no-vaporware.md):
 *     - secretRef supplied but KV not configured        → 503 LOOM_KV_NAME
 *     - secretRef supplied but secret not found          → 503 (name surfaced)
 *     - action='apply' but AAS not configured            → 503 LOOM_AAS_SERVER/REGION/MODEL
 *     - action='test'/'tables' + ADX cluster unset       → 503 LOOM_KUSTO_CLUSTER_URI
 *
 * POST /api/items/semantic-model/[id]/datasource?workspaceId=...
 *
 * Composite + Dual storage mode. Builds a `model.bim` TMSL with a per-partition
 * storage mode (`import` / `directQuery` / `dual`) for every table in the body
 * — so one semantic model can mix modes — then applies it and probes the live
 * model.
 *
 * APPLY PATH (no-vaporware.md / no-fabric-dependency.md)
 *   - The TMSL is ALWAYS built and returned (the receipt).
 *   - Fabric / Power-BI-Premium opt-in (LOOM_SEMANTIC_BACKEND=fabric or a bound
 *     LOOM_FABRIC_WORKSPACE_ID / LOOM_DEFAULT_FABRIC_WORKSPACE): the TMSL is
 *     applied in-place via the Fabric updateDefinition REST API. applied=true.
 *   - Otherwise: applied=false and the TMSL is the offline receipt.
 *   - After build/apply, a DAX probe EVALUATE TOPN(1, '<firstTable>') runs
 *     against the live model via Power BI executeQueries.
 *
 * GOV GATE: in a US-Gov boundary, `dual` mode is rejected with a precise 400 —
 * Dual requires Power BI Premium / Fabric capacity, unavailable for standalone
 * AAS at GCC-High / IL5.
 *
 * 200 → { ok: true, tmsl, applied, probe?, steps }
 * 4xx/5xx → { ok: false, error, steps? }
 *
 * No mocks. All errors surfaced verbatim.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  AasError,
  buildCompositeTmsl,
  applyTmslViaFabric,
  TABLE_STORAGE_MODES,
  applyDqSource,
  dqSourceConfigGate,
  type CompositeTableSpec,
  type CompositeRelationship,
  type CompositeDataSource,
  type TableStorageMode,
  type DqSourceConfig,
  type DqSourceType,
} from '@/lib/azure/aas-client';
import { executeDatasetQueries, PowerBiError } from '@/lib/azure/powerbi-client';
import { isGovCloud } from '@/lib/azure/cloud-endpoints';
import { kvSecretsConfigGate, getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import {
  serverlessTarget,
  dedicatedTarget,
  executeQuery as synapseExecute,
  type SynapseTarget,
} from '@/lib/azure/synapse-sql-client';
import { executeQuery as azureSqlExecute } from '@/lib/azure/azure-sql-client';
import {
  executeQuery as kustoQuery,
  executeMgmtCommand as kustoMgmt,
  kustoConfigGate,
  defaultDatabase,
} from '@/lib/azure/kusto-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_DQ_SOURCES: DqSourceType[] = ['synapse-serverless', 'synapse-dedicated', 'azure-sql', 'adx'];

const DQ_TABLE_SQL = `SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME`;
const DQ_PROBE_SQL = `SELECT 1 AS probe`;
const DQ_TABLE_KQL = `.show tables`;
const DQ_PROBE_KQL = `print probe = 1`;

function dqErr(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}
function dqGate(missing: string, detail: string) {
  return NextResponse.json({ ok: false, code: 'not_configured', missing, error: detail }, { status: 503 });
}

async function dqFindItem(itemId: string): Promise<WorkspaceItem | null> {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({
        query: 'SELECT * FROM c WHERE c.id = @id',
        parameters: [{ name: '@id', value: itemId }],
      })
      .fetchAll();
    return resources[0] ?? null;
  } catch {
    return null;
  }
}

async function dqSaveConfig(itemId: string | null, config: DqSourceConfig): Promise<boolean> {
  if (!itemId) return false;
  const existing = await dqFindItem(itemId);
  if (!existing) return false;
  const items = await itemsContainer();
  const next: WorkspaceItem = {
    ...existing,
    state: { ...(existing.state || {}), dqSource: config },
    updatedAt: new Date().toISOString(),
  };
  await items.item(existing.id, existing.workspaceId).replace(next);
  return true;
}

async function dqResolveDefaultServer(sourceType: DqSourceType, database: string): Promise<string> {
  try {
    if (sourceType === 'synapse-serverless') return serverlessTarget(database || 'master').server;
    if (sourceType === 'synapse-dedicated') return dedicatedTarget().server;
  } catch {
    /* env not set */
  }
  return '';
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return dqErr('unauthenticated', 401);
  await ctx.params;
  const itemId = req.nextUrl.searchParams.get('itemId');
  const existing = itemId ? await dqFindItem(itemId) : null;
  const config = (existing?.state as any)?.dqSource ?? null;
  return NextResponse.json({ ok: true, config });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return dqErr('unauthenticated', 401);
  await ctx.params;
  const itemId = req.nextUrl.searchParams.get('itemId');

  const body = await req.json().catch(() => ({} as any));
  const action: string = body.action || 'save';
  const sourceType: DqSourceType = body.sourceType;
  const server: string = String(body.server || '').trim();
  const database: string = String(body.database || '').trim();
  const secretRef: string | undefined = body.secretRef ? String(body.secretRef).trim() : undefined;
  const tables: string[] = Array.isArray(body.tables) ? body.tables.map((t: unknown) => String(t)) : [];

  if (!VALID_DQ_SOURCES.includes(sourceType)) {
    return dqErr(`sourceType must be one of: ${VALID_DQ_SOURCES.join(', ')}`, 400);
  }

  if (secretRef) {
    const kvGate = kvSecretsConfigGate();
    if (kvGate) return dqGate(kvGate.missing, kvGate.detail);
    try {
      await getKeyVaultSecretValue(secretRef);
    } catch (e: any) {
      return dqGate(
        secretRef,
        `Key Vault secret "${secretRef}" did not resolve: ${e?.message || String(e)}. ` +
          'Create it (the DirectQuery source connection string / credential) or clear the secret ' +
          'reference to use the Console managed identity.',
      );
    }
  }

  try {
    if (action === 'test' || action === 'tables') {
      const wantTables = action === 'tables';
      if (sourceType === 'adx') {
        const kGate = kustoConfigGate();
        if (kGate) return dqGate(kGate.missing, `Azure Data Explorer is not configured: set ${kGate.missing} to bind a DirectQuery source against ADX.`);
        const db = database || defaultDatabase();
        const result = wantTables ? await kustoMgmt(db, DQ_TABLE_KQL) : await kustoQuery(db, DQ_PROBE_KQL);
        const names = wantTables ? result.rows.map((r) => String(r[0])) : [];
        return NextResponse.json({
          ok: true,
          action,
          columns: result.columns,
          rows: result.rows.slice(0, 50),
          tables: names,
          executionMs: result.executionMs,
        });
      }

      const sql = wantTables ? DQ_TABLE_SQL : DQ_PROBE_SQL;
      if (sourceType === 'azure-sql') {
        if (!server) return dqErr('server (FQDN) required for azure-sql source', 400);
        const result = await azureSqlExecute(server, database || 'master', sql);
        const names = wantTables ? result.rows.map((r) => String(r[0])) : [];
        return NextResponse.json({
          ok: true,
          action,
          columns: result.columns,
          rows: result.rows.slice(0, 50),
          tables: names,
          executionMs: result.executionMs,
        });
      }
      let target: SynapseTarget;
      if (sourceType === 'synapse-serverless') {
        target = server
          ? { server, database: database || 'master', cacheKey: `serverless:${server}:${database || 'master'}` }
          : serverlessTarget(database || 'master');
      } else {
        target = server
          ? { server, database: database || 'master', cacheKey: `dedicated:${server}:${database || 'master'}` }
          : dedicatedTarget();
      }
      const result = await synapseExecute(target, sql);
      const names = wantTables ? result.rows.map((r) => String(r[0])) : [];
      return NextResponse.json({
        ok: true,
        action,
        columns: result.columns,
        rows: result.rows.slice(0, 50),
        tables: names,
        executionMs: result.executionMs,
        endpoint: target.server,
      });
    }

    if (action === 'apply') {
      const aGate = dqSourceConfigGate();
      if (aGate) return dqGate(aGate.missing, aGate.detail);
      if (!tables.length) return dqErr('tables[] required for apply', 400);
      const effServer = server || (await dqResolveDefaultServer(sourceType, database));
      const config: DqSourceConfig = {
        sourceType,
        server: effServer,
        database,
        secretRef,
        tables,
        appliedAt: new Date().toISOString(),
      };
      await applyDqSource(config);
      const persisted = await dqSaveConfig(itemId, config);
      return NextResponse.json({ ok: true, action: 'applied', config, persisted });
    }

    if (action === 'save') {
      const config: DqSourceConfig = {
        sourceType,
        server,
        database,
        secretRef,
        tables,
        appliedAt: new Date().toISOString(),
      };
      const persisted = await dqSaveConfig(itemId, config);
      return NextResponse.json({ ok: true, action: 'saved', config, persisted });
    }

    return dqErr(`unknown action: ${action}`, 400);
  } catch (e: any) {
    if (e instanceof AasError && (e as any).code === 'not_configured' && (e as any).missing) {
      return dqGate((e as any).missing, e.message);
    }
    const status = typeof e?.status === 'number' ? Math.min(Math.max(e.status, 400), 599) : 502;
    return dqErr(e?.message || String(e), status);
  }
}

interface DatasourceBody {
  displayName?: string;
  tables?: Array<{
    name?: string;
    mode?: string;
    sourceQuery?: string;
    dataSourceName?: string;
    columns?: Array<{ name: string; dataType?: string; sourceColumn?: string }>;
    measures?: Array<{ name: string; expression: string; formatString?: string }>;
  }>;
  relationships?: CompositeRelationship[];
  dataSources?: CompositeDataSource[];
}

function fabricBackend(workspaceId: string): { ws: string } | null {
  const optedIn =
    (process.env.LOOM_SEMANTIC_BACKEND || '').toLowerCase() === 'fabric' ||
    !!process.env.LOOM_FABRIC_WORKSPACE_ID ||
    !!process.env.LOOM_DEFAULT_FABRIC_WORKSPACE;
  if (!optedIn) return null;
  const ws = process.env.LOOM_FABRIC_WORKSPACE_ID || process.env.LOOM_DEFAULT_FABRIC_WORKSPACE || workspaceId;
  return ws ? { ws } : null;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  const body = (await req.json().catch(() => ({}))) as DatasourceBody;
  const rawTables = Array.isArray(body.tables) ? body.tables : [];
  if (rawTables.length === 0) {
    return NextResponse.json({ ok: false, error: 'tables[] required' }, { status: 400 });
  }

  const gov = isGovCloud();
  const tables: CompositeTableSpec[] = [];
  for (const t of rawTables) {
    const name = (t.name || '').trim();
    if (!name) return NextResponse.json({ ok: false, error: 'each table needs a name' }, { status: 400 });
    const mode = t.mode as TableStorageMode;
    if (!TABLE_STORAGE_MODES.includes(mode)) {
      return NextResponse.json(
        { ok: false, error: `invalid storage mode "${t.mode}" for table "${name}"` },
        { status: 400 },
      );
    }
    if ((mode === 'directQuery' || mode === 'dual') && !(t.sourceQuery || '').trim()) {
      return NextResponse.json(
        { ok: false, error: `table "${name}" mode="${mode}" requires sourceQuery` },
        { status: 400 },
      );
    }
    if (mode === 'dual' && gov) {
      return NextResponse.json(
        {
          ok: false,
          error:
            `Dual storage mode requires Power BI Premium / Fabric capacity. This deployment is a US-Gov boundary ` +
            `(GCC-High / IL5) where standalone Azure Analysis Services supports only Import and DirectQuery. ` +
            `Set table "${name}" to Import or DirectQuery.`,
        },
        { status: 400 },
      );
    }
    tables.push({
      name,
      mode,
      sourceQuery: t.sourceQuery,
      dataSourceName: t.dataSourceName,
      columns: t.columns,
      measures: t.measures,
    });
  }

  const steps: string[] = [];
  let tmsl: string;
  try {
    tmsl = buildCompositeTmsl(
      (body.displayName || 'CompositeModel').trim(),
      tables,
      body.relationships,
      body.dataSources,
      { targetEngine: gov ? 'aas-standalone' : 'fabric' },
    );
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 400;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
  const modeSummary = tables.map((t) => `${t.name}=${t.mode}`).join(', ');
  steps.push(`Built composite TMSL: ${tmsl.length} bytes, ${tables.length} table(s) [${modeSummary}].`);

  let applied = false;
  const fabric = fabricBackend(workspaceId);
  try {
    if (fabric) {
      const modelId = process.env.LOOM_FABRIC_SEMANTIC_MODEL_ID || id;
      await applyTmslViaFabric(fabric.ws, modelId, tmsl, body.displayName || 'CompositeModel', steps);
      applied = true;
      steps.push('Composite TMSL applied in-place via Fabric updateDefinition.');
    } else {
      steps.push(
        'No Fabric/Premium backend configured — TMSL built as receipt. Apply offline via ' +
          'Invoke-ASCmd, or set LOOM_SEMANTIC_BACKEND=fabric with a bound LOOM_FABRIC_WORKSPACE_ID.',
      );
    }
  } catch (e: any) {
    const status = e instanceof AasError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), tmsl, steps }, { status });
  }

  let probe: string | undefined;
  try {
    const firstTable = tables[0].name.replace(/'/g, "''");
    const dax = `EVALUATE TOPN(1, '${firstTable}')`;
    const qr = await executeDatasetQueries(workspaceId, id, dax);
    const rows = qr?.results?.[0]?.tables?.[0]?.rows || [];
    probe = JSON.stringify(rows).slice(0, 300);
    steps.push(`DAX probe EVALUATE TOPN(1, '${tables[0].name}') returned ${rows.length} row(s).`);
  } catch (e: any) {
    const status = e instanceof PowerBiError ? e.status : 0;
    steps.push(`DAX probe skipped (${status || 'error'}): ${e?.message || String(e)}`);
  }

  return NextResponse.json({ ok: true, tmsl, applied, probe, steps });
}
