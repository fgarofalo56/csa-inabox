/**
 * Foundry-parity "retention controls" (row 6.10) — real deletion of an
 * ontology's governance audit records (justifications + approvals) older than a
 * retention window. Owner-scoped by the calling route (partition /itemId = the
 * ontology id). Azure-native (Cosmos audit-log) — no Fabric.
 */
import { auditLogContainer } from './cosmos-client';
import { ACTION_JUSTIFICATION_KIND } from './action-justification-store';
import { ACTION_APPROVAL_KIND } from './action-approval-store';

/** The audit kinds this reaper is allowed to delete (governance records only). */
const REAPABLE_KINDS = [ACTION_JUSTIFICATION_KIND, ACTION_APPROVAL_KIND];

/**
 * Delete justification + approval records for `ontologyId` whose `at` is older
 * than `olderThanDays` before `nowIso`. Returns the number deleted. Best-effort
 * per row — a single delete failure doesn't abort the sweep.
 */
export async function reapOntologyAudit(ontologyId: string, olderThanDays: number, nowIso: string): Promise<number> {
  const cutoff = new Date(new Date(nowIso).getTime() - olderThanDays * 86_400_000).toISOString();
  const c = await auditLogContainer();
  const { resources } = await c.items
    .query<{ id: string; itemId: string }>({
      query: 'SELECT c.id, c.itemId FROM c WHERE c.itemId = @i AND ARRAY_CONTAINS(@kinds, c.kind) AND c.at < @cutoff',
      parameters: [
        { name: '@i', value: ontologyId },
        { name: '@kinds', value: REAPABLE_KINDS },
        { name: '@cutoff', value: cutoff },
      ],
    })
    .fetchAll();
  let deleted = 0;
  for (const r of resources) {
    try { await c.item(r.id, r.itemId).delete(); deleted++; } catch { /* best-effort per row */ }
  }
  return deleted;
}
