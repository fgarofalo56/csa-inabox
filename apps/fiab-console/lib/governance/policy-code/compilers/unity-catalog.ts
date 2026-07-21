/**
 * Unity Catalog compiler — `PolicyCodeSet` → Databricks SQL `GRANT`/`REVOKE` +
 * `ROW FILTER` / `COLUMN MASK` DDL. Works on BOTH backends:
 *   - Databricks UC  → full: grants + row filters + column masks.
 *   - OSS Unity Catalog (`LOOM_UC_BACKEND=oss`, no Databricks/Fabric capacity)
 *     → grants only; row filters / column masks are NOT part of the OSS policy
 *     surface (capability matrix `abac: none`), so they are emitted as an
 *     honest warning and the enforcement falls to the serving engine (Synapse /
 *     ADX policies) per `.claude/rules/no-fabric-dependency.md`.
 *
 * Pure string output; `reconcile.ts` executes each op via the UC SQL path.
 * Reuses `bq` / `sparkString` / `daxFilterToDatabricksSql` from the RLS compiler.
 */

import { bq, daxFilterToDatabricksSql, safeIdent } from '@/lib/azure/rls-compiler';
import type { PolicyCodeSet, PolicyStatement } from '../dsl';
import { type CompiledArtifact, type CompiledOp, dedupeOps } from './types';

/** UC apply path splits a multi-statement op on this sentinel. */
export const UC_STMT_SEP = '\n;;\n';

export interface UcCompileOptions {
  /** 'databricks' (full) | 'oss' (grants only). Defaults to 'databricks'. */
  ucVariant?: 'databricks' | 'oss';
}

const PRIVS: Record<'read' | 'write' | 'admin', string> = {
  read: 'SELECT',
  write: 'MODIFY, SELECT',
  admin: 'ALL PRIVILEGES',
};

/** REST privilege enum per action (OSS-UC path — no SQL warehouse). */
const REST_PRIVS: Record<'read' | 'write' | 'admin', string[]> = {
  read: ['SELECT'],
  write: ['MODIFY', 'SELECT'],
  admin: ['ALL_PRIVILEGES'],
};

/** Backtick-quote a UC principal when it carries space/@/./- (else bareword). */
function ucPrincipal(name: string | undefined, id: string): string {
  const p = name || id;
  return /[\s@.\-]/.test(p) ? `\`${p.replace(/`/g, '``')}\`` : p;
}

