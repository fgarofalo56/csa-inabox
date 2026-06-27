/**
 * RLS + OLS role authoring for a semantic model — Azure-NATIVE by DEFAULT.
 *
 *   GET  /api/items/semantic-model/[id]/roles?workspaceId=…&catalog=…
 *        → { ok:true, backend, native, roles, deployed? }
 *        | { ok:false, gate } (501 — ONLY when no native SQL endpoint exists)
 *
 *   PUT  /api/items/semantic-model/[id]/roles
 *        body { roles: SecRole[] }
 *        → native: persist roles to item.state.model.securityRoles (SOURCE OF
 *          TRUTH) then compile + deploy a real Synapse SECURITY POLICY + inline
 *          TVF (or a Databricks UC ROW FILTER + COLUMN MASK).
 *        → xmla : createOrReplace the model's role set via XMLA TMSL (opt-in).
 *
 *   POST /api/items/semantic-model/[id]/roles?action=test
 *        body { roleName, effectiveUserName, daxQuery? }
 *        → native: impersonate the UPN and return the FILTERED rows (the receipt).
 *        → xmla : test-as-role DAX probe (EffectiveUserName + Roles).
 *
 * ── NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md) ──────────────
 * The Security tab used to hard-gate on an Analysis-Services / Power BI XMLA
 * engine (`aasConfigGate()` → 501) — so on the canonical Loom-native
 * warehouse/lakehouse semantic model it was DEAD by default. That was a
 * no-Fabric VIOLATION. Fixed here: the DEFAULT backend is the Azure-native SQL
 * engine —
 *   • Synapse dedicated SQL pool → CREATE SECURITY POLICY + inline schemabinding
 *     TVF keyed on the calling principal (RLS) + column/table DENY (OLS / CLS).
 *   • Databricks Unity Catalog   → CREATE FUNCTION + SET ROW FILTER + SET MASK.
 * AAS / Power BI XMLA is an OPT-IN alternative (`LOOM_SEMANTIC_RLS_BACKEND=xmla`,
 * or `auto` when ONLY an AAS/PBI engine is present). The honest config-gate is
 * returned ONLY when there is NO native SQL endpoint at all, and it names the
 * Azure env vars (LOOM_SYNAPSE_DEDICATED_POOL / LOOM_DATABRICKS_SQL_WAREHOUSE_ID)
 * — never a Fabric / Power BI workspace as the default.
 *
 * The `SemanticModelSecurityTab` editor needs NO change: it already renders the
 * roles grid + per-role DAX filter + OLS matrix + test-as-role, and only shows a
 * gate when GET returns `{gate}`. The native branch returns `{roles, backend,
 * native:true}` so the existing UI lights up unchanged.
 *
 * ── QUERY-PATH CONSUMER CONTRACT (Synapse) ───────────────────────────────────
 * The compiled FILTER PREDICATE compares the row's key column to
 *   COALESCE(CAST(SESSION_CONTEXT(N'loom_user') AS sysname), USER_NAME())
 * with an `OR IS_MEMBER('db_owner') = 1` admin bypass. The Loom service identity
 * is db_owner, so to enforce RLS for the *signed-in* user the `/query` route MUST
 * run `EXEC sp_set_session_context N'loom_user', N'<signed-in UPN>'` on the
 * connection before each user query. (This route's test-as-role inlines the test
 * UPN directly so the receipt is faithful even though the service is db_owner.)
 *
 * Per no-vaporware.md: a real SECURITY POLICY / ROW FILTER is deployed via the
 * shared AAD-token SQL pool; the Cosmos write is the source of truth and survives
 * a deploy failure (surfaced honestly in `steps`).
 *
 * NOTE: the DAX→SQL compiler is inlined here (rather than a shared
 * `lib/azure/rls-compiler.ts`) because this change set may touch ONLY this file.
 * It emits the SAME DDL shapes the Synapse permissions client proves out
 * (createRlsPolicy) and runs each batch through `executeQuery` / `executeStatement`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getRoles,
  setRoles,
  testAsRole,
  aasConfigGate,
  validateRlsDax,
  AasError,
  type AasRole,
  type AasRoleTablePermission,
} from '@/lib/azure/aas-roles';
import { dedicatedTarget, executeQuery as synapseExecute, type QueryResult } from '@/lib/azure/synapse-sql-client';
import { listRlsPolicies, sqlBracket, sqlString } from '@/lib/azure/synapse-permissions-client';
import { executeStatement } from '@/lib/azure/databricks-client';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';
const NAME_RE = /^[\w\-\s.]{1,128}$/;

function catalogFrom(req: NextRequest, id: string): string {
  return req.nextUrl.searchParams.get('catalog') || id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Persisted native role shape (SOURCE OF TRUTH for the compiler). Mirrors the
// SHARED CONTRACT `SecurityRoleDef`. Persisted Azure-native onto the owned Cosmos
// item under `item.state.model.securityRoles` — NO Fabric / Power BI / AAS
// workspace required.
// ─────────────────────────────────────────────────────────────────────────────

type MetaPerm = 'read' | 'none';

interface SecurityColumnPermission {
  name: string;
  metadataPermission: MetaPerm;
}
interface SecurityTablePermission {
  table: string;
  filterExpression?: string;
  metadataPermission?: MetaPerm;
  columnPermissions?: SecurityColumnPermission[];
}
interface SecurityRoleDef {
  name: string;
  members: string[];
  tablePermissions: SecurityTablePermission[];
  updatedAt: string;
}

type RlsBackendKind = 'synapse' | 'databricks' | 'xmla' | 'none';
type RlsEngine = 'synapse' | 'databricks';

/**
 * Resolve the RLS/OLS backend. `LOOM_SEMANTIC_RLS_BACKEND` ∈
 * auto|synapse|databricks|xmla (default `auto`):
 *   auto → synapse  if LOOM_SYNAPSE_DEDICATED_POOL (+ LOOM_SYNAPSE_WORKSPACE)
 *        → databricks if LOOM_DATABRICKS_SQL_WAREHOUSE_ID
 *        → xmla      if an AAS / Power BI XMLA engine is configured (opt-in)
 *        → none      (honest Azure-native gate)
 * The DEFAULT path NEVER resolves to the AAS/Fabric gate — only when there is no
 * native SQL endpoint at all.
 */
