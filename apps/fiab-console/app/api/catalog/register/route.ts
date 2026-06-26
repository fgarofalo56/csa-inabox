/**
 * POST /api/catalog/register
 *   Cross-source registration: register a Unity Catalog table OR an
 *   OneLake item in Microsoft Purview as an Atlas entity.
 *
 *   Body: {
 *     source: 'unity-catalog' | 'onelake',
 *     // unity-catalog source:
 *     host?: string,
 *     fullName?: string,           // e.g. main.bronze.customers
 *     // onelake source:
 *     workspaceId?: string,
 *     itemId?: string,
 *     // common (optional):
 *     displayName?: string,
 *     comment?: string,
 *     owner?: string,
 *     classifications?: string[],
 *     domain?: string,             // Purview businessDomainId guid
 *   }
 *
 * Behaviour:
 *   1. Resolve the source asset: UC `getTable`; onelake → the caller's OWN Loom
 *      item from Cosmos via `listAllOwnedItems` on the DEFAULT (Azure-native,
 *      no-fabric) path, or `getFabricItem` only when LOOM_LAKEHOUSE_BACKEND=fabric
 *      is explicitly opted in; azure-database needs no pre-fetch.
 *   2. Compose an Atlas-style qualifiedName + typeName.
 *   3. Upsert via `registerAtlasEntity` — Atlas dedupes on qualifiedName.
 *   4. Return the assigned guid + a deep-link to the Purview catalog UI.
 *
 * Auth: session cookie required. Backend uses the Console UAMI tokens.
 *
 * Errors:
 *   - 400 if input missing
 *   - 404 if the source asset doesn't exist
 *   - 501 with `hint` payload if Purview is not configured
 *   - upstream status otherwise
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  registerAtlasEntity, PurviewNotConfiguredError, PurviewError,
} from '@/lib/azure/purview-client';
import {
  getTable, UnityCatalogError, UnityCatalogNotConfiguredError,
} from '@/lib/azure/unity-catalog-client';
import { getFabricItem, FabricError } from '@/lib/azure/fabric-client';
// Loom-native item resolve (DEFAULT path, no-fabric). Same helper the federated
// catalog SEARCH uses to list the caller's OWN Cosmos-backed Loom items.
import { listAllOwnedItems } from '../../items/_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Best-effort extraction of an entity guid from an Atlas upsert's
 * `mutatedEntities` map. `registerAtlasEntity` derives `primaryGuid` from
 * `guidAssignments`, which Atlas ONLY populates for newly-created entities.
 * On an idempotent re-register (an existing entity matched on qualifiedName),
 * the assigned guid arrives under `mutatedEntities` instead — a map of
 * CREATE/UPDATE/PARTIAL_UPDATE buckets, each an array of entity headers
 * carrying a real `guid`. Scanning it here lets a repeat registration still
 * surface the real guid (honouring the "200 + guid" contract the
 * azure-database path mirrors). Returns the first guid found, or undefined.
 */
