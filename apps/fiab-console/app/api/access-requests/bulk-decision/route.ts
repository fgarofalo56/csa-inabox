/**
 * POST /api/access-requests/bulk-decision — bulk approve/deny F16 access requests
 * (access-governance W4, AG-14). Inbox bulk action.
 *
 * Body: { ids: string[], decision: 'approved' | 'denied', reason?: string }
 *
 * Applies the decision to each request by REUSING the real per-request decision
 * handler (POST /api/access-requests/[id]/decision) — so every leg runs the exact
 * same state machine, approver check, real RBAC grant, entitlement-ledger write,
 * notification, and audit entry as a single decision. No duplicated grant logic.
 * Returns a per-id result set (approved / denied / gated / error).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { normalizeIds } from '@/lib/access/leaver';
import { POST as decisionPOST } from '../[id]/decision/route';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const ids = normalizeIds(body?.ids);
  const decision = body?.decision === 'denied' ? 'denied' : body?.decision === 'approved' ? 'approved' : null;
  if (!decision) return NextResponse.json({ ok: false, error: 'decision must be "approved" or "denied"' }, { status: 400 });
  const reason = String(body?.reason || '').trim().slice(0, 500);
  if (decision === 'denied' && !reason) return NextResponse.json({ ok: false, error: 'a reason is required to deny requests' }, { status: 400 });
  if (ids.length === 0) return NextResponse.json({ ok: false, error: 'no request ids supplied' }, { status: 400 });

  try {
    const results: { id: string; ok: boolean; status: number; error?: string }[] = [];
    let succeeded = 0;
    for (const id of ids) {
      // Reuse the real single-request handler with a synthesized request so the
      // full grant/ledger/audit path runs identically per leg. Session resolves
      // from the same cookie context.
      const inner = new NextRequest(new URL(`http://internal/api/access-requests/${id}/decision`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
      });
      let res: NextResponse;
      try {
        res = await decisionPOST(inner, { params: Promise.resolve({ id }) });
      } catch (e: any) {
        results.push({ id, ok: false, status: 500, error: e?.message || String(e) });
        continue;
      }
      const j = await res.json().catch(() => ({}));
      const ok = res.status < 400 && j?.ok !== false;
      if (ok) succeeded++;
      results.push({ id, ok, status: res.status, ...(ok ? {} : { error: j?.error || j?.warning || `HTTP ${res.status}` }) });
    }
    return NextResponse.json({ ok: succeeded > 0, decision, total: ids.length, succeeded, failed: ids.length - succeeded, results });
  } catch (e: any) {
    return apiServerError(e);
  }
}
