/**
 * POST /api/items/azure-sql-database/[id]/replication
 *   body { replicaServer, replicaDatabaseName?, location, skuName? }
 *   Provisions a geo-secondary of THIS item's bound database on `replicaServer`.
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2): this route USED TO be `POST(req)` +
 * `getSession()` with `server`, `database` AND `replicaServer` all read from the
 * body and `[id]` never read. Geo-replication MOVES DATA: with the primary
 * caller-chosen it seeded a readable copy of any database the Console UAMI could
 * reach onto a server of the caller's choosing — a complete exfiltration
 * primitive across subscriptions.
 *
 * TWO coordinates are pinned, because `enableReplication` resolves BOTH through
 * the same `startsWith('/') ? raw : compose` branch:
 *   - the PRIMARY server + database → the item's bound connection.
 *   - `replicaServer` (the destination) → a legitimate user PICK, so it cannot
 *     come from the item; it is admitted against the governed subscription
 *     scope instead (`admitReplicaServer`), which is what stops an ARM id from
 *     landing the copy in a subscription this deployment does not govern.
 */

import { NextResponse } from 'next/server';
import { enableReplication } from '@/lib/azure/azure-sql-client';
import {
  withBoundSqlServer,
  admitReplicaServer,
  scopeRefused,
} from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withBoundSqlServer(
  { provider: 'sql', requireDatabase: true },
  async (_req, { server, database, body }) => {
    const { replicaServer, replicaDatabaseName, location, skuName } = body || {};
    if (!replicaServer || !location) {
      return NextResponse.json(
        { ok: false, error: 'replicaServer, location are required' },
        { status: 400 },
      );
    }
    const replica = admitReplicaServer(replicaServer, 'sql');
    if (!replica.ok) return scopeRefused(replica);

    const r = await enableReplication(server, database, {
      replicaServer: replica.server,
      replicaDatabaseName: replicaDatabaseName ? String(replicaDatabaseName) : undefined,
      location: String(location),
      skuName: skuName ? String(skuName) : undefined,
    });
    if (!r.ok) return NextResponse.json(r, { status: 502 });
    return NextResponse.json({ ok: true });
  },
);
