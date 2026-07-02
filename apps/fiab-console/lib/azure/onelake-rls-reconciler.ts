/**
 * OneLake RLS/CLS reconciler — materializes a OneLake security role's
 * Row-Level-Security predicates + Column-Level-Security allow-lists to the REAL
 * SOURCE ENGINE the item resolves to, Azure-native (no Fabric).
 *
 *   - SYNAPSE (lakehouse / mirrored / warehouse → Synapse dedicated SQL pool):
 *     per RLS rule an idempotent `LoomSecurity` schema + an inline schemabinding
 *     table-valued function whose WHERE embeds the VALIDATED SQL predicate +
 *     a CREATE SECURITY POLICY binding it (DROP-IF-EXISTS first → idempotent).
 *     Per CLS rule: REVOKE table-wide SELECT + GRANT SELECT on the allowed
 *     columns, per role member (the documented column-GRANT pattern). The DDL
 *     shape is byte-identical to the semantic-model RLS path — it reuses
 *     `safeIdent` / `sqlBracket` / `RLS_SCHEMA` from `rls-compiler.ts` and the
 *     same `fn_rls_*` / `pol_rls_*` / schemabinding-TVF / IS_MEMBER('db_owner')
 *     bypass.
 *
 *   - ADX (eventhouse / kql-* → Azure Data Explorer cluster): one
 *     `.alter table T policy row_level_security enable "<query>"` per table that
 *     materializes BOTH the row predicate (`| where`) AND the restricted column
 *     set (`| project`) — the documented ADX way to express RLS + CLS in a
 *     single restricted query.
 *
 *   - HONEST GATE (no-vaporware.md): when the target engine is not configured
 *     (no LOOM_SYNAPSE_WORKSPACE/LOOM_SYNAPSE_DEDICATED_POOL, or no
 *     LOOM_KUSTO_CLUSTER_URI) the reconciler returns a receipt with
 *     status:'gated' naming the exact missing env var — NEVER a fake success,
 *     never a crash. For a Delta-on-ADLS item with no SQL engine, RLS/CLS is
 *     PDP-obligation-only (lib/auth/pdp still enforces role.rls/role.cls); the
 *     receipt says so honestly.
 *
 * Idempotent: safe to re-run (schema IF NOT EXISTS, DROP-IF-EXISTS before
 * CREATE, REVOKE before GRANT, `.alter` policy is last-writer-wins).
 *
 * The pure DDL builders (`buildSynapseRlsSteps`, `buildSynapseClsSteps`,
 * `buildAdxRestrictQuery`, `extractAndParameterize`, `resolveReconcileEngine`)
 * have NO Azure-SDK dependency so they are vitest-safe. The Synapse / Kusto
 * clients are imported LAZILY (dynamic import) inside the async reconcile so the
 * honest-gate path never loads `@azure/identity`.
 */

import { safeIdent, sqlBracket, splitSchemaTable, RLS_SCHEMA } from '@/lib/azure/rls-compiler';
import { isValidRlsPredicate } from './onelake-security-rules';
import type { RowLevelRule, ColumnLevelRule } from './onelake-security-rules';
import type { OneLakeSecurityRole, SecurityRoleMember } from './onelake-security-client';

// ════════════════════════════════════════════════════════════════════════════
// Receipt contract — mirrors the change-counter shape of
// onelake-security-client.applyRoleAcls / verifyRoleAcls.
// ════════════════════════════════════════════════════════════════════════════

export type ReconcileEngine = 'synapse' | 'adx' | 'none';
export type ReconcileStatus = 'applied' | 'gated' | 'partial';

export interface ReconcileReceipt {
  /** The source engine the item resolved to. */
  engine: ReconcileEngine;
  /** Count of enforcement objects materialized (security policies + member grants / ADX policy alters). */
  applied: number;
  /** Per-statement log (`ok: …` / `FAILED: …`) — the human-readable trace. */
  steps: string[];
  /** Honest, non-fatal notes (skipped rules, member-without-UPN, PDP-only enforcement, …). */
  warnings: string[];
  status: ReconcileStatus;
  /** Present only when status==='gated' — the exact missing env var / resource. */
  gate?: { missing: string };
}

