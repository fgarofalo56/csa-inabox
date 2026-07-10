/**
 * Azure Batch pool navigator — account + pools over the ARM management plane.
 * Reuses lib/azure/batch-client; real ARM REST, no mocks.
 *
 *   GET    /api/items/batch-pool                → { ok, account, pools }
 *   POST   /api/items/batch-pool  { action:'create-pool', name, vmSize, ... }
 *   DELETE /api/items/batch-pool?name=NAME      → delete pool
 *
 * Honest 503 gate when LOOM_BATCH_ACCOUNT / SUB / RG is unset. The Console UAMI
 * must hold Contributor on the Batch account. Azure-native — no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  batchConfigGate,
  getBatchAccount,
  listPools,
  createPool,
  deletePool,
  type CreatePoolSpec,
} from '@/lib/azure/batch-client';

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
    const [account, pools] = await Promise.all([
      getBatchAccount().catch(() => null),
      listPools(),
    ]);
    return NextResponse.json({ ok: true, account, pools });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || '');
  try {
    if (action === 'create-pool') {
      const name = String(body?.name || '').trim();
      const vmSize = String(body?.vmSize || '').trim();
      if (!name || !vmSize) return NextResponse.json({ ok: false, error: 'name and vmSize are required' }, { status: 400 });
      const spec: CreatePoolSpec = {
        name, vmSize,
        targetDedicatedNodes: Number.isFinite(body?.targetDedicatedNodes) ? Number(body.targetDedicatedNodes) : undefined,
        targetLowPriorityNodes: Number.isFinite(body?.targetLowPriorityNodes) ? Number(body.targetLowPriorityNodes) : undefined,
        enableAutoScale: !!body?.enableAutoScale,
        autoScaleFormula: typeof body?.autoScaleFormula === 'string' ? body.autoScaleFormula : undefined,
      };
      const pool = await createPool(spec);
      return NextResponse.json({ ok: true, pool });
    }
    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!getSession()) return unauth();
  const g = gate(); if (g) return g;
  const name = req.nextUrl.searchParams.get('name')?.trim();
  if (!name) return NextResponse.json({ ok: false, error: 'name query param is required' }, { status: 400 });
  try {
    await deletePool(name);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
