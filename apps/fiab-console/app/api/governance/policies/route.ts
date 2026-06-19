/**
 * GET/POST/DELETE /api/governance/policies — tenant governance policies
 * (DLP / masking / RLS rules). Stored as a single doc in the
 * tenant-settings container under `policies:<tenantId>`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { tenantSettingsContainer, CosmosNotConfiguredError } from '@/lib/azure/cosmos-client';
import {
  enforceAccessGrant, revokeAccessGrant, revokeStructuredGrant,
  type AccessPermission, type AccessScopeType, type PrincipalType,
} from '@/lib/azure/access-policy-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PolicyEnforcement {
  status: 'active' | 'pending' | 'error';
  roleName?: string;
  roleAssignmentId?: string;
  detail?: string;
}

interface Policy {
  id: string;
  name: string;
  kind: 'DLP' | 'Masking' | 'RLS' | 'Retention' | 'Access';
  scope: string;
  rule: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
  // Access-kind structured fields (enable real RBAC enforcement).
  principalId?: string;
  principalName?: string;
  principalType?: PrincipalType;
  scopeType?: AccessScopeType;
  scopeRef?: string;
  permission?: AccessPermission;
  /** Result of the real RBAC grant for Access policies. */
  enforcement?: PolicyEnforcement;
}

interface PoliciesDoc {
  id: string; tenantId: string; kind: 'policies';
  items: Policy[];
  updatedAt: string;
}

async function loadOrSeed(tenantId: string): Promise<PoliciesDoc> {
  const c = await tenantSettingsContainer();
  const docId = `policies:${tenantId}`;
  try {
    const { resource } = await c.item(docId, tenantId).read<PoliciesDoc>();
    if (resource) return resource;
  } catch (e: any) { if (e?.code !== 404) throw e; }
  const seed: PoliciesDoc = {
    id: docId, tenantId, kind: 'policies', items: [], updatedAt: new Date().toISOString(),
  } as any;
  await c.items.create(seed);
  return seed;
}

function cosmosGateResponse() {
  return NextResponse.json({
    ok: false,
    code: 'cosmos_not_configured',
    gate: {
      missing: ['LOOM_COSMOS_ENDPOINT'],
      message:
        'Governance policies require Cosmos DB. Set LOOM_COSMOS_ENDPOINT on the Console Container App ' +
        'and grant the Console UAMI the Cosmos DB Built-in Data Contributor role at account scope.',
    },
  }, { status: 503 });
}

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  try {
    const doc = await loadOrSeed(s.claims.oid);
    return NextResponse.json({ ok: true, policies: doc.items, updatedAt: doc.updatedAt });
  } catch (e: any) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGateResponse();
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  const kind = (body?.kind || '').toString();
  if (!name || !['DLP', 'Masking', 'RLS', 'Retention', 'Access'].includes(kind)) {
    return NextResponse.json({ ok: false, error: 'name + valid kind required' }, { status: 400 });
  }
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId);
    const policy: Policy = {
      id: crypto.randomUUID(),
      name, kind: kind as any,
      scope: body?.scope || 'tenant',
      rule: body?.rule || '',
      enabled: body?.enabled !== false,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || tenantId,
    };

    // Access policies are ENFORCED as a real Azure RBAC grant (no-vaporware).
    // When the structured access fields are present, attempt the grant and
    // stamp the result; persist the structured fields so DELETE can revoke it.
    if (kind === 'Access' && body?.principalId && body?.permission) {
      policy.principalId = String(body.principalId);
      policy.principalName = body?.principalName ? String(body.principalName) : String(body.principalId);
      policy.principalType = (['User', 'Group', 'ServicePrincipal'].includes(body?.principalType) ? body.principalType : 'User') as PrincipalType;
      policy.scopeType = (['adls-container', 'warehouse', 'kql-database', 'workspace', 'item', 'collection'].includes(body?.scopeType) ? body.scopeType : 'adls-container') as AccessScopeType;
      policy.scopeRef = body?.scopeRef ? String(body.scopeRef) : '';
      policy.permission = (['read', 'write', 'admin'].includes(body?.permission) ? body.permission : 'read') as AccessPermission;
      if (policy.scopeRef) {
        policy.enforcement = await enforceAccessGrant({
          principalId: policy.principalId,
          principalName: policy.principalName,
          principalType: policy.principalType,
          scopeType: policy.scopeType,
          scopeRef: policy.scopeRef,
          permission: policy.permission,
        });
        // Reflect enforcement failure to the caller but still record the policy.
        if (policy.enforcement.status === 'error') {
          doc.items.push(policy);
          doc.updatedAt = new Date().toISOString();
          await c.item(doc.id, tenantId).replace(doc);
          return NextResponse.json({ ok: false, error: `Grant failed: ${policy.enforcement.detail}`, policy, policies: doc.items }, { status: 502 });
        }
      }
    }

    doc.items.push(policy);
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, policy, policies: doc.items });
  } catch (e: any) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGateResponse();
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const id = (body?.id || '').toString();
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId);
    const ix = doc.items.findIndex((p) => p.id === id);
    if (ix < 0) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    doc.items[ix] = { ...doc.items[ix], ...body, id };
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, policy: doc.items[ix], policies: doc.items });
  } catch (e: any) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGateResponse();
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const tenantId = s.claims.oid;
    const c = await tenantSettingsContainer();
    const doc = await loadOrSeed(tenantId);
    const target = doc.items.find((p) => p.id === id);
    if (!target) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    // Revoke the real grant first (best-effort; never blocks the delete).
    if (target.enforcement?.roleAssignmentId) {
      // ADLS RBAC grant — revoke by role-assignment id.
      await revokeAccessGrant(target.enforcement.roleAssignmentId);
    } else if (
      target.kind === 'Access' && target.principalId && target.permission &&
      (target.scopeType === 'warehouse' || target.scopeType === 'kql-database')
    ) {
      // Warehouse (Synapse SQL) / KQL (ADX) grant — replay the inverse command.
      await revokeStructuredGrant({
        principalId: target.principalId,
        principalName: target.principalName,
        principalType: target.principalType || 'User',
        scopeType: target.scopeType,
        scopeRef: target.scopeRef || '',
        permission: target.permission,
      });
    }
    doc.items = doc.items.filter((p) => p.id !== id);
    doc.updatedAt = new Date().toISOString();
    await c.item(doc.id, tenantId).replace(doc);
    return NextResponse.json({ ok: true, policies: doc.items });
  } catch (e: any) {
    if (e instanceof CosmosNotConfiguredError) return cosmosGateResponse();
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
