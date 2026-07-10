/**
 * Azure Batch jobs — data-plane over the account endpoint (batch.azure.com).
 * Reuses lib/azure/batch-client; real REST, no mocks.
 *
 *   GET    /api/items/batch-pool/jobs               → { ok, jobs }
 *   POST   /api/items/batch-pool/jobs  { id, poolId, displayName?, priority? }
 *   DELETE /api/items/batch-pool/jobs?id=ID         → delete job
 *
 * Honest 503 gate when the account env is unset; a data-plane 403 (account does
 * not allow Entra auth) surfaces verbatim. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { batchConfigGate, listJobs, createJob, deleteJob } from '@/lib/azure/batch-client';

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

export async function GET() {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  try {
    return NextResponse.json({ ok: true, jobs: await listJobs() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const id = String(body?.id || '').trim();
  const poolId = String(body?.poolId || '').trim();
  if (!id || !poolId) return NextResponse.json({ ok: false, error: 'id and poolId are required' }, { status: 400 });
  try {
    const job = await createJob({
      id, poolId,
      displayName: typeof body?.displayName === 'string' ? body.displayName : undefined,
      priority: Number.isFinite(body?.priority) ? Number(body.priority) : undefined,
    });
    return NextResponse.json({ ok: true, job });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ ok: false, error: 'id query param is required' }, { status: 400 });
  try {
    await deleteJob(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
