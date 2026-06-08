/**
 * synapse-permissions-client — the SQL-plane data-access layer for the
 * Lakehouse "Permissions" dialog's Table / Column / Row tabs (parity with the
 * Azure Synapse / Fabric warehouse "Manage permissions" + SSMS Securables UI).
 *
 * Azure-native, NO Fabric dependency (no-fabric-dependency.md): every grant is
 * a real T-SQL statement executed against the **Synapse Dedicated SQL pool**
 * via the shared AAD-token TDS pool in {@link synapseExecute}. No Fabric /
 * Power BI REST is touched.
 *
 *   - Object-level (table) SELECT  → `GRANT SELECT ON [s].[t] TO [upn]`
 *   - Column-level SELECT          → `GRANT SELECT ON [s].[t]([c],…) TO [upn]`
 *   - Row-level security           → `CREATE SECURITY POLICY` + inline TVF
 *
 * Row-level security and column-level security on base tables require a
 * **Dedicated** SQL pool — they are not supported on Serverless (the Row tab
 * honest-gates on Serverless; see overview-features#security on Learn). The
 * caller resolves the target via {@link dedicatedTarget} and surfaces the gate
 * when `LOOM_SYNAPSE_DEDICATED_POOL` is unset.
 *
 * Injection safety: NO user string is ever interpolated into DDL. Schema,
 * table, and column identifiers are resolved from the `sys.*` catalog by
 * integer object_id / column_id and bracket-quoted; the principal UPN is
 * bracket-quoted (`]` doubled) for identifiers and N''-escaped for literals;
 * the RLS filter expression is chosen from a fixed allow-list.
 */

import {
  dedicatedTarget,
  executeQuery as synapseExecute,
  type SynapseTarget,
  type QueryResult,
} from './synapse-sql-client';

// Re-export so the BFF route can resolve the target + honest-gate in one import.
export { dedicatedTarget, type SynapseTarget };

// ── identifier / literal escaping (no string injection) ──────────────────────
export function sqlBracket(ident: string): string {
  return `[${ident.replace(/]/g, ']]')}]`;
}
export function sqlString(s: string): string {
  return `N'${s.replace(/'/g, "''")}'`;
}

