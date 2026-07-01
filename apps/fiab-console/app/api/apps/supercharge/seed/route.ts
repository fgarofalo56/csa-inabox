/**
 * POST /api/apps/supercharge/seed
 *   body: { workspaceId: string, pool?: string }
 *
 * Lands the supercharge medallion sample data (Files/output/* Bronze source
 * parquet) and pre-creates the lh_bronze/lh_silver/lh_gold Spark databases on a
 * Synapse Spark pool via Livy — so a freshly-installed Supercharge app's Bronze
 * notebooks have data to ingest and the medallion (bronze->silver->gold) flows.
 * Azure-native, no Microsoft Fabric required.
 *
 * The seed cold-starts a Spark session and can run for minutes, past the edge
 * gateway's ~30s window, so this route fires the seed in a floating promise and
 * returns 202 immediately (same mechanism as /api/apps/[id]/install). The
 * install worker also runs this seed automatically for medallion apps; this
 * route lets an operator (re-)seed a workspace on demand.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { runSuperchargeSeed } from '@/lib/apps/supercharge-seed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const workspaceId = (body?.workspaceId || '').toString().trim();
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });

  const pool = (body?.pool || process.env.LOOM_SYNAPSE_SPARK_POOL || process.env.LOOM_SYNAPSE_DEDICATED_POOL || 'loompool').toString().trim();

  // Verify caller owns the workspace.
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, s.claims.oid).read<any>();
    if (!resource || resource.tenantId !== s.claims.oid) {
      return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    }
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
    throw e;
  }

  // Fire the seed in the background; the Container App Node process stays alive
  // across the response so the Livy session cold-start + statement complete.
  void runSuperchargeSeed(pool)
    .then((r) => { if (!r.ok) console.error('[supercharge-seed]', workspaceId, r.status, r.error || r.gate); })
    .catch((e) => console.error('[supercharge-seed] threw', workspaceId, e?.message || e));

  return NextResponse.json(
    { ok: true, status: 'seeding', pool, note: 'Sample-data seed started on the Spark pool; Bronze notebooks can ingest once it completes (~1-3 min after cold-start).' },
    { status: 202 },
  );
}
