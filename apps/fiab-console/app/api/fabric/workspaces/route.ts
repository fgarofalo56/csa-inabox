/**
 * GET /api/fabric/workspaces
 * Returns the Fabric workspaces visible to the Console UAMI.
 * Tenant-gate errors (401/403) surface verbatim with a remediation hint.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listFabricWorkspaces, FabricError } from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const workspaces = await listFabricWorkspaces();
    // Normalize to the same shape the v2.1 WorkspacePicker expects.
    return NextResponse.json({
      ok: true,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.displayName, isOnDedicatedCapacity: !!w.capacityId })),
    });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), endpoint: e?.endpoint, hint: e?.hint },
      { status },
    );
  }
}
