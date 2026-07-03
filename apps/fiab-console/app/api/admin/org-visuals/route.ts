/**
 * F23 — Organizational custom visuals BFF.
 *
 * GET    /api/admin/org-visuals                         → { ok, visuals }
 * POST   /api/admin/org-visuals      multipart: name, version, file(.pbiviz),
 *                                    optional description, optional icon(image)
 *                                                        → { ok, visual }
 * PUT    /api/admin/org-visuals?id=<id>  body { enabled } → { ok, visual }
 * DELETE /api/admin/org-visuals?id=<id>                 → { ok }
 *
 * Azure-native: the bundle bytes are stored in the DLZ org-visuals Blob
 * container; metadata + enabled toggle live in Cosmos. Gated on
 * LOOM_ORG_VISUALS_URL (honest 503 + hint).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  listOrgVisuals,
  uploadOrgVisual,
  toggleOrgVisual,
  deleteOrgVisual,
  isConfigured,
  NotConfiguredError,
} from '@/lib/clients/org-visuals-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024; // 64 MB — generous for .pbiviz bundles.
const MAX_ICON_BYTES = 256 * 1024; // 256 KB — small icon kept inline as a data: URI.



const NOT_CONFIGURED_HINT = {
  missingEnvVar: 'LOOM_ORG_VISUALS_URL',
  bicepModule: 'platform/fiab/bicep/modules/landing-zone/org-visuals-rbac.bicep',
  bicepStatus: 'grants the Console UAMI Storage Blob Data Contributor (container) + Storage Blob Delegator (account)',
  followUp: 'Deploy with loomStorageAccount set; the org-visuals container + LOOM_ORG_VISUALS_URL are wired by storage.bicep + admin-plane/main.bicep.',
};

function notConfigured() {
  return NextResponse.json(
    { ok: false, code: 'not-configured', error: 'org-visuals Blob backing not configured', hint: NOT_CONFIGURED_HINT },
    { status: 503 },
  );
}

async function audit(tenantId: string, who: string, kind: string, fields: Record<string, unknown>) {
  try {
    const c = await auditLogContainer();
    await c.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `org-visual:${fields.visualId ?? ''}`,
      tenantId,
      who,
      at: new Date().toISOString(),
      kind,
      ...fields,
    }).catch(() => {});
  } catch { /* audit is best-effort */ }
}

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  if (!isConfigured()) return notConfigured();
  const tenantId = s.claims.oid;
  try {
    const visuals = await listOrgVisuals(tenantId);
    return NextResponse.json({ ok: true, visuals });
  } catch (e: any) {
    if (e instanceof NotConfiguredError) return notConfigured();
    return apiError(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  if (!isConfigured()) return notConfigured();
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError('expected multipart/form-data', 400);
  }
  const file = form.get('file');
  const name = String(form.get('name') || '').trim();
  const version = String(form.get('version') || '').trim();
  const description = String(form.get('description') || '').trim();
  if (!file || typeof file === 'string') return apiError('file is required', 400);
  if (!name) return apiError('name is required', 400);
  if (!version) return apiError('version is required', 400);

  const fileName = (file.name || 'visual.pbiviz').trim();
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) return apiError('uploaded file is empty', 400);
  if (buf.length > MAX_BUNDLE_BYTES) return apiError(`bundle exceeds ${MAX_BUNDLE_BYTES} bytes`, 413);

  // Optional icon (parity with Fabric's "Add visual" Icon field). Stored inline
  // as a small data: URI on the metadata doc — no second blob / SAS round-trip.
  let iconDataUri: string | undefined;
  const icon = form.get('icon');
  if (icon && typeof icon !== 'string') {
    const type = icon.type || 'image/png';
    if (!type.startsWith('image/')) return apiError('icon must be an image', 400);
    const iconBuf = Buffer.from(await icon.arrayBuffer());
    if (iconBuf.length > MAX_ICON_BYTES) return apiError(`icon exceeds ${MAX_ICON_BYTES} bytes`, 413);
    if (iconBuf.length > 0) iconDataUri = `data:${type};base64,${iconBuf.toString('base64')}`;
  }

  try {
    const visual = await uploadOrgVisual(tenantId, who, name, fileName, version, buf, {
      ...(description ? { description } : {}),
      ...(iconDataUri ? { iconDataUri } : {}),
    });
    await audit(tenantId, who, 'org-visual.upload', { visualId: visual.id, name, version, fileName, size: visual.size, hasIcon: !!iconDataUri });
    return NextResponse.json({ ok: true, visual });
  } catch (e: any) {
    if (e instanceof NotConfiguredError) return notConfigured();
    return apiError(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  if (!isConfigured()) return notConfigured();
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('id required', 400);
  const body = await req.json().catch(() => ({}));
  if (typeof body.enabled !== 'boolean') return apiError('enabled (boolean) is required', 400);
  try {
    const visual = await toggleOrgVisual(tenantId, id, body.enabled, who);
    await audit(tenantId, who, body.enabled ? 'org-visual.enable' : 'org-visual.disable', { visualId: id, name: visual.name });
    return NextResponse.json({ ok: true, visual });
  } catch (e: any) {
    if (e instanceof NotConfiguredError) return notConfigured();
    const msg = e?.message || String(e);
    return apiError(msg, /not found/i.test(msg) ? 404 : 500);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  if (!isConfigured()) return notConfigured();
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('id required', 400);
  try {
    await deleteOrgVisual(tenantId, id);
    await audit(tenantId, who, 'org-visual.delete', { visualId: id });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof NotConfiguredError) return notConfigured();
    return apiError(e?.message || String(e), 500);
  }
}