/** The minimal item shape the reconciler needs (a Cosmos workspace item). */
export interface ReconcileItem {
  id?: string;
  itemType?: string;
  state?: Record<string, any> | null;
}

type StepKind = 'schema' | 'drop' | 'function' | 'policy' | 'grant' | 'revoke' | 'adx-rls';
export interface ReconcileStep { sql: string; kind: StepKind; }

// ════════════════════════════════════════════════════════════════════════════
// Engine resolution (pure)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the source engine for an item. Eventhouse / KQL / Kusto / ADX items
 * resolve to ADX; everything else (lakehouse, mirrored-*, warehouse) resolves to
 * the Synapse SQL path. Reads the item type first, falling back to the role's
 * persisted itemType.
 */
export function resolveReconcileEngine(
  item: ReconcileItem | null | undefined,
  role?: { itemType?: string } | null,
): 'synapse' | 'adx' {
  const t = String(item?.itemType || role?.itemType || '').toLowerCase();
  if (/eventhouse|kql|kusto|adx/.test(t)) return 'adx';
  return 'synapse';
}

// ════════════════════════════════════════════════════════════════════════════
// Synapse RLS DDL builder (pure) — matches the semantic-model SECURITY-POLICY/TVF
// shape. The predicate is RAW VALIDATED SQL (not DAX): its column references are
// extracted + rewritten to `@param` so the schemabinding filter-predicate TVF is
// valid T-SQL, then bound `ON table` exactly like rls-compiler.compileSynapse.
// ════════════════════════════════════════════════════════════════════════════

/** Strip a single layer of surrounding `[ ]` brackets + trim a column token. */
function stripBrackets(c: string): string {
  return String(c || '').trim().replace(/^\[|\]$/g, '').trim();
}

// T-SQL words that are NOT columns when they appear bare in a predicate.
const RESERVED_WORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'ALL', 'ANY', 'SOME',
  'AS', 'N', 'SYSNAME', 'TRUE', 'FALSE', 'CAST', 'CONVERT', 'TRY_CAST', 'COALESCE', 'ISNULL',
  'NULLIF', 'SESSION_CONTEXT', 'USER_NAME', 'SUSER_NAME', 'SUSER_SNAME', 'CURRENT_USER',
  'ORIGINAL_LOGIN', 'IS_MEMBER', 'IS_ROLEMEMBER', 'NVARCHAR', 'VARCHAR', 'NCHAR', 'CHAR',
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT', 'FLOAT', 'REAL', 'DATE', 'DATETIME',
  'DATETIME2', 'LOWER', 'UPPER', 'LTRIM', 'RTRIM', 'TRIM', 'LEN', 'SUBSTRING', 'CONCAT',
]);

/**
 * Tokenize a validated SQL predicate, collect its column references, and rewrite
 * each bare/bracketed column to a `@<safeIdent>` parameter (so the schemabinding
 * filter-predicate TVF can declare them). String literals (`'…'` / `N'…'`),
 * already-`@param` tokens, and function names (a word immediately followed by
 * `(`) are passed through untouched. Reserved keywords are passed through.
 */
export function extractAndParameterize(predicate: string): { rewritten: string; columns: string[] } {
  const s = String(predicate || '');
  const columns: string[] = [];
  const addCol = (c: string) => { if (c && !columns.includes(c)) columns.push(c); };
  // string-literal | @param | [bracketed] | word | whitespace | other
  const re = /(N?'(?:[^']|'')*')|(@[A-Za-z_][A-Za-z0-9_]*)|(\[[^\]]+\])|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|(.)/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      out += m[1]; // string literal — verbatim
    } else if (m[2] !== undefined) {
      out += m[2]; // already a @param — verbatim
    } else if (m[3] !== undefined) {
      const col = stripBrackets(m[3]);
      addCol(col);
      out += `@${safeIdent(col)}`;
    } else if (m[4] !== undefined) {
      const word = m[4];
      // function call? peek for the next non-space char being '('
      let j = re.lastIndex;
      while (j < s.length && /\s/.test(s[j])) j++;
      const isFunc = s[j] === '(';
      if (isFunc || RESERVED_WORDS.has(word.toUpperCase())) {
        out += word;
      } else {
        addCol(word);
        out += `@${safeIdent(word)}`;
      }
    } else if (m[5] !== undefined) {
      out += m[5];
    } else if (m[6] !== undefined) {
      out += m[6];
    }
  }
  return { rewritten: out.replace(/\s+/g, ' ').trim(), columns };
}

