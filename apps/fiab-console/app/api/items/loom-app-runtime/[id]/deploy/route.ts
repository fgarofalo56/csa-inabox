/**
 * POST /api/items/loom-app-runtime/[id]/deploy
 *   body: { image, port?, env?, minReplicas?, maxReplicas?, cpu?, memory? }
 *
 * Deploys (create or update) the hosted app as an autoscale-to-zero, Entra-gated
 * Azure Container App and returns the live URL. Owner-scoped write. Honors the
 * kill switch. Persists the deployed app name + URL + env bindings to the item.
 *
 * DEFAULT-ON: no spend/approval gate — cost is bounded structurally by
 * minReplicas:0 (enforced in the container-app body builder). Only a disabled
 * runtime blocks a deploy.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError, apiHonestError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { resolveAppsRuntimeState, appsRuntimeDisabledReason } from '@/lib/apps/runtime-flag';
import { deployApp, LoomAppsNotConfiguredError, LoomAppsError } from '@/lib/azure/loom-apps-client';
import { getLoomAppTemplate, isAllowedAppEnvName, type LoomAppEnvVar } from '@/lib/azure/loom-apps-runtime-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Validate + normalize the structured env array (no-freeform-config). */
function normalizeEnv(raw: unknown): { env: LoomAppEnvVar[]; bad?: string } {
  if (!Array.isArray(raw)) return { env: [] };
  const env: LoomAppEnvVar[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const name = String((e as any).name || '').trim();
    if (!name) continue;
    if (!isAllowedAppEnvName(name)) return { env, bad: name };
    const hasSecret = typeof (e as any).secretRef === 'string' && (e as any).secretRef;
    if (hasSecret) env.push({ name, secretRef: String((e as any).secretRef) });
    else env.push({ name, value: String((e as any).value ?? '') });
  }
  return { env };
}

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

    const state = await resolveAppsRuntimeState(session.claims.oid);
    if (!state.enabled) return apiError(appsRuntimeDisabledReason(state), 403, { code: 'runtime_disabled' });

    const image = String(body?.image || '').trim();
    if (!image) return apiError('image required (build first)', 400);

    const rt = readAppRuntime(access.item);
    const tpl = rt.templateId ? getLoomAppTemplate(rt.templateId) : undefined;
    const port = Number.isFinite(body?.port) ? Number(body.port) : (rt.port ?? tpl?.defaultPort ?? 8000);

    const { env, bad } = normalizeEnv(body?.env);
    if (bad) return apiError(`env name "${bad}" is not allowlisted (APP_/LOOM_/AZURE_/… prefixes only)`, 400);

    const minReplicas = Number.isFinite(body?.minReplicas) ? Number(body.minReplicas) : 0;
    const maxReplicas = Number.isFinite(body?.maxReplicas) ? Number(body.maxReplicas) : 3;

    const deployed = await deployApp({
      itemId: id,
      name: rt.containerAppName, // stable redeploy target
      image,
      targetPort: port,
      env,
      minReplicas,
      maxReplicas,
      cpu: Number.isFinite(body?.cpu) ? Number(body.cpu) : undefined,
      memory: typeof body?.memory === 'string' ? body.memory : undefined,
    });

    const updated = await saveAppRuntime(access.item, {
      containerAppName: deployed.name,
      url: deployed.url,
      image,
      env,
      port,
      authConfigured: deployed.authConfigured,
      disabled: false,
      lastDeployAt: new Date().toISOString(),
    });
    return apiOk({ deployed, runtime: readAppRuntime(updated) });
  } catch (e) {
    if (e instanceof LoomAppsNotConfiguredError) return apiHonestError(e.message, 503);
    if (e instanceof LoomAppsError) return apiHonestError(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
    return apiServerError(e, 'deploy failed');
  }
}
