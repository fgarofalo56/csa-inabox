/**
 * Ops Admin Copilot — execute endpoint.
 *
 *   POST /api/admin/ops-copilot/execute   { intentionId: string }
 *
 * 1. Validates the session (401).
 * 2. Loads the staged intention from Cosmos; verifies it belongs to THIS caller
 *    and is still pending (403 / 409 otherwise) — an intention can only be
 *    executed by the admin who classified it, and only once.
 * 3. Performs the REAL ARM / Cosmos write via executeOpsIntention. An ARM 403
 *    (the executing UAMI lacks the role) is surfaced verbatim as `roleGate` so
 *    the pane shows an honest remediation MessageBar — never a fake success.
 * 4. Marks the intention executed/failed in Cosmos.
 *
 * No mocks, no silent no-op.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { executeOpsIntention, OpsUnconfiguredError, type OpsIntention } from '@/lib/copilot/ops-tools';
import { copilotSessionsContainer } from '@/lib/azure/cosmos-client';
import { OPS_COPILOT_PERSONAS, OPS_PERSONA_ID } from '@/lib/azure/copilot-personas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function looksLikeAuthFailure(msg: string): boolean {
  return /\b(403|401|AuthorizationFailed|does not have authorization|Forbidden|insufficient privileges)\b/i.test(msg);
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  const callerOid = session.claims.oid || session.claims.upn || session.claims.email || '';

  let body: { intentionId?: string } = {};
  try { body = await req.json(); } catch {}
  const intentionId = (body.intentionId || '').trim();
  if (!intentionId) {
    return NextResponse.json({ ok: false, error: 'intentionId is required' }, { status: 400 });
  }

  const c = await copilotSessionsContainer();
  const read = await c.item(intentionId, intentionId).read<any>().catch(() => ({ resource: null }));
  const doc = read.resource;
  if (!doc || doc.kind !== 'ops-intention') {
    return NextResponse.json({ ok: false, error: 'intention not found' }, { status: 404 });
  }
  if (doc.userOid !== callerOid) {
    return NextResponse.json({ ok: false, error: 'this intention belongs to another user' }, { status: 403 });
  }
  if (doc.status !== 'pending') {
    return NextResponse.json({ ok: false, error: `intention already ${doc.status}` }, { status: 409 });
  }

  const intention = doc.intention as OpsIntention;
  try {
    const result = await executeOpsIntention(intention, callerOid);
    doc.status = result.ok ? 'executed' : 'failed';
    doc.executedAt = new Date().toISOString();
    doc.resultDetail = result.detail;
    await c.item(intentionId, intentionId).replace(doc).catch(() => {});
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.detail }, { status: 400 });
    }
    return NextResponse.json({ ok: true, detail: result.detail, result: result.result });
  } catch (e: any) {
    const msg = e?.message || String(e);
    doc.status = 'failed';
    doc.executedAt = new Date().toISOString();
    doc.resultDetail = msg;
    await c.item(intentionId, intentionId).replace(doc).catch(() => {});

    if (e instanceof OpsUnconfiguredError) {
      return NextResponse.json({ ok: false, configGate: msg }, { status: 200 });
    }
    if (looksLikeAuthFailure(msg)) {
      const actions = (OPS_COPILOT_PERSONAS[OPS_PERSONA_ID]?.requiredArmActions || []).join(', ');
      return NextResponse.json({
        ok: false,
        roleGate:
          `Azure rejected the operation — the CSA Loom Console identity lacks the required role. ` +
          (actions ? `Grant it the Azure RBAC actions (${actions}) on the target resource, e.g. Contributor on the Synapse workspace / ADX cluster. ` : '') +
          `ARM said: ${msg}`,
      }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
