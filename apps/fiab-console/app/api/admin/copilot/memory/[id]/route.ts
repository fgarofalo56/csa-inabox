/**
 * DELETE /api/admin/copilot/memory/[id]?scopeKey=<key> — delete one memory
 * (CTS-08). Tenant-admin gated. The scopeKey (the Cosmos partition) is required
 * so the delete is a single-partition point-delete and can only remove a memory
 * within the named scope. Prunes the AI Search vector mirror too.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError } from '@/lib/api/respond';
import { deleteMemory } from '@/lib/azure/memory-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  const { id } = await params;
  const scopeKey = (new URL(req.url).searchParams.get('scopeKey') || '').trim();
  if (!id) return apiError('memory id is required', 400);
  if (!scopeKey) return apiError('scopeKey query param is required', 400);

  try {
    const ok = await deleteMemory(scopeKey, id);
    if (!ok) return apiError('memory not found', 404);
    return apiOk({ deleted: id, scopeKey });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500, { code: 'memory_delete_failed' });
  }
}
