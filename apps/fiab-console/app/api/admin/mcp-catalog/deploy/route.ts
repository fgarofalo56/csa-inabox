/**
 * POST /api/admin/mcp-catalog/deploy — deploy a vetted catalog MCP server as an
 * Azure Container App and persist it to the tenant's MCP-servers list.
 *
 * Body: { catalogId: string, name?: string, keyVaultSecretName?: string }
 *   → { ok: true, server: McpServerConfigDoc, status: DeployMcpResult }
 *
 * Real backend: ARM PUT Microsoft.App/containerApps (lib/azure/mcp-deploy-client).
 * No mock data. When the Container Apps platform isn't configured (or the
 * boundary runs on AKS), returns 200 { ok:false, gate } with the exact env to
 * set — the honest-gate idiom (no-vaporware.md). When ARM rejects (e.g. a 403
 * because the Console UAMI lacks Contributor on LOOM_ADMIN_RG) the real status
 * code + message propagate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { saveMcpServer } from '@/lib/azure/mcp-config-store';
import {
  deployMcpContainerApp,
  McpDeployError,
  McpDeployNotConfiguredError,
} from '@/lib/azure/mcp-deploy-client';
import type { McpServerConfig } from '@/lib/types/mcp-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;

  const body = await req.json().catch(() => ({}));
  const catalogId = typeof body?.catalogId === 'string' ? body.catalogId.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim().toLowerCase() : undefined;
  const keyVaultSecretName = typeof body?.keyVaultSecretName === 'string' && body.keyVaultSecretName.trim()
    ? body.keyVaultSecretName.trim()
    : undefined;
  if (!catalogId) {
    return NextResponse.json({ ok: false, error: 'catalogId is required' }, { status: 400 });
  }

  let result;
  try {
    result = await deployMcpContainerApp({ catalogId, name, keyVaultSecretName });
  } catch (e: any) {
    if (e instanceof McpDeployNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.hint } });
    }
    if (e instanceof McpDeployError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status || 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }

  // Persist as a catalog-sourced MCP connection so it shows in the existing list
  // and the orchestrator can discover its tools once it's healthy.
  const now = new Date().toISOString();
  const config: McpServerConfig = {
    name: result.entry.name,
    endpoint: result.endpoint || `https://${result.fqdn || result.name}`,
    authMethod: result.entry.secretEnv ? 'key-vault' : 'header',
    description: result.entry.description,
    // Don't auto-enable for tool discovery until the operator confirms it's
    // healthy — a deploy that's still InProgress shouldn't break orchestration.
    enabled: false,
    source: 'catalog',
    deployment: {
      catalogId: result.catalogId,
      containerAppName: result.name,
      image: result.image,
      provisioningState: result.provisioningState,
      runningStatus: result.runningStatus,
      fqdn: result.fqdn,
      deployedAt: now,
      deployedBy: who,
    },
  };

  let server;
  try {
    server = await saveMcpServer(tenantId, undefined, who, config);
  } catch (e: any) {
    // The container app deployed but persistence failed — surface honestly with
    // the live status so the operator can retry/registers manually.
    return NextResponse.json(
      { ok: false, error: `Deployed ${result.name} but failed to persist: ${e?.message || e}`, status: result },
      { status: 207 },
    );
  }

  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `mcp-server:${server.serverId}`,
      tenantId,
      who,
      at: now,
      kind: 'mcp-catalog.deploy',
      name: result.entry.name,
      catalogId: result.catalogId,
      containerAppName: result.name,
    }).catch(() => {});
  } catch { /* audit is best-effort */ }

  return NextResponse.json({ ok: true, server, status: result });
}
