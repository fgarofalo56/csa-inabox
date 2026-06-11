/**
 * GET /api/admin/mcp-catalog/status?id=<serverId>  (or ?name=<containerAppName>)
 *   → { ok: true, status: DeployMcpResult }
 *
 * Reads the LIVE ARM status of a deployed catalog MCP container app
 * (provisioningState + runningStatus + ingress FQDN). When called with a
 * serverId it resolves the container-app name from the persisted doc and
 * refreshes the stored deployment state in Cosmos. Honest-gates when the
 * Container Apps platform isn't configured; real ARM errors propagate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { getMcpServer, saveMcpServer } from '@/lib/azure/mcp-config-store';
import {
  getMcpContainerAppStatus,
  McpDeployError,
  McpDeployNotConfiguredError,
} from '@/lib/azure/mcp-deploy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;

  const url = new URL(req.url);
  const serverId = url.searchParams.get('id') || undefined;
  let containerAppName = url.searchParams.get('name') || undefined;

  // Resolve the container-app name from the persisted doc when given a serverId.
  let doc = null;
  if (serverId) {
    doc = await getMcpServer(tenantId, serverId);
    if (!doc) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    containerAppName = doc.deployment?.containerAppName || containerAppName;
  }
  if (!containerAppName) {
    return NextResponse.json({ ok: false, error: 'id or name is required' }, { status: 400 });
  }

  let status;
  try {
    status = await getMcpContainerAppStatus(containerAppName);
  } catch (e: any) {
    if (e instanceof McpDeployNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.hint } });
    }
    if (e instanceof McpDeployError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status || 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }

  // Refresh the stored deployment snapshot (best-effort) when we have the doc.
  if (doc && doc.deployment) {
    try {
      await saveMcpServer(tenantId, doc.serverId, who, {
        name: doc.name,
        endpoint: status.endpoint || doc.endpoint,
        authMethod: doc.authMethod,
        authValue: doc.authValue,
        description: doc.description,
        enabled: doc.enabled,
        source: doc.source,
        deployment: {
          ...doc.deployment,
          provisioningState: status.provisioningState,
          runningStatus: status.runningStatus,
          fqdn: status.fqdn,
        },
      });
    } catch { /* snapshot refresh is best-effort */ }
  }

  return NextResponse.json({ ok: true, status });
}
