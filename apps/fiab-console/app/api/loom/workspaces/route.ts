/**
 * GET /api/loom/workspaces — Loom workspace catalog in the
 * shape every editor's workspace-picker expects. Same response
 * format the legacy /api/fabric/workspaces used so the swap is
 * drop-in for the 12 editors that were calling the Fabric tenant
 * API (which doesn't apply in Loom's Azure-native model).
 *
 * Shape:
 *   { ok: true, workspaces: [{ id, name, isOnDedicatedCapacity, capacity? }] }
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import type { Workspace } from '@/lib/types/workspace';
import { apiServerError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const c = await workspacesContainer();
    const { resources } = await c.items
      .query<Workspace>({
        query: 'SELECT * FROM c WHERE c.tenantId = @t ORDER BY c.createdAt DESC',
        parameters: [{ name: '@t', value: s.claims.oid }],
      }, { partitionKey: s.claims.oid })
      .fetchAll();
    return NextResponse.json({
      ok: true,
      workspaces: resources.map(w => ({
        id: w.id,
        name: w.name,
        // A Loom workspace "is on dedicated capacity" if it has a capacity tag
        // (e.g. linked to a Fabric capacity, a Synapse workspace, or a
        // Databricks workspace). Otherwise it's a shared Loom workspace.
        isOnDedicatedCapacity: !!w.capacity,
        capacity: w.capacity,
        description: w.description,
        domain: w.domain,
      })),
    });
  } catch (e: any) {
    return apiServerError(e);
  }
}
