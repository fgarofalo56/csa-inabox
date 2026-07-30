/**
 * POST /api/items/loom-app-runtime/import — install an app from a `.loomapp`
 * bundle (APP-W5 S6 — the import half of `loom apps export`; completes the
 * portable-app round-trip and is the marketplace "install an app" primitive).
 *
 * Body: { workspaceId, bundle }  where bundle is the `.loomapp` JSON
 *   ({ loomapp:1, name, templateId, port, gitSource?, env[], userFiles }).
 * Creates a NEW loom-app-runtime item in the target workspace, seeded with the
 * bundle's source + config. SECRET-SAFE by construction: the export never
 * carries secret VALUES (only secretRef names), so import can't leak one —
 * secretRef bindings are re-created as references the installer re-points at
 * their own Key Vault. The imported app is NOT auto-built/deployed — the
 * installer reviews source on the Source tab, then Build → Deploy.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { createOwnedItem } from '../../_lib/item-crud';
import { getLoomAppTemplate } from '@/lib/azure/loom-apps-runtime-templates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FILES = 200;
const MAX_FILE_CHARS = 200_000;

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const body = (await req.json().catch(() => ({}))) as { workspaceId?: string; bundle?: any; name?: string };
    const workspaceId = String(body.workspaceId || '').trim();
    const bundle = body.bundle;
    if (!workspaceId) return apiError('workspaceId is required.', 400);
    if (!bundle || typeof bundle !== 'object' || bundle.loomapp !== 1) {
      return apiError('Not a valid .loomapp bundle (expected { loomapp: 1, … }).', 400, { code: 'bad_bundle' });
    }

    const templateId = typeof bundle.templateId === 'string' ? bundle.templateId : 'streamlit';
    if (!bundle.gitSource && !getLoomAppTemplate(templateId)) {
      return apiError(`Unknown template '${templateId}' in the bundle.`, 400, { code: 'bad_template' });
    }

    // Sanitize userFiles: path-safe, count/size-bounded, never a Dockerfile.
    const rawFiles = (bundle.userFiles && typeof bundle.userFiles === 'object') ? bundle.userFiles : {};
    const userFiles: Record<string, string> = {};
    let n = 0;
    for (const [path, content] of Object.entries(rawFiles)) {
      const p = String(path).replace(/^\.?\/+/, '').trim();
      if (!p || p.includes('..') || p.startsWith('/') || p === 'Dockerfile' || !/^[\w.\-/]+$/.test(p)) continue;
      if (typeof content !== 'string' || content.length > MAX_FILE_CHARS) continue;
      if (++n > MAX_FILES) break;
      userFiles[p] = content;
    }

    // Env: keep names + plain values / secretRef NAMES only (export is secret-safe).
    const env = Array.isArray(bundle.env)
      ? bundle.env
          .filter((e: any) => e && typeof e.name === 'string')
          .map((e: any) => (e.secretRef !== undefined ? { name: e.name, secretRef: String(e.secretRef) } : { name: e.name, value: String(e.value ?? '') }))
      : [];

    const displayName = String(body.name || bundle.name || 'Imported app').slice(0, 120);
    const created = await createOwnedItem(session, 'loom-app-runtime', {
      workspaceId,
      displayName,
      description: typeof bundle.description === 'string' ? bundle.description : `Imported from a .loomapp bundle (${templateId}).`,
      state: {
        appRuntime: {
          templateId,
          ...(bundle.gitSource ? { gitSource: String(bundle.gitSource) } : {}),
          port: typeof bundle.port === 'number' ? bundle.port : undefined,
          env,
          userFiles,
          importedAt: new Date().toISOString(),
        },
      },
    });
    if (!created.ok) return apiError(created.error, created.status);

    return apiOk({
      itemId: created.item.id,
      files: Object.keys(userFiles),
      note: 'App imported. Review the Source tab, re-point any Key Vault secret bindings at your vault, then Build → Deploy.',
    });
  } catch (e) {
    return apiServerError(e, 'failed to import the app bundle');
  }
}
