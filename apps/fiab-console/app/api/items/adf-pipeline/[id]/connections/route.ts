/**
 * GET /api/items/adf-pipeline/[id]/connections — linked services for the
 * Pipeline Copilot `/` source/dest completion.
 *
 *   → { ok: true, connections: [{ name, type, capable: ('source'|'sink')[] }] }
 *
 * Real ADF ARM REST (adf.listLinkedServices), classified by Copy
 * source/sink capability. Honest 503 with the missing env var when the factory
 * isn't configured. Azure-native — no Microsoft Fabric dependency.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { adfConfigGate } from '@/lib/azure/adf-client';
import { handlePipelineListConnections } from '@/lib/copilot/pipeline-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const gate = adfConfigGate();
  if (gate) {
    return NextResponse.json(
      { ok: false, code: 'config', error: `Azure Data Factory is not configured. Set ${gate.missing}.`, missing: gate.missing },
      { status: 503 },
    );
  }
  try {
    const connections = await handlePipelineListConnections({ backend: 'adf' });
    return NextResponse.json({ ok: true, connections });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
