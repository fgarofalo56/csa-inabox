/**
 * /api/admin/feedback-forwarding (rel-T79)
 *
 * GET  → { ok, autoErrorForwarding, tokenConfigured, updatedAt?, updatedBy? }
 *          `tokenConfigured` reflects whether LOOM_FEEDBACK_GITHUB_TOKEN is set,
 *          so the admin UI can say whether forwarding is even active for this
 *          deployment (an air-gapped tenant never forwards regardless).
 * PUT  → body { autoErrorForwarding: boolean } → persists the deployment-wide
 *          singleton (see lib/feedback/forwarding-config.ts) and emits an audit
 *          entry. Returns { ok, autoErrorForwarding, updatedAt }.
 *
 * HARD tenant-admin gate — this is a deployment-wide privacy control. Real
 * Cosmos persistence, no mocks (see .claude/rules/no-vaporware.md). The
 * anonymous auto-error path in /api/feedback reads the same singleton.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiServerError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import {
  readFeedbackForwardingDoc,
  setAutoErrorForwarding,
  feedbackForwardingScope,
} from '@/lib/feedback/forwarding-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  try {
    const doc = await readFeedbackForwardingDoc();
    return NextResponse.json({
      ok: true,
      autoErrorForwarding: doc.autoErrorForwarding,
      tokenConfigured: !!process.env.LOOM_FEEDBACK_GITHUB_TOKEN,
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const denied = requireTenantAdmin(s);
  if (denied) return denied;
  const body = await req.json().catch(() => ({}));
  if (typeof body?.autoErrorForwarding !== 'boolean') {
    return apiError('autoErrorForwarding (boolean) required', 400);
  }
  const who = s.claims.upn || s.claims.email || s.claims.oid;
  try {
    const before = await readFeedbackForwardingDoc();
    const doc = await setAutoErrorForwarding(body.autoErrorForwarding, who);

    // Audit only a real change.
    if (before.autoErrorForwarding !== doc.autoErrorForwarding) {
      try {
        const audit = await auditLogContainer();
        await audit.items.create({
          id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          itemId: `feedback-forwarding:${feedbackForwardingScope()}`,
          tenantId: feedbackForwardingScope(),
          who,
          at: doc.updatedAt,
          kind: 'feedback-forwarding.toggle',
          key: 'autoErrorForwarding',
          from: before.autoErrorForwarding,
          to: doc.autoErrorForwarding,
        }).catch(() => {});
      } catch { /* audit failures are non-blocking */ }
    }

    return NextResponse.json({
      ok: true,
      autoErrorForwarding: doc.autoErrorForwarding,
      updatedAt: doc.updatedAt,
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
