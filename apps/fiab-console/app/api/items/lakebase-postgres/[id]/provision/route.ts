/**
 * GET  /api/items/lakebase-postgres/[id]/provision
 *   Wizard data: the curated SKU / storage / version / HA option catalogs
 *   (dropdown sources — no-freeform-config) + the subscription inventory of
 *   existing Flexible Servers the operator can bind instead of creating one.
 *
 * POST /api/items/lakebase-postgres/[id]/provision
 *   Create a new Flexible Server via ARM PUT and bind it to this item. Body:
 *     { name, resourceGroup, location, administratorLogin,
 *       administratorLoginPassword, skuName, storageGb?, version? }
 *   HA is applied on the create body via the selected mode.
 *
 * Real backend: postgres-flex-client.createServer (ARM). A missing role/quota
 * surfaces as an honest ARM error, never a fake success.
 */
import { NextRequest } from 'next/server';
import { apiOk, apiError, apiServerError, apiHonestError } from '@/lib/api/respond';
import {
  createServer, listServers, getServer,
  PG_SKU_CATALOG, PG_STORAGE_OPTIONS, PG_VERSION_OPTIONS, PG_HA_OPTIONS, findSku,
  PostgresError, type CreatePostgresSpec,
} from '@/lib/azure/postgres-flex-client';
import { saveLakebase } from '@/lib/lakebase/lakebase-store';
import { authItem, isError } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id);
  if (isError(r)) return r.error;
  let servers: unknown[] = [];
  let inventoryError: string | undefined;
  try {
    servers = await listServers();
  } catch (e) {
    inventoryError = e instanceof PostgresError ? e.message : 'failed to list servers';
  }
  return apiOk({
    catalog: {
      skus: PG_SKU_CATALOG,
      storageGb: PG_STORAGE_OPTIONS,
      versions: PG_VERSION_OPTIONS,
      ha: PG_HA_OPTIONS,
    },
    servers,
    inventoryError,
  });
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const r = await authItem(id, { write: true });
  if (isError(r)) return r.error;
  const { item } = r;

  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }

  const skuName = String(body?.skuName || '').trim();
  const sku = findSku(skuName);
  if (!sku) return apiError(`skuName must be one of the catalog SKUs`, 400, { code: 'bad_sku' });

  const spec: CreatePostgresSpec = {
    name: String(body?.name || '').trim(),
    resourceGroup: String(body?.resourceGroup || '').trim(),
    location: String(body?.location || '').trim(),
    administratorLogin: String(body?.administratorLogin || '').trim(),
    administratorLoginPassword: String(body?.administratorLoginPassword || ''),
    skuName: sku.name,
    tier: sku.tier,
    version: PG_VERSION_OPTIONS.includes(String(body?.version)) ? String(body.version) : undefined,
    storageGb: PG_STORAGE_OPTIONS.includes(Number(body?.storageGb)) ? Number(body.storageGb) : undefined,
  };

  try {
    const result = await createServer(spec);
    if (!result.ok) return apiHonestError(result.error, result.status >= 400 && result.status < 600 ? result.status : 502);
    // Resolve the freshly-created server so the item binds to a concrete ref.
    let bound;
    try {
      const srv = await getServer(spec.name);
      bound = { name: srv.name, id: srv.id, fqdn: srv.fqdn, resourceGroup: srv.resourceGroup, location: srv.location };
    } catch {
      bound = { name: spec.name, id: result.id, fqdn: `${spec.name}.${process.env.LOOM_POSTGRES_HOST_SUFFIX || 'postgres.database.azure.com'}`, resourceGroup: spec.resourceGroup, location: spec.location };
    }
    const updated = await saveLakebase(item, { server: bound, backend: 'postgres' });
    return apiOk({ provisioned: result, config: (updated.state as any).lakebase }, { status: 202 });
  } catch (e) {
    if (e instanceof PostgresError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'provision failed');
  }
}
