/**
 * Synapse SQL compiler — `PolicyCodeSet` → T-SQL GRANT / DENY / SECURITY POLICY
 * (RLS) + column DENY (CLS). Extends the existing SQL DENY/RLS compiler
 * (`lib/azure/rls-compiler.ts`) to the policy-as-code DSL. Pure string output;
 * `reconcile.ts` executes each op via the Synapse dedicated-SQL client.
 *
 * Reuses `sqlBracket` / `sqlString` (identifier + literal escapers) and
 * `daxFilterToTSql` / `safeIdent` / `splitSchemaTable` / `RLS_SCHEMA` from the
 * RLS compiler so emitted DDL is byte-consistent with the semantic-model path.
 */

import {
  sqlBracket,
  daxFilterToTSql,
  safeIdent,
  splitSchemaTable,
  RLS_SCHEMA,
  DEFAULT_IDENTITY_TSQL,
} from '@/lib/azure/rls-compiler';
import type { PolicyCodeSet, PolicyStatement } from '../dsl';
import { type CompiledArtifact, type CompiledOp, dedupeOps } from './types';

/** Batch splitter — the reconcile apply path splits an RLS op on `\nGO\n`. */
export const SQL_BATCH_SEP = '\nGO\n';

const PERMS: Record<'read' | 'write' | 'admin', string> = {
  read: 'SELECT',
  write: 'SELECT, INSERT, UPDATE, DELETE',
  admin: 'CONTROL',
};

/** SQL principal name — the display/UPN/group name is the DB principal; fall to id. */
function sqlPrincipal(name: string | undefined, id: string): string {
  return sqlBracket(name || id);
}

function grantOps(stmt: PolicyStatement, schema: string, table: string): CompiledOp[] {
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
  const ops: CompiledOp[] = [];
  for (const action of stmt.actions) {
    if (action === 'deny') {
      for (const p of stmt.principals) {
        const principal = sqlPrincipal(p.name, p.id);
        ops.push({
          key: `synapse:deny:${schema}.${table}:${p.id}`,
          kind: 'deny',
          statement: `DENY SELECT ON ${tableFq} TO ${principal};`,
          undo: `REVOKE SELECT ON ${tableFq} FROM ${principal};`,
          target: `${schema}.${table}`,
          principals: [p.id],
          from: stmt.id,
        });
      }
    } else {
      const perms = PERMS[action];
      for (const p of stmt.principals) {
        const principal = sqlPrincipal(p.name, p.id);
        ops.push({
          key: `synapse:grant:${action}:${schema}.${table}:${p.id}`,
          kind: 'grant',
          statement: `GRANT ${perms} ON ${tableFq} TO ${principal};`,
          undo: `REVOKE ${perms} ON ${tableFq} FROM ${principal};`,
          target: `${schema}.${table}`,
          principals: [p.id],
          from: stmt.id,
        });
      }
    }
  }
  return ops;
}

function maskOps(stmt: PolicyStatement, schema: string, table: string): CompiledOp[] {
  const cols = stmt.condition?.maskColumns || [];
  if (!cols.length) return [];
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
  const ops: CompiledOp[] = [];
  for (const col of cols) {
    for (const p of stmt.principals) {
      const principal = sqlPrincipal(p.name, p.id);
      ops.push({
        key: `synapse:mask:${schema}.${table}.${col}:${p.id}`,
        kind: 'mask',
        statement: `DENY SELECT ON ${tableFq}(${sqlBracket(col)}) TO ${principal};`,
        undo: `REVOKE SELECT ON ${tableFq}(${sqlBracket(col)}) FROM ${principal};`,
        target: `${schema}.${table}.${col}`,
        principals: [p.id],
        from: stmt.id,
      });
    }
  }
  return ops;
}