/** Map a column-array QueryResult into row objects keyed by column name. */
function toObjects(qr: QueryResult): Record<string, any>[] {
  return qr.rows.map((row) => {
    const o: Record<string, any> = {};
    qr.columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

// ── catalog resolution (all identifiers come from sys.*, never user text) ─────

export interface SqlTableRef { objectId: number; schema: string; name: string; type: string }

/** Enumerate base tables + views for the table/column/row pickers. */
export async function listSqlTables(target: SynapseTarget): Promise<SqlTableRef[]> {
  const qr = await synapseExecute(
    target,
    `SELECT o.object_id AS objectId, s.name AS [schema], o.name AS name, o.type AS type
     FROM sys.objects o
     JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0
     ORDER BY s.name, o.name;`,
  );
  return toObjects(qr).map((r) => ({
    objectId: Number(r.objectId),
    schema: String(r.schema),
    name: String(r.name),
    type: String(r.type || '').trim(),
  }));
}

export interface SqlColumnRef { columnId: number; name: string; dataType: string }

/** Enumerate the columns of one table/view (resolved by integer object_id). */
export async function listSqlColumns(target: SynapseTarget, objectId: number): Promise<SqlColumnRef[]> {
  if (!Number.isInteger(objectId)) throw new Error('objectId must be an integer');
  const qr = await synapseExecute(
    target,
    `SELECT c.column_id AS columnId, c.name AS name, ty.name AS dataType
     FROM sys.columns c
     JOIN sys.types ty ON ty.user_type_id = c.user_type_id
     WHERE c.object_id = ${objectId}
     ORDER BY c.column_id;`,
  );
  return toObjects(qr).map((r) => ({
    columnId: Number(r.columnId),
    name: String(r.name),
    dataType: String(r.dataType),
  }));
}

/** Resolve `{schema,name}` for an object_id from the catalog (never from caller text). */
async function resolveTable(target: SynapseTarget, objectId: number): Promise<{ schema: string; name: string }> {
  if (!Number.isInteger(objectId)) throw new Error('objectId must be an integer');
  const qr = await synapseExecute(
    target,
    `SELECT s.name AS [schema], o.name AS name
     FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE o.object_id = ${objectId} AND o.type IN ('U','V') AND o.is_ms_shipped = 0;`,
  );
  const hit = toObjects(qr)[0];
  if (!hit) throw new Error(`Table/view not found for object_id ${objectId}`);
  return { schema: String(hit.schema), name: String(hit.name) };
}

/** Resolve the catalog column names for the requested column_ids of one object. */
async function resolveColumnNames(target: SynapseTarget, objectId: number, columnIds: number[]): Promise<string[]> {
  const ids = columnIds.filter((n) => Number.isInteger(n));
  if (ids.length === 0) return [];
  const qr = await synapseExecute(
    target,
    `SELECT c.column_id AS columnId, c.name AS name
     FROM sys.columns c
     WHERE c.object_id = ${objectId} AND c.column_id IN (${ids.join(',')})
     ORDER BY c.column_id;`,
  );
  return toObjects(qr).map((r) => String(r.name));
}

// ── table / column SELECT grants ─────────────────────────────────────────────

export interface TableGrantRow {
  principal: string;        // UPN — name of the FROM EXTERNAL PROVIDER user
  principalType: string;
  schema: string;
  table: string;
  /** null = table-level grant; column name = column-level grant. */
  column: string | null;
  permissionName: string;   // SELECT
}

/**
 * List object-level + column-level SELECT grants on user tables/views.
 * `column_id = 0` → table-level; `> 0` → column-level (joined to sys.columns).
 */
export async function listTableGrants(target: SynapseTarget): Promise<TableGrantRow[]> {
  const qr = await synapseExecute(
    target,
    `SELECT dp.name AS principal, dp.type_desc AS principalType,
            s.name AS [schema], o.name AS [table],
            col.name AS [column], perm.permission_name AS permissionName
     FROM sys.database_permissions perm
     JOIN sys.objects o ON o.object_id = perm.major_id
     JOIN sys.schemas s ON s.schema_id = o.schema_id
     JOIN sys.database_principals dp ON dp.principal_id = perm.grantee_principal_id
     LEFT JOIN sys.columns col ON col.object_id = perm.major_id AND col.column_id = perm.minor_id
     WHERE perm.class = 1
       AND perm.permission_name = 'SELECT'
       AND perm.state_desc = 'GRANT'
       AND o.type IN ('U','V')
       AND o.is_ms_shipped = 0
     ORDER BY s.name, o.name, dp.name, perm.minor_id;`,
  );
  return toObjects(qr).map((r) => ({
    principal: String(r.principal),
    principalType: String(r.principalType || ''),
    schema: String(r.schema),
    table: String(r.table),
    column: r.column == null ? null : String(r.column),
    permissionName: String(r.permissionName),
  }));
}

/** CREATE USER [upn] FROM EXTERNAL PROVIDER if absent (idempotent). */
function ensureUserClause(upn: string): string {
  return (
    `IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ${sqlString(upn)})\n` +
    `  CREATE USER ${sqlBracket(upn)} FROM EXTERNAL PROVIDER;\n`
  );
}

function columnList(cols: string[]): string {
  return `(${cols.map(sqlBracket).join(', ')})`;
}

/**
 * GRANT SELECT to `upn` on a table — table-level when `columnIds` is empty,
 * column-level otherwise. Identifiers resolved from the catalog by id.
 */
export async function grantTableSelect(
  target: SynapseTarget,
  upn: string,
  objectId: number,
  columnIds: number[] = [],
): Promise<{ granted: string }> {
  const name = (upn || '').trim();
  if (!name) throw new Error('A principal UPN is required to grant SELECT.');
  const { schema, name: table } = await resolveTable(target, objectId);
  const fq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
  let target_clause = fq;
  let label = `${schema}.${table}`;
  if (columnIds.length > 0) {
    const cols = await resolveColumnNames(target, objectId, columnIds);
    if (cols.length === 0) throw new Error('None of the requested columns exist on the table.');
    target_clause = `${fq}${columnList(cols)}`;
    label = `${schema}.${table}(${cols.join(', ')})`;
  }
  const sql = ensureUserClause(name) + `GRANT SELECT ON ${target_clause} TO ${sqlBracket(name)};`;
  await synapseExecute(target, sql);
  return { granted: `${label} → ${name}` };
}

/** REVOKE SELECT from `upn` on a table (table- or column-level). */
export async function revokeTableSelect(
  target: SynapseTarget,
  upn: string,
  objectId: number,
  columnIds: number[] = [],
): Promise<{ revoked: string }> {
  const name = (upn || '').trim();
  if (!name) throw new Error('A principal UPN is required to revoke SELECT.');
  const { schema, name: table } = await resolveTable(target, objectId);
  const fq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
  let target_clause = fq;
  let label = `${schema}.${table}`;
  if (columnIds.length > 0) {
    const cols = await resolveColumnNames(target, objectId, columnIds);
    if (cols.length === 0) throw new Error('None of the requested columns exist on the table.');
    target_clause = `${fq}${columnList(cols)}`;
    label = `${schema}.${table}(${cols.join(', ')})`;
  }
  await synapseExecute(target, `REVOKE SELECT ON ${target_clause} FROM ${sqlBracket(name)};`);
  return { revoked: `${label} ↛ ${name}` };
}

// ── row-level security (Dedicated SQL pool only) ─────────────────────────────

const RLS_SCHEMA = 'LoomSecurity';

/** Allow-listed RLS subject expressions — never free SQL. */
export const RLS_SUBJECTS = ['USER_NAME()', 'SUSER_SNAME()'] as const;
export type RlsSubject = (typeof RLS_SUBJECTS)[number];

/** Strip a catalog name down to an identifier-safe suffix for the fn/policy name. */
function safeSuffix(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80) || 'tbl';
}

export interface RlsPolicyRow {
  policyObjectId: number;
  policySchema: string;
  policyName: string;
  schema: string;
  table: string;
  isEnabled: boolean;
  predicateType: string;
  functionSchema: string;
  functionName: string;
}

/** List active row-level security policies and their target tables. */
export async function listRlsPolicies(target: SynapseTarget): Promise<RlsPolicyRow[]> {
  const qr = await synapseExecute(
    target,
    `SELECT pol.object_id AS policyObjectId, ps.name AS policySchema, pol.name AS policyName,
            ts.name AS [schema], tgt.name AS [table], pol.is_enabled AS isEnabled,
            pred.predicate_type_desc AS predicateType,
            fs.name AS functionSchema, fn.name AS functionName
     FROM sys.security_policies pol
     JOIN sys.schemas ps ON ps.schema_id = pol.schema_id
     JOIN sys.security_predicates pred ON pred.object_id = pol.object_id
     JOIN sys.objects tgt ON tgt.object_id = pred.target_object_id
     JOIN sys.schemas ts ON ts.schema_id = tgt.schema_id
     JOIN sys.objects fn ON fn.object_id = pred.function_object_id
     JOIN sys.schemas fs ON fs.schema_id = fn.schema_id
     ORDER BY pol.name;`,
  );
  return toObjects(qr).map((r) => ({
    policyObjectId: Number(r.policyObjectId),
    policySchema: String(r.policySchema),
    policyName: String(r.policyName),
    schema: String(r.schema),
    table: String(r.table),
    isEnabled: !!r.isEnabled,
    predicateType: String(r.predicateType || ''),
    functionSchema: String(r.functionSchema),
    functionName: String(r.functionName),
  }));
}

/** Ensure the LoomSecurity schema exists (Dedicated-pool-safe, no IF NOT EXISTS clause). */
async function ensureRlsSchema(target: SynapseTarget): Promise<void> {
  await synapseExecute(
    target,
    `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = ${sqlString(RLS_SCHEMA)})\n` +
      `  EXEC('CREATE SCHEMA ${RLS_SCHEMA}');`,
  );
}

/**
 * Create a row-level security FILTER predicate on a table. The inline TVF
 * returns 1 when the filter column equals the calling principal's name
 * (USER_NAME()/SUSER_SNAME()), or the caller is db_owner. CREATE FUNCTION /
 * CREATE SECURITY POLICY each require their own batch, so the statements run
 * as sequential executeQuery calls. Dedicated SQL pool only.
 */
export async function createRlsPolicy(
  target: SynapseTarget,
  opts: { objectId: number; filterColumnId: number; subject: RlsSubject },
): Promise<{ policyName: string; functionName: string }> {
  const subject: RlsSubject = RLS_SUBJECTS.includes(opts.subject) ? opts.subject : 'USER_NAME()';
  const { schema, name: table } = await resolveTable(target, opts.objectId);
  const cols = await resolveColumnNames(target, opts.objectId, [opts.filterColumnId]);
  if (cols.length === 0) throw new Error('The chosen filter column does not exist on the table.');
  const filterColumn = cols[0];

  const fnName = `fn_rls_${safeSuffix(table)}`;
  const polName = `pol_rls_${safeSuffix(table)}`;
  const fnFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(fnName)}`;
  const polFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(polName)}`;
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;

  await ensureRlsSchema(target);
  // Drop any existing policy first (it depends on the function).
  await synapseExecute(target, `IF EXISTS (SELECT 1 FROM sys.security_policies WHERE name = ${sqlString(polName)}) DROP SECURITY POLICY ${polFq};`);
  await synapseExecute(target, `IF OBJECT_ID('${RLS_SCHEMA}.${fnName.replace(/'/g, "''")}') IS NOT NULL DROP FUNCTION ${fnFq};`);
  // CREATE FUNCTION must be the only statement in its batch.
  await synapseExecute(
    target,
    `CREATE FUNCTION ${fnFq}(@cmp sysname)\n` +
      `RETURNS TABLE WITH SCHEMABINDING AS\n` +
      `RETURN SELECT 1 AS rls_result\n` +
      `WHERE @cmp = ${subject} OR IS_MEMBER('db_owner') = 1;`,
  );
  // CREATE SECURITY POLICY must be the only statement in its batch.
  await synapseExecute(
    target,
    `CREATE SECURITY POLICY ${polFq}\n` +
      `ADD FILTER PREDICATE ${fnFq}(${sqlBracket(filterColumn)}) ON ${tableFq}\n` +
      `WITH (STATE = ON);`,
  );
  return { policyName: `${RLS_SCHEMA}.${polName}`, functionName: `${RLS_SCHEMA}.${fnName}` };
}

// ── free-form WHERE-predicate RLS (F8 — "OneLake security" custom predicate) ──

// The predicate sanitizer lives in a dependency-free module so it can be
// unit-tested without dragging in the Azure SDK / mssql. Re-exported here so
// the BFF route imports validation + DDL from one place.
export { RLS_WHERE_MAX, validateWhereClause } from './rls-predicate';
import { validateWhereClause } from './rls-predicate';

function whereClauseError(message: string): Error & { status: number; code: string } {
  const err = new Error(message) as Error & { status: number; code: string };
  err.status = 400;
  err.code = 'invalid_where_clause';
  return err;
}

/**
 * Create a row-level security FILTER predicate from a free-form WHERE clause
 * (F8). The clause is validated, parse/bind-probed (so an invalid predicate
 * never drops the existing policy), then embedded in the inline TVF:
 *
 *   CREATE FUNCTION LoomSecurity.fn_rls_<table>(@cmp sysname)
 *     RETURNS TABLE WITH SCHEMABINDING AS
 *     RETURN SELECT 1 AS rls_result
 *     WHERE (<user predicate>) OR IS_MEMBER('db_owner') = 1;
 *
 * The owner-bypass (`OR IS_MEMBER('db_owner') = 1`) is always appended so a
 * database owner can still read every row. The filter column is resolved from
 * the catalog by integer column_id (never user text) and passed positionally
 * as @cmp. Dedicated SQL pool only.
 */
export async function createRlsPolicyWithPredicate(
  target: SynapseTarget,
  opts: { objectId: number; filterColumnId: number; whereClause: string },
): Promise<{ policyName: string; functionName: string; predicate: string }> {
  const verdict = validateWhereClause(opts.whereClause);
  if (!verdict.ok) throw whereClauseError(verdict.error!);
  const clause = opts.whereClause.trim();

  const { schema, name: table } = await resolveTable(target, opts.objectId);
  const cols = await resolveColumnNames(target, opts.objectId, [opts.filterColumnId]);
  if (cols.length === 0) throw new Error('The chosen filter column does not exist on the table.');
  const filterColumn = cols[0];

  const fnName = `fn_rls_${safeSuffix(table)}`;
  const polName = `pol_rls_${safeSuffix(table)}`;
  const fnFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(fnName)}`;
  const polFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(polName)}`;
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;

  await ensureRlsSchema(target);

  // Parse/bind PROBE first — validate the predicate compiles against a no-FROM
  // SELECT (only @cmp + identity functions are in scope, exactly like the TVF).
  // If it throws (precise SQL parse/bind error) we have NOT mutated any policy,
  // so an invalid predicate can never leave the table unprotected.
  await synapseExecute(
    target,
    `DECLARE @cmp sysname = N'';\n` +
      `SELECT TOP 0 1 AS rls_result WHERE (${clause}) OR IS_MEMBER('db_owner') = 1;`,
  );

  // Drop any existing policy first (it depends on the function).
  await synapseExecute(
    target,
    `IF EXISTS (SELECT 1 FROM sys.security_policies WHERE name = ${sqlString(polName)}) DROP SECURITY POLICY ${polFq};`,
  );
  await synapseExecute(
    target,
    `IF OBJECT_ID('${RLS_SCHEMA}.${fnName.replace(/'/g, "''")}') IS NOT NULL DROP FUNCTION ${fnFq};`,
  );
  // CREATE FUNCTION must be the only statement in its batch.
  await synapseExecute(
    target,
    `CREATE FUNCTION ${fnFq}(@cmp sysname)\n` +
      `RETURNS TABLE WITH SCHEMABINDING AS\n` +
      `RETURN SELECT 1 AS rls_result\n` +
      `WHERE (${clause}) OR IS_MEMBER('db_owner') = 1;`,
  );
  // CREATE SECURITY POLICY must be the only statement in its batch.
  await synapseExecute(
    target,
    `CREATE SECURITY POLICY ${polFq}\n` +
      `ADD FILTER PREDICATE ${fnFq}(${sqlBracket(filterColumn)}) ON ${tableFq}\n` +
      `WITH (STATE = ON);`,
  );
  return { policyName: `${RLS_SCHEMA}.${polName}`, functionName: `${RLS_SCHEMA}.${fnName}`, predicate: clause };
}

