/**
 * Shared Cosmos-semantics test double for the `audit-log` container (#2635).
 *
 * NOT a test file (no `.test.` in the name, so vitest's `__tests__/ **.test.ts`
 * glob skips it) — it is the fixture the /admin/overview, /admin/usage,
 * /governance/insights and /governance/govern/posture specs share.
 *
 * It emulates the two behaviours that made the real bug invisible to a naive
 * mock, and ONLY those:
 *
 *   1. **Physical partitioning on `/itemId`.** When a caller passes a
 *      `{ partitionKey }` request option, only rows whose `itemId` equals it
 *      are visible — exactly what Cosmos does. This is what turns the
 *      `/admin/overview` audit tile into a structural zero: it passed the
 *      caller's oid, and no audit row's `itemId` is ever an oid.
 *   2. **The tenant predicate.** `ARRAY_CONTAINS(@tenants, c.tenantId)` matches
 *      any bound id; the legacy `c.tenantId = @t` matches one. A query that
 *      uses NEITHER form throws, so a future drift to a third spelling fails
 *      loudly instead of silently returning everything.
 *
 * Plus the `c.at >= @since` window, the optional `c.kind/c.action = 'share'`
 * narrowing (only the posture `sharedItems30d` counter binds it), and the
 * `SELECT VALUE COUNT(1)` projection, because every surface under test uses
 * them.
 */

export interface AuditRowFixture {
  id: string;
  /** The partition key. Writers set this to the item / target, NEVER to an oid. */
  itemId: string;
  /** `tenantScopeId(session)` for most writers = tid ?? oid; oid for the admin stream. */
  tenantId: string;
  /** ISO timestamp. */
  at: string;
  [k: string]: unknown;
}

export interface RecordedQuery {
  query: string;
  parameters: Array<{ name: string; value: unknown }>;
  options?: { partitionKey?: unknown } | undefined;
}

function paramMap(parameters: RecordedQuery['parameters']): Map<string, unknown> {
  return new Map(parameters.map((p) => [p.name, p.value]));
}

/** Run one query against the fixture rows with Cosmos' partition + predicate semantics. */
export function runAuditQuery(
  rows: AuditRowFixture[],
  spec: { query: string; parameters?: RecordedQuery['parameters'] },
  options?: { partitionKey?: unknown },
): unknown[] {
  const params = paramMap(spec.parameters ?? []);
  let visible = rows;

  // 1. Physical partition — audit-log partitions on /itemId.
  if (options && Object.prototype.hasOwnProperty.call(options, 'partitionKey')) {
    const pk = options.partitionKey;
    visible = visible.filter((r) => r.itemId === pk);
  }

  // 2. Tenant predicate.
  if (/ARRAY_CONTAINS\(\s*@tenants\s*,\s*c\.tenantId\s*\)/.test(spec.query)) {
    const scope = (params.get('@tenants') as unknown[] | undefined) ?? [];
    visible = visible.filter((r) => scope.includes(r.tenantId));
  } else if (/c\.tenantId\s*=\s*@t\b/.test(spec.query)) {
    visible = visible.filter((r) => r.tenantId === params.get('@t'));
  } else {
    throw new Error(
      `audit-log query bound no recognised tenant predicate — refusing to fake a result: ${spec.query}`,
    );
  }

  // 3. Time window.
  const since = params.get('@since');
  if (typeof since === 'string') visible = visible.filter((r) => r.at >= since);

  // 4. Event-kind narrowing. Only the Govern posture `sharedItems30d` counter
  //    adds `(c.kind = 'share' OR c.action = 'share')`; every other caller's
  //    query omits it and is unaffected by this branch.
  if (/c\.kind\s*=\s*'share'|c\.action\s*=\s*'share'/.test(spec.query)) {
    visible = visible.filter((r) => r.kind === 'share' || r.action === 'share');
  }

  return /SELECT\s+VALUE\s+COUNT\(1\)/i.test(spec.query) ? [visible.length] : visible;
}

/** A `_setQuery`-compatible impl for the existing `makeContainer()` doubles. */
export function auditQueryImpl(rows: AuditRowFixture[]) {
  return (spec: any, options?: any) => runAuditQuery(rows, spec, options);
}

/**
 * A standalone container double (for specs that don't already have a
 * `makeContainer()` harness), recording every query it was handed.
 */
export function makeAuditContainerDouble(rows: AuditRowFixture[]) {
  const calls: RecordedQuery[] = [];
  return {
    calls,
    items: {
      query(spec: any, options?: any) {
        calls.push({ query: spec.query, parameters: spec.parameters ?? [], options });
        return {
          async fetchAll() {
            return { resources: runAuditQuery(rows, spec, options) };
          },
        };
      },
    },
  };
}

/**
 * The canonical fixture: one row written by the admin-plane audit stream (oid
 * scoped) and one written through `tenantScopeId(session)` (tid scoped). Both
 * carry a realistic `itemId` — a target, never an oid.
 */
export function twoScopeFixture(opts: { oid: string; tid: string; at?: string }): AuditRowFixture[] {
  const at = opts.at ?? new Date().toISOString();
  return [
    { id: 'audit-oid-1', itemId: 'cost-anomaly-rule:daily', tenantId: opts.oid, at },
    { id: 'audit-tid-1', itemId: 'unity-catalog:CATALOG:finance', tenantId: opts.tid, at },
  ];
}
