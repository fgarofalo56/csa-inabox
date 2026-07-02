/**
 * SQL Database list + create — Azure-native by DEFAULT (no-fabric-dependency.md).
 *
 * The canonical SQL editor (UnifiedSqlDatabaseEditor) is fully ARM/TDS-native:
 * it lists the tenant database inventory from `/api/items/sql-databases`
 * (Microsoft.Sql/servers · managedInstances · Microsoft.DBforPostgreSQL/
 * flexibleServers) and drives objects through `/api/sqldb/*` over TDS. This
 * legacy per-item route is therefore NOT the UI's data source; it remains
 * resolvable so any legacy caller gets a graceful Azure-native response instead
 * of the old `NO_FABRIC_WS` 503 (which both violated no-fabric-dependency.md and
 * was dead for the UI).
 *
 * DEFAULT PATH (no env opt-in): GET returns an Azure-native empty payload that
 * points the caller at the unified ARM inventory; POST returns an honest Azure
 * infra-gate (never a "bind a Fabric workspace" message).
 *
 * Fabric is STRICTLY opt-in: set `LOOM_SQL_DATABASE_BACKEND=fabric` AND bind a
 * Fabric workspace to the Loom workspace. Only then are the Fabric REST calls
 * reached. Absent either, Loom stays on the Azure-native path silently.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import {
  listFabricSqlDatabases, createFabricSqlDatabase,
} from '@/lib/azure/fabric-client';
import type { Workspace } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Canonical Azure-native inventory the UnifiedSqlDatabaseEditor actually reads. */
const AZURE_INVENTORY_ENDPOINT = '/api/items/sql-databases';

/** Fabric is opt-in only (per no-fabric-dependency.md). */
function fabricBackendOptedIn(): boolean {
  return process.env.LOOM_SQL_DATABASE_BACKEND === 'fabric';
}

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

function fabricWsIdOf(ws: Workspace | null): string | null {
  if (!ws) return null;
  const cap: any = (ws as any).capacity;
  return cap?.fabricWorkspaceId || cap?.id || null;
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);

  // ---- Fabric path: STRICTLY opt-in (env + bound workspace) ----
  if (fabricBackendOptedIn()) {
    try {
      const ws = await loadWs(workspaceId, s.claims.oid);
      if (!ws) return err('workspace not found', 404);
      const fabricWs = fabricWsIdOf(ws);
      if (fabricWs) {
        const value = await listFabricSqlDatabases(fabricWs);
        return NextResponse.json({
          ok: true, workspaceId, backend: 'fabric', fabricWorkspaceId: fabricWs,
          sqlDatabases: value.map(v => ({
            id: v.id, displayName: v.displayName, description: v.description, type: v.type,
          })),
        });
      }
      // Opted into Fabric but no workspace bound → fall through to Azure-native.
    } catch (e: any) {
      return err(e?.message || String(e), e?.status || 500, e?.hint ? { hint: e.hint } : undefined);
    }
  }

  // ---- Azure-native DEFAULT path ----
  // This legacy per-item route is not the UI's data source; the canonical
  // editor reads the unified ARM inventory. Return an Azure-native empty payload
  // and point the caller there — never a Fabric gate.
  return NextResponse.json({
    ok: true,
    workspaceId,
    backend: 'azure-sql',
    sqlDatabases: [],
    inventoryEndpoint: AZURE_INVENTORY_ENDPOINT,
    hint:
      'SQL databases are inventoried Azure-natively from the unified ARM endpoint ' +
      `(${AZURE_INVENTORY_ENDPOINT}: Microsoft.Sql/servers · managedInstances · ` +
      'Microsoft.DBforPostgreSQL/flexibleServers) and edited via the unified Azure SQL editor. ' +
      'No Fabric workspace is required.',
  });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  if (!displayName) return err('displayName required', 400);

  // ---- Fabric path: STRICTLY opt-in (env + bound workspace) ----
  if (fabricBackendOptedIn()) {
    try {
      const ws = await loadWs(workspaceId, s.claims.oid);
      if (!ws) return err('workspace not found', 404);
      const fabricWs = fabricWsIdOf(ws);
      if (fabricWs) {
        const created = await createFabricSqlDatabase(fabricWs, {
          displayName,
          description: body?.description,
          definition: body?.definition,
        });
        return NextResponse.json({ ok: true, backend: 'fabric', sqlDatabase: created });
      }
      // Opted in but no workspace bound → fall through to the Azure infra-gate.
    } catch (e: any) {
      return err(e?.message || String(e), e?.status || 500, e?.hint ? { hint: e.hint } : undefined);
    }
  }

  // ---- Azure-native DEFAULT path ----
  // Provisioning an Azure SQL database is an ARM PUT against an existing logical
  // server (Microsoft.Sql/servers/databases) — done through the unified Azure SQL
  // editor's Provision tab, which targets the canonical inventory endpoint. This
  // legacy route does not own that server selection, so return an honest Azure
  // infra-gate (never a "bind a Fabric workspace" message).
  return err(
    'Create an Azure SQL database from the unified Azure SQL editor (Provision tab). ' +
    'It issues an ARM PUT on Microsoft.Sql/servers/databases against an existing logical server; ' +
    'the console UAMI must hold Contributor (or SQL DB Contributor) on the target server\'s resource group.',
    501,
    {
      code: 'AZURE_NATIVE_PROVISION',
      backend: 'azure-sql',
      inventoryEndpoint: AZURE_INVENTORY_ENDPOINT,
      hint:
        'Use the unified Azure SQL editor → Provision (ARM PUT Microsoft.Sql/servers/databases). ' +
        'Required: an existing logical server in inventory and the console UAMI granted Contributor / ' +
        'SQL DB Contributor on its resource group. No Fabric workspace is required.',
    },
  );
}
