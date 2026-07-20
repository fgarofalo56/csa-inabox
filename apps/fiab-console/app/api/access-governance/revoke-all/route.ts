/**
 * POST /api/access-governance/revoke-all — leaver "revoke-all" for a principal
 * (access-governance W4, AG-14). Tenant-admin only.
 *
 * Body: { principalId: string, reason?: string }
 *
 * Reads every ACTIVE / ELIGIBLE entitlement-ledger row for the principal (a
 * single-partition read — PK /principalId) and tears each down through the shared
 * real revoke path (revokeAssignment → ARM role assignment + data-plane grant +
 * ledger). The one-button offboarding action. ?dryRun=1 reports what WOULD be
 * revoked. Real backends only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { requireTenantAdmin } from '@/lib/auth/feature-gate';
import { accessAssignmentsContainer, auditLogContainer } from '@/lib/azure/cosmos-client';
import type { AccessAssignment } from '@/lib/types/access-assignment';
import { selectRevocable } from '@/lib/access/leaver';
import { revokeAssignment } from '@/lib/access/revoke-assignment';
import { apiServerError } from '@/lib/api/respond';
import crypto from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const s = getSession();
  const gate = requireTenantAdmin(s);
  if (gate) return gate;

  const body = await req.json().catch(() => ({} as any));
  const principalId = String(body?.principalId || '').trim();
  if (!principalId) return NextResponse.json({ ok: false, error: 'principalId is required' }, { status: 400 });
  const reason = body?.reason ? String(body.reason).trim().slice(0, 500) : undefined;
  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1';
  const by = s!.claims.upn || s!.claims.oid;

  try {
    const ledger = await accessAssignmentsContainer();
    const { resources } = await ledger.items
      .query<AccessAssignment>({ query: 'SELECT * FROM c WHERE c.principalId = @p', parameters: [{ name: '@p', value: principalId }] })
      .fetchAll();
    const revocable = selectRevocable(resources || []);

    if (dryRun) {
      return NextResponse.json({
        ok: true, dryRun: true, principalId, candidates: revocable.length,
        assignments: revocable.map((a) => ({ id: a.id, resourceType: a.resourceType, resourceRef: a.resourceRef, role: a.role, state: a.state, source: a.source })),
      });
    }

    let revoked = 0; const warnings: string[] = [];
    for (const a of revocable) {
      const r = await revokeAssignment(a, by);
      if (r.revoked) revoked++;
      warnings.push(...r.warnings);
    }

    const al = await auditLogContainer();
    await al.items.create({
      id: crypto.randomUUID(),
      itemId: principalId,
      itemType: 'access-governance',
      action: 'leaver-revoke-all',
      summary: `${by} revoked ALL access for ${resources?.[0]?.principalUpn || principalId} — ${revoked} grant${revoked === 1 ? '' : 's'} torn down${reason ? ` — "${reason}"` : ''}.`,
      upn: by,
      at: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, principalId, candidates: revocable.length, revoked, ...(warnings.length ? { revokeWarnings: warnings.slice(0, 20) } : {}) });
  } catch (e: any) {
    return apiServerError(e);
  }
}
