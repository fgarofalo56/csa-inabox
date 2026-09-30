/**
 * GET/POST/PUT/DELETE /api/governance/policies — governance policies
 * (DLP / masking / RLS / retention / access).
 *
 * STORAGE
 *   DLP, Masking, RLS, Retention (and the library-written Label) policies are
 *   stored per author in the tenant-settings container under `policies:<oid>`.
 *   Access policies are managed by tenant admins and are stored once per tenant
 *   under `access-policies:<tenantScopeId>` (see lib/governance/policy-store).
 *
 * AUTHORIZATION
 *   Every verb requires a signed-in session (withSession). Creating, editing or
 *   deleting an Access policy additionally requires the `admin.permissions`
 *   capability at Admin role (tenant admins always hold it), because an Access
 *   policy is enforced as a real Azure RBAC / data-plane role assignment:
 *     Access    → enforceAccessGrant (ADLS container role, Synapse SQL role,
 *                 ADX database role, workspace role)
 *   The other kinds only persist a rule document and make no role assignment:
 *     DLP       → persisted rule, read by the DLP surfaces (restrict-access is a
 *                 separate admin route and only REVOKES)
 *     Masking   → persisted rule
 *     RLS       → persisted rule
 *     Retention → persisted rule
 *   so they keep their existing per-author behaviour.
 *
 * ACCESS POLICIES RECORDED BEFORE THE TENANT DOC
 *   Existing Access policies in an author's `policies:<oid>` doc are left where
 *   they are (nothing is moved or deleted). The author still sees them in their
 *   own list; an admin's list also includes every such doc attributed to the
 *   admin's Entra tenant (`listLegacyAccessPolicyDocs`: one query over the
 *   policy docs, attributed by the doc's own `tid` stamp or its owner's
 *   workspaces), and an admin can edit or delete them in place. GET stamps the
 *   caller's own doc with their `tid` so it stays attributable.
 *
 * Route-toolkit: withSession (R1) + an in-handler enforceCapability for the
 * Access kind, whose result is returned when it is a denial.
 */
import { NextRequest, NextResponse } from 'next/server';
import { tenantScopeId, type SessionPayload } from '@/lib/auth/session';
import { withSession } from '@/lib/api/route-toolkit';
import { checkCapability, enforceCapability } from '@/lib/auth/feature-gate';
import {
  enforceAccessGrant, revokeAccessGrant, revokeStructuredGrant,
  type AccessPermission, type AccessScopeType, type PrincipalType,
} from '@/lib/azure/access-policy-client';
import {
  loadOrSeedPolicies, savePolicies,
  readAccessPolicies, saveAccessPolicies, listLegacyAccessPolicyDocs, stampPoliciesTenant,
  CosmosNotConfiguredError,
  type Policy, type DlpPolicyRule, type PoliciesDoc, type AccessPoliciesDoc,
} from '@/lib/governance/policy-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The capability (and role) that manages Access policies. */
const ACCESS_POLICY_CAPABILITY = 'admin.permissions';
const ACCESS_POLICY_ROLE = 'Admin' as const;

const KINDS = ['DLP', 'Masking', 'RLS', 'Retention', 'Access'];

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

function handleError(e: unknown): NextResponse {
  if (e instanceof CosmosNotConfiguredError) return cosmosGateResponse();
  throw e; // withSession maps anything else to apiServerError
}

async function canManageAccess(s: SessionPayload): Promise<boolean> {
  const r = await checkCapability(s, ACCESS_POLICY_CAPABILITY, ACCESS_POLICY_ROLE);
  return r.allow === true;
}

/** Where a policy lives, so PUT/DELETE write back to the same doc. */
type Located =
  | { where: 'own'; doc: PoliciesDoc; ix: number }
  | { where: 'tenant'; doc: AccessPoliciesDoc; ix: number }
  | { where: 'legacy'; doc: PoliciesDoc; ix: number };

async function readLegacyAccessDocs(s: SessionPayload): Promise<PoliciesDoc[]> {
  return listLegacyAccessPolicyDocs(s.claims.tid, s.claims.oid);
}

/**
 * The list a caller sees: their own policies, plus — for a caller who manages
 * Access policies — the tenant Access-policy doc and the Access policies other
 * users in the tenant recorded before the tenant doc existed.
 */
