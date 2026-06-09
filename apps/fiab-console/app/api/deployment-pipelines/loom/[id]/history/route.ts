/**
 * GET /api/deployment-pipelines/loom/[id]/history
 *   → { ok, data: { records: LoomPipelineHistoryRecord[] } }
 *
 * The deploy receipts for a Loom-native pipeline (most recent first). Each
 * record carries the diff that motivated the deploy + the target item ids that
 * were re-provisioned. Cosmos-only; tenant-scoped via the parent pipeline.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pipelineHistoryContainer } from '@/lib/azure/cosmos-client';
import type { LoomPipelineHistoryRecord } from '@/lib/types/loom-pipeline';
import { jok, jerr, loadPipeline } from '../../_lib/pipeline-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return jerr('unauthenticated', 401, 'unauthorized');
  const { id } = await ctx.params;
  try {
    const pipeline = await loadPipeline(s.claims.oid, id);
    if (!pipeline) return jerr('pipeline not found', 404, 'not_found');
    const c = await pipelineHistoryContainer();
    const { resources } = await c.items
      .query<LoomPipelineHistoryRecord>(
        { query: 'SELECT * FROM c WHERE c.pipelineId = @p ORDER BY c.startedAt DESC OFFSET 0 LIMIT 50', parameters: [{ name: '@p', value: id }] },
        { partitionKey: id },
      )
      .fetchAll();
    return jok({ records: resources || [] });
  } catch (e) {
    return jerr((e as Error).message || 'Failed to load history');
  }
}
