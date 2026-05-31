/**
 * /api/cosmos/items — the Cosmos DB **data-plane** Items Data Explorer BFF.
 *
 *   POST  { db, container, query?, parameters?, partitionKey?, crossPartition?,
 *           maxItems?, continuation? }
 *          → run a SQL query against the container's documents feed.
 *          query defaults to `SELECT * FROM c` (top maxItems).
 *          Returns { ok, documents, requestCharge, continuation, count }.
 *
 *   GET   ?db=&container=&id=&pk=
 *          → read a single document by id + partition-key value.
 *          Returns { ok, document, requestCharge }.
 *
 * Item create/replace/delete live in the sibling action route
 *   app/api/cosmos/items/action/route.ts
 * so the verbs stay legible (Cosmos upsert is a POST to the same /docs feed,
 * which would otherwise collide with the query POST here).
 *
 * Real backend: the Cosmos DB SQL data plane on
 *   https://<account>.documents.azure.com/dbs/{db}/colls/{coll}/docs
 * via lib/azure/cosmos-data-client.ts (AAD data-plane auth — NOT master key).
 *
 * Session guard + honest gates mirror the control-plane routes:
 *   - 503 not_configured when the navigator account env isn't wired
 *   - 403 dataplane_rbac when the UAMI lacks the Cosmos data-plane role
 *     (surfaced verbatim with the exact role to grant; full UI still renders).
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryItems, getItem } from '@/lib/azure/cosmos-data-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_QUERY = 'SELECT * FROM c';
const DEFAULT_MAX_ITEMS = 100;

interface QueryBody {
  db?: string;
  container?: string;
  query?: string;
  parameters?: { name: string; value: unknown }[];
  partitionKey?: unknown;        // (reserved) single-partition scoping override
  crossPartition?: boolean;
  maxItems?: number;
  continuation?: string | null;
}

export async function POST(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<QueryBody>(req);
    if (!body.db?.trim()) return NextResponse.json({ ok: false, error: 'db is required' }, { status: 400 });
    if (!body.container?.trim()) return NextResponse.json({ ok: false, error: 'container is required' }, { status: 400 });

    const query = (body.query && body.query.trim()) || DEFAULT_QUERY;
    const maxItems = Number.isFinite(body.maxItems) && (body.maxItems as number) > 0
      ? Math.floor(body.maxItems as number)
      : DEFAULT_MAX_ITEMS;

    const result = await queryItems(body.db.trim(), body.container.trim(), query, {
      maxItems,
      crossPartition: body.crossPartition !== false,
      continuation: body.continuation ?? null,
      parameters: Array.isArray(body.parameters) ? body.parameters : [],
    });

    return NextResponse.json({
      ok: true,
      documents: result.documents,
      requestCharge: result.requestCharge,
      continuation: result.continuation,
      count: result.count,
      query,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const sp = req.nextUrl.searchParams;
    const db = sp.get('db');
    const container = sp.get('container');
    const id = sp.get('id');
    if (!db || !container || !id) {
      return NextResponse.json({ ok: false, error: 'db, container and id query params are required' }, { status: 400 });
    }
    // pk is optional: for containers whose pk path equals /id (or for the
    // pk-less legacy case) the value can be the id itself or omitted.
    const pkRaw = sp.get('pk');
    const pk = pkRaw === null ? id : pkRaw;
    const result = await getItem(db, container, id, pk);
    if (!result.document) {
      return NextResponse.json({ ok: false, error: 'document not found', status: 404 }, { status: 404 });
    }
    return NextResponse.json({ ok: true, document: result.document, requestCharge: result.requestCharge });
  } catch (e) {
    return errorResponse(e);
  }
}
