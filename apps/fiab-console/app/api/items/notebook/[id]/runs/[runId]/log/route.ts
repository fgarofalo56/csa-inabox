/**
 * GET /api/items/notebook/[id]/runs/[runId]/log?workspaceId=...&from=&size=
 *   → { ok, from, total, lines: string[] }
 *
 * DRIVER-LOG slice for an in-flight (or finished) notebook run — the
 * Databricks/Synapse-parity "driver logs" stream (#63 output fidelity). Tail by
 * re-requesting with from = max(0, total - size) from the previous response.
 *
 *   spark:<pool>:<sessionId>[:stmt] → Livy session log (real stdout/stderr of
 *     the Spark driver, includes cold-start progress — useful long before the
 *     first statement returns).
 *   aml-ci:<jobName>               → terminal-state artifact log (best-effort;
 *     empty while the job is still running — AML exposes artifacts at end).
 *   databricks:<runId>             → honest 501 (cluster log delivery is a
 *     cluster-config concern, not a per-run API).
 *
 * Session-guarded + workspace-owner-guarded like the sibling poll route.
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { assertOwner } from '@/lib/auth/workspace-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return apiError('workspaceId required', 400);
  if (!(await assertOwner(workspaceId, s.claims.oid))) return apiError('notebook not found', 404);

  const runId = decodeURIComponent((await ctx.params).runId);
  const from = Math.max(0, Number(req.nextUrl.searchParams.get('from')) || 0);
  const size = Math.min(1000, Math.max(1, Number(req.nextUrl.searchParams.get('size')) || 200));

  if (runId.startsWith('spark:')) {
    const [, pool, sessionIdStr] = runId.split(':');
    const sessionId = Number(sessionIdStr);
    if (!pool || !Number.isFinite(sessionId)) return apiError('malformed runId', 400);
    try {
      const { getLivySessionLog } = await import('@/lib/azure/synapse-livy-client');
      const slice = await getLivySessionLog(pool, sessionId, from, size);
      return NextResponse.json({ ok: true, from: slice.from, total: slice.total, lines: slice.log });
    } catch (e) {
      return apiError(`driver log unavailable: ${(e as Error)?.message || e}`, 502);
    }
  }

  if (runId.startsWith('aml-ci:')) {
    try {
      const { getCiJobLog } = await import('@/lib/azure/aml-client');
      const log = await getCiJobLog(runId.slice('aml-ci:'.length));
      const lines = log ? log.split('\n') : [];
      return NextResponse.json({ ok: true, from: 0, total: lines.length, lines: lines.slice(-size) });
    } catch (e) {
      return apiError(`driver log unavailable: ${(e as Error)?.message || e}`, 502);
    }
  }

  return NextResponse.json(
    { ok: false, error: `Driver-log streaming is not yet supported for this backend (${runId.split(':')[0]}).` },
    { status: 501 },
  );
}
