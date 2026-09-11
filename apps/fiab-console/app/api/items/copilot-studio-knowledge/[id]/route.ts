/**
 * DELETE /api/items/copilot-studio-knowledge/[id]?envId=
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteKnowledgeSource } from '@/lib/azure/copilot-studio-client';
import { withSession } from '@/lib/api/route-toolkit';
import { copilotStudioErrorEnvelope } from '@/lib/azure/copilot-studio-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withSession<{ id: string }>(async (req: NextRequest, { params }) => {
  const envId = new URL(req.url).searchParams.get('envId');
  if (!envId) return NextResponse.json({ ok: false, error: 'envId is required' }, { status: 400 });
  try {
    await deleteKnowledgeSource(envId, params.id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const { status, body: envelope } = copilotStudioErrorEnvelope(e);
    return NextResponse.json(envelope, { status });
  }
});
