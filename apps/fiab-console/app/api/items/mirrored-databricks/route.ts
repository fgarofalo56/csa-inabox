/**
 * Mirrored Databricks list + create (audit H8).
 *
 * The Fabric REST type is MirroredAzureDatabricksCatalog. A "mirror" mounts a
 * Databricks Unity Catalog so its tables are queryable elsewhere. Per
 * .claude/rules/no-fabric-dependency.md + no-vaporware.md, create does the REAL
 * mount work on the Azure-native path — it does NOT just write a config doc:
 *
 *   1. Validate the UC source against the live Databricks REST surface and
 *      resolve the catalog's queryable Delta tables + their ADLS storage
 *      locations (resolveUcMirrorTables).
 *   2. Pair a `synapse-serverless-sql-pool` item + run its provisioner so the
 *      mounted catalog is QUERYABLE in Loom as T-SQL (one OPENROWSET
 *      FORMAT='delta' view per UC table over the table's own abfss location).
 *      This is the Azure-native "shortcut" — no Microsoft Fabric / OneLake.
 *
 * If a prerequisite is missing (Databricks not configured, no queryable Delta
 * tables, Synapse not configured) the mirror is still created but the response
 * carries an honest `pairing.gate` naming the exact requirement — no silent
 * config-doc-only success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace, WorkspaceItem } from '@/lib/types/workspace';
import { resolveUcMirrorTables } from '@/lib/azure/databricks-uc-mirror';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { synapseSqlPoolProvisioner } from '@/lib/install/provisioners/synapse-serverless-sql-pool';
import { resolveTarget } from '@/lib/install/provisioning-engine';
import { apiServerError, apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

async function loadWs(id: string, tenantId: string): Promise<Workspace | null> {
  const c = await workspacesContainer();
  try {
    const { resource } = await c.item(id, tenantId).read<Workspace>();
    return resource?.tenantId === tenantId ? resource : null;
  } catch (e: any) { if (e?.code === 404) return null; throw e; }
}

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const { resources } = await items.items.query<WorkspaceItem>({
      query: 'SELECT * FROM c WHERE c.workspaceId = @w AND c.itemType = @t ORDER BY c.updatedAt DESC',
      parameters: [{ name: '@w', value: workspaceId }, { name: '@t', value: 'mirrored-databricks' }],
    }, { partitionKey: workspaceId }).fetchAll();
    return NextResponse.json({
      ok: true, workspaceId,
      mirrors: resources.map(r => ({
        id: r.id, displayName: r.displayName, description: r.description,
        catalogName: (r.state as any)?.catalogName,
        hostname: (r.state as any)?.hostname,
        sqlItemId: (r.state as any)?.sqlItemId,
        sqlDatabase: (r.state as any)?.sqlDatabase,
        sqlEndpoint: (r.state as any)?.sqlEndpoint,
        viewCount: (r.state as any)?.viewCount,
        createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
    });
  } catch (e: any) { return apiServerError(e); }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName || '').trim();
  const catalogName = String(body?.catalogName || '').trim();
  if (!displayName) return err('displayName required', 400);
  if (!catalogName) return err('catalogName required', 400);
  // Optional explicit table subset [{schema,table}] (else: whole catalog).
  const tableSubset = Array.isArray(body?.tables)
    ? body.tables
        .map((t: any) => ({ schema: String(t?.schema || '').trim(), table: String(t?.table || '').trim() }))
        .filter((t: any) => t.schema && t.table)
    : undefined;

  try {
    const ws = await loadWs(workspaceId, s.claims.oid);
    if (!ws) return err('workspace not found', 404);
    const items = await itemsContainer();
    const now = new Date().toISOString();

    // 1. Create the mirror item (config doc) first.
    const item: WorkspaceItem = {
      id: crypto.randomUUID(), workspaceId, itemType: 'mirrored-databricks',
      displayName, description: body?.description,
      state: {
        catalogName,
        hostname: body?.hostname || process.env.LOOM_DATABRICKS_HOSTNAME || null,
        mirrorMode: body?.mirrorMode || 'AllTables',
        ...(tableSubset && tableSubset.length ? { tables: tableSubset } : {}),
      },
      createdBy: s.claims.upn || s.claims.email || s.claims.oid,
      createdAt: now, updatedAt: now,
    };
    const { resource: created } = await items.items.create(item);

    // 2. Resolve the catalog's queryable Delta tables (real Databricks REST).
    const resolved = await resolveUcMirrorTables(catalogName, { tableSubset });
    const pairing: Record<string, unknown> = {
      tablesResolved: resolved.tables.length,
      tablesSkipped: resolved.skipped,
    };

    if (!resolved.ok) {
      // Honest gate — mirror exists but is not yet queryable. Name the exact
      // requirement; do NOT report a silent success.
      pairing.ok = false;
      pairing.code = resolved.code;
      pairing.gate =
        resolved.code === 'NO_DATABRICKS'
          ? 'Databricks workspace not provisioned. Set LOOM_DATABRICKS_HOSTNAME on the Console container app and grant the Console UAMI workspace-user + USE CATALOG (docs/fiab/v3-tenant-bootstrap.md). No Fabric required.'
          : resolved.error ||
            `Catalog "${catalogName}" has no queryable Delta tables with a resolvable ADLS storage location.`;
      return NextResponse.json({ ok: true, mirror: created, pairing });
    }

    // 3. Pair + provision a Synapse Serverless SQL endpoint over the UC Delta
    //    tables (the Azure-native "shortcut" that makes the catalog queryable).
    if (!process.env.LOOM_SYNAPSE_WORKSPACE) {
      pairing.ok = false;
      pairing.code = 'NO_SYNAPSE';
      pairing.gate =
        'Unity Catalog validated (' + resolved.tables.length + ' Delta table(s)), but no Synapse Serverless ' +
        'workspace is configured to serve them. Set LOOM_SYNAPSE_WORKSPACE (the synapseServerlessSqlEndpoint output ' +
        'of landing-zone/synapse.bicep) and grant the Console UAMI Synapse SQL admin. No Fabric required.';
      return NextResponse.json({ ok: true, mirror: created, pairing });
    }

    const pairedName = `${displayName} SQL Analytics`;
    const pairedContent = {
      databricksMirrorItemId: created!.id,
      databricksMirrorName: displayName,
      ucCatalogName: catalogName,
      ucTables: resolved.tables,
    };
    const createdPair = await createOwnedItem(s, 'synapse-serverless-sql-pool', {
      workspaceId,
      displayName: pairedName,
      state: { content: pairedContent },
    });
    if (!createdPair.ok) {
      pairing.ok = false;
      pairing.code = 'PAIR_CREATE_FAILED';
      pairing.gate = createdPair.error;
      return NextResponse.json({ ok: true, mirror: created, pairing });
    }

    const result = await synapseSqlPoolProvisioner({
      session: s,
      target: resolveTarget('shared'),
      cosmosItemId: createdPair.item.id,
      workspaceId,
      displayName: pairedName,
      content: pairedContent,
      appId: 'mirrored-databricks',
    });

    pairing.ok = result.status === 'created' || result.status === 'exists';
    pairing.status = result.status;
    pairing.steps = result.steps;
    if (result.gate) pairing.gate = result.gate.remediation;
    if (result.error) pairing.error = result.error;

    // Record the pairing on the mirror item so the editor + sql-endpoint route
    // can deep-link the endpoint without re-deriving it.
    if (pairing.ok) {
      const refreshed: WorkspaceItem = {
        ...created!,
        state: {
          ...(created!.state as Record<string, unknown>),
          sqlItemId: createdPair.item.id,
          sqlDatabase: result.secondaryIds?.database,
          sqlEndpoint: result.secondaryIds?.endpoint,
          viewCount: result.secondaryIds?.viewCount,
          pairedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };
      await items.item(created!.id, workspaceId).replace(refreshed);
      return NextResponse.json({ ok: true, mirror: refreshed, pairing });
    }

    return NextResponse.json({ ok: true, mirror: created, pairing });
  } catch (e: any) { return apiServerError(e); }
}
