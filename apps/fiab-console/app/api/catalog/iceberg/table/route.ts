/**
 * GET /api/catalog/iceberg/table?namespace=<dotted-ns>&table=<t>
 *   — LOAD one table's real Iceberg metadata
 *     (`GET <prefix>/v1/namespaces/{ns}/tables/{table}`): metadata-location,
 *     format-version, table-uuid, current snapshot, and the table properties.
 *     This is the call an external engine makes right before it reads data, and
 *     the call the Interop tab makes to prove "Iceberg ✓" is real rather than
 *     asserted.
 *
 * Real backend: the internal-ingress Unity Catalog OSS container. Auth: cookie
 * session OR a scoped Loom API token. Audited: one `table.load` row.
 */
import { NextResponse } from 'next/server';
import { withIrcCaller, auditedIrc } from '../_lib/irc-proxy';
import { loadTable } from '@/lib/azure/iceberg-catalog-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withIrcCaller(async (req, ctx) => {
  const namespace = (req.nextUrl.searchParams.get('namespace') || '').trim();
  const table = (req.nextUrl.searchParams.get('table') || '').trim();
  if (!namespace || !table) {
    return NextResponse.json(
      { ok: false, error: 'namespace and table query params are required' },
      { status: 400 },
    );
  }
  const loaded = await auditedIrc(ctx, 'table.load', { namespace, table }, () =>
    loadTable(namespace, table));
  const meta = loaded.metadata || {};
  return NextResponse.json({
    ok: true,
    namespace,
    table,
    metadataLocation: loaded['metadata-location'] ?? null,
    formatVersion: meta['format-version'] ?? null,
    tableUuid: meta['table-uuid'] ?? null,
    location: meta.location ?? null,
    currentSnapshotId: meta['current-snapshot-id'] ?? null,
    properties: meta.properties ?? {},
  });
});
