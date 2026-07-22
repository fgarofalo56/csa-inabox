/**
 * GET /api/admin/secret-health → the live secret & credential expiry inventory
 * (S1): the Console MSAL app registration's passwordCredentials (Graph) +
 * tracked Key Vault secret attributes, with days-to-expiry + 60/30/7-day bands
 * and MSAL drift detection. Tenant-admin only (the inventory names credential
 * ids + expiry dates; no secret VALUES are ever read or returned).
 *
 * Real engine in lib/admin/secret-health (live Graph + KV reads — no mocks,
 * no-vaporware.md). The scheduled alerting sibling is
 * azure-functions/secret-expiry-monitor (shared action group + dedup issue).
 */
import { NextResponse } from 'next/server';
import { withTenantAdmin } from '@/lib/api/route-toolkit';
import { getSecretHealthReport } from '@/lib/admin/secret-health';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export const GET = withTenantAdmin(async () => {
  try {
    const report = await getSecretHealthReport();
    return NextResponse.json({ ok: true, data: report });
  } catch (e: any) {
    return apiServerError(e);
  }
});
