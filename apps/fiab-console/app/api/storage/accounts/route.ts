/**
 * GET /api/storage/accounts → storage accounts the Console identity can read
 * (ARM), for the lakehouse shortcut wizard's in-tenant ADLS/Blob account picker.
 * Honest gate when the identity lacks Reader.
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listStorageAccounts, StorageDiscoveryError } from '@/lib/azure/storage-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const accounts = await listStorageAccounts();
    return NextResponse.json({ ok: true, accounts });
  } catch (e: any) {
    const status = e instanceof StorageDiscoveryError ? e.status : 502;
    return NextResponse.json({
      ok: false, error: e?.message || String(e),
      hint: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Reader role on the subscription (Microsoft.Storage/storageAccounts/read) to list accounts, or enter the storage URI manually.',
    }, { status: status === 401 || status === 403 ? 200 : status });
  }
}
