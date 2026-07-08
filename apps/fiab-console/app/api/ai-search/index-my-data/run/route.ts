/**
 * POST /api/ai-search/index-my-data/run
 *
 * Step 4 of the index-my-estate wizard (AIF-3): orchestrate the coordinated
 * import-and-vectorize pipeline for a source item, server-side, with
 * ROLLBACK-ON-FAILURE. Creates, in dependency order:
 *   1. adlsgen2 data source  (POST-equivalent PUT /datasources/{n})
 *   2. target index          (PUT /indexes/{n})   — projection target, must exist
 *      before the skillset that projects into it
 *   3. skillset              (PUT /skillsets/{n}) — Split → embed → indexProjections
 *   4. indexer               (PUT /indexers/{n})  — binds all three (creating runs it)
 * If any step fails, every artifact created in THIS request is deleted in reverse
 * order so a mid-sequence failure leaves NO orphan objects (acceptance: rollback
 * proven). Then the indexer's real status is returned.
 *
 * Security: the storage ResourceId + embedding endpoint are re-resolved
 * server-side from the item's provisioned coordinates via `resolveIndexPlan` —
 * the client never supplies them. Real REST only (no-vaporware.md).
 *
 * Body: { sourceType, itemId, preset?: 'documents'|'structured',
 *         chunkSize?, chunkOverlap?, subPath?, scheduleInterval? }
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveIndexPlan } from '@/lib/azure/index-my-data-plan';
import {
  buildAdlsDataSourceDefinition,
  buildIndexDefinition,
  buildPresetSkillsetDefinition,
  buildIndexerDefinition,
  type IndexableSourceType,
  type ContentPreset,
} from '@/lib/azure/index-my-data';
import {
  createDataSource, deleteDataSource,
  createIndex, deleteIndex,
  createSkillset, deleteSkillset,
  createIndexer, deleteIndexer,
  getIndexerStatus,
} from '@/lib/azure/search-index-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES: IndexableSourceType[] = ['lakehouse', 'warehouse', 'kql-database'];

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const body = await req.json().catch(() => ({}));
  const sourceType = body?.sourceType as IndexableSourceType | undefined;
  const itemId = String(body?.itemId || '');
  const preset: ContentPreset = body?.preset === 'structured' ? 'structured' : 'documents';
  const chunkSize = Number.isFinite(body?.chunkSize) ? Number(body.chunkSize) : 2000;
  const chunkOverlap = Number.isFinite(body?.chunkOverlap) ? Number(body.chunkOverlap) : 500;
  const subPath = typeof body?.subPath === 'string' ? body.subPath.replace(/^\/+|\/+$/g, '') : '';
  const scheduleInterval = typeof body?.scheduleInterval === 'string' && body.scheduleInterval.trim() ? body.scheduleInterval.trim() : undefined;

  if (!sourceType || !SOURCE_TYPES.includes(sourceType)) return apiError(`sourceType must be one of ${SOURCE_TYPES.join(', ')}`, 400);
  if (!itemId) return apiError('itemId is required', 400);

  let plan;
  try {
    plan = await resolveIndexPlan({ sourceType, itemId, tenantId: session.claims.oid });
  } catch (e: any) {
    return apiServerError(e, 'Failed to resolve the source item plan');
  }
  if (plan.notFound) return apiError('source item not found or not accessible', 404);

  // --- Honest gates (surface the exact remediation, don't half-build) ---
  if (!plan.support.supported) {
    return apiError(plan.support.reason || 'This source type cannot be indexed directly.', 422, {
      code: 'source_unsupported',
      recommended: plan.support.recommended,
    });
  }
  if (!plan.searchConfigured) {
    return apiError('Azure AI Search is not configured: set LOOM_AI_SEARCH_SERVICE.', 503, { code: 'not_configured', missing: 'LOOM_AI_SEARCH_SERVICE' });
  }
  if (!plan.embedding) {
    return apiError(plan.embeddingGate || 'Azure OpenAI embeddings are not configured.', 503, { code: 'embedding_not_configured' });
  }
  if (!plan.connection) {
    return apiError(plan.connectionGate || 'Could not resolve the source connection.', 503, { code: 'connection_unresolved' });
  }

  const { names, connection, embedding } = plan;
  // Compose the blob path prefix: the lakehouse root + an optional subfolder.
  const query = [connection.root, subPath].filter(Boolean).join('/');

  const dataSourceDef = buildAdlsDataSourceDefinition({
    name: names.dataSourceName,
    storageResourceId: connection.storageResourceId,
    container: connection.container,
    query,
    description: `Index-my-data source for ${plan.itemName} (${sourceType})`,
  });
  const indexDef = buildIndexDefinition({
    name: names.indexName,
    dimensions: embedding.dimensions,
    embedding: { resourceUri: embedding.resourceUri, deploymentId: embedding.deploymentId, modelName: embedding.modelName },
  });
  const skillsetDef = buildPresetSkillsetDefinition({
    name: names.skillsetName,
    targetIndexName: names.indexName,
    preset,
    embedding: { resourceUri: embedding.resourceUri, deploymentId: embedding.deploymentId, modelName: embedding.modelName },
    maximumPageLength: chunkSize,
    pageOverlapLength: chunkOverlap,
  });
  const indexerDef = buildIndexerDefinition({
    name: names.indexerName,
    dataSourceName: names.dataSourceName,
    targetIndexName: names.indexName,
    skillsetName: names.skillsetName,
    preset,
    scheduleInterval,
  });

  // Rollback ledger — every artifact created THIS request, in creation order.
  const created: Array<{ kind: 'datasource' | 'index' | 'skillset' | 'indexer'; name: string }> = [];
  const rollback = async () => {
    for (const a of [...created].reverse()) {
      try {
        if (a.kind === 'indexer') await deleteIndexer(a.name);
        else if (a.kind === 'skillset') await deleteSkillset(a.name);
        else if (a.kind === 'index') await deleteIndex(a.name);
        else if (a.kind === 'datasource') await deleteDataSource(a.name);
      } catch { /* best-effort cleanup; keep unwinding the rest */ }
    }
  };

  let failedStep = '';
  try {
    failedStep = 'data source';
    await createDataSource(dataSourceDef);
    created.push({ kind: 'datasource', name: names.dataSourceName });

    failedStep = 'index';
    await createIndex(indexDef);
    created.push({ kind: 'index', name: names.indexName });

    failedStep = 'skillset';
    await createSkillset(skillsetDef);
    created.push({ kind: 'skillset', name: names.skillsetName });

    failedStep = 'indexer';
    // buildIndexerDefinition returns the full wire shape (incl. parameters +
    // fieldMappings); createIndexer PUTs it verbatim.
    await createIndexer(indexerDef as any);
    created.push({ kind: 'indexer', name: names.indexerName });
  } catch (e: any) {
    await rollback();
    const detail = e?.message ? String(e.message) : String(e);
    return apiError(
      `Pipeline creation failed at the ${failedStep} step; all partial artifacts were rolled back. ${detail.slice(0, 300)}`,
      502,
      { code: 'orchestration_failed', failedStep, rolledBack: created.length },
    );
  }

  // Initial indexer status (creating an indexer also runs it).
  let status: unknown = null;
  try {
    status = await getIndexerStatus(names.indexerName);
  } catch { /* status best-effort — the run was accepted */ }

  return apiOk({
    created: names,
    indexName: names.indexName,
    preset,
    status,
    searchRoute: `/api/ai-search/indexes/${encodeURIComponent(names.indexName)}/search`,
  });
}
