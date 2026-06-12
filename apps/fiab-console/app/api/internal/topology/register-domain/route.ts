/**
 * POST /api/internal/topology/register-domain
 *
 * Internal, token-gated callback the Setup Orchestrator's `dlz-attach` flow
 * invokes after a Data Landing Zone deployment succeeds. It registers (or
 * updates) the domain in the AUTHORITATIVE tenant topology registry
 * (`tenant-settings` doc `domains:<tenant>`) — binding the domain to its
 * subscription, resource group, region, capacity sizing, and Entra admin/member
 * groups, and flipping its status to `active`.
 *
 * Auth: the shared internal token (LOOM_INTERNAL_TOKEN), accepted either as
 * `Authorization: Bearer <token>` (what the orchestrator forwards) or the
 * `x-loom-internal-token` header (the MAF convention). NOT cookie-authenticated
 * — the orchestrator has no MSAL session. Fails CLOSED when the env var is unset.
 *
 * The tenant partition comes from `x-loom-caller-oid` (the signed-in user's oid
 * the orchestrator carries through from the deploy request) so the write lands
 * in the correct tenant's domains doc.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  isValidInternalToken,
  INTERNAL_TOKEN_HEADER,
} from '@/lib/auth/internal-token';
import {
  upsertDomainBinding,
  type DomainBindingInput,
  type DomainStatus,
} from '@/lib/azure/domain-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CALLER_OID_HEADER = 'x-loom-caller-oid';

/** Pull the internal token from either the Bearer Authorization header or x-loom-internal-token. */
function presentedToken(req: NextRequest): string | null {
  const header = req.headers.get(INTERNAL_TOKEN_HEADER);
  if (header) return header;
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1] : null;
}

export async function POST(req: NextRequest) {
  if (!isValidInternalToken(presentedToken(req))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const tenantId = (req.headers.get(CALLER_OID_HEADER) || '').trim();
  if (!tenantId) {
    return NextResponse.json(
      { ok: false, error: `Missing ${CALLER_OID_HEADER} header (the tenant partition to register the domain under)` },
      { status: 400 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const domainId = String(body?.domainId || body?.domain || '').trim();
  if (!domainId) {
    return NextResponse.json({ ok: false, error: 'domainId is required' }, { status: 400 });
  }

  const input: DomainBindingInput = {
    domainId,
    name: typeof body?.name === 'string' ? body.name : undefined,
    description: typeof body?.description === 'string' ? body.description : undefined,
    subscriptionId: typeof body?.subscriptionId === 'string' ? body.subscriptionId : undefined,
    subscriptionIds: Array.isArray(body?.subscriptionIds) ? body.subscriptionIds : undefined,
    dlzRg: typeof body?.dlzRg === 'string' ? body.dlzRg : undefined,
    location: typeof body?.location === 'string' ? body.location : undefined,
    capacitySku: typeof body?.capacitySku === 'string' ? body.capacitySku : undefined,
    adminGroupId: typeof body?.adminGroupId === 'string' ? body.adminGroupId : undefined,
    memberGroupId: typeof body?.memberGroupId === 'string' ? body.memberGroupId : undefined,
    costCenter: typeof body?.costCenter === 'string' ? body.costCenter : undefined,
    chargebackTag: typeof body?.chargebackTag === 'string' ? body.chargebackTag : undefined,
    status: typeof body?.status === 'string' ? (body.status as DomainStatus) : undefined,
  };

  try {
    const domain = await upsertDomainBinding(tenantId, 'dlz-attach', input);
    return NextResponse.json({ ok: true, domain }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
