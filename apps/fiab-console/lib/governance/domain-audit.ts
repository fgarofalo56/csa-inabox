/**
 * Shared audit-write helper for Governance Domains (F4) routes.
 *
 * Writes domain CRUD + assignWorkspaces events to the Cosmos audit-log
 * container so they surface in the existing Admin → Audit Logs reader
 * (which queries `c.kind` / orders by `c.at`). Purview classic Data Map
 * Audit does NOT cover collection CRUD, so domain mutations are recorded
 * here as the authoritative audit trail.
 */
import { auditLogContainer } from '@/lib/azure/cosmos-client';

export async function writeDomainAudit(
  tenantId: string,
  who: string,
  action: 'create' | 'update' | 'delete' | 'assignWorkspaces',
  details: unknown,
): Promise<void> {
  try {
    const c = await auditLogContainer();
    const at = new Date().toISOString();
    await c.items.create({
      id: `dom-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      itemId: `governance-domain:${tenantId}`,
      tenantId,
      who,
      at,
      timestamp: at,
      kind: `governance-domain.${action}`,
      category: 'governance-domain',
      action,
      details,
    });
  } catch {
    /* Non-fatal audit write — never block the primary response. */
  }
}
