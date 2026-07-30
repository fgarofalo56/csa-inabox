/**
 * POST /api/items/loom-app-runtime/[id]/reconcile — redeploy-on-push (APP-W4 S4).
 *
 * The console-side pull half of push-to-deploy (the generated CI template is
 * the push half). Resolves the git source's current default-branch/#branch
 * commit SHA via smart-HTTP ls-remote (private repos use the stored KV token),
 * compares to state.lastBuiltSha, and:
 *   - GET  → { gitSource, currentSha, lastBuiltSha, changed }         (dry run)
 *   - POST → same, plus when changed AND (autoRedeploy || body.build):
 *            kicks a real git build (stamping the SHA) and returns runId.
 *
 * Idempotent: an unchanged SHA is a no-op. Designed to be hit by a scheduler /
 * cron / the app's own CI — no inbound webhook receiver (no WAF exception).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, recordBuild, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { resolveRemoteHeadSha, buildApp, LoomAppsError, LoomAppsNotConfiguredError } from '@/lib/azure/loom-apps-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function resolve(id: string, session: ReturnType<typeof getSession>) {
  const access = await resolveItemAccessByOid(session!, id, LOOM_APP_RUNTIME_TYPE);
  if (!access) return { error: apiError('Item not found', 404, { code: 'not_found' }) };
  const rt = readAppRuntime(access.item);
  if (!rt.gitSource) return { error: apiError('This app has no git source — reconcile applies to git-backed apps only.', 400, { code: 'not_git' }) };
  let token: string | undefined;
  if (rt.gitAuth?.secretName) {
    const { getKeyVaultSecretValue } = await import('@/lib/azure/kv-secrets-client');
    token = await getKeyVaultSecretValue(rt.gitAuth.secretName).catch(() => undefined);
  }
  const currentSha = await resolveRemoteHeadSha(rt.gitSource, token);
  return { access, rt, token, currentSha, changed: !!currentSha && currentSha !== rt.lastBuiltSha };
}

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const r = await resolve(id, session);
    if ('error' in r) return r.error;
    return apiOk({ gitSource: r.rt.gitSource, currentSha: r.currentSha, lastBuiltSha: r.rt.lastBuiltSha || null, changed: r.changed });
  } catch (e) {
    return apiServerError(e, 'reconcile check failed');
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const r = await resolve(id, session);
    if ('error' in r) return r.error;
    if (!r.access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });
    const body = (await req.json().catch(() => ({}))) as { build?: boolean; autoRedeploy?: boolean };

    // Persist an autoRedeploy toggle if supplied.
    if (typeof body.autoRedeploy === 'boolean' && body.autoRedeploy !== r.rt.autoRedeploy) {
      await saveAppRuntime(r.access.item, { autoRedeploy: body.autoRedeploy });
      r.rt.autoRedeploy = body.autoRedeploy;
    }

    if (!r.changed) {
      return apiOk({ changed: false, currentSha: r.currentSha, lastBuiltSha: r.rt.lastBuiltSha || null, note: 'Up to date — no new commit.' });
    }
    const shouldBuild = body.build === true || r.rt.autoRedeploy === true;
    if (!shouldBuild) {
      return apiOk({ changed: true, currentSha: r.currentSha, lastBuiltSha: r.rt.lastBuiltSha || null, note: 'New commit available — POST { build: true } (or enable autoRedeploy) to rebuild.' });
    }

    const result = await buildApp({
      itemId: id, gitSource: r.rt.gitSource, port: r.rt.port, gitToken: r.token,
    });
    const updated = await recordBuild(r.access.item, {
      runId: result.runId, image: result.image, imageName: result.imageName,
      status: result.status, source: result.source, at: new Date().toISOString(),
      by: session.claims.upn || session.claims.email || session.claims.oid,
    });
    await saveAppRuntime(updated, { lastBuiltSha: r.currentSha! });
    return apiOk({ changed: true, built: true, currentSha: r.currentSha, build: result });
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return apiError(e.message, 503);
    if (e instanceof LoomAppsError) return apiError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'reconcile failed');
  }
}
