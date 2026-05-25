import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stub - real impl POSTs to the Setup Orchestrator FastAPI which kicks
// off an azd deploy + tracks progress in Cosmos. Returns a fake
// deploymentId so the Setup Wizard's progress UI animates.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  return NextResponse.json({
    deploymentId: `stub-${Date.now()}`,
    status: 'queued',
    config: body,
  });
}
