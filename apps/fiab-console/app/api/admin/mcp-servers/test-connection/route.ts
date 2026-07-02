/**
 * POST /api/admin/mcp-servers/test-connection
 *   body: { config: McpServerConfig }
 *   → { ok, toolCount, tools?, error? }
 *
 * Tests connectivity to an MCP server and fetches its tool list.
 * Does NOT persist; used by the UI to validate before saving.
 */

import { NextRequest, NextResponse } from 'next/server';
import { apiError } from '@/lib/api/respond';
import { getSession } from '@/lib/auth/session';
import { listMcpTools } from '@/lib/azure/mcp-client';
import { getPbiUserToken } from '@/lib/azure/pbi-user-token-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';



export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return apiError('unauthenticated', 401);
  const body = await req.json().catch(() => ({}));
  const config = body.config;
  if (!config || typeof config !== 'object') return apiError('config (object) required', 400);
  if (!config.endpoint || !config.authMethod) return apiError('endpoint and authMethod required', 400);

  // entra-obo (e.g. the opt-in "Power BI (remote)" MCP server): validate the
  // endpoint with the ADMIN's own per-user On-Behalf-Of token rather than a
  // static header / Key Vault secret. The token is minted at login + cached
  // per-user (pbi-user-token-store) — it is NEVER stored on the server config,
  // so we resolve it fresh here and thread it through as `userToken`. If no
  // valid token is cached, surface the exact remediation (no opaque 401) per
  // no-vaporware; this remote path is opt-in only (no-fabric-dependency).
  let userToken: string | undefined;
  if (config.authMethod === 'entra-obo') {
    const oid = s.claims?.oid;
    const cached = oid ? await getPbiUserToken(oid) : null;
    if (!cached) {
      return NextResponse.json({
        ok: false,
        toolCount: 0,
        error:
          'No Power BI delegated token is cached for your account. Sign in again and consent the ' +
          'Power BI delegated scopes (Dataset.Read.All, MLModel.Execute.All, Workspace.Read.All); ' +
          'ensure a Power BI admin enabled the tenant setting "Users can use the Power BI Model ' +
          'Context Protocol server endpoint (preview)" and that LOOM_POWERBI_MCP_CLIENT_ID is set.',
      }, { status: 400 });
    }
    userToken = cached;
  }

  try {
    const tools = await listMcpTools(config.endpoint, config.authMethod, config.authValue, 5000, userToken);
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
