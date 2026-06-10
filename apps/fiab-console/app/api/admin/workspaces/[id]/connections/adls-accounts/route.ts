/**
 * F16 Azure Connections — ADLS Gen2 account picker source.
 *
 *   GET /api/admin/workspaces/{id}/connections/adls-accounts
 *       → { ok, accounts: StorageAccountSummary[] }   (ADLS Gen2 / HNS first)
 *
 * Real ARM Storage list across the subscriptions the Console identity can read
 * (storage-discovery.ts). No mocks — when the identity lacks Reader the list is
 * empty and the pane shows an honest empty-state.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listAdlsAccounts, AzureConnectionError } from '@/lib/clients/azure-connections-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, _props: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const accounts = await listAdlsAccounts();
    return NextResponse.json({ ok: true, accounts });
  } catch (e: any) {
    const status = e instanceof AzureConnectionError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
