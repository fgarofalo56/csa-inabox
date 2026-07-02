/**
 * GET /api/items/data-pipeline/[id]/connections — linked services for the
 * flagship Pipeline Copilot's `/` source/dest completion.
 *
 *   → { ok: true, connections: [{ name, type, capable: ('source'|'sink')[] }] }
 *
 * The companion of .../copilot: the docked PipelineCopilotPane fetches this on
 * bind to populate the `/` connection picker (soft-fails when absent — chat
 * still works). Real ADF ARM REST (adf.listLinkedServices via
 * handlePipelineListConnections), classified by Copy source/sink capability —
 * Azure-native by default, the same backend the flagship's run/debug/copilot
 * routes use (BACKEND='adf'). Honest 503 with the missing env var when the
 * factory isn't configured. No Microsoft Fabric / Power BI dependency.
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