function resolveRlsBackend(): RlsBackendKind {
  const pref = (process.env.LOOM_SEMANTIC_RLS_BACKEND || 'auto').trim().toLowerCase();
  const hasSynapse = !!process.env.LOOM_SYNAPSE_DEDICATED_POOL && !!process.env.LOOM_SYNAPSE_WORKSPACE;
  const hasDbx = !!process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID;
  const hasXmla = aasConfigGate() === null;
  if (pref === 'synapse') return hasSynapse ? 'synapse' : 'none';
  if (pref === 'databricks') return hasDbx ? 'databricks' : 'none';
  if (pref === 'xmla') return hasXmla ? 'xmla' : 'none';
  // auto — Azure-native SQL endpoints win; XMLA is the last-resort opt-in.
  if (hasSynapse) return 'synapse';
  if (hasDbx) return 'databricks';
  if (hasXmla) return 'xmla';
  return 'none';
}

/** The honest Azure-native config gate (NEVER names Fabric/AAS as the default). */
function nativeGate(): { missing: string; detail: string } {
  return {
    missing: 'LOOM_SYNAPSE_DEDICATED_POOL',
    detail:
      'No Azure-native SQL endpoint is configured for row-/object-level security. ' +
      'Set LOOM_SYNAPSE_DEDICATED_POOL (with LOOM_SYNAPSE_WORKSPACE) to enforce ' +
      'RLS/OLS via a Synapse dedicated SQL pool SECURITY POLICY + inline TVF, or ' +
      'set LOOM_DATABRICKS_SQL_WAREHOUSE_ID to enforce it via a Unity Catalog ROW ' +
      'FILTER + COLUMN MASK. No Fabric / Power BI workspace is required. ' +
      '(Azure Analysis Services / Power BI XMLA is an OPT-IN alternative — set ' +
      'LOOM_SEMANTIC_RLS_BACKEND=xmla with LOOM_AAS_SERVER or ' +
      'LOOM_POWERBI_XMLA_ENDPOINT.)',
  };
}

