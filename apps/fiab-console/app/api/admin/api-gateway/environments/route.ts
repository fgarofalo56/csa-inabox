/**
 * GET  /api/admin/api-gateway/environments -> the tenant catalog + settings + per-key usage
 * POST /api/admin/api-gateway/environments -> create a custom environment { displayName, ...fields }
 * PUT  /api/admin/api-gateway/environments -> settings { requireClassification }
 * Tenant-admin gated; every write is audited and passes the ADR-008 invariant.
 */
import { apiBadRequest, apiOk } from '@/lib/api/respond';
import { adminContext, isResponse, readJson, respond, serverError } from '@/lib/api-gateway/environments/route-helpers';
import { loadCatalog, mutateCatalog } from '@/lib/api-gateway/environments/service';
import type { EnvironmentInput } from '@/lib/api-gateway/environments/catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
  try {
    const catalog = await loadCatalog(ctx.deps, ctx.tenantId);
    const resources = ctx.deps.classification ? await ctx.deps.classification.list(ctx.tenantId) : [];
    const usage: Record<string, number> = {};
    for (const r of resources) if (r.environmentKey) usage[r.environmentKey] = (usage[r.environmentKey] ?? 0) + 1;
    return apiOk({
      data: {
        environments: catalog.environments,
        settings: catalog.settings,
        usage,
        unclassified: resources.filter((r) => r.environmentKey === null).length,
        registryAvailable: Boolean(ctx.deps.classification),
      },
    });
  } catch (e) {
    return serverError(e);
  }
}

export async function POST(req: Request) {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
  const body = await readJson(req);
  if (!body || typeof body.displayName !== 'string') return apiBadRequest('displayName is required');
  const { displayName, ...input } = body;
  try {
    return respond(await mutateCatalog(ctx.deps, ctx.tenantId, ctx.actor, { op: 'create', displayName, input: input as EnvironmentInput }));
  } catch (e) {
    return serverError(e);
  }
}

export async function PUT(req: Request) {
  const ctx = adminContext();
  if (isResponse(ctx)) return ctx;
  const body = await readJson(req);
  if (!body || typeof body.requireClassification !== 'boolean') return apiBadRequest('requireClassification (boolean) is required');
  try {
    return respond(await mutateCatalog(ctx.deps, ctx.tenantId, ctx.actor, { op: 'settings', requireClassification: body.requireClassification }));
  } catch (e) {
    return serverError(e);
  }
}
