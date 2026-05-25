import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Liveness + Readiness probe target. Returns 200 with a tiny body so
// the ACA Envoy considers the replica Healthy. No DB / dependency
// checks here on purpose - probes should reflect "process is alive",
// not "downstream is reachable" (otherwise a Cosmos blip cycles every
// replica). Deep health checks belong at /api/health/deep.
export async function GET() {
  return NextResponse.json({ status: 'ok', ts: new Date().toISOString() });
}