async function listVisible(s: SessionPayload): Promise<{
  policies: Policy[]; canManageAccess: boolean; warnings: string[]; updatedAt: string;
}> {
  const own = await loadOrSeedPolicies(s.claims.oid);
  const manage = await canManageAccess(s);
  const warnings: string[] = [];
  const out: Policy[] = [...own.items];
  if (manage) {
    const seen = new Set(out.map((p) => p.id));
    const tenant = await readAccessPolicies(tenantScopeId(s));
    for (const p of tenant.items) if (!seen.has(p.id)) { out.push(p); seen.add(p.id); }
    try {
      for (const d of await readLegacyAccessDocs(s)) {
        for (const p of d.items) {
          if (p.kind === 'Access' && !seen.has(p.id)) { out.push(p); seen.add(p.id); }
        }
      }
    } catch (e: any) {
      if (e instanceof CosmosNotConfiguredError) throw e;
      warnings.push(
        `Access policies recorded in other users' policy documents could not be listed: ${e?.message || String(e)}`,
      );
    }
  }
  return { policies: out, canManageAccess: manage, warnings, updatedAt: own.updatedAt };
}

async function locate(s: SessionPayload, id: string): Promise<Located | null> {
  const own = await loadOrSeedPolicies(s.claims.oid);
  const oix = own.items.findIndex((p) => p.id === id);
  if (oix >= 0) return { where: 'own', doc: own, ix: oix };
  const tenant = await readAccessPolicies(tenantScopeId(s));
  const tix = tenant.items.findIndex((p) => p.id === id);
  if (tix >= 0) return { where: 'tenant', doc: tenant, ix: tix };
  // Other users' docs are only searched for a caller who manages Access
  // policies, and only Access items there are addressable.
  if (await canManageAccess(s)) {
    for (const d of await readLegacyAccessDocs(s)) {
      const lix = d.items.findIndex((p) => p.id === id && p.kind === 'Access');
      if (lix >= 0) return { where: 'legacy', doc: d, ix: lix };
    }
  }
  return null;
}

async function persist(loc: Located): Promise<void> {
  if (loc.where === 'tenant') await saveAccessPolicies(loc.doc);
  else await savePolicies(loc.doc);
}

/** Fields a PUT may change. Identity, scope, grant and provenance fields are fixed at create. */
function editablePatch(body: any): Partial<Policy> {
  const patch: Partial<Policy> = {};
  if (typeof body?.name === 'string' && body.name.trim()) patch.name = body.name.trim().slice(0, 200);
  if (typeof body?.rule === 'string') patch.rule = body.rule.slice(0, 2000);
  if (typeof body?.scope === 'string' && body.scope.trim()) patch.scope = body.scope.trim().slice(0, 300);
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
  return patch;
}

export const GET = withSession(async (_req, { session: s }) => {
  try {
    // Record the caller's tenant on their own policies doc (once), so any
    // Access policy it still holds is attributable to this tenant for admins.
    await stampPoliciesTenant(await loadOrSeedPolicies(s.claims.oid), s.claims.tid);
    const v = await listVisible(s);
    return NextResponse.json({
      ok: true, policies: v.policies, canManageAccess: v.canManageAccess,
      ...(v.warnings.length ? { warnings: v.warnings } : {}),
      updatedAt: v.updatedAt,
    });
  } catch (e) {
    return handleError(e);
  }
});

