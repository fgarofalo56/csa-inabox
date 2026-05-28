/**
 * GET /api/loom/capacities — Fabric / Power BI Premium capacities the
 * Console UAMI can see. Drives the workspace-create Capacity dropdown
 * so the user picks a real, addressable capacity instead of typing
 * "F64" as free text.
 *
 * Returns 503 with a structured remediation hint when the UAMI is not
 * yet authorized in the Power BI tenant (matches the same pattern as
 * /api/powerbi/workspaces).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  listFabricCapacities,
  FabricError,
  fabricHint,
} from '@/lib/azure/fabric-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }
  try {
    const capacities = await listFabricCapacities();
    return NextResponse.json({ ok: true, capacities });
  } catch (e: any) {
    const status = e instanceof FabricError ? e.status : 502;
    return NextResponse.json(
      {
        ok: false,
        error: e?.message || String(e),
        endpoint: e?.endpoint,
        hint: fabricHint(status),
      },
      { status },
    );
  }
}
