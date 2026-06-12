/**
 * Shared DLZ-pane authorization gate (D2).
 *
 * The Data Landing Zone panes — Scale (`/api/admin/scaling/*`), Cost
 * (`/api/admin/capacity/cost`), and Monitor (`/api/admin/capacity/{utilization,
 * viz-config}`) — are tenant-admin (global) or domain-admin only. Domain
 * contributors, workspace-scoped users, and unprivileged sessions cannot read
 * or mutate them (previously ANY authenticated session could).
 *
 * Granularity note (deliberate): DLZ scale/cost/monitor resources are the
 * SHARED landing-zone infrastructure (Fabric/PBI capacity, ADX, AKS, APIM,
 * Cosmos, Synapse, Databricks, AML compute, VMSS) the whole tenant's domains
 * sit on — they are NOT per-domain workspace resources, so there is no
 * resource→domain map to scope against. Access is therefore gated at
 * "tenant-admin OR domain-admin of at least one domain" granularity, not
 * per-resource. Domain-scoped authority (rename/admins/move, member
 * management) is enforced per-domain elsewhere (PATCH /api/admin/domains,
 * role-assignments). See docs/fiab/parity/domain-rbac-tiers.md.
 *
 * Usage in a route handler:
 *   const s = getSession();
 *   if (!s) return NextResponse.json({ ok:false, error:'unauthenticated' }, { status:401 });
 *   const denied = await denyIfNoDlzAccess(s, 'scaling');
 *   if (denied) return denied;
 */
import { NextResponse } from 'next/server';
import type { SessionPayload } from './session';
import { canAccessDlzPanes } from './domain-role';
import { loadTenantDomains } from './load-domains';

type DlzPane = 'scaling' | 'cost' | 'monitoring';

const PANE_NOUN: Record<DlzPane, string> = {
  scaling: 'scaling',
  cost: 'cost',
  monitoring: 'monitoring',
};

/**
 * Returns a 403 NextResponse when the caller may NOT open the DLZ panes, or
 * `null` when access is allowed (tenant admin, or domain admin of ≥1 domain).
 * Loads the tenant domain list from Cosmos for the tier check; the Graph
 * fallback inside `canAccessDlzPanes` only fires for the Entra >200-group
 * claim-overage case, so the common (claim-present) path stays in-memory.
 */
export async function denyIfNoDlzAccess(
  session: SessionPayload,
  pane: DlzPane = 'scaling',
): Promise<NextResponse | null> {
  const domains = await loadTenantDomains(session.claims.oid);
  if (await canAccessDlzPanes(session, domains)) return null;
  return NextResponse.json(
    {
      ok: false,
      error: 'forbidden',
      reason:
        `The Data Landing Zone ${PANE_NOUN[pane]} pane is available to tenant admins and domain admins only. ` +
        'A tenant admin can grant you a domain admin Entra group at /admin/permissions (Domain access).',
    },
    { status: 403 },
  );
}
