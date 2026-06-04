/**
 * GET  /api/admin/scaling/ai-search — current SKU + replica + partition.
 * POST /api/admin/scaling/ai-search — { sku?, replicaCount?, partitionCount? }
 *
 * Real ARM PATCH against Microsoft.Search/searchServices/{name}.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getSearchService, updateSearchService, SearchNotConfiguredError,
} from '@/lib/azure/aisearch-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_SKUS = new Set([
  'free', 'basic', 'standard', 'standard2', 'standard3',
  'storage_optimized_l1', 'storage_optimized_l2',
]);

export async function GET(_req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const service = await getSearchService();
    return NextResponse.json({ ok: true, service });
  } catch (e: any) {
    if (e instanceof SearchNotConfiguredError) {
      return NextResponse.json({
        ok: false, error: e.message,
        hint: `Set ${e.missing.join(', ')} on loom-console. Bicep: platform/fiab/bicep/modules/ai/ai-search.bicep`,
      }, { status: 503 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({})) as {
    sku?: string; replicaCount?: number; partitionCount?: number;
  };
  if (!body.sku && !body.replicaCount && !body.partitionCount) {
    return NextResponse.json({ ok: false, error: 'at least one of sku, replicaCount, partitionCount required' }, { status: 400 });
  }
  if (body.sku && !VALID_SKUS.has(body.sku)) {
    return NextResponse.json({ ok: false, error: `sku must be one of ${[...VALID_SKUS].join(', ')}` }, { status: 400 });
  }
  try {
    const service = await updateSearchService(body);
    return NextResponse.json({ ok: true, service });
  } catch (e: any) {
    if (e instanceof SearchNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
    }
    const msg = (e?.message || String(e)).toString();
    const status = e?.status || 502;
    // Azure AI Search SKU TIER is immutable once the service exists — only
    // replicas + partitions scale. ARM rejects a SKU change (400). Surface an
    // honest, actionable message instead of a raw "updateSearchService 400".
    if (body.sku && (status === 400 || /sku|immutable|cannot be (changed|updated)/i.test(msg))) {
      return NextResponse.json({
        ok: false,
        error: 'Azure AI Search SKU tier is immutable after the service is created — it cannot be changed in place (e.g. basic → standard).',
        gate: {
          reason: 'Changing the AI Search SKU requires creating a NEW search service and re-indexing.',
          remediation: 'Scale replicas + partitions here (those ARE adjustable on the current SKU). To change the tier, provision a new Search service via platform/fiab/bicep/modules/ai/ai-search.bicep and migrate indexes.',
        },
      }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
