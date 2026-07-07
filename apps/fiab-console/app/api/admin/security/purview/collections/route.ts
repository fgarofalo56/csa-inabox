/**
 * GET /api/admin/security/purview/collections
 *
 * List the Microsoft Purview account's collections (the classic Data Map mirror
 * of governance domains), so the "Register source" wizard can auto-map a picked
 * resource to a collection via a dropdown — NO freeform collection typing
 * (no-freeform-config). The first collection with no parent is the root.
 *
 * 503 → Purview not configured (LOOM_PURVIEW_ACCOUNT unset) with the structured
 * hint; 403 → UAMI lacks a Data Map role (honest gate). Both render the
 * NotConfiguredBar in the panel (handleSecurityError).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { listCollections } from '@/lib/azure/purview-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const collections = await listCollections();
    return NextResponse.json({ ok: true, collections });
  } catch (e) { return handleSecurityError(e); }
}