export const POST = withSession(async (req: NextRequest, { session: s }) => {
  const body = await req.json().catch(() => ({}));
  const name = (body?.name || '').toString().trim();
  const kind = (body?.kind || '').toString();
  if (!name || !KINDS.includes(kind)) {
    return NextResponse.json({ ok: false, error: 'name + valid kind required' }, { status: 400 });
  }
  if (kind === 'Access') {
    // Access policies are managed by tenant admins.
    const gate = await enforceCapability(s, ACCESS_POLICY_CAPABILITY, ACCESS_POLICY_ROLE);
    if (gate) return gate;
  }
  try {
    const policy: Policy = {
      id: crypto.randomUUID(),
      name, kind: kind as Policy['kind'],
      scope: body?.scope || 'tenant',
      rule: body?.rule || '',
      enabled: body?.enabled !== false,
      createdAt: new Date().toISOString(),
      createdBy: s.claims.upn || s.claims.oid,
    };

    if (kind === 'Access') {
      const tenantDoc = await readAccessPolicies(tenantScopeId(s));
      // Access policies are ENFORCED as a real Azure role assignment
      // (no-vaporware). When the structured fields are present, make the grant
      // and stamp the result; the structured fields let DELETE revoke it.
      if (body?.principalId && body?.permission) {
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
        }
      }
      tenantDoc.items.push(policy);
      await saveAccessPolicies(tenantDoc);
      const v = await listVisible(s);
      // Reflect an enforcement failure to the caller but still record the policy.
      if (policy.enforcement?.status === 'error') {
        return NextResponse.json({ ok: false, error: `Grant failed: ${policy.enforcement.detail}`, policy, policies: v.policies }, { status: 502 });
      }
      return NextResponse.json({ ok: true, policy, policies: v.policies });
    }

    // DLP policies carry a real rule shape (sensitive-info types + action +
    // condition) — persist it so downstream enforcement + the editor read the
    // structured rule, not just the human string. Preset-enabled policies also
    // stamp their provenance (`source`) + compliance category.
    if (kind === 'DLP' && body?.dlp && typeof body.dlp === 'object') {
      const sits = Array.isArray(body.dlp.sensitiveInfoTypes)
        ? body.dlp.sensitiveInfoTypes.map((x: unknown) => String(x)).slice(0, 64) : [];
      const action = ['Audit', 'Block', 'Notify', 'Quarantine'].includes(body.dlp.action) ? body.dlp.action : 'Audit';
      const sharedWith = body.dlp.sharedWith === 'any' ? 'any' : 'external';
      policy.dlp = { sensitiveInfoTypes: sits, action, sharedWith } as DlpPolicyRule;
    }
    if (typeof body?.source === 'string') policy.source = body.source;
    if (typeof body?.category === 'string') policy.category = body.category as any;

    const doc = await loadOrSeedPolicies(s.claims.oid);
    doc.items.push(policy);
    await savePolicies(doc);
    const v = await listVisible(s);
    return NextResponse.json({ ok: true, policy, policies: v.policies });
  } catch (e) {
    return handleError(e);
  }
});

export const PUT = withSession(async (req: NextRequest, { session: s }) => {
  const body = await req.json().catch(() => ({}));
  const id = (body?.id || '').toString();
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const loc = await locate(s, id);
    if (!loc) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const current = loc.doc.items[loc.ix];
    if (body?.kind !== undefined && body.kind !== current.kind) {
      // A policy's kind is fixed at create; an edit cannot change it.
      return NextResponse.json({ ok: false, error: 'kind cannot be changed; create a new policy instead' }, { status: 400 });
    }
    if (current.kind === 'Access') {
      const gate = await enforceCapability(s, ACCESS_POLICY_CAPABILITY, ACCESS_POLICY_ROLE);
      if (gate) return gate;
    }
    loc.doc.items[loc.ix] = { ...current, ...editablePatch(body), id: current.id };
    await persist(loc);
    const v = await listVisible(s);
    return NextResponse.json({ ok: true, policy: loc.doc.items[loc.ix], policies: v.policies });
  } catch (e) {
    return handleError(e);
  }
});

export const DELETE = withSession(async (req: NextRequest, { session: s }) => {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 });
  try {
    const loc = await locate(s, id);
    if (!loc) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    const target = loc.doc.items[loc.ix];
    if (target.kind === 'Access') {
      const gate = await enforceCapability(s, ACCESS_POLICY_CAPABILITY, ACCESS_POLICY_ROLE);
      if (gate) return gate;
      // Revoke the real grant first (best-effort; never blocks the delete).
      if (target.enforcement?.roleAssignmentId) {
        // ADLS RBAC grant — revoke by role-assignment id.
        await revokeAccessGrant(target.enforcement.roleAssignmentId);
      } else if (
        target.principalId && target.permission &&
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
    }
    loc.doc.items = loc.doc.items.filter((p) => p.id !== id) as any;
    await persist(loc);
    const v = await listVisible(s);
    return NextResponse.json({ ok: true, policies: v.policies });
  } catch (e) {
    return handleError(e);
  }
});
