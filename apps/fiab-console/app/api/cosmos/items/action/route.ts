/**
 * /api/cosmos/items/action — write side of the Cosmos Items Data Explorer.
 *
 *   POST { op:'upsert', db, container, document, partitionKeyPath? }
 *          → create-or-replace a document (the portal's New / Save). The
 *            partition-key VALUE is derived from the container's pk path on the
 *            document itself; pass partitionKeyPath (e.g. "/tenantId") so the
 *            write is scoped to the right logical partition.
 *          Returns { ok, document, requestCharge }.
 *
 *   POST { op:'delete', db, container, id, partitionKey }
 *          → delete a document by id + partition-key value.
 *          Returns { ok, requestCharge }.
 *
 * This is a sibling of the query/get route (../route.ts); the write verbs live
 * here so the query POST and the upsert POST (both hit the /docs feed) don't
 * collide on one handler.
 *
 * Real backend: Cosmos DB SQL data plane on
 *   https://<account>.documents.azure.com/dbs/{db}/colls/{coll}/docs
 * via lib/azure/cosmos-data-client.ts (AAD data-plane auth). Session guard +
 * honest 503 / 403-dataplane gates mirror the rest of /api/cosmos/*.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  upsertItem, deleteItem, partitionKeyValueFromDoc,
} from '@/lib/azure/cosmos-data-client';
import { requireSession, gateResponse, errorResponse, readBody } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ActionBody {
  op?: 'upsert' | 'delete';
  db?: string;
  container?: string;
  document?: Record<string, unknown>;
  /** pk path on the container (e.g. "/tenantId") used to derive the pk value on upsert. */
  partitionKeyPath?: string;
  /** explicit pk value (delete, or upsert override). */
  partitionKey?: unknown;
  id?: string;
}

export async function POST(req: NextRequest) {
  const unauth = requireSession(); if (unauth) return unauth;
  const gated = gateResponse(); if (gated) return gated;
  try {
    const body = await readBody<ActionBody>(req);
    if (!body.db?.trim()) return NextResponse.json({ ok: false, error: 'db is required' }, { status: 400 });
    if (!body.container?.trim()) return NextResponse.json({ ok: false, error: 'container is required' }, { status: 400 });
    const db = body.db.trim();
    const container = body.container.trim();

    if (body.op === 'delete') {
      if (!body.id) return NextResponse.json({ ok: false, error: 'id is required for delete' }, { status: 400 });
      // pk defaults to the id for /id-partitioned containers when not given.
      const pk = body.partitionKey !== undefined ? body.partitionKey : body.id;
      const r = await deleteItem(db, container, body.id, pk);
      return NextResponse.json({ ok: true, requestCharge: r.requestCharge });
    }

    if (body.op === 'upsert') {
      const doc = body.document;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return NextResponse.json({ ok: false, error: 'document (a JSON object) is required for upsert' }, { status: 400 });
      }
      // Derive the partition-key value from the pk path on the doc, unless an
      // explicit value was supplied. Fall back to doc.id for /id containers.
      let pk = body.partitionKey;
      if (pk === undefined) {
        pk = body.partitionKeyPath
          ? partitionKeyValueFromDoc(doc, body.partitionKeyPath)
          : (doc as any).id;
      }
      const r = await upsertItem(db, container, doc, pk);
      return NextResponse.json({ ok: true, document: r.document, requestCharge: r.requestCharge });
    }

    return NextResponse.json({ ok: false, error: "op must be 'upsert' or 'delete'" }, { status: 400 });
  } catch (e) {
    return errorResponse(e);
  }
}
