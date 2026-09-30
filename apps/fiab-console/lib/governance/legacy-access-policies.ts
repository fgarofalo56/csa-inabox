/**
 * Access policies recorded before Access policies became tenant-scoped still
 * live in their authors' `policies:<oid>` documents (lib/governance/policy-store.ts).
 * This module finds them for an admin. It is separate from the policy store so
 * the store stays a plain tenant-settings reader: the attribution below also
 * consults the workspaces container.
 */
import { tenantSettingsContainer, workspacesContainer } from '@/lib/azure/cosmos-client';
import { sameTenantConfirmed } from '@/lib/auth/tenant-boundary';
import type { PoliciesDoc } from '@/lib/governance/policy-store';

/**
 * Every OTHER user's `policies:<oid>` doc in Entra tenant `tid` that still holds
 * an Access policy recorded before Access policies became tenant-scoped.
 *
 * One cross-partition query finds the docs holding an Access item — the
 * enumeration is over the policy documents themselves, so it does not depend on
 * the author owning anything, and it is not capped. A `policies:<oid>` doc
 * records no Entra tenant of its own, so each candidate is attributed to `tid`
 * when EITHER
 *   - it carries the `tid` stamp its owner's own session wrote
 *     (`stampPoliciesTenant`, on every policies list since this change), or
 *   - it is unstamped and its owner created a workspace stamped with `tid`.
 * A doc stamped with another tenant is never included. An unstamped doc whose
 * owner has created no `tid`-stamped workspace cannot be attributed and is not
 * listed until its owner next opens the policies page; nothing is deleted.
 * Returns [] for a tid-less session (the single-operator case, where the only
 * relevant doc is the caller's own).
 */
export async function listLegacyAccessPolicyDocs(
  tid: string | undefined,
  excludeOwner: string,
): Promise<PoliciesDoc[]> {
  if (!tid) return [];
  const settings = await tenantSettingsContainer();
  const { resources } = await settings.items
    .query<PoliciesDoc>({
      query: "SELECT * FROM c WHERE c.kind = 'policies' AND ARRAY_CONTAINS(c.items, @access, true)",
      parameters: [{ name: '@access', value: { kind: 'Access' } }],
    })
    .fetchAll();
  const candidates = (resources || []).filter((d) =>
    d && d.tenantId && d.tenantId !== excludeOwner && Array.isArray(d.items)
    && d.items.some((p) => p?.kind === 'Access'));
  if (candidates.length === 0) return [];
  const needMembership = candidates.some((d) => !d.tid);
  let members = new Set<string>();
  if (needMembership) {
    const ws = await workspacesContainer();
    const { resources: owners } = await ws.items
      .query<string>({
        query: 'SELECT DISTINCT VALUE c.tenantId FROM c WHERE c.tid = @tid',
        parameters: [{ name: '@tid', value: tid }],
      })
      .fetchAll();
    members = new Set((owners || []).filter((x) => typeof x === 'string' && x));
  }
  return candidates.filter((d) => (d.tid ? sameTenantConfirmed(d.tid, tid) : members.has(d.tenantId)));
}
