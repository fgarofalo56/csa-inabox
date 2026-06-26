/**
 * GET /api/items/[type]/[id]/pbids
 *
 * One-click "Open in Power BI Desktop" — returns a valid Power BI Desktop
 * connection file (.pbids) that, when opened, launches Power BI Desktop already
 * pointed at the Loom item's underlying AZURE endpoint. NO Microsoft Fabric /
 * Power BI service dependency (per no-fabric-dependency.md): the file targets the
 * item's surfaced Synapse SQL / Azure SQL (TDS), Azure Analysis Services
 * (analysis-services), or Azure Data Explorer (azure-data-explorer) endpoint
 * directly. This is the Azure-native bridge — distinct from the opt-in
 * Power-BI-service "Open in Power BI" (webUrl) buttons.
 *
 *   Reply (success): the .pbids JSON body with
 *     content-type: application/json
 *     content-disposition: attachment; filename="<itemName>.pbids"
 *   Reply (gate):    412 { ok:false, code:'endpoint_not_resolvable', missing, error }
 *                    naming the missing endpoint/env var (per no-vaporware.md) —
 *                    an honest gate, NOT a broken download.
 *
 * Query: ?mode=import|directQuery  (optional; tds + adx honor it, AS ignores it).
 *
 * The .pbids carries NO credentials — Power BI Desktop prompts for the user's
 * Entra sign-in on open and the Navigator picks tables/model.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import {
  buildPbids,
  serializePbids,
  normalizeMode,
  PbidsError,
  type PbidsItemKind,
  type PbidsSource,
} from '@/lib/azure/pbids';
import { serverlessEndpoint, dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import { clusterUri, defaultDatabase, normalizeClusterUri } from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Item types this route can emit a .pbids for, mapped to a PBIDS kind. */
const SUPPORTED: Record<string, PbidsItemKind> = {
  lakehouse: 'lakehouse',
  warehouse: 'warehouse',
  'sql-database': 'sql-database',
  'mirrored-database': 'mirrored-database',
  'mirrored-databricks': 'mirrored-databricks',
  'mirrored-catalog': 'mirrored-catalog',
  'semantic-model': 'semantic-model',
  'kql-database': 'kql-database',
  eventhouse: 'eventhouse',
};

function gate(missing: string, error: string) {
  return NextResponse.json({ ok: false, code: 'endpoint_not_resolvable', missing, error }, { status: 412 });
}

/** Find an item by id (cross-partition) + verify the caller's tenant owns its workspace. */
async function loadItem(itemId: string, type: string, tenantId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  const { resources } = await items.items
    .query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.id = @id AND c.itemType = @t',
      parameters: [
        { name: '@id', value: itemId },
        { name: '@t', value: type },
      ],
    })
    .fetchAll();
  const item = resources[0];
  if (!item) return null;
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(item.workspaceId, tenantId).read<Workspace>();
    if (!resource || resource.tenantId !== tenantId) return null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
  return item;
}

