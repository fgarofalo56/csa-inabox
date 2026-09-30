/**
 * GET /api/storage/accounts → storage accounts the Console identity can read
 * (ARM), for the lakehouse shortcut wizard's in-tenant ADLS/Blob account picker.
 * Honest gate when the identity lacks Reader. 401 without a session
 * (`withSession`).
 */
import { NextResponse } from 'next/server';
import { withSession } from '@/lib/api/route-toolkit';
import { listStorageAccounts, StorageDiscoveryError } from '@/lib/azure/storage-discovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSession(async (_req, { session: s }) => {
  try {
    const accounts = await listStorageAccounts(s);
    return NextResponse.json({ ok: true, accounts });
  } catch (e: any) {
    const status = e instanceof StorageDiscoveryError ? e.status : 502;
    // The hint names only the role the listing needs. It does not offer manual
    // entry: several callers (the workspace storage binding, #4619) have none,
    // and a caller that does describes its own manual path.
    return NextResponse.json({
      ok: false, error: e?.message || String(e),
      hint: 'Grant the Console UAMI (LOOM_UAMI_CLIENT_ID) the Reader role on the subscription (Microsoft.Storage/storageAccounts/read) to list accounts.',
    }, { status: status === 401 || status === 403 ? 200 : status });
  }
});
