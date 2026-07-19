/**
 * GET /api/items/loom-app-runtime/[id]/context — the app's ASSEMBLED build
 * context (APP-W4 `loom apps run-local`): template starter files overlaid with
 * the item's persisted userFiles plus the generated Dockerfile — byte-identical
 * to what the remote ACR build packs, so a local `docker build` reproduces the
 * deployed image. Read access is enough (no mutation).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import { getLoomAppTemplate, assembleBuildContext } from '@/lib/azure/loom-apps-runtime-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    const rt = readAppRuntime(access.item);
    if (rt.gitSource) {
      return apiError('This app builds from a git source — clone the repository locally instead.', 400, { code: 'git_source' });
    }
    const template = getLoomAppTemplate(rt.templateId || 'streamlit');
    if (!template) return apiError(`Unknown template '${rt.templateId}'.`, 400, { code: 'bad_template' });
    const port = rt.port || template.defaultPort;
    const files = assembleBuildContext({ template, port, userFiles: rt.userFiles });
    return apiOk({ templateId: template.id, port, files });
  } catch (e) {
    return apiServerError(e, 'failed to assemble the build context');
  }
}
