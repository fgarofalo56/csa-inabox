/**
 * GET /api/items/synapse-pipeline/[id]/connections — linked services for the
 * Pipeline Copilot `/` source/dest completion (Synapse Integrate).
 *
 *   → { ok: true, connections: [{ name, type, capable: ('source'|'sink')[] }] }
 *
 * Real Synapse dev-endpoint REST (synapseDev.listLinkedServices), classified by
 * Copy source/sink capability. Honest 503 with the missing env var when the
 * workspace isn't configured. Azure-native — no Microsoft Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { handlePipelineListConnections } from '@/lib/copilot/pipeline-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  for (const k of ['LOOM_SUBSCRIPTION_ID', 'LOOM_DLZ_RG', 'LOOM_SYNAPSE_WORKSPACE']) {
    if (!process.env[k]) {
      return NextResponse.json(
        { ok: false, code: 'config', error: `Synapse workspace is not configured. Set ${k}.`, missing: k },
        { status: 503 },
      );
    }
  }
  try {
    const connections = await handlePipelineListConnections({ backend: 'synapse' });
    return NextResponse.json({ ok: true, connections });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
