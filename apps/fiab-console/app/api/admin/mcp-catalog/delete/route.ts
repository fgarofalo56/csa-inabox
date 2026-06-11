/**
 * DELETE /api/admin/mcp-catalog/delete?id=<serverId>
 *   → { ok: true }
 *
 * Tears down a deployed catalog MCP server: real ARM DELETE on the Container App
 * (lib/azure/mcp-deploy-client) then removes the persisted connection doc. Only
 * operates on catalog-sourced servers (source === 'catalog'); refuses to delete
 * a manually-registered external endpoint via this route (use /api/admin/mcp-servers
 * for those). Honest-gates when the platform isn't configured; real ARM errors
 * (e.g. 403) propagate. A 404 from ARM is treated as already-gone (idempotent).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { getMcpServer, deleteMcpServer } from '@/lib/azure/mcp-config-store';
import {
  deleteMcpContainerApp,
  McpDeployError,
  McpDeployNotConfiguredError,
} from '@/lib/azure/mcp-deploy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const tenantId = s.claims.oid;
  const who = s.claims.upn || s.claims.email || tenantId;

  const url = new URL(req.url);
  const serverId = url.searchParams.get('id');
  if (!serverId) return NextResponse.json({ ok: false, error: 'id is required' }, { status: 400 });

  const doc = await getMcpServer(tenantId, serverId);
  if (!doc) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  if (doc.source !== 'catalog' || !doc.deployment?.containerAppName) {
    return NextResponse.json(
      { ok: false, error: 'Not a catalog-deployed server; use /api/admin/mcp-servers to remove external connections.' },
      { status: 400 },
    );
  }

  try {
    await deleteMcpContainerApp(doc.deployment.containerAppName);
  } catch (e: any) {
    if (e instanceof McpDeployNotConfiguredError) {
      return NextResponse.json({ ok: false, gate: { missing: e.missing, message: e.hint } });
    }
    if (e instanceof McpDeployError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: e.status || 502 });
    }
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }

  try {
    await deleteMcpServer(tenantId, serverId);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `Container app deleted but failed to remove connection: ${e?.message || e}` },
      { status: 207 },
    );
  }

  try {
    const audit = await auditLogContainer();
    await audit.items.create({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `mcp-server:${serverId}`,
      tenantId,
      who,
      at: new Date().toISOString(),
      kind: 'mcp-catalog.delete',
      name: doc.name,
      containerAppName: doc.deployment.containerAppName,
    }).catch(() => {});
  } catch { /* audit is best-effort */ }

  return NextResponse.json({ ok: true });
}
