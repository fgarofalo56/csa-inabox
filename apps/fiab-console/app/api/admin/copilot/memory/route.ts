/**
 * Admin memory visibility (CTS-08) — tenant-admin gated.
 *
 *   GET  /api/admin/copilot/memory                    → list scopes (+counts)
 *   GET  /api/admin/copilot/memory?scopeKey=user:oid  → list a scope's memories
 *        &q=<term>                                     → keyword-filter within scope
 *   POST /api/admin/copilot/memory { action:'purge', scopeKey } → bulk purge
 *
 * The Copilot memory brain administers per-user / per-workspace state; a bare
 * session gives ZERO isolation, so every handler gates on requireTenantAdmin.
 * Real backend: Cosmos `copilot-memory` + the AI Search vector mirror (purge
 * prunes both). No Fabric / Power BI.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError } from '@/lib/api/respond';
import { listScopes, listMemories, keywordScan, purgeScope } from '@/lib/azure/memory-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  const url = new URL(req.url);
  const scopeKey = (url.searchParams.get('scopeKey') || '').trim();
  const q = (url.searchParams.get('q') || '').trim();

  try {
    if (!scopeKey) {
      const scopes = await listScopes(500);
      return apiOk({ scopes });
    }
    const memories = q ? await keywordScan([scopeKey], q, 200) : await listMemories([scopeKey], 200);
    return apiOk({ scopeKey, memories });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500, { code: 'memory_list_failed' });
  }
}

interface PostBody {
  action?: unknown;
  scopeKey?: unknown;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    /* validation below */
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey.trim() : '';
  if (action !== 'purge') return apiError("unsupported action (expected 'purge')", 400);
  if (!scopeKey) return apiError('scopeKey is required', 400);

  try {
    const purged = await purgeScope(scopeKey);
    return apiOk({ scopeKey, purged });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500, { code: 'memory_purge_failed' });
  }
}
