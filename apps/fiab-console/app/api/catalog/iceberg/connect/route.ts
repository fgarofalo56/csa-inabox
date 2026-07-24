/**
 * GET /api/catalog/iceberg/connect?namespace=<ns>&table=<t>&alias=<a>
 *   — the copy-paste connect configuration external engines need to read Loom
 *     tables IN PLACE: the Iceberg REST Catalog endpoint they point at (the
 *     audited Loom proxy, never the internal container), the warehouse id, and
 *     ready-to-run snippets for Spark / Trino / DuckDB / Snowflake / Databricks.
 *
 * DELIBERATELY NOT GATED on LOOM_ICEBERG_CATALOG_URL. When the catalog service
 * is not deployed the response still returns real, usable values — it flips
 * `catalog.configured:false`, names the gate so the surface can render the
 * inline Fix-it, and includes the direct metadata-folder path (an engine can
 * always be pointed straight at the Iceberg metadata Loom wrote into the
 * customer's own ADLS Gen2). Honest, never empty.
 *
 * Auth: session required. No upstream call, so nothing to audit here — the
 * audited events are the actual catalog reads in the sibling routes.
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { buildGateEnvelope } from '@/lib/api/gate-envelope';
import {
  ICEBERG_CATALOG_GATE_ID,
  icebergCatalogConfigGate,
  icebergWarehouse,
} from '@/lib/azure/iceberg-catalog-client';
import { buildConnectSnippets, icebergMetadataLocation, toAzureScheme, toHttpsScheme } from '@/lib/azure/iceberg-metadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The IRC endpoint EXTERNAL engines use — the Loom proxy on this deployment's
 * public origin, not the internal-ingress container. Derived from the request
 * origin (so it is correct behind Front Door / a vanity domain) with
 * LOOM_PUBLIC_BASE_URL as the fallback.
 */
function proxyCatalogUri(req: Request): string {
  let origin = '';
  try {
    origin = new URL(req.url).origin;
  } catch {
    origin = '';
  }
  if (!origin) origin = (process.env.LOOM_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return `${origin}/api/catalog/iceberg`;
}

export const GET = withSession(async (req) => {
  const sp = req.nextUrl.searchParams;
  const namespace = (sp.get('namespace') || '').trim() || 'default';
  const table = (sp.get('table') || '').trim() || undefined;
  const alias = (sp.get('alias') || '').trim() || 'loom';
  // abfss:// root of the Delta table, when the caller knows it (the Interop tab
  // does) — lets us return the direct metadata path for the un-cataloged case.
  const tableRootUri = (sp.get('tableRootUri') || '').trim();

  const gate = icebergCatalogConfigGate();
  const catalogUri = proxyCatalogUri(req);
  const warehouse = icebergWarehouse();

  const metadataLocation = tableRootUri ? icebergMetadataLocation(tableRootUri) : null;

  return NextResponse.json({
    ok: true,
    catalog: {
      configured: !gate,
      /** What an engine points at. Always the audited proxy — never the container. */
      uri: catalogUri,
      warehouse,
      namespace,
      table: table ?? null,
      ...(gate ? { gate: buildGateEnvelope(ICEBERG_CATALOG_GATE_ID, { missing: [gate.missing] }).gate } : {}),
    },
    /** Direct (catalog-less) path — valid whether or not the catalog is deployed. */
    directMetadata: metadataLocation
      ? {
          abfss: metadataLocation,
          https: toHttpsScheme(metadataLocation),
          azure: toAzureScheme(metadataLocation),
          note:
            'Point any Iceberg reader at this metadata folder to read the table without the REST catalog. '
            + 'The catalog adds discovery + credential vending; it is never on the data path.',
        }
      : null,
    snippets: buildConnectSnippets({ catalogUri, warehouse, namespace, table, catalogAlias: alias }),
    tokenHint:
      'Mint a scoped Loom API token under Settings → Developer → API tokens and paste it where the snippet '
      + 'says <loom-api-token>. A read-only token is enough for SELECT; every call it makes is audited.',
  });
});
