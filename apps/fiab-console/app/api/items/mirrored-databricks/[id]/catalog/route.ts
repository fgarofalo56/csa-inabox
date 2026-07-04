/**
 * GET /api/items/mirrored-databricks/[id]/catalog?workspaceId=...&schema=
 *
 * Returns live Unity Catalog metadata for the mounted catalog. With no
 * `schema` query param it lists schemas. With `schema=foo` it lists tables
 * in that schema. Both call Databricks REST /api/2.1/unity-catalog/* on
 * behalf of the BFF's UAMI (or the user's OBO token in local dev) using
 * the AAD scope 2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default.
 *
 * If LOOM_DATABRICKS_HOSTNAME is not configured the route returns
 * { ok: false, error, code: 'NO_DATABRICKS' } so the editor can surface
 * the documented MessageBar config-gap instead of a generic 500.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { listUcSchemas, listUcTables } from '@/lib/azure/databricks-client';
import { apiError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return apiError(error, status, extra);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return err('mirrored databricks catalog not found', 404);

  if (!process.env.LOOM_DATABRICKS_HOSTNAME) {
    return err(
      'Databricks workspace not provisioned in this deployment',
      503,
      {
        code: 'NO_DATABRICKS',
        hint: 'Set LOOM_DATABRICKS_HOSTNAME (e.g. adb-...azuredatabricks.net) on the Console container app and grant the Console UAMI workspace-user via the SCIM bootstrap step (see docs/fiab/v3-tenant-bootstrap.md).',
      },
    );
  }

  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'mirrored-databricks') return err('mirrored databricks catalog not found', 404);
    const catalogName = (resource.state as any)?.catalogName;
    if (!catalogName) return err('catalogName not set on this mirror', 400, { code: 'NO_CATALOG' });

    const schema = req.nextUrl.searchParams.get('schema');
    if (schema) {
      const tables = await listUcTables(catalogName, schema);
      return NextResponse.json({ ok: true, catalogName, schemaName: schema, tables });
    }
    const schemas = await listUcSchemas(catalogName);
    return NextResponse.json({ ok: true, catalogName, schemas });
  } catch (e: any) {
    const msg = e?.message || String(e);
    const status = /403|401/.test(msg) ? 403 : 500;
    return err(msg, status);
  }
}
