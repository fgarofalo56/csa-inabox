/**
 * OneLake Security — "Preview as <principal>" (test-as-user) for a data-access
 * role's Row-Level-Security (RLS) predicate + Column-Level-Security (CLS)
 * allow-list.
 *
 *   POST /api/items/[type]/[id]/security-roles/preview-as
 *        body { roleName:string, table?:string, principal:string, sampleRows?:number }
 *        → { ok, engine, table, principal, predicate?, projectedColumns,
 *            restrictedColumns?, columns, rows, rowCount, executionMs, truncated }
 *
 * Fabric's "Manage OneLake security" lets an admin preview the rows a member of
 * a role would see, with RLS filtering + CLS masking applied. The Azure-native
 * 1:1 (no-fabric-dependency.md) evaluates the role's persisted RLS/CLS rules
 * against LIVE rows of the SOURCE engine the item resolves to:
 *
 *   - SYNAPSE (lakehouse / mirrored-*): a read-only `SELECT TOP <n> <allowed
 *     columns> FROM <table> WHERE (<RLS predicate>)`. The predicate's identity
 *     functions (USER_NAME()/SUSER_SNAME()) are substituted with the selected
 *     principal's UPN (injection-safe N''-literal) so the preview shows exactly
 *     the rows THAT principal would see — the same substitution the F8
 *     rls-test path uses. CLS projects ONLY the role's allowed columns
 *     (restricted columns are masked out of the result). Executed via the
 *     Console service identity through `synapse-sql-client.executeQuery`; the
 *     owner-bypass is intentionally NOT appended so the role's own filtering is
 *     visible.
 *
 *   - ADX (defensive; the security-roles item types are all Synapse-backed):
 *     the role's restricted `<table> | where (<pred>) | project <cols> | take
 *     <n>` query via `kusto-client.executeQuery`.
 *
 * NO Fabric dependency. Honest 503 gate (no-vaporware.md) when the backing store
 * isn't configured (LOOM_SYNAPSE_WORKSPACE/LOOM_SYNAPSE_DEDICATED_POOL, or
 * LOOM_KUSTO_CLUSTER_URI). Session-gated + PDP-read-checked exactly like the
 * sibling security-roles route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { pdpCheck } from '@/lib/auth/pdp/enforce';
import {
  getRole,
  roleDocId,
  isValidRlsPredicate,
  isValidColumnList,
  type OneLakeSecurityItemType,
  type OneLakeSecurityRole,
  type RowLevelRule,
  type ColumnLevelRule,
} from '@/lib/azure/onelake-security-client';
import { resolveReconcileEngine, buildAdxRestrictQuery } from '@/lib/azure/onelake-rls-reconciler';
import { splitSchemaTable, sqlBracket, sqlString } from '@/lib/azure/rls-compiler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPES: OneLakeSecurityItemType[] = ['lakehouse', 'mirrored-database', 'mirrored-catalog'];

function parseItemType(v: string): OneLakeSecurityItemType | null {
  return (ITEM_TYPES as string[]).includes(v) ? (v as OneLakeSecurityItemType) : null;
}

/** Clamp the sample-row count to a sane preview window. */
function clampRows(n: unknown): number {
  return Math.min(Math.max(Number(n) || 50, 1), 500);
}

/** Find the RLS + CLS rules for a table on a role (case-insensitive on table). */
function rulesForTable(
  role: OneLakeSecurityRole,
  table: string,
): { rls?: RowLevelRule; cls?: ColumnLevelRule } {
  const t = table.toLowerCase();
  return {
    rls: (role.rls || []).find((r) => r.table.toLowerCase() === t),
    cls: (role.cls || []).find((c) => c.table.toLowerCase() === t),
  };
}

/** The union of tables that carry an RLS or CLS rule on the role. */
function ruledTables(role: OneLakeSecurityRole): string[] {
  const set = new Set<string>();
  for (const r of role.rls || []) set.add(r.table);
  for (const c of role.cls || []) set.add(c.table);
  return Array.from(set);
}

function synapseGate(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      gate: true,
      missing: 'LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL',
      hint: 'Preview-as evaluates the role\'s RLS/CLS against the Azure-native Synapse Dedicated SQL pool. Set LOOM_SYNAPSE_WORKSPACE and LOOM_SYNAPSE_DEDICATED_POOL on loom-console (already wired in admin-plane/main.bicep) and grant the Console UAMI db_owner on the pool database.',
    },
    { status: 503 },
  );
}

function adxGate(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      gate: true,
      missing: 'LOOM_KUSTO_CLUSTER_URI',
      hint: 'Preview-as evaluates the role\'s RLS/CLS against the Azure Data Explorer cluster. Set LOOM_KUSTO_CLUSTER_URI on loom-console and grant the Console UAMI AllDatabasesViewer on the cluster.',
    },
    { status: 503 },
  );
}

/**
 * Preview as principal on the Synapse Dedicated SQL pool: SELECT the allowed
 * columns filtered by the RLS predicate with the principal substituted for the
 * identity functions.
 */
