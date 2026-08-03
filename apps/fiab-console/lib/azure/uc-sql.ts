/**
 * `ucSql` — the AUDITED transport for every Unity Catalog call Loom makes over
 * the Databricks **SQL Statement Execution** API (issue #2622, gap 2).
 *
 * ## Why this module exists
 *
 * LU-3 gave the Console a Unity Catalog access trail with two choke points —
 * `ucFetch` (the backend-agnostic UC REST client) and `dbxFetch` (the Databricks
 * workspace client). Both cover UC **REST**. But Loom also reaches the catalog
 * over SQL, and the SQL half is where the highest-privilege governance
 * operations live:
 *
 *   - `GRANT` / `REVOKE` — privilege mutation (`grantPrivilegesSQL`);
 *   - `CREATE POLICY` / `DROP POLICY` — ABAC row filters + column masks;
 *   - `ALTER TABLE … SET MASK` / `SET ROW FILTER` — the function-based column
 *     mask + row filter the security wizard binds;
 *   - `CREATE` / `ALTER` / `DROP GOVERNED TAG`, `SET TAGS` / `UNSET TAGS`;
 *   - `CREATE CONNECTION` / `CREATE FOREIGN CATALOG` — Lakehouse Federation.
 *
 * Those produced NO Loom audit row. The gap was declared (the guard's
 * `SQL_EXIT_BASELINES` ratcheted the count so it could not grow) but not closed.
 * This module closes it the same way the REST half was closed: ONE wrapper, the
 * recorder called from a `finally` so a DENIED statement — the highest-value row
 * — is recorded exactly like a successful one.
 *
 * ## The one rule you must not break here
 *
 * **The SQL text never reaches the audit row.** `buildCreateConnection` emits
 * `CREATE CONNECTION … OPTIONS (host '…', password '…')`; `createUcConnection`
 * deliberately returns `executionMs` only, never the SQL. A mutation row is
 * fanned out to tenant-registered OUTBOUND WEBHOOKS (third-party URLs), so a
 * statement — or a Databricks error message, which echoes the failing statement
 * — on that row would put a plaintext credential outside the Loom boundary and
 * it could not be recalled. `recordUnitySqlAccess` therefore classifies the
 * statement into a CLOSED vocabulary and stamps `detail` from a validated
 * `error_code` token only. See `lib/azure/unity-audit.ts` § 3b.
 *
 * ## Enforcement
 *
 * `scripts/ci/check-unity-audit-chokepoint.mjs` brace-matches the `finally` of
 * `ucSql` and fails the build if `recordUnitySqlAccess(` leaves it, pins this
 * file's outbound-transport count at 0, and holds every UC-governance file's
 * `executeStatement(` count at 0 — so a caller cannot quietly go back to the raw
 * transport.
 *
 * No Microsoft Fabric / Power BI is reachable from any path in this file
 * (.claude/rules/no-fabric-dependency.md).
 */
import {
  executeStatement,
  type DbxQueryParam,
  type QueryResult,
} from './databricks-client';
import { recordUnitySqlAccess } from './unity-audit';

/** Optional arguments, in an object so a call site reads the same as the raw
 *  `executeStatement(warehouseId, sql)` it replaces. */
export interface UcSqlOptions {
  /** Default catalog for the statement (`executeStatement`'s 3rd argument). */
  catalog?: string;
  /** Default schema for the statement (`executeStatement`'s 4th argument). */
  schema?: string;
  /** Named parameter markers — bound by Databricks, never concatenated. */
  params?: DbxQueryParam[];
  /** Server-assigned statement id callback, for cancellation. */
  onStatementId?: (id: string) => void;
  /**
   * The securable this statement targets, for the audit row's `securableFqn`.
   *
   * Supplied by the CALLER from the structured params it already has (catalog /
   * schema / object name) — deliberately NOT parsed out of the statement, so no
   * substring of the SQL can reach the row. Omit it and the row records at
   * collection scope (`*`), which is honest rather than wrong.
   */
  target?: string;
}

/**
 * Run one statement on a Databricks SQL warehouse and record a Unity Catalog
 * audit row for it — success, failure, or DENIED.
 *
 * Behaviourally identical to `executeStatement` (same result, same thrown
 * error); the audit write is fire-and-forget and cannot turn a working statement
 * into a failure. The recorder is called from `finally`, so an authorization
 * refusal produces a row even though this function re-throws.
 */
export async function ucSql(
  warehouseId: string,
  sql: string,
  opts: UcSqlOptions = {},
): Promise<QueryResult> {
  const startedAt = Date.now();
  let failure: unknown;
  try {
    return await executeStatement(
      warehouseId,
      sql,
      opts.catalog,
      opts.schema,
      opts.params,
      opts.onStatementId,
    );
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    recordUnitySqlAccess({
      sql,
      target: opts.target,
      warehouseId,
      durationMs: Date.now() - startedAt,
      error: failure,
    });
  }
}
