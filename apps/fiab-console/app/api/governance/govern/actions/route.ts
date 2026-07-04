/**
 * GET /api/governance/govern/actions — recommended governance-remediation cards
 * for the Discover, trust, reuse sub-tab. Real Cosmos read from the
 * `recommended-actions` container (PK /tenantId, doc id `actions:${tenantId}`).
 *
 * Returns an empty list (not an error) when no actions doc exists yet — the UI
 * renders an honest empty state. Admin-gated (F2).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { recommendedActionsAdminContainer } from '@/lib/azure/cosmos-client';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface RecommendedAction {
  id: string;
  title: string;
  description?: string;
  priority?: 'high' | 'medium' | 'low';
  ctaLabel?: string;
  ctaHref?: string;
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json({ ok: false, error: 'forbidden', code: 'admin_only' }, { status: 403 });
  }
  const tenantId = s.claims.oid;
  try {
    const c = await recommendedActionsAdminContainer();
    const { resource } = await c.item(`actions:${tenantId}`, tenantId).read<{ actions?: RecommendedAction[] }>();
    const actions = Array.isArray(resource?.actions) ? resource!.actions : [];
    return NextResponse.json({ ok: true, actions });
  } catch (e: any) {
    // A missing doc is a 404 from Cosmos — treat as empty, not an error.
    if (e?.code === 404) return NextResponse.json({ ok: true, actions: [] });
    return apiServerError(e, 'internal error', 'unexpected');
  }
}
