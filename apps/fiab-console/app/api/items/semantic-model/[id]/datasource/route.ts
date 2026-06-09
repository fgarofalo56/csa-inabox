/**
 * GET  /api/items/semantic-model/[id]/datasource?workspaceId=...&itemId=...
 *   Returns the persisted DirectQuery source config (from the Loom item's
 *   `state.dqSource`, looked up by `itemId` cross-partition) — or null.
 *
 * PUT  /api/items/semantic-model/[id]/datasource?workspaceId=...&itemId=...
 *   Body: { action, sourceType, server, database, secretRef?, tables[] }
 *     action='test'   → probe the source (SELECT 1 / print 1 / .show cluster)
 *     action='tables' → list base tables on the source (INFORMATION_SCHEMA / .show tables)
 *     action='apply'  → push DirectQuery TMSL to the AAS model (real XMLA write)
 *                        + persist config to Cosmos
 *     action='save'   → persist config to Cosmos only (no AAS call)
 *
 * Azure-native by default (no-fabric-dependency.md): the source is reached via
 * the Synapse / Azure SQL TDS clients or the ADX REST client — NO Fabric /
 * Power BI host on the default path, and the DirectQuery write targets Azure
 * Analysis Services (aas-client), not a Fabric capacity.
 *
 * Honest gates (no-vaporware.md):
 *   - secretRef supplied but KV not configured  → 503 LOOM_KV_NAME
 *   - secretRef supplied but secret not found    → 503 (name surfaced)
 *   - action='apply' but AAS not configured      → 503 LOOM_AAS_SERVER/REGION/MODEL
 *   - action='test'/'tables' but the ADX cluster not configured → 503 LOOM_KUSTO_CLUSTER_URI
 *
 * All hosts resolve through cloud-endpoints (gov-correct suffixes).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  aasConfigGate, applyDqSource, AasError,
  type DqSourceConfig, type DqSourceType,
} from '@/lib/azure/aas-client';
import { kvSecretsConfigGate, getKeyVaultSecretValue } from '@/lib/azure/kv-secrets-client';
import {
  serverlessTarget, dedicatedTarget, executeQuery as synapseExecute,
  type SynapseTarget,
} from '@/lib/azure/synapse-sql-client';
import { executeQuery as azureSqlExecute } from '@/lib/azure/azure-sql-client';
import { executeQuery as kustoQuery, executeMgmtCommand as kustoMgmt, kustoConfigGate, defaultDatabase } from '@/lib/azure/kusto-client';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_SOURCES: DqSourceType[] = ['synapse-serverless', 'synapse-dedicated', 'azure-sql', 'adx'];

// Base-table discovery + a 1-row probe per dialect. INFORMATION_SCHEMA is the
// ANSI catalog view present on Synapse (Serverless + Dedicated) and Azure SQL.
const DQ_TABLE_SQL = `SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME`;
const DQ_PROBE_SQL = `SELECT 1 AS probe`;
const DQ_TABLE_KQL = `.show tables`;
const DQ_PROBE_KQL = `print probe = 1`;

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}
function gate(missing: string, detail: string) {
  return NextResponse.json({ ok: false, code: 'not_configured', missing, error: detail }, { status: 503 });
}

/** Cross-partition lookup of a Loom item by id (partition key = workspaceId). */
async function findItem(itemId: string): Promise<WorkspaceItem | null> {
  try {
    const items = await itemsContainer();
    const { resources } = await items.items
      .query<WorkspaceItem>({ query: 'SELECT * FROM c WHERE c.id = @id', parameters: [{ name: '@id', value: itemId }] })
      .fetchAll();
    return resources[0] ?? null;
  } catch { return null; }
}