function pick(state: any, keys: string[]): string {
  for (const k of keys) {
    const v = state?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function safeFilename(name: string): string {
  const base = (name || 'data-source').replace(/[^A-Za-z0-9 ._-]+/g, '_').replace(/\s+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80);
  return `${base || 'data-source'}.pbids`;
}

/**
 * Resolve the surfaced endpoint for the item and return the normalized
 * {@link PbidsSource}, or a NextResponse gate when the endpoint isn't resolvable.
 */
function resolveSource(kind: PbidsItemKind, item: WorkspaceItem, mode: PbidsSource['mode']): PbidsSource | NextResponse {
  const state = (item as any).state || {};

  // ── TDS family ──────────────────────────────────────────────────────────────
  if (kind === 'lakehouse') {
    // Lakehouse SQL analytics endpoint = the Synapse Serverless FQDN (OPENROWSET
    // over the Delta tables). Azure-native default — no Fabric SQL endpoint.
    try {
      const server = serverlessEndpoint();
      const database = pick(state, ['serverlessDatabase', 'sqlDatabase', 'database', 'databaseName']);
      return { kind, server, database, mode };
    } catch {
      return gate(
        'LOOM_SYNAPSE_WORKSPACE',
        'No Synapse Serverless SQL endpoint is configured for the lakehouse. Set LOOM_SYNAPSE_WORKSPACE to the Synapse workspace whose -ondemand endpoint serves OPENROWSET over the lakehouse Delta tables, then retry.',
      );
    }
  }
  if (kind === 'warehouse') {
    try {
      const t = dedicatedTarget();
      return { kind, server: t.server, database: t.database, mode };
    } catch {
      return gate(
        'LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL',
        'No Synapse Dedicated SQL pool endpoint is configured for the warehouse. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL, then retry.',
      );
    }
  }
  if (kind === 'sql-database' || kind === 'mirrored-database' || kind === 'mirrored-databricks' || kind === 'mirrored-catalog') {
    const server = pick(state, [
      'sqlServerFqdn', 'serverFqdn', 'fullyQualifiedDomainName', 'sqlEndpoint', 'sqlFqdn', 'endpoint', 'server',
    ]);
    if (!server) {
      return gate(
        'state.sqlServerFqdn',
        `No SQL endpoint is surfaced on this ${kind}. The item must carry its SQL server FQDN (state.sqlServerFqdn) before a .pbids can target it.`,
      );
    }
    const database = pick(state, ['database', 'databaseName', 'sqlDatabase']) || item.displayName;
    return { kind, server, database, mode };
  }

  // ── analysis-services (semantic model) ───────────────────────────────────────
  if (kind === 'semantic-model') {
    const xmlaServer = pick(state, ['aasServer', 'xmlaServer', 'asazureServer']) || (process.env.LOOM_AAS_SERVER || '').trim();
    if (!xmlaServer) {
      return gate(
        'state.aasServer / LOOM_AAS_SERVER',
        'No Analysis Services (XMLA) endpoint is bound. Set state.aasServer (e.g. asazure://<region>.asazure.windows.net/<server>) on this semantic model, or configure LOOM_AAS_SERVER, then retry.',
      );
    }
    const database = pick(state, ['aasDatabase', 'aasModel', 'model', 'database', 'databaseName'])
      || (process.env.LOOM_AAS_MODEL || process.env.LOOM_AAS_DATABASE || '').trim();
    return { kind, xmlaServer, database, mode };
  }

  // ── azure-data-explorer (kql-database / eventhouse) ──────────────────────────
  if (kind === 'kql-database' || kind === 'eventhouse') {
    const cluster = normalizeClusterUri(pick(state, ['clusterUri', 'cluster', 'queryUri'])) || clusterUri();
    if (!cluster) {
      return gate(
        'LOOM_KUSTO_CLUSTER_URI',
        'No Azure Data Explorer cluster is configured. Set LOOM_KUSTO_CLUSTER_URI to the ADX cluster URI, then retry.',
      );
    }
    const database = pick(state, ['databaseName', 'database']) || defaultDatabase();
    return { kind, cluster, database, mode };
  }

  return gate('kind', `Unsupported item kind for .pbids: ${kind}`);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const { type, id } = await ctx.params;
  const kind = SUPPORTED[type];
  if (!kind) {
    return NextResponse.json(
      { ok: false, error: `'${type}' does not support Open in Power BI Desktop` },
      { status: 400 },
    );
  }

  const mode = normalizeMode(req.nextUrl.searchParams.get('mode'));

  let item: WorkspaceItem | null;
  try {
    item = await loadItem(id, type, session.claims.oid);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Failed to load item' }, { status: 500 });
  }
  if (!item) return NextResponse.json({ ok: false, error: 'Item not found' }, { status: 404 });

  const resolved = resolveSource(kind, item, mode);
  if (resolved instanceof NextResponse) return resolved; // honest gate

  let body: string;
  try {
    body = serializePbids(buildPbids(resolved));
  } catch (e: any) {
    if (e instanceof PbidsError) {
      return gate(e.missing, e.message);
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      // PBIDS is JSON; the .pbids extension + attachment disposition make the
      // browser hand it to Power BI Desktop (the registered handler).
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${safeFilename(item.displayName || type)}"`,
      'cache-control': 'no-store',
    },
  });
}
