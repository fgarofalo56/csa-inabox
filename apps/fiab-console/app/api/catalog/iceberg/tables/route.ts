/**
 * GET  /api/catalog/iceberg/tables?namespace=<dotted-ns>
 *   — list the tables in a namespace (`GET <prefix>/v1/namespaces/{ns}/tables`).
 * POST /api/catalog/iceberg/tables
 *   body: { namespace, table, metadataLocation }
 *   — register an EXISTING Iceberg metadata file (the one Delta UniForm /
 *     Apache XTable just wrote into the customer's lake) as a catalog table
 *     (`POST <prefix>/v1/namespaces/{ns}/register`). Zero-copy: the catalog
 *     records a pointer, no data moves.
 * DELETE /api/catalog/iceberg/tables?namespace=<ns>&table=<t>
 *   — de-register the catalog POINTER (`purgeRequested=false` is pinned in the
 *     client, so this can never delete customer data files).
 *
 * Real backend: the internal-ingress Unity Catalog OSS container. Auth: cookie
 * session OR a scoped Loom API token. Audited: `table.list` (aggregated),
 * `table.register`, `table.deregister`.
 */
import { NextResponse } from 'next/server';
import { withIrcCaller, auditedIrc } from '../_lib/irc-proxy';
import {
  dropTableRegistration,
  listTables,
  namespaceToDotted,
  registerTable,
} from '@/lib/azure/iceberg-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withIrcCaller(async (req, ctx) => {
  const namespace = (req.nextUrl.searchParams.get('namespace') || '').trim();
  if (!namespace) {
    return NextResponse.json({ ok: false, error: 'namespace query param is required' }, { status: 400 });
  }
  const result = await auditedIrc(
    ctx,
    'table.list',
    { namespace },
    () => listTables(namespace),
    (r) => (r.identifiers || []).length,
  );
  return NextResponse.json({
    ok: true,
    namespace,
    tables: (result.identifiers || []).map((id) => ({
      name: id.name,
      namespace: namespaceToDotted(id.namespace || []),
      // Every table the Loom catalog serves is Iceberg-readable BY DEFINITION
      // (it is in an Iceberg REST catalog) and Delta-readable because Loom
      // wrote it as Delta — that duality is the whole point of N1.
      formats: ['delta', 'iceberg'] as const,
    })),
    nextPageToken: result['next-page-token'] ?? null,
  });
});

export const POST = withIrcCaller(async (req, ctx) => {
  const body = (await req.json().catch(() => ({}))) as {
    namespace?: string;
    table?: string;
    metadataLocation?: string;
  };
  const namespace = String(body?.namespace ?? '').trim();
  const table = String(body?.table ?? '').trim();
  const metadataLocation = String(body?.metadataLocation ?? '').trim();
  if (!namespace || !table || !metadataLocation) {
    return NextResponse.json(
      { ok: false, error: 'namespace, table and metadataLocation are required' },
      { status: 400 },
    );
  }
  const registered = await auditedIrc(ctx, 'table.register', { namespace, table }, () =>
    registerTable(namespace, table, metadataLocation));
  return NextResponse.json({
    ok: true,
    namespace,
    table,
    metadataLocation: registered['metadata-location'] ?? metadataLocation,
  });
});

export const DELETE = withIrcCaller(async (req, ctx) => {
  const namespace = (req.nextUrl.searchParams.get('namespace') || '').trim();
  const table = (req.nextUrl.searchParams.get('table') || '').trim();
  if (!namespace || !table) {
    return NextResponse.json(
      { ok: false, error: 'namespace and table query params are required' },
      { status: 400 },
    );
  }
  await auditedIrc(ctx, 'table.deregister', { namespace, table }, () =>
    dropTableRegistration(namespace, table));
  return NextResponse.json({ ok: true, namespace, table, deregistered: true, dataPurged: false });
});
