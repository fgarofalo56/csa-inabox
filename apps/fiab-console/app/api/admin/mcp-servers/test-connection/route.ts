/**
 * POST /api/admin/mcp-servers/test-connection
 *   body: { config: McpServerConfig }
 *   → { ok, toolCount, tools?, error? }
 *
 * Tests connectivity to an MCP server and fetches its tool list.
 * Does NOT persist; used by the UI to validate before saving.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { listMcpTools } from '@/lib/azure/mcp-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const config = body.config;
  if (!config || typeof config !== 'object') return err('config (object) required', 400);
  if (!config.endpoint || !config.authMethod) return err('endpoint and authMethod required', 400);

  try {
    const tools = await listMcpTools(config.endpoint, config.authMethod, config.authValue, 5000);
    return NextResponse.json({
      ok: true,
      toolCount: tools.length,
      tools: tools.map((t) => ({ name: t.name, description: t.description })).slice(0, 10),
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      toolCount: 0,
    }, { status: 400 });
  }
}
