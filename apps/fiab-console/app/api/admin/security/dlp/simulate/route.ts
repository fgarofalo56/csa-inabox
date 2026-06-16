/**
 * /api/admin/security/dlp/simulate
 *
 * POST { content, policyIds?, metadata? }
 *   → ask Microsoft Graph DLP what would fire against sample text.
 *
 * Reality (audit B12): there is NO public Microsoft Graph REST endpoint for DLP
 * policy simulation — the old POST /beta/security/dataLossPrevention/evaluatePolicies
 * segment does not exist (live tenants return 400 "Resource not found for the
 * segment 'dataLossPrevention'"). evaluatePolicy() therefore throws a typed 501
 * honest gate, which this route renders as a clear MessageBar (no faked results).
 * If Microsoft ships a GA simulate API, repoint evaluatePolicy + remove the gate.
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
    // There is no public Graph DLP simulate API (audit B12) — evaluatePolicy()
    // throws a typed 501 (or 404 from a legacy path). Surface either as an honest
    // 501 gate with explicit remediation instead of leaking a raw error.
    if (e instanceof DlpError && (e.status === 501 || e.status === 404)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'DLP policy simulation is not available via Microsoft Graph',
          code: 'dlp_simulate_not_available',
          hint: {
            followUp: 'Microsoft Graph exposes no public REST API to simulate DLP policies. Test a policy in the Microsoft Purview portal (https://purview.microsoft.com → Data loss prevention → Policies → "..." → "Test policy") or via Security & Compliance PowerShell. Loom does not fabricate simulation results; this surface will light up automatically if Microsoft ships a GA Graph simulate endpoint.',
          },
        },
        { status: 501 },
      );
    }
    return handleSecurityError(e);
  }
}
