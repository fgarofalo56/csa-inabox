/**
 * POST /api/workspaces/[id]/task-flows/[flowId]/run
 *   → { ok, runId }   (202-style: returns immediately, drives async)
 *
 * GET  /api/workspaces/[id]/task-flows/[flowId]/run?runId=...  → { ok, run }
 * GET  /api/workspaces/[id]/task-flows/[flowId]/run            → { ok, runs } (last 20)
 *
 * Executes a task flow: topologically orders the steps from their edges, then —
 * for each step IN ORDER — launches every RUNNABLE linked item in parallel by
 * REUSING that item's real server-side run helper (ADF / Synapse / Databricks /
 * Spark), polling each to a terminal state before advancing. Non-runnable linked
 * types (lakehouse, warehouse, semantic-model, …) are skipped ('not runnable');
 * a step with zero runnable items is skipped. Progress is written to the Cosmos
 * `task-flow-runs` container so the UI can poll it.
 *
 * Owner-scoped: the caller must own the workspace (tenantId == session.oid) —
 * identical to the sibling task-flows routes. Loom-native; no Fabric dependency.
 * Fabric task flows cannot be executed at all, so real execution EXCEEDS Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { randomUUID } from 'node:crypto';
import { workspacesContainer, itemsContainer } from '@/lib/azure/cosmos-client';
import { dbGetTaskFlow } from '@/lib/clients/taskflow-client';
import {
  dbCreateFlowRun, dbSaveFlowRun, dbGetFlowRun, dbListFlowRuns,
} from '@/lib/clients/taskflow-run-client';
import {
  topoSortSteps, buildFlowRunSkeleton, flowHasRunnableItems,
  rollupStepStatus, rollupFlowStatus,
  type FlowRunDoc,
} from '@/lib/taskflow/step-runner';
import { launchItemRun, type LaunchedRun } from '@/lib/taskflow/launch-item';
import { apiServerError } from '@/lib/api/respond';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// --- poll tuning (Container Apps host, not Front Door — the driver outlives
// the 30s edge timeout because we return before it starts) ------------------
const POLL_INTERVAL_MS = 5000;
const MAX_POLLS_PER_ITEM = 240; // ~20 min ceiling per item (Spark cold-start safe)

/** Sanitize a value for logging: replace control chars, cap length (CodeQL log-injection). */
function safeLog(v: unknown): string {
  const str = String(v ?? '');
  let out = '';
  for (let i = 0; i < str.length && out.length < 200; i += 1) {
    const c = str.charCodeAt(i);
    out += c < 0x20 || c === 0x7f ? ' ' : str[i];
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function assertOwnedWorkspace(id: string, tenantId: string): Promise<boolean> {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(id, tenantId).read<any>();
    return !!resource && resource.tenantId === tenantId;
  } catch (e: any) {
    if (e?.code === 404) return false;
    throw e;
  }
}

/** Point-read a workspace item (owner already verified at the workspace). */
async function loadItem(itemId: string, workspaceId: string): Promise<WorkspaceItem | null> {
  const items = await itemsContainer();
  try {
    const { resource } = await items.item(itemId, workspaceId).read<WorkspaceItem>();
    return resource ?? null;
  } catch (e: any) {
    if (e?.code === 404) return null;
    throw e;
  }
}

export async function POST(
  _req: NextRequest,
  props: { params: Promise<{ id: string; flowId: string }> },
) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });

  try {
    const flow = await dbGetTaskFlow(params.id, params.flowId);
    if (!flow) return NextResponse.json({ ok: false, error: 'task flow not found' }, { status: 404 });

    // Topological order — a cycle is a hard 400 (a flow can't run a loop).
    const topo = topoSortSteps(flow.steps || [], flow.edges || []);
    if (!topo.ok) {
      const named = topo.cycle
        .map((sid) => (flow.steps || []).find((st) => st.id === sid)?.label || sid)
        .map(safeLog);
      return NextResponse.json(
        { ok: false, error: `Task flow has a cycle and cannot run: ${named.join(' → ')}` },
        { status: 400 },
      );
    }

    if (!flowHasRunnableItems(flow)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'This flow has no runnable steps. Link a pipeline, Databricks job, or notebook to a step, then run it.',
        },
        { status: 400 },
      );
    }

    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const doc = buildFlowRunSkeleton({
      runId,
      flow,
      order: topo.order,
      startedAt,
      startedBy: s.claims.upn || s.claims.oid,
    });
    await dbCreateFlowRun(doc);

    // Floating driver — advances steps sequentially, items within a step in
    // parallel. Errors are captured onto the doc (never thrown past here).
    void driveFlowRun(doc, params.id, s.claims.oid).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[taskflow-run] driver crashed:', safeLog(e?.message || e));
    });

    return NextResponse.json({ ok: true, runId }, { status: 202 });
  } catch (e: any) {
    return apiServerError(e);
  }
}

