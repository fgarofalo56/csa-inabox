/** GET /api/admin/api-gateway/environments/matrix -> compatibility matrix derived from permits(). The console never reimplements the rules. */
import { withCapability } from '@/lib/api/route-toolkit';
import { PLANE_ADMIN_CAPABILITY, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';
import { apiOk } from '@/lib/api/respond';
import { compatibilityMatrix } from '@/lib/api-gateway/environments/permits';
import { adminContext, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { loadCatalog, settingsOf } from '@/lib/api-gateway/environments/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withPlaneGroupHint(withCapability(PLANE_ADMIN_CAPABILITY, 'Admin', async (_req, { session }) => {
  const ctx = adminContext(session);
  try {
    const catalog = await loadCatalog(ctx.deps, ctx.tenantId);
    const matrix = compatibilityMatrix(settingsOf(catalog));
    return apiOk({ data: { environments: catalog.environments, requireClassification: catalog.settings.requireClassification, ...matrix } });
  } catch (e) {
    return serverError(e);
  }
}));
