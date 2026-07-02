/**
 * F16 Azure Connections — disconnect one binding.
 *
 *   DELETE /api/admin/workspaces/{id}/connections/{connId}
 *          → { ok: true }
 *
 * Removes the Cosmos record. The underlying Azure resource (storage account /
 * Log Analytics workspace) and any RBAC grants are left untouched — disconnect
 * only severs the workspace binding. A 404 (already gone) is treated as success.
 */
import { NextRequest, NextResponse } from 'next/server';
import { disconnectAzureConnection, AzureConnectionError } from '@/lib/clients/azure-connections-client';
import { requireWorkspace } from '@/lib/auth/workspace-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(_req: NextRequest, props: { params: Promise<{ id: string; connId: string }> }) {
  const { id, connId } = await props.params;
  const guard = await requireWorkspace(id);
  if (guard.resp) return guard.resp;
  try {
    await disconnectAzureConnection(id, decodeURIComponent(connId));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e instanceof AzureConnectionError ? e.status : 500;
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status });
  }
}
