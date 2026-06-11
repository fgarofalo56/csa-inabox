/**
 * GET /api/admin/mcp-servers/bridge — bridged stdio MCP servers available for
 * one-click registration.
 *
 * The MCP stdio→HTTP/SSE bridge is the Container App in `apps/fiab-mcp-bridge/`
 * (deployed with the other Loom apps, gated by deployAppsEnabled). When its URL
 * is wired into the console via `LOOM_MCP_BRIDGE_URL`, this fetches the bridge's
 * /servers catalog and returns each bridged stdio server (npx/uvx) so the
 * External-MCP panel can offer it as a one-click registration — endpoint =
 * <bridge>/servers/<id>, the same HTTP JSON-RPC shape mcp-client.ts already
 * speaks. When the var is unset, this returns an HONEST gate naming the exact
 * env var + deploy module — per .claude/rules/no-vaporware.md (no fabricated
 * "connected" state).
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BridgeCatalogEntry {
  id: string;
  displayName?: string;
  description?: string;
  launcher?: string;
  package?: string;
  outputTransport?: string;
  endpointPath?: string;
}

export async function GET() {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  const base = (process.env.LOOM_MCP_BRIDGE_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    return NextResponse.json({
      ok: true,
      configured: false,
      gate: {
        message:
          'The Loom MCP stdio→HTTP/SSE bridge is not provisioned in this deployment. ' +
          'It runs npx/uvx stdio MCP servers as HTTP endpoints you can register one-click. ' +
          'Deploy the Loom apps tier and set LOOM_MCP_BRIDGE_URL on the console to the bridge ' +
          'service URL (e.g. http://loom-mcp-bridge:8080) to offer the bridged servers here.',
        envVar: 'LOOM_MCP_BRIDGE_URL',
        deployModule: 'apps/fiab-mcp-bridge (loom-mcp-bridge in admin-plane/main.bicep apps[])',
        deploymentDoc: 'apps/fiab-mcp-bridge/README.md',
      },
    });
  }

  // Fetch the bridge catalog. Internal vnet call; short timeout so the panel
  // degrades to an honest "unreachable" state rather than hanging.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${base}/servers`, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) {
      return NextResponse.json({
        ok: true,
        configured: true,
        reachable: false,
        base,
        error: `bridge /servers returned HTTP ${res.status}`,
      });
    }
    const j = await res.json();
    const entries: BridgeCatalogEntry[] = Array.isArray(j?.servers) ? j.servers : [];
    const servers = entries.map((e) => ({
      id: e.id,
      name: e.displayName || e.id,
      description: e.description || '',
      launcher: e.launcher || '',
      package: e.package || '',
      endpoint: `${base}${e.endpointPath || `/servers/${e.id}`}`,
    }));
    return NextResponse.json({ ok: true, configured: true, reachable: true, base, servers });
  } catch (e: any) {
    return NextResponse.json({
      ok: true,
      configured: true,
      reachable: false,
      base,
      error: e?.name === 'AbortError' ? 'bridge unreachable (timeout)' : String(e?.message || e),
    });
  } finally {
    clearTimeout(timer);
  }
}
