/**
 * PUT    /api/admin/api-gateway/environments/[key] -> edit (the key is immutable)
 * DELETE /api/admin/api-gateway/environments/[key] -> delete a custom, unused environment
 */
import { apiBadRequest } from '@/lib/api/respond';
import { adminContext, isResponse, readJson, respond, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { mutateCatalog } from '@/lib/api-gateway/environments/service';
import type { EnvironmentInput } from '@/lib/api-gateway/environments/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { key: string } };

export async function PUT(req: Request, { params }: Ctx) {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
  const body = await readJson(req);
  if (!body) return apiBadRequest('a JSON body is required');
  try {
    return respond(await mutateCatalog(ctx.deps, ctx.tenantId, ctx.actor, { op: 'update', key: params.key, input: body as EnvironmentInput }));
  } catch (e) {
    return serverError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
  try {
    return respond(await mutateCatalog(ctx.deps, ctx.tenantId, ctx.actor, { op: 'delete', key: params.key }));
  } catch (e) {
    return serverError(e);
  }
}
