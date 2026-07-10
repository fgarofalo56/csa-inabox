/**
 * Azure Batch tasks — data-plane over the account endpoint (batch.azure.com).
 * Reuses lib/azure/batch-client; real REST, no mocks.
 *
 *   GET    /api/items/batch-pool/tasks?job=JOBID          → { ok, tasks }
 *   POST   /api/items/batch-pool/tasks  { jobId, id, commandLine, displayName? }
 *   DELETE /api/items/batch-pool/tasks?job=JOBID&id=TASKID → delete task
 *
 * Honest 503 gate when the account env is unset; a data-plane 403 surfaces
 * verbatim. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { denyIfNoDlzAccess } from '@/lib/auth/dlz-gate';
import { batchConfigGate, listTasks, createTask, deleteTask } from '@/lib/azure/batch-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unauth() { return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }); }

function gate() {
  const g = batchConfigGate();
  if (g) {
    return NextResponse.json(
      {
        ok: false, code: 'not_configured', notDeployed: true,
        error: `Azure Batch account not configured: set ${g.missing}.`,
        missing: g.missing,
        hint: 'Set LOOM_BATCH_ACCOUNT (+ LOOM_BATCH_SUB/RG) and grant the Console UAMI Contributor on the Batch account.',
        bicep: 'platform/fiab/bicep/modules/deploy-planner/batch.bicep',
      },
      { status: 503 },
    );
  }
  return null;
}

export async function GET(req: NextRequest) {
  const s = getSession(); if (!s) return unauth();
  { const denied = await denyIfNoDlzAccess(s, 'scaling'); if (denied) return denied; }
  const g = gate(); if (g) return g;
  const job = req.nextUrl.searchParams.get('job')?.trim();
  if (!job) return NextResponse.json({ ok: false, error: 'job query param is required' }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, tasks: await listTasks(job) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession(); if (!s) return unauth();
  { const denied = await denyIfNoDlzAccess(s, 'scaling'); if (denied) return denied; }
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const jobId = String(body?.jobId || '').trim();
  const id = String(body?.id || '').trim();
  const commandLine = String(body?.commandLine || '').trim();
  if (!jobId || !id || !commandLine) {
    return NextResponse.json({ ok: false, error: 'jobId, id and commandLine are required' }, { status: 400 });
  }
  try {
    const task = await createTask({
      jobId, id, commandLine,
      displayName: typeof body?.displayName === 'string' ? body.displayName : undefined,
    });
    return NextResponse.json({ ok: true, task });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession(); if (!s) return unauth();
  { const denied = await denyIfNoDlzAccess(s, 'scaling'); if (denied) return denied; }
  const g = gate(); if (g) return g;
  const job = req.nextUrl.searchParams.get('job')?.trim();
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!job || !id) return NextResponse.json({ ok: false, error: 'job and id query params are required' }, { status: 400 });
  try {
    await deleteTask(job, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
