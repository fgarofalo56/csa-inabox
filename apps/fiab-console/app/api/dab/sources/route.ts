/**
 * GET /api/dab/sources?kind=mssql|postgresql|cosmosdb_nosql
 *   → list candidate Loom data sources (servers/accounts + their databases) for
 *     the DAB Data-source stage. Real Azure control-plane via existing clients.
 *
 * Honest gate: when LOOM_SUBSCRIPTION_ID is unset the underlying clients throw a
 * config error; we surface it as { ok:false, gate } so the UI can render the
 * exact env var instead of faking a list.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { jerr } from '../../items/_lib/item-crud';
import { listServers, listDatabases } from '@/lib/azure/azure-sql-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return jerr('unauthenticated', 401);
  const kind = (req.nextUrl.searchParams.get('kind') || 'mssql') as string;

  if (!process.env.LOOM_SUBSCRIPTION_ID) {
    return NextResponse.json(
      { ok: false, gate: { missing: 'LOOM_SUBSCRIPTION_ID' }, error: 'Subscription not configured for source discovery.' },
      { status: 503 },
    );
  }

  try {
    if (kind === 'mssql') {
      const servers = await listServers();
      // Resolve databases per server (best-effort; skip failures).
      const out = await Promise.all(
        servers.map(async (s) => {
          let databases: { name: string }[] = [];
          try {
            const dbs = await listDatabases(s.name);
            databases = dbs.filter((d) => d.name.toLowerCase() !== 'master').map((d) => ({ name: d.name }));
          } catch { /* server may be unreachable; still list it */ }
          return { server: s.name, fqdn: s.fqdn, databases };
        }),
      );
      return NextResponse.json({ ok: true, kind, sources: out });
    }
    // postgresql + cosmosdb_nosql discovery is wired via their own navigators;
    // honest gate here keeps the surface truthful until those listers are bridged.
    return NextResponse.json(
      {
        ok: false,
        gate: { missing: kind === 'postgresql' ? 'LOOM_POSTGRES_DISCOVERY' : 'LOOM_COSMOS_ACCOUNT' },
        error: `Source discovery for ${kind} is provided by the dedicated navigator; pick the server/account there, then enter it on the Data source stage.`,
      },
      { status: 503 },
    );
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}
