/**
 * /api/cosmos/databases — SQL (NoSQL) databases on the navigator account.
 *
 *   GET                       → { ok, databases:[{name, throughput}] }
 *   POST  { id, throughput?, maxThroughput? } → create a database (real ARM PUT)
 *   DELETE ?db=<name>         → delete a database (real ARM DELETE)
 *
 * Real backend: Microsoft.DocumentDB/databaseAccounts/{acct}/sqlDatabases
 * (ARM api-version 2024-11-15) via lib/azure/cosmos-account-client.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listSqlDatabases, createSqlDatabase, deleteSqlDatabase,
} from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const databases = await listSqlDatabases({ withThroughput: true });
    return NextResponse.json({ ok: true, databases });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<{ id?: string; throughput?: number; maxThroughput?: number }>(req);
    if (!body.id?.trim()) {
      return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
    }
    const db = await createSqlDatabase({
      id: body.id.trim(),
      throughput: body.throughput,
      maxThroughput: body.maxThroughput,
    });
    return NextResponse.json({ ok: true, database: db });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const db = req.nextUrl.searchParams.get('db');
    if (!db) return NextResponse.json({ ok: false, error: 'db query param is required' }, { status: 400 });
    await deleteSqlDatabase(db);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
