/**
 * GET /api/lakehouse/containers
 * Returns the ADLS Gen2 file-systems configured for this Loom deployment
 * that the BFF identity can actually see.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listContainers, hasConfiguredContainers } from '@/lib/azure/adls-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  try {
    const containers = await listContainers();
    // Honest gate when the DLZ ADLS isn't wired yet — never 504. The shortcut
    // wizard renders this as a remediation hint instead of "Cannot list containers".
    if (containers.length === 0) {
      const configured = hasConfiguredContainers();
      return NextResponse.json({
        ok: true,
        containers: [],
        gate: configured
          ? {
              reason:
                'No DLZ ADLS Gen2 containers were reachable from the Console UAMI within the timeout.',
              remediation:
                'Ensure the DLZ storage account is reachable from the Console VNet (private endpoint in the console VNet, or the storage firewall allows it) and that the Console UAMI has the "Storage Blob Data Reader" role on it.',
            }
          : {
              reason: 'No internal Data Landing Zone ADLS Gen2 container is configured.',
              remediation:
                'Set LOOM_LANDING_URL (and/or LOOM_BRONZE_URL / LOOM_SILVER_URL / LOOM_GOLD_URL) to the DLZ ADLS Gen2 container URLs the DLZ Bicep deploy emits. No Microsoft Fabric required.',
            },
      });
    }
    return NextResponse.json({ ok: true, containers });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 502 },
    );
  }
}
