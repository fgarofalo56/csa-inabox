/**
 * POST /api/items/loom-app-runtime/[id]/build
 *   body: { templateId?, gitSource?, port?, userFiles?, tag? }
 *
 * Builds the app source into an image in the Loom ACR (real ACR quick-build).
 * Owner-scoped write via resolveItemAccessByOid. Honors the tenant-wide kill
 * switch (default-ON; a disabled runtime blocks the build with an honest 403).
 * Persists the chosen source config + a build record to the item.
 *
 * GET /api/items/loom-app-runtime/[id]/build?runId=... → poll the build status.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, recordBuild, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { resolveAppsRuntimeState, appsRuntimeDisabledReason } from '@/lib/apps/runtime-flag';
import { buildApp, getBuildStatus, LoomAppsNotConfiguredError, LoomAppsError } from '@/lib/azure/loom-apps-client';
import { getLoomAppTemplate } from '@/lib/azure/loom-apps-runtime-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  let body: any;
  try { body = await req.json(); } catch { return apiError('Invalid JSON', 400, { code: 'bad_json' }); }
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });

    // Kill switch (default-ON, opt-out). A disabled runtime blocks NEW builds.
    const state = await resolveAppsRuntimeState(session.claims.oid);
    if (!state.enabled) return apiError(appsRuntimeDisabledReason(state), 403, { code: 'runtime_disabled' });

    const templateId: string | undefined = body?.templateId;
    const gitSource: string | undefined = body?.gitSource;
    const userFiles = body?.userFiles && typeof body.userFiles === 'object' ? body.userFiles : undefined;
    const port = Number.isFinite(body?.port) ? Number(body.port) : undefined;

    // Resolve the listen/ingress port from the template default unless overridden.
    const tpl = templateId ? getLoomAppTemplate(templateId) : undefined;
    const effPort = port && port > 0 ? port : (tpl?.defaultPort ?? 8000);

    const result = await buildApp({ itemId: id, templateId, gitSource, userFiles, port: effPort, tag: body?.tag });

    // Persist the source config + the build record.
    await saveAppRuntime(access.item, { templateId, gitSource, port: effPort, userFiles });
    const updated = await recordBuild(access.item, {
      runId: result.runId, image: result.image, imageName: result.imageName,
      status: result.status, source: result.source, at: new Date().toISOString(),
      by: session.claims.upn || session.claims.email || session.claims.oid,
    });
    return apiOk({ build: result, runtime: readAppRuntime(updated) });
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return apiHonestError(e.message, 503);
    if (e instanceof LoomAppsError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'build failed');
  }
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  const runId = req.nextUrl.searchParams.get('runId') || '';
  if (!runId) return apiError('runId required', 400);
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    const status = await getBuildStatus(runId);
    // Update the matching build record's status best-effort (history freshness).
    const rt = readAppRuntime(access.item);
    if (access.canWrite && rt.builds?.some((b) => b.runId === runId && b.status !== status.status)) {
      const builds = rt.builds.map((b) => (b.runId === runId ? { ...b, status: status.status } : b));
      await saveAppRuntime(access.item, { builds });
    }
    return apiOk({ status });
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return apiHonestError(e.message, 503);
    return apiServerError(e, 'failed to read build status');
  }
}
