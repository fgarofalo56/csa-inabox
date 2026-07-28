/**
 * B-N19g — POST /api/catalog/interop/ingest.
 *
 * The BACKFILL leg: accept a DataHub MCE stream or an OpenMetadata payload and
 * merge its curation back onto Loom items.
 *
 * Body: { format: 'datahub'|'openmetadata', payload: <parsed JSON>,
 *         apply?: boolean, workspaceId?: string }
 *
 * DRY-RUN BY DEFAULT (`apply` omitted/false): the response is the typed plan —
 * exactly which items would gain which owners/tags/description/label/lineage,
 * plus per-row reasons for everything skipped. `apply: true` performs the REAL
 * writes: item docs patched in Cosmos and lineage recorded through the SAME
 * `recordThreadEdge` sink the N17 OpenLineage emitter uses.
 *
 * Merge is additive and non-destructive (see lib/catalog/interop/ingest.ts):
 * tags/owners union; a description or sensitivity label is only written when
 * Loom has none, so an external catalog can never overwrite Loom curation.
 */
import { NextRequest } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { emitAuditEvent } from '@/lib/admin/audit-stream';
import { loadCatalogSnapshot } from '@/lib/catalog/interop/export-source';
import { parseDataHubMces } from '@/lib/catalog/interop/datahub';
import { parseOpenMetadata } from '@/lib/catalog/interop/openmetadata';
import { planIngest, applyIngestPlan } from '@/lib/catalog/interop/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Body cap — an ingest payload is a metadata file, not a data extract. */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const POST = withSession(async (req: NextRequest, { session }) => {
  const raw = await req.text();
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return apiError(`payload exceeds the ${Math.round(MAX_PAYLOAD_BYTES / 1024 / 1024)} MB ingest cap`, 413, {
      code: 'payload_too_large',
    });
  }

  let body: { format?: string; payload?: unknown; apply?: boolean; workspaceId?: string };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return apiError('a JSON body is required', 400, { code: 'bad_body' });
  }

  const format = String(body.format || '').toLowerCase();
  if (format !== 'datahub' && format !== 'openmetadata') {
    return apiError('format must be datahub or openmetadata', 400, { code: 'bad_format' });
  }
  if (body.payload == null) {
    return apiError('payload is required', 400, { code: 'missing_payload' });
  }

  try {
    const parsed = format === 'datahub' ? parseDataHubMces(body.payload) : parseOpenMetadata(body.payload);
    if (!parsed.records.length && !parsed.skipped.length) {
      return apiError(
        `no ${format} entities were found in the payload — check that it is the export shape this endpoint emits`,
        400,
        { code: 'empty_payload' },
      );
    }

    const snapshot = await loadCatalogSnapshot(session, { workspaceId: body.workspaceId, includeLineage: false });
    const plan = planIngest(parsed.records, snapshot.assets, parsed.skipped);

    if (!body.apply) {
      return apiOk({ dryRun: true, format, plan });
    }

    const applied = await applyIngestPlan(session, plan, snapshot.assets);
    emitAuditEvent({
      actorOid: session.claims.oid,
      actorUpn: session.claims.upn || session.claims.oid,
      action: 'catalog.interop.ingest',
      targetType: 'catalog-ingest',
      targetId: body.workspaceId || 'all-workspaces',
      outcome: applied.failures.length ? 'failure' : 'success',
      tenantId: session.claims.oid,
      detail: {
        format,
        records: plan.totals.records,
        itemsUpdated: applied.itemsUpdated,
        lineageEdgesWritten: applied.lineageEdgesWritten,
        failures: applied.failures.length,
      },
    });

    return apiOk({ dryRun: false, format, plan, applied });
  } catch (e) {
    return apiServerError(e, 'Failed to ingest the catalog payload', 'catalog_interop_ingest_failed');
  }
});
