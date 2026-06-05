/**
 * GET /api/admin/mcp-servers/builtin — status of the Loom built-in MCP server.
 *
 * The built-in MCP server is the Azure Functions app in
 * `azure-functions/mcp-server/` (deployed via its own bicep — opt-in). When its
 * URL is wired into the console via `LOOM_BUILTIN_MCP_URL`, this returns it so
 * the Connect-MCP panel can offer it as a one-click registration. When it isn't,
 * this returns an HONEST gate naming the exact bicep + env var to provision it —
 * per .claude/rules/no-vaporware.md (no fabricated "connected" state).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const url = (process.env.LOOM_BUILTIN_MCP_URL || '').trim();
  if (!url) {
    return NextResponse.json({
      ok: true,
      configured: false,
      gate: {
        message:
          'The Loom built-in MCP tool server is not provisioned in this deployment. ' +
          'Deploy it (opt-in) and set LOOM_BUILTIN_MCP_URL on the console to its ' +
          '/api/mcp endpoint to offer it for one-click registration.',
        envVar: 'LOOM_BUILTIN_MCP_URL',
        deployModule: 'azure-functions/mcp-server/deploy/main.bicep',
        deploymentDoc: 'azure-functions/mcp-server/DEPLOYMENT.md',
      },
    });
  }

  // Normalise to the /api/mcp endpoint + a sibling /api/health probe URL.
  const mcpEndpoint = url.endsWith('/api/mcp') ? url : `${url.replace(/\/$/, '')}/api/mcp`;
  const healthEndpoint = mcpEndpoint.replace(/\/api\/mcp$/, '/api/health');
  return NextResponse.json({
    ok: true,
    configured: true,
    endpoint: mcpEndpoint,
    healthEndpoint,
    name: 'Loom built-in tools',
    description: 'Vetted read-only Loom tools (catalog search, ARM resources, deployments).',
  });
}
