/**
 * Azure Data Explorer (ADX / Kusto) compiler — `PolicyCodeSet` → database-role
 * principal grants (`.add database <db> <role> (...)`) + table Row-Level-Security
 * (`.alter table <t> policy row_level_security enable "<kql>"`). ADX is
 * Azure-native (Gov-safe, no Fabric dependency). Pure string output; the RLS KQL
 * is validated with the dependency-free `validateKustoRlsQuery`.
 *
 * ADX RLS restricts rows to members of the statement's principals via
 * `current_principal_is_member_of(...)` (the DSL DAX row filter is a SQL-dialect
 * predicate and is not translated to KQL — an honest warning is emitted if one
 * is set on an ADX resource so the author moves it to a Synapse/UC resource).
 */

import { validateKustoRlsQuery } from '@/lib/azure/kusto-rls-predicate';
import type { PolicyCodeSet, PolicyPrincipal, PolicyStatement } from '../dsl';
import { type CompiledArtifact, type CompiledOp, dedupeOps } from './types';

export interface AdxCompileOptions {
  /** Entra tenant id appended to the principal FQN (`;<tid>`) when supplied. */
  tenantId?: string;
}

/** read→viewers, write→users, admin→admins (deny handled as a revoke, no add). */
const ROLE: Record<'read' | 'write' | 'admin', string> = {
  read: 'viewers',
  write: 'users',
  admin: 'admins',
};

/** KQL identifier — bareword when safe, else bracket-quoted. */
export function kqlName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `["${name.replace(/["\\]/g, '\\$&')}"]`;
}

/** ADX principal FQN — `aadgroup=<id>[;tid]` / `aaduser=<upn|oid>[;tid]`. */
export function adxPrincipalFqn(p: PolicyPrincipal, tenantId?: string): string {
  const kind = p.kind === 'user' ? 'aaduser' : 'aadgroup';
  const value = p.kind === 'user' ? p.name || p.id : p.id;
  return tenantId ? `${kind}=${value};${tenantId}` : `${kind}=${value}`;
}

/** Split `database/table` (or bare `database`). */
function splitDbTable(object: string): { db: string; table?: string } {
  const parts = object.split(/[\/.]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { db: parts[0], table: parts.slice(1).join('.') };
  return { db: parts[0] || object };
}

export function compileAdx(set: PolicyCodeSet, opts: AdxCompileOptions = {}): CompiledArtifact {
  const ops: CompiledOp[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];

  for (const stmt of set.statements) {
    for (const res of stmt.resources) {
      if (res.backend !== 'adx') continue;
      const { db, table } = splitDbTable(res.object);

      // ── database-role principal grants ──────────────────────────────────────
      for (const action of stmt.actions) {
        if (action === 'deny') {
          // Modeled as a revoke by the reconcile loop (remove principal from role).
          for (const p of stmt.principals) {
            const fqn = adxPrincipalFqn(p, opts.tenantId);
            ops.push({
              key: `adx:drop:${db}:viewers:${p.id}`,
              kind: 'revoke',
              statement: `.drop database ${kqlName(db)} viewers ('${fqn}') skip-results`,
              target: db,
              principals: [p.id],
              from: stmt.id,
            });
          }
          continue;
        }
        const role = ROLE[action];
        for (const p of stmt.principals) {
          const fqn = adxPrincipalFqn(p, opts.tenantId);
          ops.push({
            key: `adx:add:${db}:${role}:${p.id}`,
            kind: 'principal',
            statement: `.add database ${kqlName(db)} ${role} ('${fqn}') skip-results`,
            undo: `.drop database ${kqlName(db)} ${role} ('${fqn}') skip-results`,
            target: db,
            principals: [p.id],
            from: stmt.id,
          });
        }
      }

      // ── Row-Level Security on a table ───────────────────────────────────────
      const rls = adxRlsOp(stmt, db, table, warnings);
      if (rls) {
        ops.push(rls);
        summary.push(`RLS: statement "${stmt.id}" → row_level_security on ${db}/${table}`);
      }
    }
  }

  const deduped = dedupeOps(ops);
  const adds = deduped.filter((o) => o.kind === 'principal').length;
  if (adds) summary.unshift(`${adds} database-role principal grant(s)`);
  return { backend: 'adx', applicable: deduped.length > 0, ops: deduped, warnings, summary };
}

function adxRlsOp(
  stmt: PolicyStatement,
  db: string,
  table: string | undefined,
  warnings: string[],
): CompiledOp | null {
  // RLS is a table policy. A membership restriction is meaningful only for the
  // groups/users named on a granting statement.
  const hasGrant = stmt.actions.some((a) => a !== 'deny');
  const wantsRls = !!stmt.condition?.rowFilter || (hasGrant && stmt.principals.length > 0 && !!table);
  if (!wantsRls) return null;
  if (!table) {
    warnings.push(`statement "${stmt.id}": ADX resource "${db}" names no table; row_level_security skipped.`);
    return null;
  }
  if (stmt.condition?.rowFilter) {
    warnings.push(
      `statement "${stmt.id}" / ${db}/${table}: the DAX row filter is not translated to KQL — ADX RLS ` +
        `restricts rows to the statement's principals via current_principal_is_member_of(). Put per-column ` +
        `SQL predicates on a Synapse/UC resource instead.`,
    );
  }
  // The RLS membership predicate omits the tenant suffix: a `;<tid>` inside the
  // KQL string would trip the single-expression (`;`) guard, and ADX resolves
  // aadgroup=<objectId> without it.
  const members = stmt.principals.map((p) => `'${adxPrincipalFqn(p)}'`).join(', ');
  if (!members) return null;
  const query = `${kqlName(table)} | where current_principal_is_member_of(${members})`;
  const check = validateKustoRlsQuery(query);
  if (!check.ok) {
    warnings.push(`statement "${stmt.id}" / ${db}/${table}: RLS query invalid — ${check.error}`);
    return null;
  }
  const escaped = query.replace(/"/g, '\\"');
  return {
    key: `adx:rls:${db}/${table}:${stmt.id}`,
    kind: 'rls',
    statement: `.alter table ${kqlName(table)} policy row_level_security enable "${escaped}"`,
    undo: `.alter table ${kqlName(table)} policy row_level_security disable "${escaped}"`,
    target: `${db}/${table}`,
    principals: stmt.principals.map((p) => p.id),
    from: stmt.id,
  };
}
