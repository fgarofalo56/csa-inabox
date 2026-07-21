/**
 * /.well-known/agent.json — A2A agent-card discovery (WS-5.2, legacy v0.1/v0.2 path).
 *
 * The older well-known location many A2A clients still probe. Serves the same
 * platform agent card as /.well-known/agent-card.json so both new and old A2A
 * clients discover Loom. Public discovery metadata. Azure-native; no Fabric.
 */
import { NextRequest, NextResponse } from 'next/server';
import { buildPlatformAgentCard } from '@/lib/copilot/a2a-tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  let origin = '';
  try { origin = new URL(req.url).origin; } catch { origin = process.env.LOOM_PUBLIC_BASE_URL || ''; }
  return NextResponse.json(buildPlatformAgentCard(origin));
}