/**
 * Test a free-form RLS predicate against LIVE rows without creating a policy.
 * Faithfully evaluates the predicate the policy would apply:
 *   - `@cmp`            → each row's filter-column value (catalog-resolved name)
 *   - USER_NAME()       → the `testIdentity` (the signed-in admin's UPN by
 *   - SUSER_SNAME()       default) so the preview shows the rows THAT user would
 *                         see, not the rows the BFF service identity sees.
 *
 * Returns `SELECT TOP <n>` of the live table filtered by the predicate. The
 * owner-bypass is intentionally omitted here so the predicate's own filtering
 * is visible (the connecting identity is db_owner and would otherwise match
 * every row). Read-only — no DDL, no policy mutation.
 */
export async function testRlsPredicate(
  target: SynapseTarget,
  opts: { objectId: number; filterColumnId: number; whereClause: string; testIdentity: string; sampleRows?: number },
): Promise<{ schema: string; table: string; filterColumn: string; testIdentity: string; result: QueryResult }> {
  const verdict = validateWhereClause(opts.whereClause);
  if (!verdict.ok) throw whereClauseError(verdict.error!);
  const clause = opts.whereClause.trim();

  const { schema, name: table } = await resolveTable(target, opts.objectId);
  const cols = await resolveColumnNames(target, opts.objectId, [opts.filterColumnId]);
  if (cols.length === 0) throw new Error('The chosen filter column does not exist on the table.');
  const filterColumn = cols[0];

  const testIdentity = (opts.testIdentity || '').trim();
  const top = Math.min(Math.max(Number(opts.sampleRows) || 20, 1), 200);
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;

  // Substitute the only user-side tokens with injection-safe values:
  //   @cmp           → t.[filterColumn]    (bracket-escaped catalog identifier)
  //   USER_NAME()    → N'testIdentity'     (sqlString-escaped literal)
  //   SUSER_SNAME()  → N'testIdentity'
  // The rest of the clause already passed validateWhereClause (no quotes,
  // comments, semicolons, or DDL/DML keywords) so it is safe to embed verbatim.
  const probeClause = clause
    .replace(/@cmp\b/gi, `t.${sqlBracket(filterColumn)}`)
    .replace(/USER_NAME\s*\(\s*\)/gi, sqlString(testIdentity))
    .replace(/SUSER_SNAME\s*\(\s*\)/gi, sqlString(testIdentity));

  const result = await synapseExecute(
    target,
    `SELECT TOP ${top} * FROM ${tableFq} AS t WHERE (${probeClause});`,
  );
  return { schema, table, filterColumn, testIdentity, result };
}

// ── policy teardown ──────────────────────────────────────────────────────────

/** Drop a row-level security policy (resolved from the catalog by object_id). */
export async function dropRlsPolicy(target: SynapseTarget, policyObjectId: number): Promise<{ dropped: string }> {
  if (!Number.isInteger(policyObjectId)) throw new Error('policyObjectId must be an integer');
  const qr = await synapseExecute(
    target,
    `SELECT s.name AS [schema], p.name AS name
     FROM sys.security_policies p JOIN sys.schemas s ON s.schema_id = p.schema_id
     WHERE p.object_id = ${policyObjectId};`,
  );
  const hit = toObjects(qr)[0];
  if (!hit) throw new Error(`Security policy not found for object_id ${policyObjectId}`);
  const fq = `${sqlBracket(String(hit.schema))}.${sqlBracket(String(hit.name))}`;
  await synapseExecute(target, `DROP SECURITY POLICY ${fq};`);
  return { dropped: `${hit.schema}.${hit.name}` };
}
