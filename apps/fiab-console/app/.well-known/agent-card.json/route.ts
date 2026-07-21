/**
 * /.well-known/agent-card.json — A2A agent-card discovery (WS-5.2, current spec).
 *
 * The canonical location an A2A client (Google ADK, Foundry Agent Service, any
 * A2A server) probes to discover Loom as a delegable agent. Serves the platform
 * agent card (Loom's delegable skills + the JSON-RPC endpoint at /api/a2a).
 * Public discovery metadata — no secrets. Azure-native; no Fabric.
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
