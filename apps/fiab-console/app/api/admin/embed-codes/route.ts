/**
 * F22 — Embed codes BFF.
 *
 * GET    /api/admin/embed-codes            → { ok, codes }   (lazy SAS refresh)
 * POST   /api/admin/embed-codes            body { report }   → { ok, code }
 * DELETE /api/admin/embed-codes?id=<id>                      → { ok, code }
 *
 * Azure-native: each code is a real user-delegation SAS URL over an
 * org-visuals manifest blob. Gated on LOOM_ORG_VISUALS_URL (honest 503 + hint).
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  listEmbedCodes,
  createEmbedCode,
  revokeEmbedCode,
  refreshExpiringSas,
  isConfigured,
  NotConfiguredError,
} from '@/lib/clients/embed-codes-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



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
      itemId: `embed-code:${fields.embedCodeId ?? ''}`,
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
  if (!isConfigured()) return notConfigured();
  const tenantId = s.claims.oid;
  try {
    const codes = await refreshExpiringSas(tenantId, await listEmbedCodes(tenantId));
    return NextResponse.json({ ok: true, codes });
  } catch (e: any) {
    if (e instanceof NotConfiguredError) return notConfigured();
    return apiError(e?.message || String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  if (!isConfigured()) return notConfigured();
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const body = await req.json().catch(() => ({}));
  const report = typeof body.report === 'string' ? body.report.trim() : '';
  if (!report) return apiError('report is required', 400);
  try {
    const code = await createEmbedCode(tenantId, who, report);
    await audit(tenantId, who, 'embed-code.create', { embedCodeId: code.id, report });
    return NextResponse.json({ ok: true, code });
  } catch (e: any) {
    if (e instanceof NotConfiguredError) return notConfigured();
    return apiError(e?.message || String(e), 500);
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  if (!isConfigured()) return notConfigured();
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return apiError('id required', 400);
  try {
    const code = await revokeEmbedCode(tenantId, id, who);
    await audit(tenantId, who, 'embed-code.revoke', { embedCodeId: id, report: code.report });
    return NextResponse.json({ ok: true, code });
  } catch (e: any) {
    if (e instanceof NotConfiguredError) return notConfigured();
    const msg = e?.message || String(e);
    return apiError(msg, /not found/i.test(msg) ? 404 : 500);
  }
}