function rlsOp(
  stmt: PolicyStatement,
  schema: string,
  table: string,
  warnings: string[],
): CompiledOp | null {
  const dax = stmt.condition?.rowFilter?.trim();
  if (!dax) return null;
  const tr = daxFilterToTSql(dax, DEFAULT_IDENTITY_TSQL);
  tr.warnings.forEach((w) => warnings.push(`statement "${stmt.id}" / ${schema}.${table}: ${w}`));
  if (tr.columns.length === 0) {
    warnings.push(`statement "${stmt.id}" / ${schema}.${table}: row filter references no columns; RLS skipped.`);
    return null;
  }
  const ssafe = safeIdent(stmt.id);
  const tsafe = safeIdent(table);
  const fnName = `fn_pc_${ssafe}_${tsafe}`;
  const polName = `pol_pc_${ssafe}_${tsafe}`;
  const fnFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(fnName)}`;
  const polFq = `${sqlBracket(RLS_SCHEMA)}.${sqlBracket(polName)}`;
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
  const params = tr.columns.map((c) => `@${safeIdent(c)} NVARCHAR(4000)`).join(', ');
  const bind = tr.columns.map((c) => sqlBracket(c)).join(', ');

  const ddl = [
    `IF NOT EXISTS (SELECT 1 FROM sys.schemas WHERE name = N'${RLS_SCHEMA}') EXEC('CREATE SCHEMA ${RLS_SCHEMA}');`,
    `IF EXISTS (SELECT 1 FROM sys.security_policies WHERE name = N'${polName}') DROP SECURITY POLICY ${polFq};`,
    `IF OBJECT_ID('${RLS_SCHEMA}.${fnName}') IS NOT NULL DROP FUNCTION ${fnFq};`,
    `CREATE FUNCTION ${fnFq}(${params})\nRETURNS TABLE WITH SCHEMABINDING\nAS RETURN SELECT 1 AS rls_result WHERE (${tr.sql}) OR IS_MEMBER('db_owner') = 1;`,
    `CREATE SECURITY POLICY ${polFq}\nADD FILTER PREDICATE ${fnFq}(${bind}) ON ${tableFq}\nWITH (STATE = ON);`,
  ].join(SQL_BATCH_SEP);

  return {
    key: `synapse:rls:${schema}.${table}:${stmt.id}`,
    kind: 'rls',
    statement: ddl,
    undo: [
      `IF EXISTS (SELECT 1 FROM sys.security_policies WHERE name = N'${polName}') DROP SECURITY POLICY ${polFq};`,
      `IF OBJECT_ID('${RLS_SCHEMA}.${fnName}') IS NOT NULL DROP FUNCTION ${fnFq};`,
    ].join(SQL_BATCH_SEP),
    target: `${schema}.${table}`,
    principals: stmt.principals.map((p) => p.id),
    from: stmt.id,
  };
}

export function compileSynapse(set: PolicyCodeSet): CompiledArtifact {
  const ops: CompiledOp[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];

  for (const stmt of set.statements) {
    for (const res of stmt.resources) {
      if (res.backend !== 'synapse') continue;
      const { schema, table } = splitSchemaTable(res.object);
      ops.push(...grantOps(stmt, schema, table));
      ops.push(...maskOps(stmt, schema, table));
      const rls = rlsOp(stmt, schema, table, warnings);
      if (rls) {
        ops.push(rls);
        summary.push(`RLS: statement "${stmt.id}" → FILTER PREDICATE on ${schema}.${table}`);
      }
    }
  }

  const deduped = dedupeOps(ops);
  const grants = deduped.filter((o) => o.kind === 'grant').length;
  const denies = deduped.filter((o) => o.kind === 'deny' || o.kind === 'mask').length;
  if (grants) summary.unshift(`${grants} GRANT statement(s)`);
  if (denies) summary.push(`${denies} DENY (table/column) statement(s)`);

  return { backend: 'synapse', applicable: deduped.length > 0, ops: deduped, warnings, summary };
}
