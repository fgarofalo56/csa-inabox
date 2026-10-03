/**
 * Identity of the tenant Access-policy doc in the tenant-settings container.
 *
 * Access policies are managed by tenant admins and recorded once per tenant:
 * doc id `access-policies:<tenantScope>` in partition `<tenantScope>`, where
 * tenantScope is `tenantScopeId(session)` (the Entra `tid`, or the oid for a
 * tid-less single-operator session). Kept dependency-free so read-only callers
 * (data-product routes) can address the doc without loading the policy store.
 */
export function accessPoliciesDocId(tenantScope: string): string {
  return `access-policies:${tenantScope}`;
}
