/**
 * POST /api/connections/[id]/purview
 * ----------------------------------
 * Per-connection "Register in Purview / Scan now" action. Registers an existing
 * Loom Connection as a Microsoft Purview CLASSIC Data Map scan source (real PUT
 * /scan/datasources via registerConnectionInPurview) and, when body.defineScan
 * is true, also upserts a System-ruleset scan.
 *
 * Best-effort + honest (no-vaporware.md): a silent skip when LOOM_PURVIEW_ACCOUNT
 * is unset (HTTP 200 with skipped:'not_configured'), an actionable 400 when the
 * connection type isn't a Purview-scannable store (Event Hubs / Service Bus /
 * Key Vault), and the real source/scan result otherwise.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadConnection, registerConnectionInPurview } from '@/lib/azure/connections-store';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({} as any));
  const defineScan = !!body?.defineScan;

  try {
    const conn = await loadConnection(session.claims.oid, params.id);
    if (!conn) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

    const result = await registerConnectionInPurview(conn, { defineScan });

    // The helper never throws; translate its outcome into honest HTTP codes.
    if (result.skipped === 'not_configured') {
      return NextResponse.json(
        { ...result, ok: true, error: 'Microsoft Purview is not configured (LOOM_PURVIEW_ACCOUNT unset).' },
        { status: 200 },
      );
    }
    if (result.skipped === 'unsupported') {
      return NextResponse.json({ ...result, ok: false, error: result.reason }, { status: 400 });
    }
    if (!result.ok) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result, { status: 200 });
  } catch (e: any) {
    return apiServerError(e);
  }
}