/** `catalog.schema.table` → backticked fully-qualified name. */
function ucFq(object: string): { fq: string; catalog: string; schema: string; table: string } | null {
  const parts = object.split('.').map((p) => p.replace(/`/g, '').trim()).filter(Boolean);
  if (parts.length < 3) return null;
  const [catalog, schema, table] = [parts[parts.length - 3], parts[parts.length - 2], parts[parts.length - 1]];
  return { fq: `${bq(catalog)}.${bq(schema)}.${bq(table)}`, catalog, schema, table };
}

export function compileUnityCatalog(set: PolicyCodeSet, opts: UcCompileOptions = {}): CompiledArtifact {
  const oss = opts.ucVariant === 'oss';
  const ops: CompiledOp[] = [];
  const warnings: string[] = [];
  const summary: string[] = [];
  let maskFnEmitted = false;

  for (const stmt of set.statements) {
    for (const res of stmt.resources) {
      if (res.backend !== 'unity-catalog') continue;
      const parsed = ucFq(res.object);
      if (!parsed) {
        warnings.push(`statement "${stmt.id}": UC object "${res.object}" is not catalog.schema.table; skipped.`);
        continue;
      }
      const { fq, catalog, schema } = parsed;
      const home = `${bq(catalog)}.${bq(schema)}`;

      // ── GRANT / REVOKE ──────────────────────────────────────────────────────
      for (const action of stmt.actions) {
        for (const p of stmt.principals) {
          const principal = ucPrincipal(p.name, p.id);
          const restPrincipal = p.name || p.id;
          if (action === 'deny') {
            ops.push({
              key: `uc:revoke:${res.object}:${p.id}`,
              kind: 'revoke',
              statement: `REVOKE ALL PRIVILEGES ON TABLE ${fq} FROM ${principal}`,
              rest: { securableType: 'TABLE', securableName: res.object, principal: restPrincipal, remove: ['ALL_PRIVILEGES'] },
              target: res.object,
              principals: [p.id],
              from: stmt.id,
            });
          } else {
            ops.push({
              key: `uc:grant:${action}:${res.object}:${p.id}`,
              kind: 'grant',
              statement: `GRANT ${PRIVS[action]} ON TABLE ${fq} TO ${principal}`,
              undo: `REVOKE ${PRIVS[action]} ON TABLE ${fq} FROM ${principal}`,
              rest: {
                securableType: 'TABLE',
                securableName: res.object,
                principal: restPrincipal,
                add: REST_PRIVS[action],
              },
              target: res.object,
              principals: [p.id],
              from: stmt.id,
            });
          }
        }
      }

      // ── ROW FILTER / COLUMN MASK (Databricks only) ──────────────────────────
      const dax = stmt.condition?.rowFilter?.trim();
      const maskCols = stmt.condition?.maskColumns || [];
      if (dax || maskCols.length) {
        if (oss) {
          warnings.push(
            `statement "${stmt.id}" / ${res.object}: OSS Unity Catalog has no row-filter / column-mask surface — ` +
              `enforce this at the serving engine (Synapse / ADX policy). Grants above still apply.`,
          );
        } else {
          if (dax) {
            const rls = ucRowFilterOp(stmt, res.object, home, dax, warnings);
            if (rls) {
              ops.push(rls);
              summary.push(`RLS: statement "${stmt.id}" → ROW FILTER on ${res.object}`);
            }
          }
          for (const col of maskCols) {
            const parts: string[] = [];
            if (!maskFnEmitted) {
              parts.push(`CREATE OR REPLACE FUNCTION ${home}.${bq('loom_mask_hide')}(c STRING) RETURNS STRING RETURN NULL`);
              maskFnEmitted = true;
            }
            parts.push(`ALTER TABLE ${fq} ALTER COLUMN ${bq(col)} SET MASK ${home}.${bq('loom_mask_hide')}`);
            ops.push({
              key: `uc:mask:${res.object}.${col}`,
              kind: 'mask',
              statement: parts.join(UC_STMT_SEP),
              undo: `ALTER TABLE ${fq} ALTER COLUMN ${bq(col)} DROP MASK`,
              target: `${res.object}.${col}`,
              principals: stmt.principals.map((p) => p.id),
              from: stmt.id,
            });
          }
        }
      }
    }
  }

  const deduped = dedupeOps(ops);
  const grants = deduped.filter((o) => o.kind === 'grant').length;
  if (grants) summary.unshift(`${grants} GRANT statement(s)`);
  return {
    backend: 'unity-catalog',
    applicable: deduped.length > 0,
    ops: deduped,
    warnings,
    summary,
  };
}

function ucRowFilterOp(
  stmt: PolicyStatement,
  object: string,
  home: string,
  dax: string,
  warnings: string[],
): CompiledOp | null {
  const tr = daxFilterToDatabricksSql(dax);
  tr.warnings.forEach((w) => warnings.push(`statement "${stmt.id}" / ${object}: ${w}`));
  if (tr.columns.length === 0) {
    warnings.push(`statement "${stmt.id}" / ${object}: row filter references no columns; ROW FILTER skipped.`);
    return null;
  }
  const parsed = ucFqLoose(object);
  const fnName = `rls_pc_${safeIdent(stmt.id)}_${safeIdent(parsed.table)}`;
  const fnFq = `${home}.${bq(fnName)}`;
  const sig = tr.columns.map((c) => `${bq(c)} STRING`).join(', ');
  const onCols = tr.columns.map((c) => bq(c)).join(', ');
  const ddl = [
    `CREATE OR REPLACE FUNCTION ${fnFq}(${sig}) RETURNS BOOLEAN RETURN (${tr.sql})`,
    `ALTER TABLE ${parsed.fq} SET ROW FILTER ${fnFq} ON (${onCols})`,
  ].join(UC_STMT_SEP);
  return {
    key: `uc:rls:${object}:${stmt.id}`,
    kind: 'rls',
    statement: ddl,
    undo: `ALTER TABLE ${parsed.fq} DROP ROW FILTER`,
    target: object,
    principals: stmt.principals.map((p) => p.id),
    from: stmt.id,
  };
}

function ucFqLoose(object: string): { fq: string; table: string } {
  const parts = object.split('.').map((p) => p.replace(/`/g, '').trim()).filter(Boolean);
  const table = parts[parts.length - 1] || object;
  const fq = parts.map((p) => bq(p)).join('.');
  return { fq, table };
}
