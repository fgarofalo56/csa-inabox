/**
 * GET /api/ai-search/index-my-data/prepare?sourceType=&itemId=
 *
 * Step 1 of the index-my-estate wizard (AIF-3): resolve — from the LIVE estate —
 * everything the wizard needs to propose a coordinated import-and-vectorize
 * pipeline for a source item, WITHOUT creating anything yet:
 *   - the source's support posture (lakehouse = direct adlsgen2; warehouse / ADX
 *     = honest-gated with the exact reason + recommended Azure-native path),
 *   - the auto-derived data-source connection (a lakehouse's real ADLS Gen2 root
 *     + the storage-account ResourceId, resolved by name via Resource Graph),
 *   - the four proposed artifact names (index / data source / skillset / indexer),
 *   - the embedding target (Foundry AOAI endpoint + embedding deployment), or an
 *     honest gate naming the exact env var when AOAI is unconfigured,
 *   - the real source schema (Delta table columns) for the confirm-schema step.
 *
 * Real backend only (no-vaporware.md); the resolution lives in the shared
 * `resolveIndexPlan` server helper the `run` route reuses.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { resolveIndexPlan } from '@/lib/azure/index-my-data-plan';
import type { IndexableSourceType } from '@/lib/azure/index-my-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SOURCE_TYPES: IndexableSourceType[] = ['lakehouse', 'warehouse', 'kql-database'];

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const sp = req.nextUrl.searchParams;
  const sourceType = sp.get('sourceType') as IndexableSourceType | null;
  const itemId = sp.get('itemId') || '';
  if (!sourceType || !SOURCE_TYPES.includes(sourceType)) {
    return apiError(`sourceType must be one of ${SOURCE_TYPES.join(', ')}`, 400);
  }
  if (!itemId) return apiError('itemId is required', 400);

  try {
    const plan = await resolveIndexPlan({ sourceType, itemId, tenantId: session.claims.oid });
    if (plan.notFound) return apiNotFound('source item not found or not accessible');
    return apiOk(plan as unknown as Record<string, unknown>);
  } catch (e: any) {
    return apiServerError(e, 'Failed to prepare the index-my-data wizard');
  }
}
