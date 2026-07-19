/**
 * GET /api/items/loom-app-runtime/[id]/export — the portable `.loomapp`
 * bundle (APP-W4): { loomapp: 1, name, templateId, port, env, resources,
 * userFiles }. Deterministic (stable key order like the git serializeItem
 * convention) and SECRET-SAFE: plain env values export verbatim, but a
 * secretRef exports only the reference name — never the secret value.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';

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
    const bundle = {
      loomapp: 1,
      name: access.item.displayName,
      description: access.item.description || undefined,
      templateId: rt.templateId || 'streamlit',
      port: rt.port,
      gitSource: rt.gitSource || undefined,
      env: (rt.env || []).map((e) =>
        e.secretRef !== undefined ? { name: e.name, secretRef: e.secretRef } : { name: e.name, value: e.value ?? '' },
      ),
      resources: (rt.resources || []).map((r) => ({ kind: r.kind, label: r.label, envNames: r.envNames })),
      userFiles: rt.userFiles || {},
      exportedAt: new Date().toISOString(),
    };
    return new NextResponse(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="${encodeURIComponent(access.item.displayName || id)}.loomapp"`,
      },
    });
  } catch (e) {
    return apiServerError(e, 'failed to export the app bundle');
  }
}
