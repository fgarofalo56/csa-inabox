/**
 * GET  /api/admin/workspaces — TENANT-WIDE workspace inventory with live item
 *      counts, last activity, capacity assignment, state, and resolved owners.
 *      Cosmos-backed (cross-partition scan; see lib/clients/workspaces-client.ts).
 *      Admin-only: every workspace in the tenant is visible regardless of owner,
 *      so the route is gated by isTenantAdmin (LOOM_TENANT_ADMIN_OID / _GROUP_ID).
 *      A non-admin caller gets a structured 403 rather than another user's
 *      workspaces.
 * POST /api/admin/workspaces — create a workspace from the admin create wizard:
 *      persist the Cosmos doc, then best-effort bind a real Fabric/Power BI
 *      capacity (Azure-native default needs none), register the domain in
 *      Purview, and optionally provision a dedicated backing resource group.
 *      The Azure-native path works with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { listAllWorkspacesAdmin } from '@/lib/clients/workspaces-client';
import { workspacesContainer } from '@/lib/azure/cosmos-client';
import { upsertLoomDoc, docForWorkspace } from '@/lib/azure/loom-search';
import { applyWorkspaceBindings } from '@/lib/azure/workspace-bindings';
import { domainExists, DEFAULT_DOMAIN_ID } from '@/lib/azure/domain-registry';
import type { Workspace, WorkspaceLicenseMode } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  if (!isTenantAdmin(s)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'forbidden',
        reason:
          'Tenant-wide workspace inventory is admin-only. Become a tenant admin by ' +
          'setting LOOM_TENANT_ADMIN_OID to your user OID (or LOOM_TENANT_ADMIN_GROUP_ID ' +
          'to an Entra group you belong to) on the loom-console container app.',
      },
      { status: 403 },
    );
  }
  try {
    const workspaces = await listAllWorkspacesAdmin();
    return NextResponse.json({ ok: true, total: workspaces.length, workspaces });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

const VALID_LICENSE_MODES: WorkspaceLicenseMode[] = [
  'Org', 'Trial', 'Pro', 'Premium', 'PremiumPerUser', 'Embedded', 'Delegated',
];

export async function POST(req: NextRequest) {
  const s = getSession();
  if (!s) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  // Per-principal rate limit (default-off: no-op unless LOOM_RATE_LIMIT=on). Workspace create provisions backing resources.
  const limited = await enforceRateLimit(s, 'provision');
  if (limited) return limited;
  // PDP gate (default-off / shadow-ready). Admin write: create a tenant workspace.
  const blocked = await pdpCheck(s, { level: 'domain', id: s.claims.oid }, 'admin');
  if (blocked) return blocked;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }); }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ ok: false, error: 'name is required' }, { status: 400 });

  // A workspace MUST be bound to a governance domain (t158 — domains are the
  // authoritative tenant topology). The domain must exist in this tenant's
  // registry; the `default` starter domain is the guaranteed fallback for
  // legacy / single-domain tenants (loadOrSeedDomains seeds it on first read).
  // When the caller omits a domain (the picker only lists domains they
  // administer — a fresh tenant has none), fall back to the seeded `default`
  // domain so workspace creation works day-one. An explicit unknown domain is
  // still rejected below.
  const domain = (typeof body?.domain === 'string' ? body.domain.trim() : '') || DEFAULT_DOMAIN_ID;
  if (!(await domainExists(s.claims.oid, domain))) {
    return NextResponse.json(
      { ok: false, error: `Unknown domain '${domain}' — it is not registered in this tenant.`, code: 'unknown_domain' },
      { status: 400 },
    );
  }

  const licenseMode: WorkspaceLicenseMode =
    VALID_LICENSE_MODES.includes(body?.licenseMode) ? body.licenseMode : 'Org';
  const contacts = Array.isArray(body?.contacts)
    ? (body.contacts as unknown[]).map((c) => String(c).trim()).filter(Boolean).slice(0, 100)
    : undefined;
  const provisionBackingRg = body?.provisionBackingRg === true;

  const now = new Date().toISOString();
  const ws: Workspace = {
    id: crypto.randomUUID(),
    tenantId: s.claims.oid,
    // rel-T11: record owner oid + Entra tenant id (kept in lock-step with
    // app/api/workspaces/route.ts) for the shared read path's tid boundary.
    ownerOid: s.claims.oid,
    ...(s.claims.tid ? { tid: s.claims.tid } : {}),
    name,
    description: typeof body?.description === 'string' && body.description.trim() ? body.description.trim() : undefined,
    capacity: typeof body?.capacity === 'string' && body.capacity.trim() ? body.capacity.trim() : undefined,
    domain,
    storageAccountId: typeof body?.storageAccountId === 'string' && body.storageAccountId.trim() ? body.storageAccountId.trim() : undefined,
    licenseMode,
    contacts: contacts && contacts.length ? contacts : undefined,
    createdBy: s.claims.upn || s.claims.email || s.claims.oid,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const c = await workspacesContainer();
    const { resource } = await c.items.create<Workspace>(ws);
    if (!resource) {
      return NextResponse.json({ ok: false, error: 'Cosmos returned no resource on create' }, { status: 500 });
    }

    // Best-effort post-create side-effects: Fabric/Power BI capacity assign
    // (queued on the Azure-native default), Purview register + marketplace
    // publish, and an optional dedicated backing resource group. Never blocks
    // the create — outcomes are captured into status fields and replaced.
    let merged: Workspace = resource;
    if (resource.capacity || resource.domain || provisionBackingRg) {
      try {
        const bindings = await applyWorkspaceBindings(resource, { provisionBackingRg });
        merged = {
          ...resource,
          ...(bindings.capacityAssignment ? { capacityAssignment: bindings.capacityAssignment } : {}),
          ...(bindings.domainRegistration ? { domainRegistration: bindings.domainRegistration } : {}),
          ...(bindings.backingRgProvision ? { backingRgProvision: bindings.backingRgProvision } : {}),
          ...(bindings.backingRgProvision?.status === 'provisioned' ? { backingRgName: bindings.backingRgProvision.rgName } : {}),
          updatedAt: new Date().toISOString(),
        };
        try { await c.item(merged.id, merged.tenantId).replace(merged); } catch { /* race — UI refetches */ }
      } catch { /* applyWorkspaceBindings never throws, but fail-safe */ }
    }

    void upsertLoomDoc(docForWorkspace(merged));
    return NextResponse.json({ ok: true, workspace: merged }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Failed to create workspace' }, { status: 500 });
  }
}
