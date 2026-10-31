/**
 * PUT    /api/admin/api-gateway/environments/[key] -> edit (the key is immutable)
 * DELETE /api/admin/api-gateway/environments/[key] -> delete a custom, unused environment
 */
import { withCapability } from '@/lib/api/route-toolkit';
import { PLANE_ADMIN_CAPABILITY, withPlaneGroupHint } from '@/lib/api-gateway/admin-gate';
import { apiBadRequest } from '@/lib/api/respond';
import { adminContext, readJson, respond, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { mutateCatalog } from '@/lib/api-gateway/environments/service';
import type { EnvironmentInput } from '@/lib/api-gateway/environments/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


export const PUT = withPlaneGroupHint<{ key: string }>(withCapability<{ key: string }>(PLANE_ADMIN_CAPABILITY, 'Admin', async (req, { session, params }) => {
  const ctx = adminContext(session);
  const body = await readJson(req);
  if (!body) return apiBadRequest('a JSON body is required');
  try {
    return respond(await mutateCatalog(ctx.deps, ctx.tenantId, ctx.actor, { op: 'update', key: params.key, input: body as EnvironmentInput }));
  } catch (e) {
    return serverError(e);
  }
}));

export const DELETE = withPlaneGroupHint<{ key: string }>(withCapability<{ key: string }>(PLANE_ADMIN_CAPABILITY, 'Admin', async (_req, { session, params }) => {
  const ctx = adminContext(session);
  try {
    return respond(await mutateCatalog(ctx.deps, ctx.tenantId, ctx.actor, { op: 'delete', key: params.key }));
  } catch (e) {
    return serverError(e);
  }
}));
