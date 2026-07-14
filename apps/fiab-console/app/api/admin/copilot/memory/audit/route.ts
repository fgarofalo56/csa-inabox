/**
 * GET /api/admin/copilot/memory/audit?scopeKey=<key> — the CTS-12 write-audit
 * trail for a scope (every memory-write guard verdict, pass or fail). Tenant-admin
 * gated. Read-only Cosmos query over `copilot-memory-write-audit`.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { apiOk, apiError } from '@/lib/api/respond';
import { listWriteAudit } from '@/lib/azure/memory-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const session = getSession();
  const gate = requireTenantAdmin(session);
  if (gate) return gate;

  const scopeKey = (new URL(req.url).searchParams.get('scopeKey') || '').trim();
  if (!scopeKey) return apiError('scopeKey query param is required', 400);

  try {
    const audit = await listWriteAudit(scopeKey, 100);
    return apiOk({ scopeKey, audit });
  } catch (e) {
    return apiError(e instanceof Error ? e.message : String(e), 500, { code: 'memory_audit_failed' });
  }
}
