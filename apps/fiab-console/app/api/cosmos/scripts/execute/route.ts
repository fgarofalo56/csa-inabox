/**
 * /api/cosmos/scripts/execute — execute a stored procedure on the data plane.
 *
 *   POST { db, container, sprocName, params?, partitionKey }
 *     → { ok, result, requestCharge }
 *
 * Real backend (Cosmos data plane) via lib/azure/cosmos-data-client.ts:
 *   POST {endpoint}/dbs/{db}/colls/{container}/sprocs/{sprocName}
 *     x-ms-documentdb-partitionkey: ["<pk>"]   (REQUIRED for partitioned containers)
 *     body: [<param1>, …]
 *
 * RBAC: this is a DATA-plane call — it needs the "Cosmos DB Built-in Data
 * Contributor" data-plane role on the Console UAMI (same as the Items tab), not
 * the control-plane "DocumentDB Account Contributor". A 403 surfaces as the
 * honest dataplane_rbac gate (see _shared.errorResponse).
 *
 * (Only stored procedures are directly executable: triggers fire implicitly on
 * item writes, and UDFs are invoked inline in SQL queries.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { executeStoredProcedure } from '@/lib/azure/cosmos-data-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<{
      db?: string; container?: string; sprocName?: string;
      params?: unknown[]; partitionKey?: unknown;
    }>(req);
    const db = body.db?.trim();
    const container = body.container?.trim();
    const sprocName = body.sprocName?.trim();
    if (!db || !container || !sprocName) {
      return NextResponse.json({ ok: false, error: 'db, container, and sprocName are required' }, { status: 400 });
    }
    const params = Array.isArray(body.params) ? body.params : [];
    const { result, requestCharge } = await executeStoredProcedure(db, container, sprocName, {
      params,
      partitionKey: body.partitionKey,
    });
    return NextResponse.json({ ok: true, result, requestCharge });
  } catch (e) {
    return errorResponse(e);
  }
}