function extractMutatedGuid(mutated: unknown): string | undefined {
  if (!mutated || typeof mutated !== 'object') return undefined;
  for (const bucket of Object.values(mutated as Record<string, unknown>)) {
    if (!Array.isArray(bucket)) continue;
    for (const ent of bucket) {
      const g = (ent as { guid?: unknown } | null)?.guid;
      if (typeof g === 'string' && g) return g;
    }
  }
  return undefined;
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const source = body.source as 'unity-catalog' | 'onelake' | 'azure-database' | undefined;
  if (!source) return NextResponse.json({ ok: false, error: 'source required' }, { status: 400 });

  try {
    let typeName = '';
    let qualifiedName = '';
    let displayName = body.displayName as string | undefined;
    let comment = body.comment as string | undefined;
    const owner = body.owner as string | undefined;

    if (source === 'unity-catalog') {
      const host = body.host as string;
      const fullName = body.fullName as string;
      if (!host || !fullName) {
        return NextResponse.json({ ok: false, error: 'host and fullName required' }, { status: 400 });
      }
      const table = await getTable(host, fullName);
      if (!table) {
        return NextResponse.json({ ok: false, error: `Unity Catalog table not found: ${fullName}` }, { status: 404 });
      }
      typeName = 'databricks_table';
      qualifiedName = `https://${host}/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`;
      displayName = displayName || table.name;
      comment = comment || table.comment;
    } else if (source === 'onelake') {
      const workspaceId = body.workspaceId as string;
      const itemId = body.itemId as string;
      if (!workspaceId || !itemId) {
        return NextResponse.json({ ok: false, error: 'workspaceId and itemId required' }, { status: 400 });
      }
      if (process.env.LOOM_LAKEHOUSE_BACKEND === 'fabric') {
        // OPT-IN ONLY (LOOM_LAKEHOUSE_BACKEND=fabric): resolve the asset from a
        // REAL Fabric workspace via the Fabric REST API. Per
        // no-fabric-dependency.md, api.fabric.microsoft.com is reached ONLY on
        // this explicitly-opted-in path — never on the default below.
        const item = await getFabricItem(workspaceId, itemId);
        if (!item) {
          return NextResponse.json({ ok: false, error: 'OneLake item not found' }, { status: 404 });
        }
        typeName = item.type === 'Warehouse' ? 'fabric_warehouse'
          : item.type === 'Lakehouse' ? 'fabric_lakehouse'
          : 'fabric_item';
        qualifiedName = `https://onelake.dfs.fabric.microsoft.com/${workspaceId}/${itemId}`;
        displayName = displayName || item.displayName;
        comment = comment || item.description;
      } else {
        // DEFAULT (Azure-native, no-fabric): a Loom item lives in Loom's OWN
        // Cosmos store, NOT a real Fabric workspace. Resolve it exactly the way
        // the federated catalog SEARCH does (listAllOwnedItems) — zero calls to
        // api.fabric.microsoft.com on this path.
        const owned = await listAllOwnedItems(s.claims.oid, workspaceId);
        const item = owned.find((i) => i.id === itemId);
        if (!item) {
          return NextResponse.json({ ok: false, error: 'Loom item not found' }, { status: 404 });
        }
        typeName = item.itemType === 'lakehouse' ? 'loom_lakehouse'
          : item.itemType === 'warehouse' ? 'loom_warehouse'
          : item.itemType === 'semantic-model' ? 'loom_semantic_model'
          : item.itemType === 'kql-database' ? 'loom_kql_database'
          : item.itemType === 'sql-database' ? 'loom_sql_database'
          : 'loom_item';
        // Azure-native Atlas-dedup key: prefer the item's real ADLS/abfss path
        // when its state carries one; else a stable Loom identity URI. NEVER an
        // onelake.dfs.fabric host on the default path.
        const st = (item.state || {}) as Record<string, unknown>;
        const path = [st.abfssPath, st.adlsPath, st.lakehousePath, st.storagePath]
          .find((v) => typeof v === 'string' && v) as string | undefined;
        qualifiedName = path || `loom://workspaces/${workspaceId}/items/${itemId}`;
        displayName = displayName || item.displayName;
        comment = comment || item.description;
      }
    } else if (source === 'azure-database') {
      // Register an Azure database (Azure SQL DB / MI / PostgreSQL flexible
      // server) as an Atlas entity in Purview using its FQDN + database name
      // as the qualifiedName. No source pre-fetch is needed — the caller
      // already selected a live server/database from the ARM inventory.
      const family = body.family as 'azure-sql' | 'managed-instance' | 'postgres' | undefined;
      const fqdn = body.fqdn as string;
      const database = body.database as string;
      if (!family || !fqdn) {
        return NextResponse.json({ ok: false, error: 'family and fqdn required for azure-database source' }, { status: 400 });
      }
      typeName = family === 'postgres' ? 'azure_postgresql_server' : 'azure_sql_db';
      qualifiedName = database
        ? `mssql://${fqdn}/${encodeURIComponent(database)}`
        : `mssql://${fqdn}`;
      if (family === 'postgres') {
        qualifiedName = database ? `postgresql://${fqdn}/${encodeURIComponent(database)}` : `postgresql://${fqdn}`;
      }
      displayName = displayName || database || fqdn;
    } else {
      return NextResponse.json({ ok: false, error: `Unsupported source: ${source}` }, { status: 400 });
    }

    if (!displayName) return NextResponse.json({ ok: false, error: 'displayName could not be resolved' }, { status: 400 });

    const upsert = await registerAtlasEntity({
      typeName,
      qualifiedName,
      displayName,
      comment,
      owner,
      classifications: Array.isArray(body.classifications) ? body.classifications : undefined,
      domain: body.domain,
    });

    // `upsert.primaryGuid` is populated only when Atlas creates a NEW entity
    // (it comes from `guidAssignments`). On an idempotent re-register the guid
    // arrives under `mutatedEntities` instead, leaving `primaryGuid` undefined
    // — recover it from there so a repeat write still returns the real guid and
    // honours the "200 + guid" contract the azure-database path mirrors.
    const guid = upsert.primaryGuid || extractMutatedGuid(upsert.mutatedEntities);
    const purviewDeepLink = guid && process.env.LOOM_PURVIEW_ACCOUNT
      ? `https://${process.env.LOOM_PURVIEW_ACCOUNT}.purview.azure.com/main.html#/asset/${encodeURIComponent(guid)}`
      : null;

    // Honest no-vaporware signal: a 200 with NO guid is not the same as a real
    // upsert. Surface a soft warning (and an explicit `guidAssigned` flag) so
    // callers can distinguish a guid-bearing Atlas write from a guid-less
    // response (e.g. an Atlas store that accepted the POST but returned neither
    // a guidAssignment nor a mutated entity) without re-parsing `raw`.
    const warning = guid
      ? undefined
      : 'Purview accepted the entity but returned no guid assignment; the asset may already exist, or the Atlas response omitted guids. Re-query by qualifiedName to confirm the registration.';

    return NextResponse.json({
      ok: true,
      source,
      typeName,
      qualifiedName,
      guid,
      guidAssigned: Boolean(guid),
      ...(warning ? { warning } : {}),
      purviewDeepLink,
      raw: upsert,
    });
  } catch (e: any) {
    if (e instanceof PurviewNotConfiguredError || e instanceof UnityCatalogNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: e.hint }, { status: 501 });
    }
    const status = e instanceof PurviewError || e instanceof UnityCatalogError || e instanceof FabricError
      ? e.status
      : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e), endpoint: e?.endpoint, body: e?.body }, { status: status || 500 });
  }
}