async function previewSynapse(
  table: string,
  principal: string,
  rls: RowLevelRule | undefined,
  cls: ColumnLevelRule | undefined,
  top: number,
): Promise<NextResponse> {
  const { dedicatedTarget, executeQuery } = await import('@/lib/azure/synapse-sql-client');
  let target;
  try {
    target = dedicatedTarget();
  } catch {
    return synapseGate();
  }

  const { schema, table: tbl } = splitSchemaTable(table);
  const tableFq = `${sqlBracket(schema)}.${sqlBracket(tbl)}`;

  // Column projection — CLS masks by projecting ONLY the allowed columns.
  let projection = '*';
  let projectedColumns: string[] | '*' = '*';
  if (cls && Array.isArray(cls.allowedColumns) && cls.allowedColumns.length) {
    const v = isValidColumnList(cls.allowedColumns);
    if (!v.ok) return NextResponse.json({ ok: false, error: `CLS allow-list invalid: ${v.error}` }, { status: 400 });
    const cols = cls.allowedColumns.map((c) => sqlBracket(c.replace(/^\[|\]$/g, '').trim()));
    projection = cols.join(', ');
    projectedColumns = cls.allowedColumns.map((c) => c.replace(/^\[|\]$/g, '').trim());
  }

  // WHERE clause — RLS predicate with the identity functions bound to the
  // selected principal (injection-safe N'' literal). The predicate already
  // passed isValidRlsPredicate on save; re-validate defensively.
  let whereClause = '';
  let effectivePredicate: string | undefined;
  if (rls && rls.predicate && rls.predicate.trim()) {
    const v = isValidRlsPredicate(rls.predicate);
    if (!v.ok) return NextResponse.json({ ok: false, error: `RLS predicate invalid: ${v.error}` }, { status: 400 });
    const lit = sqlString(principal);
    const substituted = rls.predicate
      .replace(/USER_NAME\s*\(\s*\)/gi, lit)
      .replace(/SUSER_SNAME\s*\(\s*\)/gi, lit)
      .replace(/SUSER_NAME\s*\(\s*\)/gi, lit)
      .replace(/CURRENT_USER\b/gi, lit);
    whereClause = ` WHERE (${substituted})`;
    effectivePredicate = substituted;
  }

  const sqlText = `SELECT TOP ${top} ${projection} FROM ${tableFq} AS t${whereClause};`;

  try {
    const result = await executeQuery(target, sqlText);
    return NextResponse.json({
      ok: true,
      engine: 'synapse',
      table,
      principal,
      predicate: effectivePredicate,
      projectedColumns,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
      note:
        !rls && !cls
          ? 'This role has no RLS/CLS rule for the selected table — showing unfiltered rows.'
          : cls
            ? 'Columns restricted to the role\'s CLS allow-list; rows filtered by the role\'s RLS predicate for this principal.'
            : 'Rows filtered by the role\'s RLS predicate for this principal.',
    });
  } catch (e: any) {
    if (/Missing env var/i.test(String(e?.message))) return synapseGate();
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

/**
 * Preview on Azure Data Explorer: run the role's restricted query (row `where`
 * + column `project`) plus a `take` cap. Defensive — the security-roles item
 * types are Synapse-backed, so this path is rarely reached.
 */
async function previewAdx(
  item: { id: string; itemType: string; state?: Record<string, any> | null },
  table: string,
  principal: string,
  rls: RowLevelRule | undefined,
  cls: ColumnLevelRule | undefined,
  top: number,
): Promise<NextResponse> {
  if (!process.env.LOOM_KUSTO_CLUSTER_URI) return adxGate();
  const { executeQuery, validateKustoRlsQuery, defaultDatabase } = await import('@/lib/azure/kusto-client');
  const db = (item?.state?.databaseName as string)?.trim() || defaultDatabase();

  const restrict = buildAdxRestrictQuery(table, rls?.predicate, cls?.allowedColumns);
  const v = validateKustoRlsQuery(restrict);
  if (!v.ok) return NextResponse.json({ ok: false, error: `RLS/CLS query invalid: ${v.error}` }, { status: 400 });
  const query = `${restrict} | take ${top}`;

  try {
    const result = await executeQuery(db, query);
    return NextResponse.json({
      ok: true,
      engine: 'adx',
      table,
      principal,
      predicate: rls?.predicate,
      projectedColumns: cls?.allowedColumns
        ? cls.allowedColumns.map((c) => c.replace(/^\[|\]$/g, '').trim())
        : '*',
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      truncated: result.truncated,
      note:
        'ADX row_level_security is table-wide; the preview reflects the role\'s restricted query. Principal-specific identity substitution is limited to literal comparisons.',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}

export async function POST(req: NextRequest, props: { params: Promise<{ type: string; id: string }> }) {
  const params = await props.params;
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const itemType = parseItemType(params.type);
  if (!itemType) return NextResponse.json({ ok: false, error: `unsupported item type: ${params.type}` }, { status: 400 });

  // PDP gate (default-off / shadow-ready). Previewing role data is a read.
  const blocked = await pdpCheck(session, { level: 'item', id: params.id, itemType: params.type }, 'read');
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const roleName = String(body?.roleName || '').trim();
  const principal = String(body?.principal || '').trim();
  const top = clampRows(body?.sampleRows);
  if (!roleName) return NextResponse.json({ ok: false, error: 'roleName is required' }, { status: 400 });
  if (!principal) return NextResponse.json({ ok: false, error: 'principal (UPN or object id) is required' }, { status: 400 });

  try {
    const role = await getRole(params.id, roleDocId(params.id, roleName));
    if (!role) return NextResponse.json({ ok: false, error: 'role not found' }, { status: 404 });

    // Default to the first table that carries an RLS/CLS rule when none is given.
    const tables = ruledTables(role);
    const table = String(body?.table || '').trim() || tables[0] || '';
    if (!table) {
      return NextResponse.json(
        { ok: false, error: 'This role has no row- or column-level rules to preview. Add a Row/Column security rule first.' },
        { status: 400 },
      );
    }
    const { rls, cls } = rulesForTable(role, table);

    const engine = resolveReconcileEngine({ id: role.itemId, itemType: params.type }, role);
    if (engine === 'adx') {
      return previewAdx({ id: role.itemId, itemType: params.type }, table, principal, rls, cls, top);
    }
    return previewSynapse(table, principal, rls, cls, top);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: e?.status || 502 });
  }
}