async function saveDqConfig(itemId: string | null, config: DqSourceConfig): Promise<boolean> {
  if (!itemId) return false;
  const existing = await findItem(itemId);
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

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  await ctx.params; // path id reserved for AAS targeting; config keyed by itemId
  const itemId = req.nextUrl.searchParams.get('itemId');
  const existing = itemId ? await findItem(itemId) : null;
  const config = (existing?.state as any)?.dqSource ?? null;
  return NextResponse.json({ ok: true, config });
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return err('unauthenticated', 401);
  await ctx.params;
  const itemId = req.nextUrl.searchParams.get('itemId');

  const body = await req.json().catch(() => ({} as any));
  const action: string = body.action || 'save';
  const sourceType: DqSourceType = body.sourceType;
  const server: string = String(body.server || '').trim();
  const database: string = String(body.database || '').trim();
  const secretRef: string | undefined = body.secretRef ? String(body.secretRef).trim() : undefined;
  const tables: string[] = Array.isArray(body.tables) ? body.tables.map((t: unknown) => String(t)) : [];

  if (!VALID_SOURCES.includes(sourceType)) {
    return err(`sourceType must be one of: ${VALID_SOURCES.join(', ')}`, 400);
  }

  // Honest gate: a KV secret reference requires KV to be configured, and the
  // named secret must actually resolve (real KV data-plane read).
  if (secretRef) {
    const kvGate = kvSecretsConfigGate();
    if (kvGate) return gate(kvGate.missing, kvGate.detail);
    try {
      await getKeyVaultSecretValue(secretRef);
    } catch (e: any) {
      return gate(secretRef, `Key Vault secret "${secretRef}" did not resolve: ${e?.message || String(e)}. Create it (the DirectQuery source connection string / credential) or clear the secret reference to use the Console managed identity.`);
    }
  }

  try {
    if (action === 'test' || action === 'tables') {
      const wantTables = action === 'tables';
      if (sourceType === 'adx') {
        const kGate = kustoConfigGate();
        if (kGate) return gate(kGate.missing, `Azure Data Explorer is not configured: set ${kGate.missing} to bind a DirectQuery source against ADX.`);
        const db = database || defaultDatabase();
        const result = wantTables ? await kustoMgmt(db, DQ_TABLE_KQL) : await kustoQuery(db, DQ_PROBE_KQL);
        const names = wantTables ? result.rows.map((r) => String(r[0])) : [];
        return NextResponse.json({ ok: true, action, columns: result.columns, rows: result.rows.slice(0, 50), tables: names, executionMs: result.executionMs });
      }

      // TDS family (Synapse Serverless / Dedicated / Azure SQL).
      const sql = wantTables ? DQ_TABLE_SQL : DQ_PROBE_SQL;
      if (sourceType === 'azure-sql') {
        if (!server) return err('server (FQDN) required for azure-sql source', 400);
        const result = await azureSqlExecute(server, database || 'master', sql);
        const names = wantTables ? result.rows.map((r) => String(r[0])) : [];
        return NextResponse.json({ ok: true, action, columns: result.columns, rows: result.rows.slice(0, 50), tables: names, executionMs: result.executionMs });
      }
      // Synapse Serverless / Dedicated — env-bound workspace; optional override.
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
      return NextResponse.json({ ok: true, action, columns: result.columns, rows: result.rows.slice(0, 50), tables: names, executionMs: result.executionMs, endpoint: target.server });
    }

    if (action === 'apply') {
      const aGate = aasConfigGate();
      if (aGate) return gate(aGate.missing, aGate.detail);
      if (!tables.length) return err('tables[] required for apply', 400);
      const effServer = server || (await resolveDefaultServer(sourceType, database));
      const config: DqSourceConfig = { sourceType, server: effServer, database, secretRef, tables, appliedAt: new Date().toISOString() };
      await applyDqSource(config);
      const persisted = await saveDqConfig(itemId, config);
      return NextResponse.json({ ok: true, action: 'applied', config, persisted });
    }

    if (action === 'save') {
      const config: DqSourceConfig = { sourceType, server, database, secretRef, tables, appliedAt: new Date().toISOString() };
      const persisted = await saveDqConfig(itemId, config);
      return NextResponse.json({ ok: true, action: 'saved', config, persisted });
    }

    return err(`unknown action: ${action}`, 400);
  } catch (e: any) {
    if (e instanceof AasError && e.code === 'not_configured' && e.missing) {
      return gate(e.missing, e.message);
    }
    const status = typeof e?.status === 'number' ? Math.min(Math.max(e.status, 400), 599) : 502;
    return err(e?.message || String(e), status);
  }
}

/** Best-effort default source FQDN for env-bound Synapse when the caller did
 *  not override `server` — used so the AAS DataSource records a concrete host. */
async function resolveDefaultServer(sourceType: DqSourceType, database: string): Promise<string> {
  try {
    if (sourceType === 'synapse-serverless') return serverlessTarget(database || 'master').server;
    if (sourceType === 'synapse-dedicated') return dedicatedTarget().server;
  } catch { /* env not set — caller-supplied server is required, validated upstream */ }
  return '';
}
