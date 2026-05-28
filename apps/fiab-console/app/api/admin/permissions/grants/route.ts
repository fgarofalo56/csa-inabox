/**
 * /api/admin/permissions/grants — CRUD for feature-permission grants.
 *
 *   GET  ?capabilityId=...        → list rows for the capability
 *   GET  (no qs)                  → list all rows in the tenant
 *   POST {capabilityId, principalId, principalType, principalDisplayName?,
 *         principalUpn?, role}     → upsert grant
 *   DELETE ?id=...                → delete grant
 *
 * All routes enforce capability 'admin.permissions' with role Contributor
 * (mutations) or Reader (list).
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceCapability, type FeatureGrant, type FeatureRole } from '@/lib/auth/feature-gate';
import { featurePermissionsContainer } from '@/lib/azure/cosmos-client';
import { getCapability } from '@/lib/auth/feature-catalog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_ROLES: FeatureRole[] = ['Reader', 'Contributor', 'Admin'];

export async function GET(req: NextRequest) {
  const s = getSession();
  const gate = await enforceCapability(s, 'admin.permissions', 'Reader');
  if (gate) return gate;
  const capabilityId = req.nextUrl.searchParams.get('capabilityId') || undefined;
  const c = await featurePermissionsContainer();
  const tenantId = s!.claims.oid;
  const q = capabilityId
    ? {
        query: 'SELECT * FROM c WHERE c.tenantId = @t AND c.capabilityId = @cap',
        parameters: [{ name: '@t', value: tenantId }, { name: '@cap', value: capabilityId }],
      }
    : {
        query: 'SELECT * FROM c WHERE c.tenantId = @t',
        parameters: [{ name: '@t', value: tenantId }],
      };
  const { resources } = await c.items.query<FeatureGrant>(q, { partitionKey: tenantId }).fetchAll();
  return NextResponse.json({ ok: true, grants: resources });
}

export async function POST(req: NextRequest) {
  const s = getSession();
  const gate = await enforceCapability(s, 'admin.permissions', 'Contributor');
  if (gate) return gate;
  const body = await req.json().catch(() => ({}));
  const capabilityId = (body?.capabilityId || '').toString().trim();
  const principalId = (body?.principalId || '').toString().trim();
  const principalType = body?.principalType === 'group' ? 'group' : 'user';
  const role = VALID_ROLES.includes(body?.role) ? (body.role as FeatureRole) : null;
  if (!capabilityId || !principalId || !role) {
    return NextResponse.json({ ok: false, error: 'capabilityId, principalId, role required' }, { status: 400 });
  }
  // Dynamic capabilities (workspace.<id>) are allowed even if not in the
  // static catalog; static ones must resolve.
  if (capabilityId.startsWith('workspace.') === false && !getCapability(capabilityId)) {
    return NextResponse.json({ ok: false, error: `unknown capability '${capabilityId}'` }, { status: 400 });
  }
  const tenantId = s!.claims.oid;
  const c = await featurePermissionsContainer();
  // Idempotent — upsert by (tenantId, capabilityId, principalId).
  const stableId = `${capabilityId}::${principalType}::${principalId}`;
  const doc: FeatureGrant = {
    id: stableId,
    tenantId,
    capabilityId,
    principalId,
    principalType,
    principalDisplayName: body?.principalDisplayName || undefined,
    principalUpn: body?.principalUpn || undefined,
    role,
    grantedBy: s!.claims.upn || s!.claims.oid,
    grantedAt: new Date().toISOString(),
  };
  const { resource } = await c.items.upsert(doc);
  return NextResponse.json({ ok: true, grant: resource });
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  const gate = await enforceCapability(s, 'admin.permissions', 'Contributor');
  if (gate) return gate;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  const c = await featurePermissionsContainer();
  const tenantId = s!.claims.oid;
  try {
    await c.item(id, tenantId).delete();
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: false, error: 'grant not found' }, { status: 404 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}
