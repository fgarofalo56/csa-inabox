/**
 * GET /api/admin/mcp-servers/deployed/status?id=<serverId>  (or ?name=<containerAppName>)
 *   → { ok: true, status: McpContainerAppStatus }
 *
 * Reads the LIVE ARM status (provisioningState + runningStatus + ingress FQDN)
 * of a catalog-deployed MCP Container App via the canonical Container Apps ARM
 * client (lib/azure/container-apps-arm-client). When called with a serverId it
 * resolves the container-app name from the persisted Cosmos doc and refreshes
 * the stored deployment snapshot. Honest-gates when the Container Apps platform
 * isn't configured (AcaNotConfiguredError → 503 naming the env vars). Real ARM
 * errors propagate verbatim. Azure-native — no Microsoft Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { getMcpServer, saveMcpServer } from '@/lib/azure/mcp-config-store';
import {
  getMcpContainerAppStatus,
  AcaArmError,
  AcaNotConfiguredError,
} from '@/lib/azure/container-apps-arm-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await enforceCapability(session, 'admin.deploy-mcp', 'Admin');
  if (denied) return denied;

  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || tenantId;

  const url = new URL(req.url);
  const serverId = url.searchParams.get('id') || undefined;
  let containerAppName = url.searchParams.get('name') || undefined;

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
    if (e instanceof AcaNotConfiguredError) {
      return NextResponse.json({ ok: false, error: e.message, hint: `Set ${e.missing.join(', ')}.` }, { status: 503 });
    }
    if (e instanceof AcaArmError) {
      return NextResponse.json(
        { ok: false, error: `ARM ${e.status}: ${typeof e.body === 'string' ? e.body.slice(0, 300) : e.message}` },
        { status: e.status || 502 },
      );
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }

  // Refresh the stored deployment snapshot (best-effort) when we have the doc.
  if (doc && doc.deployment) {
    try {
      await saveMcpServer(tenantId, doc.serverId, who, {
        name: doc.name,
        endpoint: doc.endpoint,
        authMethod: doc.authMethod,
        authValue: doc.authValue,
        description: doc.description,
        enabled: doc.enabled,
        catalogId: doc.catalogId,
        configValues: doc.configValues,
        secretRefs: doc.secretRefs,
        source: doc.source,
        deployment: {
          ...doc.deployment,
          provisioningState: status.provisioningState,
          runningStatus: status.runningStatus,
          fqdn: status.fqdn || doc.deployment.fqdn,
        },
      });
    } catch { /* snapshot refresh is best-effort */ }
  }

  return NextResponse.json({ ok: true, status });
}
