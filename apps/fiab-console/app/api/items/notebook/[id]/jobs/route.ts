/**
 * GET /api/items/notebook/[id]/jobs?workspaceId=...
 *   Returns recent run instances (run history) for this notebook.
 *
 * Azure-native by DEFAULT (no Fabric required). Run history lives in Cosmos:
 * every terminal cell/notebook run is appended to state.runHistory by the
 * poll route (/runs/[runId]); in-flight runs are derived from state.pendingRuns
 * and the persisted Livy session. The HistoryDrawer renders these one-for-one.
 *
 * Fabric is strictly opt-in (per no-fabric-dependency.md): only when a real
 * Fabric workspace GUID is bound AND LOOM_NOTEBOOK_BACKEND=fabric do we also
 * fetch + merge Fabric job instances. A non-GUID workspaceId (the normal Loom
 * workspace slug) NEVER hits api.fabric.microsoft.com — that was the GUID bug.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface JobLite {
  id: string;
  status?: string;
  jobType?: string;
  invokeType?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: { errorCode?: string; message?: string } | null;
  runUrl?: string;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!getSession()) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return NextResponse.json({ ok: false, error: 'workspaceId required' }, { status: 400 });
  const id = (await ctx.params).id;

  // --- DEFAULT: Cosmos-backed run history (Azure-native, no Fabric) ---
  let jobs: JobLite[] = [];
  let fabricWorkspaceId: string | undefined;
  try {
    const items = await itemsContainer();
    const { resource: nb } = await items.item(id, workspaceId).read<WorkspaceItem>();
    if (!nb || nb.itemType !== 'notebook') {
      return NextResponse.json({ ok: false, error: 'notebook not found' }, { status: 404 });
    }
    const state = (nb.state as any) || {};

    // Completed runs persisted by the poll route, newest first.
    const history: JobLite[] = Array.isArray(state.runHistory) ? state.runHistory : [];
    jobs = history.slice().reverse();

    // In-flight runs (cell dispatched, statement not yet terminal): surface
    // pendingRuns so a running cell shows up live in the drawer.
    const pending = (state.pendingRuns && typeof state.pendingRuns === 'object') ? state.pendingRuns : {};
    for (const [runId, p] of Object.entries<any>(pending)) {
      if (jobs.some((j) => j.id === runId)) continue;
      jobs.unshift({
        id: runId,
        status: 'InProgress',
        jobType: 'NotebookRun',
        invokeType: 'Manual',
        startTimeUtc: p?.startedAt || new Date().toISOString(),
      });
    }

    // Opt-in only: a bound Fabric workspace GUID.
    const candidate = state.fabricWorkspaceId || state.definition?.fabricWorkspaceId;
    if (typeof candidate === 'string' && GUID_RE.test(candidate)) fabricWorkspaceId = candidate;
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.code === 404 ? 404 : 502 });
  }

  // --- OPT-IN: merge Fabric job instances only when a GUID is bound + chosen ---
  if (fabricWorkspaceId && (process.env.LOOM_NOTEBOOK_BACKEND || '').toLowerCase() === 'fabric') {
    try {
      const { listJobInstances } = await import('@/lib/azure/fabric-client');
      const fabricJobs = await listJobInstances(fabricWorkspaceId, id);
      const seen = new Set(jobs.map((j) => j.id));
      for (const f of fabricJobs) if (!seen.has(f.id)) jobs.push(f as JobLite);
      jobs.sort((a, b) => Date.parse(b.startTimeUtc || '') - Date.parse(a.startTimeUtc || ''));
    } catch { /* honest: Cosmos history still returns; Fabric is best-effort */ }
  }

  return NextResponse.json({ ok: true, jobs, backend: fabricWorkspaceId ? 'fabric+cosmos' : 'cosmos' });
}
