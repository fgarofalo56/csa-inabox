/**
 * Databricks cluster HYGIENE surface.
 *
 * GET  /api/items/databricks-cluster/hygiene
 *   → { ok, rows, staleCount, gate? }
 *     Lists EVERY cluster in the bound workspace enriched with idle-days,
 *     stale classification, source, and Loom-managed / preset badges. When
 *     Databricks isn't configured, returns an honest gate (200, gate set) so
 *     the UI can render the remediation MessageBar rather than error.
 *
 * POST /api/items/databricks-cluster/hygiene  body { action, clusterIds }
 *   → { ok, results: [{ cluster_id, ok, error? }] }
 *     Bulk 'terminate' (clusters/delete) or 'delete' (clusters/permanent-delete)
 *     over the selected clusters. Session-guarded; each id is applied
 *     independently so one failure doesn't abort the batch.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listClusters,
  terminateCluster,
  permanentDeleteCluster,
  databricksConfigGate,
} from '@/lib/azure/databricks-client';
import { toHygieneRow } from '@/lib/databricks/cluster-presets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Honest gate (no-vaporware): when the workspace URL / token env is unset,
  // return a 200 with a gate the UI renders as a warning MessageBar naming the
  // exact env var to set — not a 5xx.
  const gate = databricksConfigGate();
  if (gate) {
    return NextResponse.json({ ok: true, rows: [], staleCount: 0, gate: gate.missing });
  }

  try {
    const clusters = await listClusters();
    const now = Date.now();
    const rows = clusters.map((c) => toHygieneRow(c, now));
    const staleCount = rows.filter((r) => r.stale).length;
    return NextResponse.json({ ok: true, rows, staleCount });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: e?.status === 403 ? 403 : 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  const clusterIds: string[] = Array.isArray(body?.clusterIds) ? body.clusterIds.filter(Boolean) : [];

  if (action !== 'terminate' && action !== 'delete') {
    return NextResponse.json(
      { ok: false, error: "action must be 'terminate' or 'delete'" },
      { status: 400 },
    );
  }
  if (clusterIds.length === 0) {
    return NextResponse.json({ ok: false, error: 'clusterIds must be a non-empty array' }, { status: 400 });
  }

  // Apply each id independently — one PERMISSION_DENIED / INVALID_STATE doesn't
  // abort the rest; the UI shows a per-cluster result.
  const results = await Promise.all(
    clusterIds.map(async (cid) => {
      try {
        if (action === 'delete') await permanentDeleteCluster(cid);
        else await terminateCluster(cid);
        return { cluster_id: cid, ok: true };
      } catch (e: any) {
        return { cluster_id: cid, ok: false, error: e?.message || String(e) };
      }
    }),
  );

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
