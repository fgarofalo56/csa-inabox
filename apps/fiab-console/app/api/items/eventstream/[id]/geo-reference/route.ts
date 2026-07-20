/**
 * Geofence reference-data provisioning for the Eventstream geospatial operators.
 *
 * GET  /api/items/eventstream/[id]/geo-reference
 *   → { ok, asaJobName, nodes: [{ name, fenceRefInput, fenceCount, published? }] }
 *     Reports the geo-fence nodes in REFERENCE mode + whether ASA/storage are ready.
 *
 * POST /api/items/eventstream/[id]/geo-reference   body: { inputAlias? }
 *   → { ok, published: [{ inputAlias, blob, inputId, records }], asaJobName }
 *   Materializes the blob-backed fence reference TABLE that slice-1's SQL JOIN
 *   (`JOIN [geofences] R ON ST_WITHIN(L.point, R.polygon) = 1`) reads:
 *     1. serialize the node's fences → line-delimited GeoJSON records (adls-client
 *        uploadBlob to the DLZ storage account, MSI), then
 *     2. PUT the ASA reference-data input (stream-analytics-client, type Reference,
 *        Blob datasource, Json serialization, MSI auth).
 *
 * Azure-native by default — Event Hubs + Stream Analytics + ADLS Gen2, no Microsoft
 * Fabric (no-fabric-dependency.md). Honest gates (no-vaporware.md): the ASA job must
 * be provisioned first (state.asaJobName — provision the stream), the DLZ storage
 * account must be configured (svc-adls / LOOM_*_URL), and the node must carry at
 * least one valid fence polygon. Each gate names the exact remediation; nothing is
 * faked.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { loadKustoItem, KustoError } from '@/lib/azure/kusto-client';
import {
  apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError, apiHonestError,
} from '@/lib/api/respond';
import {
  configuredContainerNames, getAccountName, uploadBlob,
} from '@/lib/azure/adls-client';
import {
  createOrUpdateInput, AsaNotConfiguredError, type AsaInputCreateSpec,
} from '@/lib/azure/stream-analytics-client';
import {
  collectGeoReferenceNodes, fenceReferenceBlobBody, fenceReferenceRecords,
  fenceReferenceBlobPath, buildGeoReferenceInputSpec,
} from '@/lib/editors/eventstream/geo-reference';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'eventstream';

const ADLS_GATE =
  'The fence reference table is written to the DLZ storage account. Set LOOM_BRONZE_URL / ' +
  'LOOM_LANDING_URL (or another LOOM_*_URL) and grant the ASA job managed identity + the Console ' +
  'UAMI "Storage Blob Data Reader/Contributor" on the account. Deployed by ' +
  'platform/fiab/bicep/modules/landing-zone/storage.bicep. No Microsoft Fabric required.';

const ASA_JOB_GATE =
  'Provision the eventstream first (Provision on the ribbon) so a Stream Analytics job exists, ' +
  'then Publish the fence reference table. The reference-data input attaches to that job.';

/** Pick the container the reference blob is written to (env override → landing → first configured). */
function resolveReferenceContainer(): string | null {
  const configured = configuredContainerNames();
  const override = (process.env.LOOM_ASA_REFERENCE_CONTAINER || '').trim();
  if (override && (configured as string[]).includes(override)) return override;
  if (override && !configured.length) return override; // trust an explicit override even pre-probe
  if ((configured as string[]).includes('landing')) return 'landing';
  return configured[0] || null;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  if (!id || id === 'new') return apiOk({ asaJobName: null, nodes: [] });

  try {
    const item = await loadKustoItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('eventstream not found');
    const state = (item.state || {}) as Record<string, any>;
    const nodes = collectGeoReferenceNodes(state).map((n) => ({
      name: n.name,
      fenceRefInput: n.fenceRefInput,
      fenceRefNameColumn: n.fenceRefNameColumn,
      fenceRefPolygonColumn: n.fenceRefPolygonColumn,
      fenceCount: fenceReferenceRecords(n.fences, {
        nameColumn: n.fenceRefNameColumn, polygonColumn: n.fenceRefPolygonColumn,
      }).length,
      published: Array.isArray(state.geoReferenceInputs)
        ? state.geoReferenceInputs.includes(n.fenceRefInput)
        : false,
    }));
    return apiOk({
      asaJobName: (state.asaJobName as string) || null,
      storageConfigured: configuredContainerNames().length > 0,
      nodes,
    });
  } catch (e: any) {
    if (e instanceof KustoError) return apiHonestError(e, e.status);
    return apiServerError(e, 'failed to read geofence reference status');
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const limited = await enforceRateLimit(session, 'provision');
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!id || id === 'new') return apiError('save the eventstream before publishing a fence reference table', 400, { code: 'no_id' });

  const body = await req.json().catch(() => ({} as any));
  const wantAlias = typeof body?.inputAlias === 'string' && body.inputAlias.trim() ? body.inputAlias.trim() : undefined;

  try {
    const item = await loadKustoItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('eventstream not found');
    const state = (item.state || {}) as Record<string, any>;

    // Gate 1 — the ASA job must already exist (provision the stream first).
    const asaJobName = (state.asaJobName as string) || '';
    if (!asaJobName) {
      return apiError('Stream Analytics job not provisioned yet.', 409, { code: 'asa_not_provisioned', hint: ASA_JOB_GATE });
    }

    // Gate 2 — a geofence node in reference mode with at least one valid polygon.
    let nodes = collectGeoReferenceNodes(state);
    if (wantAlias) nodes = nodes.filter((n) => n.fenceRefInput === wantAlias);
    if (!nodes.length) {
      return apiError(
        wantAlias
          ? `No geofence node uses reference input "${wantAlias}".`
          : 'No geofence node is in reference-data mode. Set a Geofence node to "ASA reference-data input" and add at least one fence.',
        422, { code: 'no_reference_node' },
      );
    }

    // Gate 3 — the DLZ storage account must be configured.
    const container = resolveReferenceContainer();
    if (!container) {
      return apiError('DLZ storage account not configured.', 503, { code: 'adls_not_configured', hint: ADLS_GATE });
    }
    const account = getAccountName();

    const published: Array<{ inputAlias: string; blob: string; inputId: string; records: number }> = [];
    for (const node of nodes) {
      const cols = { nameColumn: node.fenceRefNameColumn, polygonColumn: node.fenceRefPolygonColumn };
      const bodyText = fenceReferenceBlobBody(node.fences, cols);
      const recordCount = fenceReferenceRecords(node.fences, cols).length;
      if (!bodyText) {
        return apiError(
          `Geofence node "${node.name}" (reference input "${node.fenceRefInput}") has no fence with at least 3 vertices to publish.`,
          422, { code: 'no_valid_fence' },
        );
      }
      const blobPath = fenceReferenceBlobPath(id, node.fenceRefInput);
      // 1. Upload the fence reference table blob (MSI — Console UAMI writes it).
      await uploadBlob(container, blobPath, Buffer.from(bodyText, 'utf8'), 'application/json', account);
      // 2. PUT the ASA reference-data input pointing at that blob (MSI — ASA job MI reads it).
      const spec = buildGeoReferenceInputSpec({
        inputAlias: node.fenceRefInput, storageAccount: account, container, blobPath,
      });
      const created = await createOrUpdateInput(asaJobName, spec as AsaInputCreateSpec);
      published.push({ inputAlias: spec.name, blob: `${container}/${blobPath}`, inputId: created.id, records: recordCount });
    }

    // Record which reference inputs are now published (for GET status + the UI badge).
    const priorInputs: string[] = Array.isArray(state.geoReferenceInputs) ? state.geoReferenceInputs : [];
    const nextInputs = Array.from(new Set([...priorInputs, ...published.map((p) => p.inputAlias)]));
    const { saveItemState } = await import('@/lib/azure/kusto-client');
    await saveItemState(item, { geoReferenceInputs: nextInputs, asaJobName });

    return apiOk({ published, asaJobName, container, account });
  } catch (e: any) {
    if (e instanceof AsaNotConfiguredError) return apiHonestError(e, 501);
    if (e instanceof KustoError) return apiHonestError(e, e.status);
    // ASA / ADLS ARM permission gates are user-actionable — surface verbatim.
    if (e?.status === 401 || e?.status === 403 || e?.statusCode === 403) {
      return apiHonestError(e, 403);
    }
    return apiServerError(e, 'failed to publish the fence reference table');
  }
}
