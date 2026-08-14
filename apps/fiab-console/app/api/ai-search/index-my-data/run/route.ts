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
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
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
} from '@/lib/azure/search-index-client';
import { readIndexerHealth } from '@/lib/azure/search-indexer-health';
import { trimSlashes } from '@/lib/util/trim';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES: IndexableSourceType[] = ['lakehouse', 'warehouse', 'kql-database'];

export const POST = withSession(async (req: NextRequest, { session }) => {

  const body = await req.json().catch(() => ({}));
  const sourceType = body?.sourceType as IndexableSourceType | undefined;
  const itemId = String(body?.itemId || '');
  const preset: ContentPreset = body?.preset === 'structured' ? 'structured' : 'documents';
  const chunkSize = Number.isFinite(body?.chunkSize) ? Number(body.chunkSize) : 2000;
  const chunkOverlap = Number.isFinite(body?.chunkOverlap) ? Number(body.chunkOverlap) : 500;
  const subPath = typeof body?.subPath === 'string' ? trimSlashes(body.subPath) : '';
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

  // --- Reconcile the FIRST RUN. Creating an indexer also runs it. -----------
  //
  // #3384: this block used to be
  //
  //     try { status = await getIndexerStatus(names.indexerName); }
  //     catch { /* status best-effort — the run was accepted */ }
  //
  // and then returned `ok:true` with whatever `status` happened to hold —
  // including `null`. Two separate untruths in three lines:
  //
  //   * "the run was accepted" was never established. The code knew the PUT
  //     succeeded; it knew nothing about the run (deploy-integrity R7).
  //   * a raw status whose top-level field reads `"status":"running"` while
  //     `lastResult.status` is `"transientFailure"` was handed to the wizard,
  //     which rendered nothing at all when `lastResult` was absent — so a
  //     pipeline that failed its first run in five seconds looked like a
  //     successful create.
  //
  // Now: the read failing is reported as a failed read (verdict `unknown`,
  // carrying the real error), and a first run that has ALREADY failed is a
  // 502 with the quoted service error and a concrete remediation. The created
  // artifacts are named in the error body — they are deliberately NOT rolled
  // back, because the pipeline exists and is repairable.
  const { status, health } = await readIndexerHealth(names.indexerName);

  if (health.verdict === 'failed' || health.verdict === 'degraded') {
    return apiError(
      `The pipeline was created, but its first indexer run did not succeed. ${health.observed}`,
      502,
      {
        code: 'first_run_failed',
        created: names,
        indexName: names.indexName,
        preset,
        status,
        health,
        remediation: health.remediation,
      },
    );
  }

  return apiOk({
    created: names,
    indexName: names.indexName,
    preset,
    status,
    // The verdict every caller must branch on. `pending`/`unknown` here are the
    // NORMAL first-response shapes (the run is asynchronous) — they mean "not
    // yet proven", never "fine".
    health,
    searchRoute: `/api/ai-search/indexes/${encodeURIComponent(names.indexName)}/search`,
  });
});
