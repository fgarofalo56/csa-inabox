/** GET /api/admin/api-gateway/environments/matrix -> compatibility matrix derived from permits(). The console never reimplements the rules. */
import { apiOk } from '@/lib/api/respond';
import { compatibilityMatrix } from '@/lib/api-gateway/environments/permits';
import { adminContext, isResponse, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { loadCatalog, settingsOf } from '@/lib/api-gateway/environments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
  try {
    const catalog = await loadCatalog(ctx.deps, ctx.tenantId);
    const matrix = compatibilityMatrix(settingsOf(catalog));
    return apiOk({ data: { environments: catalog.environments, requireClassification: catalog.settings.requireClassification, ...matrix } });
  } catch (e) {
    return serverError(e);
  }
}
