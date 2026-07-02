/**
 * Shared honest-gate error mapper for the Advanced networking BFF routes.
 *
 * Maps the networking-client error classes to structured `{ ok:false, ... }`
 * responses per no-vaporware.md:
 *   - NetworkingNotConfiguredError → 503 + the exact env var(s) to set
 *   - NetworkingArmError 401/403   → 403 + the exact Network Contributor role to
 *                                    grant the Console UAMI (honest infra gate;
 *                                    HTTP 403 so the UI renders a MessageBar)
 *   - NetworkingArmError 400/404/409 → pass through the ARM status
 *   - anything else → 502
 */
import { NextResponse } from 'next/server';
import { NetworkingNotConfiguredError, NetworkingArmError } from '@/lib/clients/networking-client';
import { getSession, type SessionPayload } from '@/lib/auth/session';
import { isTenantAdmin } from '@/lib/auth/feature-gate';
import { workspacesContainer } from '@/lib/azure/cosmos-client';

/** Network Contributor built-in role definition id. */
export const NETWORK_CONTRIBUTOR_ROLE_ID = '4d97b98b-1d4f-4787-a291-c67834d212e7';
/** Storage Account Contributor built-in role definition id (PATCH networkAcls). */
export const STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID = '17d1049b-9a84-46fb-8f53-869881c3d3ab';

export function networkingErrorResponse(e: unknown): NextResponse {
  if (e instanceof NetworkingNotConfiguredError) {
    return NextResponse.json({
      ok: false,
      error: `Advanced networking not configured: set ${e.missing.join(' / ')}.`,
      gate: {
        reason: 'The Azure-native networking pane writes NSG rules + private endpoints over Azure Resource Manager.',
        remediation: `Set ${e.missing.join(' + ')} on the Console (network.bicep wires these from the hub VNet). No Microsoft Fabric required.`,
        missing: e.missing,
      },
    }, { status: 503 });
  }
  if (e instanceof NetworkingArmError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Resource Manager ${e.status}: not authorized to manage networking.`,
      gate: {
        reason: 'The Console UAMI needs rights to write NSG security rules + create private endpoints on the networking resource group.',
        remediation: 'Grant the Console UAMI "Network Contributor" on LOOM_NETWORKING_RG (network.bicep does this when consolePrincipalId is wired).',
        roleId: NETWORK_CONTRIBUTOR_ROLE_ID,
      },
    }, { status: 403 });
  }
  if (e instanceof NetworkingArmError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json({ ok: false, error: e.message }, { status });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ ok: false, error: msg }, { status: 502 });
}

/**
 * Honest-gate mapper for the trusted-resources (storage resource-instance rules)
 * route. Identical to {@link networkingErrorResponse} except the 401/403 branch:
 * that route PATCHes `networkAcls` on a STORAGE ACCOUNT (not the networking RG),
 * so the role the Console UAMI is missing is **Storage Account Contributor**
 * (or Owner) on the target storage account — not Network Contributor.
 */
export function storageTrustedAccessErrorResponse(e: unknown): NextResponse {
  if (e instanceof NetworkingArmError && (e.status === 401 || e.status === 403)) {
    return NextResponse.json({
      ok: false,
      error: `Azure Resource Manager ${e.status}: not authorized to update the storage account's network rules.`,
      gate: {
        reason: 'Trusted workspace access PATCHes networkAcls.resourceAccessRules on the target storage account over ARM.',
        remediation: `Grant the Console UAMI "Storage Account Contributor" (${STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID}) — or Owner — on the target storage account (platform/fiab/bicep/modules/landing-zone/storage-lifecycle-rbac.bicep grants it on the DLZ lake).`,
        roleId: STORAGE_ACCOUNT_CONTRIBUTOR_ROLE_ID,
      },
    }, { status: 403 });
  }
  return networkingErrorResponse(e);
}

/**
 * SECURITY authorization gate for the Advanced networking BFF routes.
 *
 * These handlers write REAL NSG security rules / private endpoints over ARM on
 * the SHARED deployment-level networking resource group (LOOM_NETWORKING_RG /
 * hub VNet). A bare authenticated session used to be the ONLY check, which let
 * ANY signed-in user POST an Allow 0.0.0.0/0 rule (or DELETE a Deny rule) and
 * bypass the deployment firewall. We now require BOTH:
 *
 *   1. assertOwner  — the caller owns the workspace [id] they are acting through
 *                     (same ownership check as
 *                     app/api/admin/workspaces/[id]/git/route.ts), and
 *   2. isTenantAdmin — networking is shared landing-zone infrastructure, so only
 *                      a tenant admin may mutate it (matches the sibling
 *                      admin/workspaces/[id]/* task-flows/folders routes, and the
 *                      denyIfNoDlzAccess gate the scaling routes use for the same
 *                      class of shared DLZ infra).
 *
 * Honest note: the ip-rules NSG is deployment-level / shared, so [id] scopes the
 * ownership check but the rule write targets the shared NSG — the admin gate is
 * what actually authorizes the mutation. For inbound/outbound/trusted the [id]
 * additionally names the per-workspace private endpoints / allowlist registry.
 */
const NETWORKING_ADMIN_REASON =
  'Managing workspace networking (NSG security rules / private endpoints on the ' +
  'shared deployment network) is restricted to tenant admins. A tenant admin can ' +
  'set LOOM_TENANT_ADMIN_OID / LOOM_TENANT_ADMIN_GROUP_ID, or grant access at ' +
  '/admin/permissions.';

/** Verify the workspace exists and belongs to the calling tenant (oid). */
async function assertOwner(workspaceId: string, tenantId: string): Promise<boolean> {
  const ws = await workspacesContainer();
  try {
    const { resource } = await ws.item(workspaceId, tenantId).read<any>();
    return !!resource && resource.tenantId === tenantId;
  } catch (e: any) {
    if (e?.code === 404) return false;
    throw e;
  }
}

/**
 * Resolve + authorize the request. Returns `{ session, id }` when the caller is
 * authenticated, owns the workspace, and is a tenant admin; otherwise returns
 * `{ resp }` carrying the 401 / 404 / 403 response the handler should return.
 */
export async function authorizeNetworking(
  ctx: { params: Promise<{ id: string }> },
): Promise<
  | { resp: NextResponse; session?: undefined; id?: undefined }
  | { resp?: undefined; session: SessionPayload; id: string }
> {
  const session = getSession();
  if (!session) {
    return { resp: NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 }) };
  }
  const { id } = await ctx.params;
  if (!(await assertOwner(id, session.claims.oid))) {
    return { resp: NextResponse.json({ ok: false, error: 'workspace not found' }, { status: 404 }) };
  }
  if (!isTenantAdmin(session)) {
    return {
      resp: NextResponse.json(
        { ok: false, error: 'forbidden', reason: NETWORKING_ADMIN_REASON },
        { status: 403 },
      ),
    };
  }
  return { session, id };
}
