/**
 * RLS compiler — DAX boolean filter → T-SQL / Databricks predicate, then the
 * SECURITY POLICY + inline TVF (Synapse) / ROW FILTER + COLUMN MASK (Databricks)
 * DDL. Pure string output; the caller (the semantic-model roles route) executes
 * each emitted statement. No Azure / network calls live here.
 *
 * Extracted verbatim from `app/api/items/semantic-model/[id]/roles/route.ts` so the
 * compiler + its input/output contract (`MetaPerm`, `Security*Permission`,
 * `SecurityRoleDef`, `RlsEngine`, `CompiledStep`, `CompiledRlsArtifact`) can be
 * unit-tested and reused. Behaviour is byte-for-byte identical to the previous
 * inlined version; `sqlBracket`/`sqlString` come from the same
 * synapse-permissions-client source, so the emitted DDL is unchanged.
 */

import { sqlBracket, sqlString } from '@/lib/azure/synapse-permissions-client';

// ─────────────────────────────────────────────────────────────────────────────
// Shared role contract (SOURCE OF TRUTH for the compiler). Persisted Azure-native
// onto the owned Cosmos item under `item.state.model.securityRoles` — NO Fabric /
// Power BI / AAS workspace required.
// ─────────────────────────────────────────────────────────────────────────────

export type MetaPerm = 'read' | 'none';

export interface SecurityColumnPermission {
  name: string;
  metadataPermission: MetaPerm;
}
export interface SecurityTablePermission {
  table: string;
  filterExpression?: string;
  metadataPermission?: MetaPerm;
  columnPermissions?: SecurityColumnPermission[];
}
export interface SecurityRoleDef {
  name: string;
  members: string[];
  tablePermissions: SecurityTablePermission[];
  updatedAt: string;
}

export type RlsEngine = 'synapse' | 'databricks';

// ═════════════════════════════════════════════════════════════════════════════
// RLS compiler — DAX boolean filter → T-SQL / Databricks predicate, then the
// SECURITY POLICY + TVF / ROW FILTER + COLUMN MASK DDL. Pure string output; the
// route executes each statement.
// ═════════════════════════════════════════════════════════════════════════════

export const RLS_SCHEMA = 'LoomSecurity';
export const DEFAULT_IDENTITY_TSQL = "COALESCE(CAST(SESSION_CONTEXT(N'loom_user') AS sysname), USER_NAME())";

export function safeIdent(s: string): string {
  return (String(s || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80)) || 'x';
}

/** Split `schema.table` (or bracketed) into parts; default schema `dbo`. */
export function splitSchemaTable(t: string): { schema: string; table: string } {
  const parts = String(t || '')
    .split('.')
    .map((p) => p.replace(/[[\]]/g, '').trim())
    .filter(Boolean);
  if (parts.length >= 2) return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
  return { schema: 'dbo', table: parts[0] || String(t || '').replace(/[[\]]/g, '') };
}