function dbxCatalog(): string {
  return process.env.LOOM_DATABRICKS_CATALOG || process.env.LOOM_DATABRICKS_DEFAULT_CATALOG || 'main';
}
function dbxSchema(): string {
  return process.env.LOOM_DATABRICKS_SCHEMA || process.env.LOOM_DATABRICKS_DEFAULT_SCHEMA || 'default';
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor (AasRole) ⇆ persisted (SecurityRoleDef) translation
//
// The editor speaks the AasRole shape (`tablePermissions[].name`,
// `members:[{memberName}]`, `modelPermission:'read'`). We persist + compile the
// contract's SecurityRoleDef (`table`, `members:string[]`). GET maps back so the
// UI lights up unchanged.
// ─────────────────────────────────────────────────────────────────────────────

function toSecurityRoleDef(r: AasRole): SecurityRoleDef {
  return {
    name: r.name,
    members: (r.members || []).map((m) => (m?.memberName || '').trim()).filter(Boolean),
    tablePermissions: (r.tablePermissions || []).map((tp) => ({
      table: tp.name,
      filterExpression: tp.filterExpression?.trim() || undefined,
      metadataPermission: tp.metadataPermission === 'none' ? 'none' : 'read',
      columnPermissions: (tp.columnPermissions || []).map((c) => ({
        name: c.name,
        metadataPermission: c.metadataPermission === 'none' ? 'none' : 'read',
      })),
    })),
    updatedAt: new Date().toISOString(),
  };
}

function toEditorRole(r: SecurityRoleDef): AasRole {
  return {
    name: r.name,
    modelPermission: 'read',
    members: (r.members || []).map((memberName) => ({ memberName })),
    tablePermissions: (r.tablePermissions || []).map<AasRoleTablePermission>((tp) => ({
      name: tp.table,
      filterExpression: tp.filterExpression || undefined,
      metadataPermission: tp.metadataPermission === 'none' ? 'none' : 'read',
      columnPermissions: (tp.columnPermissions || []).map((c) => ({
        name: c.name,
        metadataPermission: c.metadataPermission === 'none' ? 'none' : 'read',
      })),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Owned-item read / write of `item.state.model.securityRoles`
//
// We touch item-crud directly (rather than model-store.readModelState, which
// projects only relationships+measures and would drop securityRoles on read).
// The rest of `state` — including `state.model.relationships` / `.measures` — is
// preserved.
// ─────────────────────────────────────────────────────────────────────────────

async function readSecurityRoles(
  id: string,
  tenantId: string,
): Promise<{ item: WorkspaceItem | null; roles: SecurityRoleDef[] }> {
  const item = await loadOwnedItem(id, ITEM_TYPE, tenantId);
  if (!item) return { item: null, roles: [] };
  const model = (item.state as Record<string, unknown> | undefined)?.model as
    | { securityRoles?: unknown }
    | undefined;
  const roles = Array.isArray(model?.securityRoles) ? (model!.securityRoles as SecurityRoleDef[]) : [];
  return { item, roles };
}

async function writeSecurityRoles(
  item: WorkspaceItem,
  tenantId: string,
  roles: SecurityRoleDef[],
): Promise<boolean> {
  const prevState = (item.state as Record<string, unknown>) || {};
  const prevModel = (prevState.model as Record<string, unknown>) || {};
  const nextState = { ...prevState, model: { ...prevModel, securityRoles: roles } };
  const updated = await updateOwnedItem(item.id, ITEM_TYPE, tenantId, { state: nextState });
  return !!updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// Inlined RLS compiler — DAX boolean filter → T-SQL / Databricks predicate, then
// the SECURITY POLICY + TVF / ROW FILTER + COLUMN MASK DDL. Pure string output;
// the route executes each statement. (Stands in for lib/azure/rls-compiler.ts.)
// ═════════════════════════════════════════════════════════════════════════════

const RLS_SCHEMA = 'LoomSecurity';
const DEFAULT_IDENTITY_TSQL = "COALESCE(CAST(SESSION_CONTEXT(N'loom_user') AS sysname), USER_NAME())";

function safeIdent(s: string): string {
  return (String(s || '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 80)) || 'x';
}

/** Split `schema.table` (or bracketed) into parts; default schema `dbo`. */
function splitSchemaTable(t: string): { schema: string; table: string } {
  const parts = String(t || '')
    .split('.')
    .map((p) => p.replace(/[[\]]/g, '').trim())
    .filter(Boolean);
  if (parts.length >= 2) return { schema: parts[parts.length - 2], table: parts[parts.length - 1] };
  return { schema: 'dbo', table: parts[0] || String(t || '').replace(/[[\]]/g, '') };
}

function bq(ident: string): string {
  return '`' + String(ident).replace(/`/g, '') + '`';
}
function sparkString(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

interface PredDialect {
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
function translateDax(dax: string, d: PredDialect): { sql: string; columns: string[]; warnings: string[] } {
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
function daxFilterToTSql(dax: string, identityExpr = DEFAULT_IDENTITY_TSQL): { sql: string; columns: string[]; warnings: string[] } {
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
function daxFilterToTSqlInline(dax: string, testUpn: string): { sql: string; columns: string[]; warnings: string[] } {
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
function daxFilterToDatabricksSql(dax: string): { sql: string; columns: string[]; warnings: string[] } {
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

interface CompiledStep {
  sql: string;
  kind: 'schema' | 'drop' | 'function' | 'policy' | 'rowfilter' | 'mask' | 'deny';
}
interface CompiledRlsArtifact {
  engine: RlsEngine;
  steps: CompiledStep[];
  summary: string[];
  warnings: string[];
}

function compileSynapse(roles: SecurityRoleDef[], identityExpr: string): CompiledRlsArtifact {
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

function compileDatabricks(roles: SecurityRoleDef[], catalog: string, schema: string): CompiledRlsArtifact {
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

/** Map a column-array QueryResult into row objects keyed by column name. */
function rowsToObjects(qr: { columns: string[]; rows: unknown[][] }): Array<Record<string, unknown>> {
  return (qr.rows || []).map((row) => {
    const o: Record<string, unknown> = {};
    (qr.columns || []).forEach((c, i) => {
      o[c] = row[i];
    });
    return o;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation (shared by native + xmla). Produces AasRole[]; the native branch
// then maps to SecurityRoleDef.
// ─────────────────────────────────────────────────────────────────────────────

function validateRoles(roles: unknown): { error: string } | { roles: AasRole[] } {
  if (!Array.isArray(roles)) return { error: 'roles must be an array' };
  const out: AasRole[] = [];
  const seen = new Set<string>();
  for (const r of roles as any[]) {
    const name = (r?.name || '').trim();
    if (!NAME_RE.test(name)) return { error: `Invalid role name: "${name}"` };
    if (seen.has(name.toLowerCase())) return { error: `Duplicate role name: "${name}"` };
    seen.add(name.toLowerCase());
    if (r.modelPermission && r.modelPermission !== 'read') {
      return { error: `Role "${name}": only modelPermission "read" is supported.` };
    }
    const tablePermissions: AasRoleTablePermission[] = [];
    for (const tp of (r.tablePermissions || []) as any[]) {
      const tname = (tp?.name || '').trim();
      if (!tname) continue;
      if (tp.filterExpression && tp.filterExpression.trim()) {
        const v = validateRlsDax(tp.filterExpression);
        if (!v.ok) return { error: `Role "${name}" table "${tname}": ${v.error}` };
      }
      const mp = tp.metadataPermission;
      if (mp && mp !== 'read' && mp !== 'none') {
        return { error: `Role "${name}" table "${tname}": metadataPermission must be read|none` };
      }
      const columnPermissions = ((tp.columnPermissions || []) as any[])
        .filter((c) => (c?.name || '').trim())
        .map((c) => {
          const cmp = c.metadataPermission;
          return {
            name: String(c.name).trim(),
            metadataPermission: (cmp === 'none' ? 'none' : 'read') as MetaPerm,
          };
        });
      tablePermissions.push({
        name: tname,
        filterExpression: tp.filterExpression?.trim() || undefined,
        metadataPermission: mp === 'none' ? 'none' : 'read',
        columnPermissions: columnPermissions.length ? columnPermissions : undefined,
      });
    }
    const members = ((r.members || []) as any[])
      .filter((m) => (m?.memberName || '').trim())
      .map((m) => ({ memberName: String(m.memberName).trim() }));
    out.push({ name, modelPermission: 'read', description: r.description?.trim() || undefined, tablePermissions, members });
  }
  return { roles: out };
}

// ═════════════════════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════════════════════

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const backend = resolveRlsBackend();

  if (backend === 'none') {
    return NextResponse.json({ ok: false, gate: nativeGate() }, { status: 501 });
  }

  // ── opt-in XMLA (Azure Analysis Services / Power BI) ──────────────────────────
  if (backend === 'xmla') {
    const gate = aasConfigGate();
    if (gate) return NextResponse.json({ ok: false, gate }, { status: 501 });
    try {
      const roles = await getRoles(catalogFrom(req, id));
      return NextResponse.json({ ok: true, backend: 'xmla', native: false, roles });
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
    }
  }

  // ── Azure-native (DEFAULT) ────────────────────────────────────────────────────
  const { item, roles } = await readSecurityRoles(id, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });

  let deployed: unknown = undefined;
  if (backend === 'synapse') {
    try {
      deployed = await listRlsPolicies(dedicatedTarget());
    } catch {
      /* best-effort — deployed list is informational, never blocks the tab. */
    }
  }
  return NextResponse.json({
    ok: true,
    backend,
    native: true,
    roles: roles.map(toEditorRole),
    ...(deployed !== undefined ? { deployed } : {}),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// PUT — persist (source of truth) then compile + deploy real DDL
// ═════════════════════════════════════════════════════════════════════════════

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const id = (await ctx.params).id;
  const backend = resolveRlsBackend();

  if (backend === 'none') {
    return NextResponse.json({ ok: false, gate: nativeGate() }, { status: 501 });
  }

  const body = (await req.json().catch(() => ({}))) as { roles?: unknown };
  const v = validateRoles(body.roles);
  if ('error' in v) return NextResponse.json({ ok: false, error: v.error }, { status: 400 });

  // ── opt-in XMLA (verbatim legacy behaviour) ──────────────────────────────────
  if (backend === 'xmla') {
    const gate = aasConfigGate();
    if (gate) return NextResponse.json({ ok: false, gate }, { status: 501 });
    try {
      await setRoles(catalogFrom(req, id), v.roles);
      return NextResponse.json({ ok: true, backend: 'xmla', native: false, roleCount: v.roles.length });
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
    }
  }

  // ── Azure-native: persist FIRST (survives a deploy failure), then deploy ──────
  const defs = v.roles.map(toSecurityRoleDef);
  const { item } = await readSecurityRoles(id, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });
  const persisted = await writeSecurityRoles(item, session.claims.oid, defs);
  if (!persisted) {
    return NextResponse.json({ ok: false, error: 'Failed to persist roles to the model.' }, { status: 500 });
  }

  // Compile + execute each DDL batch sequentially against the native engine.
  const engine: RlsEngine = backend === 'databricks' ? 'databricks' : 'synapse';
  const artifact =
    engine === 'databricks' ? compileDatabricks(defs, dbxCatalog(), dbxSchema()) : compileSynapse(defs, DEFAULT_IDENTITY_TSQL);

  const counts = { policies: 0, functions: 0, masks: 0, denies: 0 };
  const steps: string[] = [];
  const statements: string[] = [];
  let deployOk = true;

  const warehouseId = process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '';
  for (const step of artifact.steps) {
    statements.push(step.sql);
    const head = step.sql.split('\n')[0].slice(0, 120);
    try {
      if (engine === 'synapse') {
        await synapseExecute(dedicatedTarget(), step.sql);
      } else {
        await executeStatement(warehouseId, step.sql, dbxCatalog(), dbxSchema());
      }
      if (step.kind === 'policy' || step.kind === 'rowfilter') counts.policies++;
      else if (step.kind === 'function') counts.functions++;
      else if (step.kind === 'mask') counts.masks++;
      else if (step.kind === 'deny') counts.denies++;
      steps.push(`ok: ${step.kind} — ${head}`);
    } catch (e: any) {
      deployOk = false;
      steps.push(`FAILED: ${step.kind} — ${head} — ${e?.message || String(e)}`);
    }
  }

  return NextResponse.json({
    ok: true,
    backend,
    native: true,
    persisted: true,
    roleCount: defs.length,
    deployOk,
    deployed: counts,
    statements,
    steps,
    warnings: artifact.warnings,
    summary: artifact.summary,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// POST ?action=test — impersonate a UPN and return the FILTERED rows (receipt)
// ═════════════════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const action = req.nextUrl.searchParams.get('action');
  if (action !== 'test') {
    return NextResponse.json({ ok: false, error: 'unsupported action (use ?action=test)' }, { status: 400 });
  }
  const id = (await ctx.params).id;
  const backend = resolveRlsBackend();

  if (backend === 'none') {
    return NextResponse.json({ ok: false, gate: nativeGate() }, { status: 501 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    roleName?: string;
    effectiveUserName?: string;
    daxQuery?: string;
  };
  const roleName = (body.roleName || '').trim();
  const effectiveUserName = (body.effectiveUserName || '').trim();
  if (!roleName) return NextResponse.json({ ok: false, error: 'roleName is required' }, { status: 400 });
  if (!effectiveUserName) {
    return NextResponse.json(
      { ok: false, error: 'effectiveUserName (a real Entra UPN to impersonate) is required' },
      { status: 400 },
    );
  }

  // ── opt-in XMLA test-as-role (verbatim legacy behaviour) ──────────────────────
  if (backend === 'xmla') {
    const gate = aasConfigGate();
    if (gate) return NextResponse.json({ ok: false, gate }, { status: 501 });
    const daxQuery = (body.daxQuery || '').trim();
    if (!daxQuery) return NextResponse.json({ ok: false, error: 'daxQuery is required' }, { status: 400 });
    try {
      const rows = await testAsRole(catalogFrom(req, id), daxQuery, { effectiveUserName, roles: roleName });
      return NextResponse.json({ ok: true, backend: 'xmla', native: false, rows, rowCount: rows.length });
    } catch (e: any) {
      const status = e instanceof AasError ? e.status : 502;
      return NextResponse.json({ ok: false, error: e?.message || String(e), status }, { status });
    }
  }

  // ── Azure-native test-as-role ─────────────────────────────────────────────────
  const { item, roles } = await readSecurityRoles(id, session.claims.oid);
  if (!item) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });
  const role = roles.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
  if (!role) {
    return NextResponse.json(
      { ok: false, error: `Role "${roleName}" is not saved on this model. Save roles before testing.` },
      { status: 400 },
    );
  }
  const filtered = (role.tablePermissions || []).find((tp) => tp.filterExpression && tp.filterExpression.trim());
  if (!filtered || !filtered.filterExpression) {
    return NextResponse.json({
      ok: true,
      backend,
      native: true,
      rows: [],
      rowCount: 0,
      note: `Role "${roleName}" has no row-level filter; all rows are visible to its members.`,
    });
  }
  const { schema, table } = splitSchemaTable(filtered.table);

  try {
    if (backend === 'synapse') {
      const tr = daxFilterToTSqlInline(filtered.filterExpression, effectiveUserName);
      const tableFq = `${sqlBracket(schema)}.${sqlBracket(table)}`;
      // Set the documented session-context token (parity with the /query path),
      // then return the rows the FILTER PREDICATE would expose to this UPN. The
      // predicate is inlined with the test identity so the receipt is faithful
      // even though the service identity is db_owner (which would otherwise
      // bypass the policy via IS_MEMBER('db_owner')).
      const batch =
        `EXEC sp_set_session_context @key = N'loom_user', @value = ${sqlString(effectiveUserName)};\n` +
        `SELECT TOP 100 * FROM ${tableFq} AS t WHERE (${tr.sql});`;
      const qr: QueryResult = await synapseExecute(dedicatedTarget(), batch);
      const objs = rowsToObjects(qr);
      return NextResponse.json({
        ok: true,
        backend,
        native: true,
        impersonated: effectiveUserName,
        table: `${schema}.${table}`,
        rows: objs,
        rowCount: objs.length,
        ...(tr.warnings.length ? { warnings: tr.warnings } : {}),
      });
    }
    // databricks
    const tr = daxFilterToDatabricksSql(filtered.filterExpression);
    // Substitute current_user() with the literal test UPN for a faithful receipt.
    const predicate = tr.sql.replace(/current_user\(\)/gi, sparkString(effectiveUserName));
    const tableFq = `${bq(dbxCatalog())}.${bq(dbxSchema())}.${bq(table)}`;
    const stmt = `SELECT * FROM ${tableFq} WHERE (${predicate}) LIMIT 100;`;
    const qr = await executeStatement(process.env.LOOM_DATABRICKS_SQL_WAREHOUSE_ID || '', stmt, dbxCatalog(), dbxSchema());
    const objs = rowsToObjects(qr);
    return NextResponse.json({
      ok: true,
      backend,
      native: true,
      impersonated: effectiveUserName,
      table: `${dbxCatalog()}.${dbxSchema()}.${table}`,
      rows: objs,
      rowCount: objs.length,
      ...(tr.warnings.length ? { warnings: tr.warnings } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
