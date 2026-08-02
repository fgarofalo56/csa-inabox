/**
 * Tenant scope for reads of the Cosmos `audit-log` container.
 *
 * WHY THIS EXISTS — two facts about that container that every reader gets
 * wrong the first time:
 *
 *  1. **Its partition key is `/itemId`, not `/tenantId`.**
 *     (`cosmos-client.ts`: `createTtlEnabledContainer(database, 'audit-log', '/itemId')`.)
 *     Every other tenant-scoped container in Loom partitions on `/tenantId`, so
 *     a reader copied from a sibling naturally passes
 *     `{ partitionKey: <caller oid> }` — which restricts the read to the
 *     partition `itemId === <caller oid>`. No audit row ever lands there:
 *     writers set `itemId` to the item / target (`unity-catalog:CATALOG:finance`,
 *     `cost-anomaly-rule:daily`, an item GUID…). Such a query is structurally
 *     guaranteed to return zero. Audit-log reads MUST be cross-partition.
 *
 *  2. **Writers are not consistent about `tenantId`.** The admin-plane audit
 *     stream records `ev.tenantId || actorOid`, while ~45 other writers record
 *     `tenantScopeId(session)` = `claims.tid ?? claims.oid` — the Entra TENANT
 *     id. A reader that binds only the viewer's `oid` can therefore never see a
 *     `tid`-scoped row (a `tid` never equals an `oid`), which is the
 *     under-count #2608 fixed for `/admin/audit-logs` and this module now
 *     shares with its sibling counters (#2635).
 *
 * Usage — bind the returned array to `@tenants` and filter with
 * {@link AUDIT_TENANT_PREDICATE}; do NOT pass a `partitionKey` option:
 *
 * ```ts
 * const c = await auditLogContainer();
 * const scope = auditScopeIds(session.claims);
 * await c.items.query({
 *   query: `SELECT VALUE COUNT(1) FROM c WHERE ${AUDIT_TENANT_PREDICATE} AND c.at >= @since`,
 *   parameters: [{ name: '@tenants', value: scope }, { name: '@since', value: since }],
 * }).fetchAll();
 * ```
 *
 * Widening a read to the caller's `tid` widens it to the caller's own Entra
 * tenant only — never across tenants — and every surface that uses it is
 * either tenant-admin gated or applies the widening only for tenant admins.
 */

/** The claim subset an audit-log read needs. Structurally compatible with `UserClaims`. */
export interface AuditScopeClaims {
  /** The caller's object id. Always present on a minted session. */
  oid: string;
  /** The caller's Entra tenant id. Absent on pre-rel-T11 / bootstrap sessions. */
  tid?: string;
}

/**
 * The SQL predicate that pairs with {@link auditScopeIds}. Binds `@tenants`.
 * Kept as a constant so a reader can never drift back to `c.tenantId = @t`.
 */
export const AUDIT_TENANT_PREDICATE = 'ARRAY_CONTAINS(@tenants, c.tenantId)';

/**
 * The tenant ids an audit-log read must cover for one session: the caller's
 * `oid`, plus their Entra `tid` when it is present and distinct.
 *
 * Never returns an empty array (an empty `ARRAY_CONTAINS` set would silently
 * match nothing, reproducing the very bug this module exists to prevent), and
 * never contains a duplicate (`tid === oid` on bootstrap sessions).
 */
export function auditScopeIds(claims: AuditScopeClaims): string[] {
  const { oid, tid } = claims;
  return tid && tid !== oid ? [oid, tid] : [oid];
}
