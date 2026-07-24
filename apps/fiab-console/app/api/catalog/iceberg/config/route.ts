/**
 * GET /api/catalog/iceberg/config?warehouse=<wh>
 *   — the Iceberg REST Catalog handshake (`GET <prefix>/v1/config`). This is the
 *     FIRST call every external engine makes; Trino/Spark/DuckDB/Snowflake use
 *     the returned defaults/overrides to configure themselves.
 *
 * Real backend: the internal-ingress Unity Catalog OSS container
 * (LOOM_ICEBERG_CATALOG_URL) via lib/azure/iceberg-catalog-client. Entra auth is
 * injected server-side; the catalog is never exposed publicly.
 *
 * Auth: cookie session OR a scoped Loom API token. Audited: one
 * `catalog.config` data-access row per request.
 */
import { NextResponse } from 'next/server';
import { withIrcCaller, auditedIrc } from '../_lib/irc-proxy';
import { getCatalogConfig, icebergWarehouse } from '@/lib/azure/iceberg-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withIrcCaller(async (req, ctx) => {
  const warehouse = (req.nextUrl.searchParams.get('warehouse') || '').trim() || icebergWarehouse();
  const config = await auditedIrc(ctx, 'catalog.config', {}, () => getCatalogConfig(warehouse));
  return NextResponse.json({ ok: true, warehouse, config });
});
