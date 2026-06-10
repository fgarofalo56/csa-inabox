/**
 * F16 Azure Connections — Log Analytics workspace picker source.
 *
 *   GET /api/admin/workspaces/{id}/connections/log-analytics-workspaces
 *       → { ok, workspaces: LawSummary[] }
 *
 * Real ARM OperationalInsights list against LOOM_SUBSCRIPTION_ID. No mocks —
 * when LOOM_SUBSCRIPTION_ID is unset the route returns an honest 400 the pane
 * surfaces as a MessageBar.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listLogAnalyticsWorkspaces, AzureConnectionError } from '@/lib/clients/azure-connections-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, _props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const workspaces = await listLogAnalyticsWorkspaces();
    return NextResponse.json({ ok: true, workspaces });
  } catch (e: any) {
    const status = e instanceof AzureConnectionError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