/** The idempotent `LoomSecurity` schema step (emitted once per Synapse reconcile). */
export function synapseSchemaStep(): ReconcileStep {
  return {
    kind: 'schema',
    sql: `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'${RLS_SCHEMA}') EXEC('CREATE SCHEMA ${RLS_SCHEMA}');`,
  };
}

/**
 * Build the DROP-IF-EXISTS → CREATE FUNCTION (schemabinding TVF) → CREATE
 * SECURITY POLICY steps for ONE RLS rule. Idempotent. Returns no policy steps
 * (with a warning) when the predicate is invalid or references no columns.
 */
export function buildSynapseRlsSteps(
  roleName: string,
  rule: RowLevelRule,
): { steps: ReconcileStep[]; columns: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const v = isValidRlsPredicate(rule.predicate);
  if (!v.ok) {
    return { steps: [], columns: [], warnings: [`RLS predicate for "${rule.table}" rejected: ${v.error}`] };
  }
  const { schema, table } = splitSchemaTable(rule.table);
  const rsafe = safeIdent(roleName);
  const tsafe = safeIdent(table);
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
  const { rewritten, columns } = extractAndParameterize(rule.predicate);
  if (columns.length === 0) {
    return {
      steps: [],
      columns: [],
      warnings: [`RLS predicate for "${rule.table}" references no columns; FILTER PREDICATE skipped (cannot bind a schemabinding TVF without a column).`],
    };
  }
  const fnName = `fn_rls_${rsafe}_${tsafe}`;
  const polName = `pol_rls_${rsafe}_${tsafe}`;
  const fnFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(fnName)}`;
  const polFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(polName)}`;
  const params = columns.map((c) => `@${safeIdent(c)} NVARCHAR(4000)`).join(', ');
  const bind = columns.map((c) => sqlBracket(c)).join(', ');
  const steps: ReconcileStep[] = [
    {
      kind: 'drop',
      sql: `IF EXISTS (SELECT 1 FROM sys.security_policies WHERE name = N'${polName}') DROP SECURITY POLICY ${polFq};`,
    },
    {
      kind: 'drop',
      sql: `IF OBJECT_ID('${RLS_SCHEMA}.${fnName}') IS NOT NULL DROP FUNCTION ${fnFq};`,
    },
    {
      kind: 'function',
      sql:
        `CREATE FUNCTION ${fnFq}(${params})\n` +
        `RETURNS TABLE WITH SCHEMABINDING\n` +
        `AS RETURN SELECT 1 AS rls_result WHERE (${rewritten}) OR IS_MEMBER('db_owner') = 1;`,
    },
    {
      kind: 'policy',
      sql:
        `CREATE SECURITY POLICY ${polFq}\n` +
        `ADD FILTER PREDICATE ${fnFq}(${bind}) ON ${tableFq}\n` +
        `WITH (STATE = ON);`,
    },
  ];
  return { steps, columns, warnings };
}

/**
 * Build the CLS steps for ONE rule: per role member (by UPN), REVOKE any
 * table-wide SELECT then GRANT SELECT on ONLY the allowed columns (the
 * documented column-GRANT pattern — selecting an un-granted column then raises a
 * permission error). Idempotent (REVOKE/GRANT are last-writer-wins). Members
 * without a UPN are skipped with a warning (a GRANT needs a contained DB user).
 */
