/**
 * DELETE /api/admin/mcp-servers/deployed/teardown?id=<serverId>
 *   → { ok: true }
 *
 * Tears down a catalog-deployed MCP server completely:
 *   1. real ARM DELETE on the Container App (container-apps-arm-client),
 *   2. deletes the per-field Key Vault secrets named in the doc's secretRefs,
 *   3. removes the persisted connection doc from Cosmos.
 *
 * Gates on `admin.deploy-mcp` (Admin). Only operates on catalog-sourced servers
 * (source === 'catalog' with a recorded containerAppName); refuses to delete a
 * manually-registered external endpoint via this route (use /api/admin/mcp-servers).
 * Honest-gates when the Container Apps platform isn't configured; real ARM 4xx/5xx
 * propagate. A 404 from ARM is treated as already-gone (idempotent). Azure-native
 * — Container Apps + Key Vault + Cosmos, no Microsoft Fabric dependency.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability } from '@/lib/auth/feature-gate';
import { auditLogContainer } from '@/lib/azure/cosmos-client';
import { getMcpServer, deleteMcpServer } from '@/lib/azure/mcp-config-store';
import {
  deleteMcpContainerApp,
  AcaArmError,
  AcaNotConfiguredError,
} from '@/lib/azure/container-apps-arm-client';
import { deleteKeyVaultSecret } from '@/lib/azure/kv-secrets-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const denied = await enforceCapability(session, 'admin.deploy-mcp', 'Admin');
  if (denied) return denied;

  const tenantId = session.claims.oid;
  const who = session.claims.upn || session.claims.email || tenantId;

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

  // 1. Delete the Container App (idempotent on 404).
  try {
    await deleteMcpContainerApp(doc.deployment.containerAppName);
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

  // 2. Delete the per-field Key Vault secrets (best-effort; names only persisted).
  const secretNames = Object.values(doc.secretRefs || {});
  for (const n of secretNames) {
    if (n) await deleteKeyVaultSecret(n).catch(() => {});
  }

  // 3. Remove the persisted connection doc.
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
      kind: 'mcp-server.teardown',
      name: doc.name,
      containerApp: doc.deployment.containerAppName,
    }).catch(() => {});
  } catch { /* audit is best-effort */ }

  return NextResponse.json({ ok: true });
}
