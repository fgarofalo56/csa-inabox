/** GET /api/admin/api-gateway/environments/suggestions -> one-click suggestions from Azure environment/env tags. Read-only; tags are never written back. */
import { apiOk } from '@/lib/api/respond';
import { suggestFromTags } from '@/lib/api-gateway/environments/tags';
import { adminContext, isResponse, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { loadCatalog } from '@/lib/api-gateway/environments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
  try {
    const catalog = await loadCatalog(ctx.deps, ctx.tenantId);
    const resources = ctx.deps.classification ? await ctx.deps.classification.list(ctx.tenantId) : [];
    return apiOk({ data: { suggestions: suggestFromTags(resources, catalog.environments), registryAvailable: Boolean(ctx.deps.classification) } });
  } catch (e) {
    return serverError(e);
  }
}
