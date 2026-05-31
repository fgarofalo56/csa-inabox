/**
 * /api/cosmos/account — the navigator account header chip + sanity probe.
 *
 *   GET → { ok, account:{ name, location, documentEndpoint, capabilities,
 *                          serverless, provisioningState, enableFreeTier } }
 *
 * Real backend: GET Microsoft.DocumentDB/databaseAccounts/{acct}
 * (ARM api-version 2024-11-15) via lib/azure/cosmos-account-client.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAccountInfo } from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const account = await getAccountInfo();
    if (!account) {
      return NextResponse.json(
        { ok: false, error: 'Cosmos account not found at the configured subscription/resource group/name.' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, account });
  } catch (e) {
    return errorResponse(e);
  }
}