/**
 * Drive one flow run to completion. Loads + launches each step's runnable items
 * in parallel, polls them to terminal, persists progress after each transition.
 */
async function driveFlowRun(doc: FlowRunDoc, workspaceId: string, oid: string): Promise<void> {
  const persist = async () => {
    try {
      await dbSaveFlowRun(doc);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error('[taskflow-run] persist failed:', safeLog(e?.message || e));
    }
  };

  for (const step of doc.steps) {
    const pending = step.itemRuns.filter((i) => i.status === 'pending');
    if (pending.length === 0) {
      step.status = rollupStepStatus(step.itemRuns);
      await persist();
      continue;
    }
    step.status = 'running';
    doc.status = 'running';
    await persist();

    // Launch every runnable item in the step in parallel.
    const launched = new Map<string, LaunchedRun>();
    await Promise.all(
      pending.map(async (item) => {
        try {
          const item2 = await loadItem(item.itemId, workspaceId);
          if (!item2) throw new Error('linked item not found in this workspace');
          const run = await launchItemRun(item2, oid);
          item.runId = run.runId;
          item.detail = run.detail;
          item.status = 'running';
          launched.set(item.itemId, run);
        } catch (e: any) {
          item.status = 'failed';
          item.reason = safeLog(e?.message || String(e));
        }
      }),
    );
    step.status = rollupStepStatus(step.itemRuns);
    await persist();

    // Poll the launched items to terminal.
    const inFlight = new Set(pending.filter((i) => i.status === 'running').map((i) => i.itemId));
    let polls = 0;
    while (inFlight.size > 0 && polls < MAX_POLLS_PER_ITEM) {
      await sleep(POLL_INTERVAL_MS);
      polls += 1;
      await Promise.all(
        Array.from(inFlight).map(async (itemId) => {
          const item = step.itemRuns.find((i) => i.itemId === itemId)!;
          const run = launched.get(itemId)!;
          try {
            const res = await run.poll();
            if (res.terminal) {
              item.status = res.ok ? 'succeeded' : 'failed';
              if (!res.ok && res.message) item.reason = safeLog(res.message);
              inFlight.delete(itemId);
            }
          } catch (e: any) {
            item.status = 'failed';
            item.reason = safeLog(e?.message || String(e));
            inFlight.delete(itemId);
          }
        }),
      );
      step.status = rollupStepStatus(step.itemRuns);
      await persist();
    }
    // Anything still in-flight after the ceiling → honest timeout failure.
    for (const itemId of inFlight) {
      const item = step.itemRuns.find((i) => i.itemId === itemId)!;
      item.status = 'failed';
      item.reason = 'timed out waiting for the run to finish';
    }
    step.status = rollupStepStatus(step.itemRuns);
    await persist();
  }

  doc.status = rollupFlowStatus(doc.steps);
  doc.finishedAt = new Date().toISOString();
  await persist();
}

export async function GET(
  req: NextRequest,
  props: { params: Promise<{ id: string; flowId: string }> },
) {
  const params = await props.params;
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!(await assertOwnedWorkspace(params.id, s.claims.oid)))
    return NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 });
  try {
    const runId = req.nextUrl.searchParams.get('runId');
    if (runId) {
      const run = await dbGetFlowRun(params.id, runId);
      if (!run || run.flowId !== params.flowId)
        return NextResponse.json({ ok: false, error: 'run not found' }, { status: 404 });
      return NextResponse.json({ ok: true, run });
    }
    const runs = await dbListFlowRuns(params.id, params.flowId, 20);
    return NextResponse.json({ ok: true, runs });
  } catch (e: any) {
    return apiServerError(e);
  }
}
