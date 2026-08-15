/**
 * GET /api/items/copy-job/[id]/runs
 *
 * Lists Azure Data Factory pipeline runs over the last 7 days filtered to the
 * materialised pipeline name `loom-copy-<itemId>`. Real ADF REST via adf-client
 * (no-fabric-dependency.md) — no Synapse, no Fabric.
 *
 * AUTHORIZATION — `withWorkspaceOwner(…, { allowReadRoles: true })`.
 *   This route did not authorize the item at all: it took `[id]` from the URL,
 *   built a pipeline name from it, and queried the shared factory, so read
 *   access to a job's run history was not scoped to the workspace that owns the
 *   job. Its two siblings both scope by item — `[id]/run` (POST) and
 *   `[id]/watermark` (GET) each resolve the item first — so the three halves of
 *   one editor disagreed about who may read it.
 *
 *   It was allowlisted in check-route-guards under SHARED_BACKEND_ITEM_ROUTES,
 *   whose stated class is "specific-per-item-TYPE route over a SHARED Azure
 *   backend … no per-tenant Cosmos ownership to scope". That premise is false
 *   here on both halves: the route is addressed by item ID, not item type, and
 *   ownership IS scopeable — its own siblings scope it. The path therefore moves
 *   to NOW_GUARDED rather than staying allowlisted-but-guarded, so a future edit
 *   that drops the wrapper is re-flagged instead of silently masked.
 *
 *   `allowReadRoles` because listing run history is read-only, matching every
 *   sibling run-history surface (agent-flow/[id]/runs, activation-sync/[id]/runs,
 *   ai-enrichment/[id]/runs, airflow-job/[id]/dag-runs).
 *
 * PIPELINE NAME USES THE RAW ROUTE ID, NOT `item.id` — deliberately.
 *   `[id]/run` materialises the pipeline as `loom-copy-${id}` from the SAME raw
 *   route param (run/route.ts:513) while `loadOwnedItem` resolves the `loom:`
 *   synthetic-id prefix internally for the ownership lookup only. Naming this
 *   query from the resolved `item.id` would diverge for every bundle-installed
 *   job — whose route id is `loom:<cosmosId>` — and the list would silently
 *   return zero runs for a job that has run many times.
 */

import { apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { listPipelineRuns } from '@/lib/azure/adf-client';
import { jerr } from '../../../_lib/item-crud';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'copy-job';

export const GET = withWorkspaceOwner(ITEM_TYPE, { allowReadRoles: true }, async (_req, { params }) => {
  const pipelineName = `loom-copy-${params.id}`;
  try {
    const runs = await listPipelineRuns(pipelineName);
    return apiOk({ pipelineName, runs });
  } catch (e: any) {
    return jerr(e?.message || String(e), 502);
  }
});
