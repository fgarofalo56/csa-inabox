/**
 * GET /api/catalog/iceberg/overview?namespaceLimit=<n>
 *   — the aggregate the /admin/catalog federation surface renders: every
 *     Iceberg namespace, the tables inside each, the format badges each table
 *     carries (Delta ✓ / Iceberg ✓ — sourced from the REAL loom-lakehouse-interop
 *     state joined onto the REAL catalog listing, never assumed), the Unity
 *     Catalog grant mapping per namespace, and the external-engine connection
 *     string.
 *
 * DELIBERATELY NOT GATED. When LOOM_ICEBERG_CATALOG_URL is unset the full
 * surface still renders: `catalog.configured:false` + the gate block (so the
 * page shows an inline Fix-it), and the namespaces/tables that Loom has already
 * emitted Iceberg metadata for are listed FROM COSMOS with their real metadata
 * locations — because those tables genuinely are readable by pointing an engine
 * at the metadata folder. Honest, never an empty page.
 *
 * Auth: tenant admin (this is an /admin surface). Audited: the catalog reads go
 * through `auditedIrc`, so a namespace/table listing here produces the same
 * data-access rows as an external engine's listing.
 */
import { NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { buildGateEnvelope } from '@/lib/api/gate-envelope';
import { lakehouseInteropContainer } from '@/lib/azure/cosmos-client';
import {
  ICEBERG_CATALOG_GATE_ID,
  icebergCatalogConfigGate,
  icebergWarehouse,
  listNamespaceGrants,
  listNamespaces,
  listTables,
  logIcebergAccess,
  namespaceToDotted,
  type IcebergNamespaceGrants,
} from '@/lib/azure/iceberg-catalog-client';
import { buildConnectSnippets } from '@/lib/azure/iceberg-metadata';
import type { LakehouseInteropDoc, InteropTableState } from '@/lib/azure/lakehouse-interop-model';
import { normalizeTableKey, tableNameOf } from '@/lib/azure/lakehouse-interop-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bounded fan-out so a large catalog can never stall the admin page. */
const MAX_NAMESPACES = 40;

export interface CatalogTableRow {
  namespace: string;
  name: string;
  /** Always true — Loom writes Delta; the Iceberg tree is additive. */
  delta: boolean;
  /** True when Iceberg metadata exists (catalog-registered or emitted by Loom). */
  iceberg: boolean;
  /** 'catalog' = seen in the REST catalog; 'lake' = known only from interop state. */
  source: 'catalog' | 'lake' | 'both';
  metadataLocation: string | null;
  via: string | null;
  container: string | null;
}

function interopRows(docs: LakehouseInteropDoc[]): Map<string, { row: InteropTableState; container: string }> {
  const byKey = new Map<string, { row: InteropTableState; container: string }>();
  for (const doc of docs) {
    for (const t of doc.tables || []) {
      const key = `${t.namespace}.${tableNameOf(normalizeTableKey(t.table))}`.toLowerCase();
      byKey.set(key, { row: t, container: doc.container });
    }
  }
  return byKey;
}

export const GET = withTenantAdmin(async (req, { session }) => {
  const tenantId = session.claims.oid;
  const gate = icebergCatalogConfigGate();
  const warehouse = icebergWarehouse();
  const limit = Math.min(
    Math.max(Number(req.nextUrl.searchParams.get('namespaceLimit')) || MAX_NAMESPACES, 1),
    MAX_NAMESPACES,
  );

  // ── Loom-side truth: which tables did WE emit Iceberg metadata for? ──
  let interopDocs: LakehouseInteropDoc[] = [];
  let interopError: string | null = null;
  try {
    const c = await lakehouseInteropContainer();
    const { resources } = await c.items
      .query<LakehouseInteropDoc>(
        {
          query: "SELECT * FROM c WHERE c.tenantId = @t AND c.docType = 'lakehouse-interop'",
          parameters: [{ name: '@t', value: tenantId }],
        },
        { partitionKey: tenantId },
      )
      .fetchAll();
    interopDocs = resources;
  } catch (e) {
    interopError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  }
  const lakeByKey = interopRows(interopDocs);

  const rows: CatalogTableRow[] = [];
  const grants: IcebergNamespaceGrants[] = [];
  const namespaces: string[] = [];
  let catalogError: string | null = null;

  if (!gate) {
    const audit = {
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn,
      tenantId: session.claims.tid || session.claims.oid,
      warehouse,
    };
    try {
      const nsList = await listNamespaces();
      const found = (nsList.namespaces || []).map((levels) => namespaceToDotted(levels)).slice(0, limit);
      namespaces.push(...found);
      await logIcebergAccess({
        ...audit, operation: 'namespace.list', outcome: 'success', resultCount: found.length,
      });

      for (const ns of found) {
        try {
          const tl = await listTables(ns);
          await logIcebergAccess({
            ...audit, operation: 'table.list', namespace: ns, outcome: 'success',
            resultCount: (tl.identifiers || []).length,
          });
          for (const id of tl.identifiers || []) {
            const key = `${ns}.${id.name}`.toLowerCase();
            const lake = lakeByKey.get(key);
            rows.push({
              namespace: ns,
              name: id.name,
              delta: true,
              iceberg: true,
              source: lake ? 'both' : 'catalog',
              metadataLocation: lake?.row.metadataLocation ?? null,
              via: lake?.row.via ?? null,
              container: lake?.container ?? null,
            });
            lakeByKey.delete(key);
          }
        } catch (e) {
          await logIcebergAccess({
            ...audit, operation: 'table.list', namespace: ns, outcome: 'failure',
            detail: e instanceof Error ? e.message : String(e),
          });
        }
        try {
          grants.push(await listNamespaceGrants(ns));
        } catch (e) {
          grants.push({
            namespace: ns, supported: false, assignments: [],
            note: `Grant read failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
          });
        }
      }
    } catch (e) {
      catalogError = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      await logIcebergAccess({
        ...audit, operation: 'namespace.list', outcome: 'failure', detail: catalogError,
      });
    }
  }

  // Tables Loom exposed as Iceberg that the catalog has NOT (yet) listed —
  // still real and still readable via their metadata folder, so they render
  // with source 'lake' rather than being silently dropped.
  for (const [, { row, container }] of lakeByKey) {
    if (!row.iceberg) continue;
    if (!namespaces.includes(row.namespace)) namespaces.push(row.namespace);
    rows.push({
      namespace: row.namespace,
      name: tableNameOf(normalizeTableKey(row.table)),
      delta: true,
      iceberg: true,
      source: 'lake',
      metadataLocation: row.metadataLocation ?? null,
      via: row.via ?? null,
      container,
    });
  }
  rows.sort((a, b) => (a.namespace + a.name).localeCompare(b.namespace + b.name));

  const origin = (() => {
    try { return new URL(req.url).origin; } catch { return (process.env.LOOM_PUBLIC_BASE_URL || '').replace(/\/+$/, ''); }
  })();
  const catalogUri = `${origin}/api/catalog/iceberg`;

  return NextResponse.json({
    ok: true,
    catalog: {
      configured: !gate,
      uri: catalogUri,
      warehouse,
      ...(gate ? { gate: buildGateEnvelope(ICEBERG_CATALOG_GATE_ID, { missing: [gate.missing] }).gate } : {}),
      ...(catalogError ? { error: catalogError } : {}),
    },
    namespaces: namespaces.sort(),
    tables: rows,
    grants,
    snippets: buildConnectSnippets({
      catalogUri, warehouse, namespace: namespaces[0] || 'gold', catalogAlias: 'loom',
    }),
    ...(interopError ? { interopError } : {}),
  });
});
