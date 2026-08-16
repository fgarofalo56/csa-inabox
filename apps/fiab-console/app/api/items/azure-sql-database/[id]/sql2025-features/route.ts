/**
 * POST /api/items/azure-sql-database/[id]/sql2025-features
 *   Probes THIS item's bound database engine, returns version + a note for the
 *   UI MessageBar if older than SQL 2025 (major <17).
 *
 * AUTHORITY (GHSA-v8r7-c2p5-mjf2). `body.server` + `body.database` went to
 * `enableSqlServer2025Features` under a bare `getSession()`. The probe itself is
 * a version read, but it reaches TDS through the shared
 * `azure-sql-client.getPool`, which composes
 * `server.includes('.') ? server : `${server}.${sqlHostSuffix()}`` and then
 * presents an Entra ACCESS TOKEN for the SQL scope to whatever host that yields
 * — so a body carrying an external FQDN egressed a live credential. That, not
 * the version string, is why this route is in the advisory.
 *
 * NOW the target is the item's bound connection, admitted against the governed
 * subscription set; `admitGovernedServer` reduces an FQDN to its first DNS
 * label, so no reachable value can name a host outside this cloud's SQL suffix.
 */

import { NextResponse } from 'next/server';
import { enableSqlServer2025Features } from '@/lib/azure/azure-sql-client';
import { withBoundSqlServer } from '@/app/api/items/_lib/sql-server-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withBoundSqlServer(
  { provider: 'sql', requireDatabase: true },
  async (_req, { server, database }) => {
    const r = await enableSqlServer2025Features(server, database);
    return NextResponse.json(r);
  },
);
