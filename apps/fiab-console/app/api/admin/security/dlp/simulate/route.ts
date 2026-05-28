/**
 * /api/admin/security/dlp/simulate
 *
 * POST { content, policyIds?, metadata? }
 *   → ask Microsoft Graph DLP what would fire against sample text.
 *
 * Backing call: POST /beta/security/dataLossPrevention/evaluatePolicies.
 *
 * Reality: this endpoint is in Graph /beta + behind a tenant-level
 * preview flag in most tenants. If the tenant hasn't opted in, the
 * upstream call returns 404 — the route surfaces that as a 501 with the
 * remediation hint so the panel renders a clear MessageBar instead of
 * faking results.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { evaluatePolicy, DlpError } from '@/lib/azure/dlp-graph-client';
import { handleSecurityError } from '../../_lib/error-handling';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CONTENT_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 }); }
  const content: string = (body?.content || '').toString();
  if (!content.trim()) return NextResponse.json({ ok: false, error: 'content is required' }, { status: 400 });
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return NextResponse.json({ ok: false, error: `content exceeds ${MAX_CONTENT_BYTES} bytes` }, { status: 413 });
  }

  try {
    const evaluation = await evaluatePolicy({
      content,
      policyIds: Array.isArray(body?.policyIds) ? body.policyIds : undefined,
      metadata: body?.metadata,
    });
    return NextResponse.json({ ok: true, evaluation });
  } catch (e) {
    // 404 from upstream means the tenant hasn't enabled the Graph DLP
    // simulate preview — surface that as a 501 with explicit remediation.
    if (e instanceof DlpError && e.status === 404) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Graph DLP simulate endpoint not available for this tenant',
          code: 'dlp_simulate_preview_not_enabled',
          hint: {
            followUp: 'Sign in to the Microsoft Purview portal at https://compliance.microsoft.com, open Data loss prevention → Policies, click "..." → "Test policy" on any policy. If the option is missing, your tenant has not been granted the Graph DLP simulate /beta preview. Open a Microsoft support ticket referencing endpoint /beta/security/dataLossPrevention/evaluatePolicies to request preview enrollment. Loom will start using the endpoint as soon as it returns 200.',
          },
        },
        { status: 501 },
      );
    }
    return handleSecurityError(e);
  }
}
