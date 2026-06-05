/**
 * /api/powerbi/endorsement — read + set endorsement (Promote / Certify) on a
 * Power BI dataset, report, or dataflow.
 *
 *   GET /api/powerbi/endorsement?workspaceId=W&itemId=I
 *         → { ok, endorsement: { endorsementStatus, certifiedBy } }   (Fabric Get Item)
 *   PUT /api/powerbi/endorsement
 *         { workspaceId, itemId, itemType:'datasets'|'reports'|'dataflows',
 *           endorsement:'None'|'Promoted'|'Certified', certifiedBy? }   (Admin REST)
 *
 * READ uses the Fabric Items REST; WRITE uses the Power BI Admin REST
 * (Tenant.ReadWrite.All / Fabric admin SP). When the SP isn't a tenant admin
 * the PUT 401/403 is surfaced as an HONEST admin-gate — the editor still
 * renders the current endorsement badge + the control.
 *
 * Power BI dashboards cannot be endorsed (endorsement overview), so itemType is
 * restricted to datasets / reports / dataflows.
 *
 * Docs: https://learn.microsoft.com/fabric/governance/endorsement-overview
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  PowerBiError,
  powerbiConfigGate,
  POWERBI_SP_HINT,
  getItemEndorsement,
  setItemEndorsement,
  type EndorsementStatus,
} from '@/lib/azure/powerbi-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: EndorsementStatus[] = ['None', 'Promoted', 'Certified'];
const ITEM_TYPES = ['datasets', 'reports', 'dataflows'] as const;

/** Admin-write 401/403 needs a *different* hint than the read SP-gate. */
const ENDORSE_ADMIN_HINT =
  'Setting endorsement programmatically requires a Power BI / Fabric admin. The Console service principal must ' +
  'be granted Tenant.ReadWrite.All (admin API) and be a member of the "Service principals can use read-only/Fabric ' +
  'admin APIs" tenant security group. Until then, set Promoted/Certified from the item Settings in the Power BI service.';

function gate(): NextResponse | null {
  const g = powerbiConfigGate();
  if (g) return NextResponse.json({ ok: false, code: 'not_configured', error: g.detail, missing: g.missing }, { status: 503 });
  return null;
}
function requireAuth(): NextResponse | null {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  return null;
}

export async function GET(req: NextRequest) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId')?.trim();
  const itemId = req.nextUrl.searchParams.get('itemId')?.trim();
  if (!workspaceId || !itemId) {
    return NextResponse.json({ ok: false, error: 'workspaceId and itemId query params are required' }, { status: 400 });
  }
  try {
    return NextResponse.json({ ok: true, endorsement: await getItemEndorsement(workspaceId, itemId) });
  } catch (e) {
    const status = e instanceof PowerBiError ? e.status : 502;
    const hint = status === 401 || status === 403 ? POWERBI_SP_HINT : undefined;
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), hint }, { status: status >= 400 ? status : 502 });
  }
}

export async function PUT(req: NextRequest) {
  const unauth = requireAuth(); if (unauth) return unauth;
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({} as any));
  const workspaceId: string = (body?.workspaceId || '').trim();
  const itemId: string = (body?.itemId || '').trim();
  const itemType: string = (body?.itemType || '').trim();
  const endorsement: string = (body?.endorsement || '').trim();
  const certifiedBy: string | undefined = body?.certifiedBy?.trim() || undefined;
  if (!workspaceId || !itemId) {
    return NextResponse.json({ ok: false, error: 'workspaceId and itemId are required' }, { status: 400 });
  }
  if (!ITEM_TYPES.includes(itemType as (typeof ITEM_TYPES)[number])) {
    return NextResponse.json({ ok: false, error: `itemType must be one of ${ITEM_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!STATUSES.includes(endorsement as EndorsementStatus)) {
    return NextResponse.json({ ok: false, error: `endorsement must be one of ${STATUSES.join(', ')}` }, { status: 400 });
  }
  if (endorsement === 'Certified' && !certifiedBy) {
    return NextResponse.json({ ok: false, error: 'certifiedBy (the certifier UPN) is required when endorsement is Certified' }, { status: 400 });
  }
  try {
    await setItemEndorsement(workspaceId, itemType as (typeof ITEM_TYPES)[number], itemId, endorsement as EndorsementStatus, certifiedBy);
    return NextResponse.json({ ok: true, endorsement: await getItemEndorsement(workspaceId, itemId) });
  } catch (e) {
    const status = e instanceof PowerBiError ? e.status : 502;
    const hint = status === 401 || status === 403 ? ENDORSE_ADMIN_HINT : undefined;
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e), hint }, { status: status >= 400 ? status : 502 });
  }
}