export function buildSynapseClsSteps(
  rule: ColumnLevelRule,
  members: SecurityRoleMember[],
): { steps: ReconcileStep[]; warnings: string[] } {
  const warnings: string[] = [];
  const steps: ReconcileStep[] = [];
  const { schema, table } = splitSchemaTable(rule.table);
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
  const cols = (rule.allowedColumns || []).map((c) => sqlBracket(stripBrackets(c))).join(', ');
  if (!cols) {
    return { steps: [], warnings: [`CLS rule for "${rule.table}" has no allowed columns; skipped.`] };
  }
  const named = (members || []).filter((m) => m && (m.upn || '').trim());
  if (named.length === 0) {
    warnings.push(`CLS rule for "${rule.table}" has no members with a resolvable UPN; nothing to GRANT.`);
  }
  for (const m of named) {
    const principal = sqlBracket(String(m.upn).trim());
    steps.push({ kind: 'revoke', sql: `REVOKE SELECT ON ${tableFq} FROM ${principal};` });
    steps.push({ kind: 'grant', sql: `GRANT SELECT ON ${tableFq}(${cols}) TO ${principal};` });
  }
  return { steps, warnings };
}

// ════════════════════════════════════════════════════════════════════════════
// ADX restricted-query builder (pure). One `.alter table policy
// row_level_security` query materializes both the row predicate and the column
// allow-list (`| where` + `| project`).
// ════════════════════════════════════════════════════════════════════════════

function kqlName(t: string): string {
  return `["${String(t).replace(/"/g, '\\"')}"]`;
}
function kqlCol(c: string): string {
  return `['${stripBrackets(c).replace(/'/g, "\\'")}']`;
}

/**
 * Build the KQL RLS query for a table. The predicate (validated KQL) becomes a
 * `| where (…)`; the allowed-column set becomes a `| project …` (restricted
 * columns). Either part may be absent.
 */
export function buildAdxRestrictQuery(
  table: string,
  predicate?: string,
  allowedColumns?: string[],
): string {
  let q = kqlName(table);
  const p = (predicate || '').trim();
  if (p) {
    // Already a piped/tabular expression? Append a where; otherwise wrap.
    q += p.includes('|') ? ` | ${p.replace(/^\|+\s*/, '')}` : ` | where (${p})`;
  }
  if (allowedColumns && allowedColumns.length) {
    q += ` | project ${allowedColumns.map(kqlCol).join(', ')}`;
  }
  return q;
}

// ════════════════════════════════════════════════════════════════════════════
// Async reconcile — executes the real DDL via the existing clients, or gates.
// ════════════════════════════════════════════════════════════════════════════

async function reconcileSynapse(item: ReconcileItem, role: OneLakeSecurityRole): Promise<ReconcileReceipt> {
  const hasWs = !!process.env.LOOM_SYNAPSE_WORKSPACE;
  const hasPool = !!process.env.LOOM_SYNAPSE_DEDICATED_POOL;
  if (!hasWs || !hasPool) {
    return {
      engine: 'synapse',
      applied: 0,
      steps: [],
      warnings: [
        'No Azure-native Synapse dedicated SQL pool is configured, so row-/column-level security is NOT materialized as a SECURITY POLICY here. It is still enforced by the Loom PDP as obligations on role.rls / role.cls (Delta-on-ADLS PDP-obligation path). Bind a SQL engine to additionally enforce it at the source.',
      ],
      status: 'gated',
      gate: { missing: !hasWs ? 'LOOM_SYNAPSE_WORKSPACE' : 'LOOM_SYNAPSE_DEDICATED_POOL' },
    };
  }

  const { dedicatedTarget, executeQuery } = await import('./synapse-sql-client');
  const target = dedicatedTarget();
  const steps: string[] = [];
  const warnings: string[] = [];
  let applied = 0;
  let failed = false;

  const run = async (sql: string, kind: StepKind, label: string): Promise<void> => {
    try {
      await executeQuery(target, sql);
      steps.push(`ok: ${kind} — ${label}`);
      if (kind === 'policy' || kind === 'grant') applied++;
    } catch (e: any) {
      failed = true;
      steps.push(`FAILED: ${kind} — ${label} — ${e?.message || String(e)}`);
    }
  };

  await run(synapseSchemaStep().sql, 'schema', RLS_SCHEMA);

  for (const rule of role.rls || []) {
    const b = buildSynapseRlsSteps(role.roleName, rule);
    warnings.push(...b.warnings);
    for (const s of b.steps) await run(s.sql, s.kind, rule.table);
  }
  for (const rule of role.cls || []) {
    const b = buildSynapseClsSteps(rule, role.members || []);
    warnings.push(...b.warnings);
    for (const s of b.steps) await run(s.sql, s.kind, rule.table);
  }

  return { engine: 'synapse', applied, steps, warnings, status: failed ? 'partial' : 'applied' };
}

