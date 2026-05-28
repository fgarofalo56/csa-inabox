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
 *   1. Resolve the source asset (UC `getTable` or OneLake `getFabricItem`).
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const source = body.source as 'unity-catalog' | 'onelake' | undefined;
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

    const guid = upsert.primaryGuid;
    const purviewDeepLink = guid && process.env.LOOM_PURVIEW_ACCOUNT
      ? `https://${process.env.LOOM_PURVIEW_ACCOUNT}.purview.azure.com/main.html#/asset/${encodeURIComponent(guid)}`
      : null;

    return NextResponse.json({
      ok: true,
      source,
      typeName,
      qualifiedName,
      guid,
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