export function bq(ident: string): string {
  return '`' + String(ident).replace(/`/g, '') + '`';
}
export function sparkString(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export interface PredDialect {
  identityExpr: string;
  column: (rawCol: string) => string;
  str: (inner: string) => string;
  and: string;
  or: string;
  not: string;
  ne: string;
  trueLit: string;
  falseLit: string;
}

/**
 * Translate a DAX boolean filter into the dialect's predicate text. Supports the
 * documented subset: [Column] / 'Table'[Column], "literal", numbers,
 * USERPRINCIPALNAME()/USERNAME() → identity, =, ==, <>, !=, <, >, <=, >=, AND/&&,
 * OR/||, NOT, IN, parentheses and DAX `{ … }` set braces. Unsupported constructs
 * are dropped/approximated and reported in `warnings` (honest).
 */
export function translateDax(dax: string, d: PredDialect): { sql: string; columns: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const columns: string[] = [];
  const addCol = (c: string) => {
    if (c && !columns.includes(c)) columns.push(c);
  };
  let out = '';
  const s = String(dax || '');
  // Ordered alternation, sticky: ws | func() | column | string | number | multiOp | singleOp | word | other
  const re =
    /(\s+)|([A-Za-z_][A-Za-z0-9_]*\s*\(\s*\))|((?:'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_]*)?\[[^\]]*\])|("(?:[^"\\]|\\.)*")|(\d+(?:\.\d+)?)|(<=|>=|<>|!=|==|&&|\|\|)|([(){}<>=,])|([A-Za-z_][A-Za-z0-9_]*)|(.)/gy;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(s)) !== null) {
    if (guard++ > 5000) {
      warnings.push('filter expression too long; truncated');
      break;
    }
    if (m[1] !== undefined) {
      out += ' ';
    } else if (m[2] !== undefined) {
      // zero-arg function call
      const name = m[2].slice(0, m[2].indexOf('(')).trim().toUpperCase();
      if (name === 'USERPRINCIPALNAME' || name === 'USERNAME' || name === 'USEROBJECTID' || name === 'CUSTOMDATA') {
        out += d.identityExpr;
      } else if (name === 'TRUE') {
        out += d.trueLit;
      } else if (name === 'FALSE') {
        out += d.falseLit;
      } else {
        warnings.push(`unsupported function ${name}() — treated as FALSE`);
        out += d.falseLit;
      }
    } else if (m[3] !== undefined) {
      // column reference (optionally table-qualified) — take the last [..]
      const tok = m[3];
      const open = tok.lastIndexOf('[');
      const close = tok.lastIndexOf(']');
      const col = open >= 0 && close > open ? tok.slice(open + 1, close).trim() : '';
      if (!col) {
        warnings.push('empty column reference dropped');
        out += d.falseLit;
      } else {
        addCol(col);
        out += d.column(col);
      }
    } else if (m[4] !== undefined) {
      const inner = m[4].slice(1, -1).replace(/\\(.)/g, '$1');
      out += d.str(inner);
    } else if (m[5] !== undefined) {
      out += m[5];
    } else if (m[6] !== undefined) {
      const op = m[6];
      if (op === '&&') out += d.and;
      else if (op === '||') out += d.or;
      else if (op === '<>' || op === '!=') out += d.ne;
      else if (op === '==') out += '=';
      else out += op;
    } else if (m[7] !== undefined) {
      const c = m[7];
      if (c === '{') out += '(';
      else if (c === '}') out += ')';
      else out += c;
    } else if (m[8] !== undefined) {
      const w = m[8].toUpperCase();
      if (w === 'AND') out += d.and;
      else if (w === 'OR') out += d.or;
      else if (w === 'NOT') out += d.not;
      else if (w === 'IN') out += ' IN ';
      else if (w === 'TRUE') out += d.trueLit;
      else if (w === 'FALSE') out += d.falseLit;
      else {
        warnings.push(`unsupported token "${m[8]}" passed through`);
        out += m[8];
      }
    } else if (m[9] !== undefined) {
      // stray character — drop it
      warnings.push(`unexpected character "${m[9]}" dropped`);
    }
  }
  return { sql: out.replace(/\s+/g, ' ').trim() || d.falseLit, columns, warnings };
}

/** DAX → T-SQL predicate referencing @<col> params (for the inline TVF body). */
export function daxFilterToTSql(dax: string, identityExpr = DEFAULT_IDENTITY_TSQL): { sql: string; columns: string[]; warnings: string[] } {
  return translateDax(dax, {
    identityExpr,
    column: (c) => `@${safeIdent(c)}`,
    str: (inner) => sqlString(inner),
    and: ' AND ',
    or: ' OR ',
    not: ' NOT ',
    ne: ' <> ',
    trueLit: '(1=1)',
    falseLit: '(1=0)',
  });
}

/** DAX → T-SQL predicate referencing `t.[col]` with a literal test identity (test receipt). */
export function daxFilterToTSqlInline(dax: string, testUpn: string): { sql: string; columns: string[]; warnings: string[] } {
  return translateDax(dax, {
    identityExpr: sqlString(testUpn),
    column: (c) => `t.${sqlBracket(c)}`,
    str: (inner) => sqlString(inner),
    and: ' AND ',
    or: ' OR ',
    not: ' NOT ',
    ne: ' <> ',
    trueLit: '(1=1)',
    falseLit: '(1=0)',
  });
}

/** DAX → Databricks predicate referencing bare `col` (for the row-filter body). */
export function daxFilterToDatabricksSql(dax: string): { sql: string; columns: string[]; warnings: string[] } {
  return translateDax(dax, {
    identityExpr: 'current_user()',
    column: (c) => bq(c),
    str: (inner) => sparkString(inner),
    and: ' AND ',
    or: ' OR ',
    not: ' NOT ',
    ne: ' <> ',
    trueLit: 'true',
    falseLit: 'false',
  });
}

export interface CompiledStep {
  sql: string;
  kind: 'schema' | 'drop' | 'function' | 'policy' | 'rowfilter' | 'mask' | 'deny';
}
export interface CompiledRlsArtifact {
  engine: RlsEngine;
  steps: CompiledStep[];
  summary: string[];
  warnings: string[];
}

export function compileSynapse(roles: SecurityRoleDef[], identityExpr: string): CompiledRlsArtifact {
  const steps: CompiledStep[] = [];
  const summary: string[] = [];
  const warnings: string[] = [];
  steps.push({
    kind: 'schema',
    sql: `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'${RLS_SCHEMA}') EXEC('CREATE SCHEMA ${RLS_SCHEMA}');`,
  });
  const tablesWithFilters = new Map<string, number>();
  for (const role of roles) {
    const rsafe = safeIdent(role.name);
    for (const tp of role.tablePermissions || []) {
      const { schema, table } = splitSchemaTable(tp.table);
      const tsafe = safeIdent(table);
      const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;

      // ── RLS — FILTER PREDICATE ──────────────────────────────────────────────
      if (tp.filterExpression && tp.filterExpression.trim()) {
        const key = `${schema}.${table}`.toLowerCase();
        const seen = tablesWithFilters.get(key) || 0;
        tablesWithFilters.set(key, seen + 1);
        if (seen >= 1) {
          warnings.push(
            `table "${schema}.${table}" is filtered by more than one role; SQL Server ANDs ` +
              `their FILTER PREDICATEs (intersection). Combine the roles' filters into one if you need a union.`,
          );
        }
        const tr = daxFilterToTSql(tp.filterExpression, identityExpr);
        tr.warnings.forEach((w) => warnings.push(`role "${role.name}" / "${table}": ${w}`));
        if (tr.columns.length === 0) {
          warnings.push(`role "${role.name}" / "${table}": filter references no columns; RLS skipped.`);
        } else {
          const fnName = `fn_rls_${rsafe}_${tsafe}`;
          const polName = `pol_rls_${rsafe}_${tsafe}`;
          const fnFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(fnName)}`;
          const polFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(polName)}`;
          const params = tr.columns.map((c) => `@${safeIdent(c)} NVARCHAR(4000)`).join(', ');
          const bind = tr.columns.map((c) => sqlBracket(c)).join(', ');
          steps.push({
            kind: 'drop',
            sql: `IF EXISTS (SELECT 1 FROM sys.security_policies WHERE name = N'${polName}') DROP SECURITY POLICY ${polFq};`,
          });
          steps.push({
            kind: 'drop',
            sql: `IF OBJECT_ID('${RLS_SCHEMA}.${fnName}') IS NOT NULL DROP FUNCTION ${fnFq};`,
          });
          steps.push({
            kind: 'function',
            sql:
              `CREATE FUNCTION ${fnFq}(${params})\n` +
              `RETURNS TABLE WITH SCHEMABINDING\n` +
              `AS RETURN SELECT 1 AS rls_result WHERE (${tr.sql}) OR IS_MEMBER('db_owner') = 1;`,
          });
          steps.push({
            kind: 'policy',
            sql:
              `CREATE SECURITY POLICY ${polFq}\n` +
              `ADD FILTER PREDICATE ${fnFq}(${bind}) ON ${tableFq}\n` +
              `WITH (STATE = ON);`,
          });
          summary.push(`RLS: role "${role.name}" → FILTER PREDICATE on ${schema}.${table} (cols: ${tr.columns.join(', ')})`);
        }
      }

      // ── OLS — whole-table hide → table-scope DENY for each member ────────────
      if (tp.metadataPermission === 'none') {
        for (const member of role.members || []) {
          steps.push({ kind: 'deny', sql: `DENY SELECT ON ${tableFq} TO ${sqlBracket(member)};` });
        }
        if ((role.members || []).length === 0) {
          warnings.push(`role "${role.name}" hides table "${table}" but has no members; nothing to DENY.`);
        }
        summary.push(`OLS: table "${schema}.${table}" hidden from role "${role.name}" members`);
      } else {
        // ── OLS / CLS — per-column hide → column-scope DENY for each member ────
        for (const cp of tp.columnPermissions || []) {
          if (cp.metadataPermission === 'none') {
            for (const member of role.members || []) {
              steps.push({
                kind: 'deny',
                sql: `DENY SELECT ON ${tableFq}(${sqlBracket(cp.name)}) TO ${sqlBracket(member)};`,
              });
            }
            if ((role.members || []).length === 0) {
              warnings.push(`role "${role.name}" hides column "${table}.${cp.name}" but has no members; nothing to DENY.`);
            }
            summary.push(`OLS: column "${table}.${cp.name}" hidden from role "${role.name}" members`);
          }
        }
      }
    }
  }
  return { engine: 'synapse', steps, summary, warnings };
}

export function compileDatabricks(roles: SecurityRoleDef[], catalog: string, schema: string): CompiledRlsArtifact {
  const steps: CompiledStep[] = [];
  const summary: string[] = [];
  const warnings: string[] = [];
  const home = `${bq(catalog)}.${bq(schema)}`;
  let maskFnEmitted = false;
  for (const role of roles) {
    const rsafe = safeIdent(role.name);
    for (const tp of role.tablePermissions || []) {
      const { table } = splitSchemaTable(tp.table);
      const tsafe = safeIdent(table);
      const tableFq = `${home}.${bq(table)}`;

      // ── RLS — ROW FILTER ────────────────────────────────────────────────────
      if (tp.filterExpression && tp.filterExpression.trim()) {
        const tr = daxFilterToDatabricksSql(tp.filterExpression);
        tr.warnings.forEach((w) => warnings.push(`role "${role.name}" / "${table}": ${w}`));
        if (tr.columns.length === 0) {
          warnings.push(`role "${role.name}" / "${table}": filter references no columns; ROW FILTER skipped.`);
        } else {
          const fnName = `rls_${rsafe}_${tsafe}`;
          const fnFq = `${home}.${bq(fnName)}`;
          const sig = tr.columns.map((c) => `${bq(c)} STRING`).join(', ');
          const onCols = tr.columns.map((c) => bq(c)).join(', ');
          warnings.push(
            `role "${role.name}" / "${table}": ROW FILTER params typed STRING (Unity Catalog needs explicit types; ` +
              `re-type if the key columns are numeric/date).`,
          );
          steps.push({
            kind: 'function',
            sql: `CREATE OR REPLACE FUNCTION ${fnFq}(${sig}) RETURNS BOOLEAN RETURN (${tr.sql});`,
          });
          steps.push({ kind: 'rowfilter', sql: `ALTER TABLE ${tableFq} SET ROW FILTER ${fnFq} ON (${onCols});` });
          summary.push(`RLS: role "${role.name}" → ROW FILTER on ${catalog}.${schema}.${table} (cols: ${tr.columns.join(', ')})`);
        }
      }

      // ── OLS — whole-table hide is a UC GRANT/REVOKE concern (honest warning) ─
      if (tp.metadataPermission === 'none') {
        warnings.push(
          `role "${role.name}" hides whole table "${table}": Unity Catalog has no table-level column-mask; ` +
            `revoke SELECT on ${catalog}.${schema}.${table} from the role's principals via GRANT/REVOKE instead.`,
        );
      } else {
        // ── CLS — COLUMN MASK (null-out) for each hidden column ────────────────
        for (const cp of tp.columnPermissions || []) {
          if (cp.metadataPermission === 'none') {
            if (!maskFnEmitted) {
              steps.push({
                kind: 'mask',
                sql: `CREATE OR REPLACE FUNCTION ${home}.${bq('loom_mask_hide')}(c STRING) RETURNS STRING RETURN NULL;`,
              });
              maskFnEmitted = true;
            }
            steps.push({
              kind: 'mask',
              sql: `ALTER TABLE ${tableFq} ALTER COLUMN ${bq(cp.name)} SET MASK ${home}.${bq('loom_mask_hide')};`,
            });
            summary.push(`CLS: column "${table}.${cp.name}" masked (null) for role "${role.name}"`);
          }
        }
      }
    }
  }
  return { engine: 'databricks', steps, summary, warnings };
}
