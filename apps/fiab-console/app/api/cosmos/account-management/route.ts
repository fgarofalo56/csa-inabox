/**
 * /api/cosmos/account-management — the Cosmos DB *account* blade (the portal's
 * account-level management the Data Explorer studio does NOT expose):
 * Replicate-data-globally, default Consistency, Backup & Restore, Networking.
 *
 *   GET   → { ok, management: CosmosAccountManagement }
 *   PATCH { section, … }  → { ok, management }
 *     section='consistency'        { consistencyPolicy }
 *     section='globalDistribution' { locations } | { enableMultipleWriteLocations?, enableAutomaticFailover? }
 *     section='backup'             { backupPolicy }
 *     section='networking'         { publicNetworkAccess?, isVirtualNetworkFilterEnabled?, ipRules?, virtualNetworkRules? }
 *
 * Real backend: GET / PATCH Microsoft.DocumentDB/databaseAccounts/{acct}
 * (ARM "Database Accounts - Update", api-version 2024-11-15) via
 * lib/azure/cosmos-account-client.ts. No mocks — a read-only UAMI gets ARM 403,
 * surfaced by errorResponse() as an honest "DocumentDB Account Contributor"
 * gate (per no-vaporware.md).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAccountManagement,
  updateAccountConsistency,
  updateAccountLocations,
  updateAccountReplication,
  updateAccountBackupPolicy,
  updateAccountNetworking,
  type CosmosConsistencyPolicy,
  type CosmosAccountLocation,
  type CosmosBackupPolicy,
  type CosmosVirtualNetworkRule,
} from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const management = await getAccountManagement();
    if (!management) {
      return NextResponse.json(
        { ok: false, error: 'Cosmos account not found at the configured subscription/resource group/name.' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, management });
  } catch (e) {
    return errorResponse(e);
  }
}

interface PatchBody {
  section?: 'consistency' | 'globalDistribution' | 'backup' | 'networking';
  consistencyPolicy?: CosmosConsistencyPolicy;
  locations?: CosmosAccountLocation[];
  enableMultipleWriteLocations?: boolean;
  enableAutomaticFailover?: boolean;
  backupPolicy?: CosmosBackupPolicy;
  publicNetworkAccess?: 'Enabled' | 'Disabled';
  isVirtualNetworkFilterEnabled?: boolean;
  ipRules?: string[];
  virtualNetworkRules?: CosmosVirtualNetworkRule[];
}

export async function PATCH(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<PatchBody>(req);
    let management;
    switch (body.section) {
      case 'consistency': {
        if (!body.consistencyPolicy?.defaultConsistencyLevel) {
          return NextResponse.json({ ok: false, error: 'consistencyPolicy.defaultConsistencyLevel is required' }, { status: 400 });
        }
        management = await updateAccountConsistency(body.consistencyPolicy);
        break;
      }
      case 'globalDistribution': {
        if (Array.isArray(body.locations)) {
          management = await updateAccountLocations(body.locations);
        } else if (typeof body.enableMultipleWriteLocations === 'boolean' || typeof body.enableAutomaticFailover === 'boolean') {
          management = await updateAccountReplication({
            enableMultipleWriteLocations: body.enableMultipleWriteLocations,
            enableAutomaticFailover: body.enableAutomaticFailover,
          });
        } else {
          return NextResponse.json({ ok: false, error: 'provide locations[] or a replication toggle' }, { status: 400 });
        }
        break;
      }
      case 'backup': {
        if (!body.backupPolicy?.type) {
          return NextResponse.json({ ok: false, error: 'backupPolicy.type (Periodic|Continuous) is required' }, { status: 400 });
        }
        management = await updateAccountBackupPolicy(body.backupPolicy);
        break;
      }
      case 'networking': {
        management = await updateAccountNetworking({
          publicNetworkAccess: body.publicNetworkAccess,
          isVirtualNetworkFilterEnabled: body.isVirtualNetworkFilterEnabled,
          ipRules: body.ipRules,
          virtualNetworkRules: body.virtualNetworkRules,
        });
        break;
      }
      default:
        return NextResponse.json({ ok: false, error: 'unknown section (consistency|globalDistribution|backup|networking)' }, { status: 400 });
    }
    return NextResponse.json({ ok: true, management });
  } catch (e) {
    return errorResponse(e);
  }
}
