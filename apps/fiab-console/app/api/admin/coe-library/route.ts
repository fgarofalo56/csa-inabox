/**
 * CoE template-library BFF.
 *
 * GET    /api/admin/coe-library                 → { ok, catalog, clones, orgVisualsConfigured }
 * POST   /api/admin/coe-library  { templateId, displayName? }  → { ok, clone, blobGate? }
 * DELETE /api/admin/coe-library?id=<cloneId>    → { ok }
 *
 * The default CoE Power BI report templates ship bundled with the app, so the
 * catalog is ALWAYS available (no Fabric / Power BI workspace dependency).
 * "Use this template" clones a template into the tenant's library: a real
 * Cosmos write always, plus a real copy of the PBIP bytes into the org-visuals
 * Blob container when LOOM_ORG_VISUALS_URL is configured. When it is not, the
 * clone still succeeds (metadata-only) and the response carries an honest gate
 * hint naming the env var to set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  getCatalog,
  listClones,
  cloneTemplate,
  deleteClone,
  getTemplate,
  isConfigured,
  setClonePublished,
} from '@/lib/coe-library/coe-library-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

const BLOB_GATE = {
  missingEnvVar: 'LOOM_ORG_VISUALS_URL',
  bicepModule: 'platform/fiab/bicep/modules/landing-zone/org-visuals-rbac.bicep',
  bicepStatus: 'grants the Console UAMI Storage Blob Data Contributor (container) + Storage Blob Delegator (account)',
  followUp: 'The clone is saved to your library now; set LOOM_ORG_VISUALS_URL to also copy the editable PBIP files into Blob storage.',
};

async function audit(tenantId: string, who: string, kind: string, fields: Record<string, unknown>) {
  try {
    const c = await auditLogContainer();
    await c.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `coe-template:${fields.templateId ?? fields.cloneId ?? ''}`,
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
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  try {
    const clones = await listClones(tenantId);
    return NextResponse.json({
      ok: true,
      catalog: getCatalog(),
      clones,
      orgVisualsConfigured: isConfigured(),
    });
  } catch (e: any) {
    // The catalog is bundled, so even if Cosmos is unreachable we still return it.
    return NextResponse.json({
      ok: true,
      catalog: getCatalog(),
      clones: [],
      orgVisualsConfigured: isConfigured(),
      warning: e?.message || String(e),
    });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '').trim();

  // Publish / unpublish a clone to the organization consumer gallery.
  if (action === 'publish' || action === 'unpublish') {
    const cloneId = String(body.cloneId || '').trim();
    if (!cloneId) return err('cloneId is required', 400);
    const publish = action === 'publish';
    try {
      const clone = await setClonePublished(tenantId, who, cloneId, publish);
      await audit(tenantId, who, `coe-template.${action}`, { cloneId, templateId: clone.templateId });
      return NextResponse.json({ ok: true, clone });
    } catch (e: any) {
      const msg = e?.message || String(e);
      return err(msg, /unknown clone/.test(msg) ? 404 : 500);
    }
  }

  const templateId = String(body.templateId || '').trim();
  const displayName = body.displayName ? String(body.displayName).trim() : undefined;
  if (!templateId) return err('templateId is required', 400);
  if (!getTemplate(templateId)) return err(`unknown template: ${templateId}`, 404);

  try {
    const clone = await cloneTemplate(tenantId, who, templateId, displayName);
    await audit(tenantId, who, 'coe-template.clone', { templateId, cloneId: clone.id, blobCopied: clone.blobCopied, fileCount: clone.fileCount });
    return NextResponse.json({
      ok: true,
      clone,
      ...(clone.blobCopied ? {} : { blobGate: BLOB_GATE }),
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return err('id required', 400);
  try {
    await deleteClone(tenantId, id);
    await audit(tenantId, who, 'coe-template.delete-clone', { cloneId: id });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}
