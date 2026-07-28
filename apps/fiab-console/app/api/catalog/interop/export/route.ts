/**
 * B-N19g — GET /api/catalog/interop/export.
 *
 * Exports the Loom catalog in an open, importable format so governance
 * metadata is never locked in:
 *   ?format=datahub       → DataHub MetadataChangeEvent stream (file source)
 *   ?format=openmetadata  → OpenMetadata entity + lineage payload
 *   ?format=openlineage   → the N17 OpenLineage 1.x RunEvent stream
 *
 * Optional: `workspaceId` narrows the scope, `lineage=false` drops the graph,
 * `download=true` returns the JSON as a file attachment.
 *
 * Real backend: the Loom Cosmos catalog (`loom-workspaces` + `items`) and the
 * Weave/Thread lineage store the N17 emitter writes. Asset identity is N17's
 * `datasetUriForItem`, so all three formats name the same dataset the same way.
 *
 * READ-ONLY + audited (an export IS a metadata egress event). Azure-native —
 * no SaaS catalog is contacted; Loom emits the format, the operator moves it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { loadCatalogSnapshot, snapshotToOpenLineage } from '@/lib/catalog/interop/export-source';
import { assetsToDataHubMces } from '@/lib/catalog/interop/datahub';
import { assetsToOpenMetadata } from '@/lib/catalog/interop/openmetadata';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS = ['datahub', 'openmetadata', 'openlineage'] as const;
type Format = (typeof FORMATS)[number];

export const GET = withSession(async (req: NextRequest, { session }) => {
  const sp = req.nextUrl.searchParams;
  const format = (sp.get('format') || 'datahub').toLowerCase() as Format;
  if (!FORMATS.includes(format)) {
    return apiError(`format must be one of ${FORMATS.join(', ')}`, 400, { code: 'bad_format' });
  }
  const workspaceId = sp.get('workspaceId') || undefined;
  const includeLineage = sp.get('lineage') !== 'false';
  const download = sp.get('download') === 'true';

  try {
    const snapshot = await loadCatalogSnapshot(session, { workspaceId, includeLineage });

    let payload: unknown;
    let count = 0;
    if (format === 'datahub') {
      const mces = assetsToDataHubMces(snapshot.assets, snapshot.lineage);
      count = mces.length;
      payload = { mces };
    } else if (format === 'openmetadata') {
      const om = assetsToOpenMetadata(snapshot.assets, snapshot.lineage);
      count = om.entities.length;
      payload = om;
    } else {
      const events = snapshotToOpenLineage(snapshot);
      count = events.length;
      payload = { events };
    }

    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'catalog.interop.export',
      targetType: 'catalog-export',
      targetId: workspaceId || 'all-workspaces',
      outcome: 'success',
      tenantId: session.claims.oid,
      detail: { format, assets: snapshot.assets.length, lineage: snapshot.lineage.length, count },
    });

    if (download) {
      const filename = `loom-catalog-${format}-${new Date().toISOString().slice(0, 10)}.json`;
      return new NextResponse(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        },
      });
    }

    return apiOk({
      format,
      assetCount: snapshot.assets.length,
      lineageCount: snapshot.lineage.length,
      workspaceCount: snapshot.workspaceCount,
      truncated: snapshot.truncated,
      recordCount: count,
      payload,
    });
  } catch (e) {
    return apiServerError(e, 'Failed to export the catalog', 'catalog_interop_export_failed');
  }
});
