/**
 * Loom App Runtime — RESOURCES (APPS-W2, Databricks-Apps "App resources" parity).
 *
 *   GET    /api/items/loom-app-runtime/[id]/resources
 *            → { resources, kinds } — attached resources + the attachable-kind
 *              catalog with honest per-kind availability (missing env named).
 *   POST   { kind }
 *            → attach: resolves the deployment's REAL coordinates for the kind,
 *              grants the shared apps UAMI the needed role (ARM role assignment /
 *              ADX principal-assignment / Cosmos sqlRoleAssignment — or an honest
 *              pending-grants script for data-plane grants), and merges the
 *              resolved env vars into the app's bindings. Env applies on the
 *              next Deploy (same contract as manual bindings).
 *   DELETE ?rid=<resourceId>
 *            → detach: removes the resource record + the env vars it injected.
 *              The RBAC grant is left in place (idempotent to re-attach; role
 *              removal is an admin decision, not a side effect).
 *
 * Owner-scoped via resolveItemAccessByOid like the sibling routes. Real ARM
 * only — no mocks (no-vaporware).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { resolveItemAccessByOid } from '@/lib/auth/item-access';
import { readAppRuntime, saveAppRuntime, LOOM_APP_RUNTIME_TYPE } from '@/lib/apps/runtime-store';
import {
  attachAppResource,
  listAppResourceKinds,
  type AppResourceKind,
} from '@/lib/apps/app-resources';

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
    return apiOk({ resources: rt.resources || [], kinds: listAppResourceKinds() });
  } catch (e) {
    return apiServerError(e, 'failed to list app resources');
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });

    const body = (await req.json().catch(() => ({}))) as { kind?: string };
    const kind = (body.kind || '').trim() as AppResourceKind;
    if (!kind) return apiError('kind required', 400);
    const known = listAppResourceKinds().find((k) => k.kind === kind);
    if (!known) return apiError(`Unknown resource kind: ${kind}`, 400);
    if (!known.available) {
      return apiError(`${known.label} is not configured in this deployment — set ${known.missing} on the Console.`, 503, { code: 'not_configured' });
    }

    const rt = readAppRuntime(access.item);
    if ((rt.resources || []).some((r) => r.kind === kind)) {
      return apiError(`${known.label} is already attached — detach it first to re-attach.`, 409, { code: 'conflict' });
    }

    const who = session.claims.upn || session.claims.email || session.claims.oid;
    const { resource, envVars } = await attachAppResource(kind, who);

    // Merge injected env into bindings (resource values win over stale manual
    // rows of the same name — the resource is now the owner of those names).
    const injected = new Set(envVars.map((e) => e.name));
    const mergedEnv = [...(rt.env || []).filter((e) => !injected.has(e.name)), ...envVars];

    const updated = await saveAppRuntime(access.item, {
      env: mergedEnv,
      resources: [...(rt.resources || []), resource],
    });
    return apiOk({ resource, resources: readAppRuntime(updated).resources || [] });
  } catch (e) {
    return apiServerError(e, 'failed to attach resource');
  }
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const access = await resolveItemAccessByOid(session, id, LOOM_APP_RUNTIME_TYPE);
    if (!access) return apiError('Item not found', 404, { code: 'not_found' });
    if (!access.canWrite) return apiError('Read-only access', 403, { code: 'forbidden' });

    const rid = (req.nextUrl.searchParams.get('rid') || '').trim();
    if (!rid) return apiError('rid required', 400);

    const rt = readAppRuntime(access.item);
    const target = (rt.resources || []).find((r) => r.id === rid);
    if (!target) return apiError('Resource not attached', 404, { code: 'not_found' });

    const removed = new Set(target.envNames);
    const updated = await saveAppRuntime(access.item, {
      env: (rt.env || []).filter((e) => !removed.has(e.name)),
      resources: (rt.resources || []).filter((r) => r.id !== rid),
    });
    return apiOk({ resources: readAppRuntime(updated).resources || [] });
  } catch (e) {
    return apiServerError(e, 'failed to detach resource');
  }
}
