/**
 * /api/cosmos/containers — SQL (NoSQL) containers within a database.
 *
 *   GET    ?db=<name>                                  → { ok, containers:[…] }
 *   POST   { db, id, partitionKey, throughput?, maxThroughput? } → create
 *   DELETE ?db=<name>&container=<name>                 → delete
 *
 * Real backend:
 *   Microsoft.DocumentDB/databaseAccounts/{acct}/sqlDatabases/{db}/containers
 *   (ARM api-version 2024-11-15) via lib/azure/cosmos-account-client.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  listContainers, createContainer, deleteContainer,
  type CosmosIndexingPolicy, type CosmosUniqueKeyPolicy,
} from '@/lib/azure/cosmos-account-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const db = req.nextUrl.searchParams.get('db');
    if (!db) return NextResponse.json({ ok: false, error: 'db query param is required' }, { status: 400 });
    const containers = await listContainers(db, { withThroughput: true });
    return NextResponse.json({ ok: true, containers });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<{
      db?: string; id?: string; partitionKey?: string; throughput?: number; maxThroughput?: number;
      defaultTtl?: number; indexingPolicy?: CosmosIndexingPolicy; uniqueKeyPolicy?: CosmosUniqueKeyPolicy;
    }>(req);
    if (!body.db?.trim()) return NextResponse.json({ ok: false, error: 'db is required' }, { status: 400 });
    if (!body.id?.trim()) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });
    if (!body.partitionKey?.trim()) {
      return NextResponse.json({ ok: false, error: 'partitionKey is required (e.g. /id)' }, { status: 400 });
    }
    const container = await createContainer(body.db.trim(), {
      id: body.id.trim(),
      partitionKey: body.partitionKey.trim(),
      throughput: body.throughput,
      maxThroughput: body.maxThroughput,
      defaultTtl: body.defaultTtl,
      indexingPolicy: body.indexingPolicy,
      uniqueKeyPolicy: body.uniqueKeyPolicy,
    });
    return NextResponse.json({ ok: true, container });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const db = req.nextUrl.searchParams.get('db');
    const container = req.nextUrl.searchParams.get('container');
    if (!db || !container) {
      return NextResponse.json({ ok: false, error: 'db and container query params are required' }, { status: 400 });
    }
    await deleteContainer(db, container);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