async function reconcileAdx(item: ReconcileItem, role: OneLakeSecurityRole): Promise<ReconcileReceipt> {
  // Gate without importing the Kusto client (keeps the gate path SDK-free).
  if (!process.env.LOOM_KUSTO_CLUSTER_URI) {
    return {
      engine: 'adx',
      applied: 0,
      steps: [],
      warnings: [
        'No Azure Data Explorer cluster is configured, so row-/column-level security is NOT materialized as an ADX row_level_security policy here. It is still enforced by the Loom PDP as obligations on role.rls / role.cls.',
      ],
      status: 'gated',
      gate: { missing: 'LOOM_KUSTO_CLUSTER_URI' },
    };
  }

  const { alterTableRlsPolicy, validateKustoRlsQuery, defaultDatabase } = await import('./kusto-client');
  const db = (item?.state?.databaseName as string)?.trim() || defaultDatabase();
  const steps: string[] = [];
  const warnings: string[] = [];
  let applied = 0;
  let failed = false;

  // Union the rls + cls rules by table — one RLS policy expresses both.
  const byTable = new Map<string, { predicate?: string; cols?: string[] }>();
  for (const r of role.rls || []) byTable.set(r.table, { ...byTable.get(r.table), predicate: r.predicate });
  for (const c of role.cls || []) byTable.set(c.table, { ...byTable.get(c.table), cols: c.allowedColumns });

  for (const [table, spec] of byTable) {
    const query = buildAdxRestrictQuery(table, spec.predicate, spec.cols);
    const v = validateKustoRlsQuery(query);
    if (!v.ok) {
      warnings.push(`${table}: ${v.error}`);
      continue;
    }
    if (v.warning) warnings.push(`${table}: ${v.warning}`);
    try {
      await alterTableRlsPolicy(db, table, true, query);
      steps.push(`ok: adx-rls — ${table}`);
      applied++;
      // Honest disclosure of ADX's RLS model vs Synapse's per-role/per-member one:
      // `.alter table policy row_level_security` is TABLE-WIDE + LAST-WRITER-WINS.
      // So (a) this policy applies to EVERY non-bypass principal querying the table,
      // not only role "${role.roleName}" members (unlike Synapse's per-member GRANT),
      // and (b) reconciling another role over the same table replaces this policy at
      // the source. The Loom PDP obligation-union is authoritative for net per-
      // principal enforcement; the ADX source policy reflects the last reconciled role.
      warnings.push(
        `${table}: ADX row_level_security is table-wide + last-writer-wins — this policy applies to ALL principals querying the table (not only role "${role.roleName}" members) and replaces any prior role's ADX policy on this table. The Loom PDP obligation-union remains authoritative for net per-principal enforcement.`,
      );
      if (spec.cols && spec.cols.length) {
        warnings.push(`${table}: column-level security is materialized via the row_level_security policy's | project — restricted to ${spec.cols.join(', ')}.`);
      }
    } catch (e: any) {
      failed = true;
      steps.push(`FAILED: adx-rls — ${table} — ${e?.message || String(e)}`);
    }
  }

  return { engine: 'adx', applied, steps, warnings, status: failed ? 'partial' : 'applied' };
}

/**
 * Materialize a OneLake security role's RLS/CLS to the source engine the item
 * resolves to. Idempotent; returns a {@link ReconcileReceipt}. Never throws for
 * a missing engine — returns status:'gated' instead (no-vaporware honest gate).
 */
export async function reconcileRoleRlsCls(
  item: ReconcileItem | null | undefined,
  role: OneLakeSecurityRole,
): Promise<ReconcileReceipt> {
  const safeItem: ReconcileItem = item || {};
  const engine = resolveReconcileEngine(safeItem, role);
  if (engine === 'adx') return reconcileAdx(safeItem, role);
  return reconcileSynapse(safeItem, role);
}
