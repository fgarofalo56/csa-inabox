/**
 * Workshop (PMF-44 / Atelier-T51) — run a data action (real CRUD).
 *
 * POST /api/items/workshop-app/[id]/run-action
 *   body: {
 *     entityType: string,
 *     op?: 'list' | 'get' | 'create' | 'update' | 'delete',  (default 'list')
 *     top?: number,                       // list
 *     key?: string,                       // get/update/delete — PK value
 *     keyColumn?: string,                 // PK column (or from the binding)
 *     values?: Record<string, string|null>, // create/update — column → value
 *   }
 *   → list/get: { ok, op, entityType, columns:[], rows:[][], rowCount }
 *   → create/update/delete: { ok, op, entityType, recordsAffected }
 *   → honest gate otherwise
 *
 * A Workshop (Atelier) app's operational actions read AND write the data behind
 * the bound ontology entity types — real CRUD over the Azure-native backing
 * store. This route resolves the app's bound ontology, finds the ontology's
 * entity binding for `entityType` (a warehouse source persisted on the
 * ontology's state.entityBindings), and runs REAL T-SQL against Synapse
 * dedicated SQL pool (synapse-sql-client) — the Azure-native equivalent of
 * Fabric Apps' "SQL database in Fabric". All values are bound via TDS named
 * parameters (SynapseQueryParam) — never concatenated. All identifiers
 * (table/column/key) are validated via safeSqlIdent and bracket-quoted.
 *
 * Per no-fabric-dependency.md the default is Azure-native (Synapse), no Fabric.
 * Honest infra-gate (503) when Synapse env is unset; honest 409 when no
 * warehouse source is bound to the type; honest 400 on bad/missing key/columns.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import { dedicatedTarget, executeQuery, type SynapseQueryParam } from '@/lib/azure/synapse-sql-client';
import {
  safeSqlIdent, buildInsertSql, buildUpdateSql, buildDeleteSql,
  type OntologyEntityBinding, type AtelierColumnValue,
} from '@/lib/editors/_family-utils';
import { recordThreadEdge } from '@/lib/thread/thread-edges';
import type { WorkspaceItem } from '@/lib/types/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'workshop-app';
const WRITE_OPS = new Set(['create', 'update', 'delete']);
const ALL_OPS = new Set(['list', 'get', 'create', 'update', 'delete']);

function err(error: string, status: number, code?: string, gate?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}), ...(gate ? { gate } : {}) }, { status });
}

interface RunBody {
  entityType?: string;
  op?: string;
  top?: number;
  key?: string;
  keyColumn?: string;
  values?: Record<string, unknown>;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401, 'unauthenticated');
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the workshop app first', 400, 'no_id');
  const body = (await req.json().catch(() => ({}))) as RunBody;
  const entityType = String(body?.entityType || '').trim();
  const op = String(body?.op || 'list').trim();
  const top = Math.min(Math.max(Number(body?.top) || 50, 1), 1000);
  if (!entityType) return err('entityType is required', 400, 'bad_request');
  if (!ALL_OPS.has(op)) return err(`unsupported op "${op}"`, 400, 'bad_op');

  const app = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!app) return err('workshop app not found', 404, 'not_found');
  const boundOntologyId = String(((app.state || {}) as Record<string, unknown>).boundOntologyId || '');
  if (!boundOntologyId) return err('Bind an ontology to this Workshop app first.', 409, 'no_ontology');

  const onto: WorkspaceItem | null = await loadOwnedItem(boundOntologyId, 'ontology', s.claims.oid);
  if (!onto) return err('bound ontology not found', 404, 'ontology_not_found');
  const bindings = (((onto.state || {}) as Record<string, unknown>).entityBindings as OntologyEntityBinding[]) || [];
  const binding = bindings.find((b) => (b.entityTypes || []).includes(entityType) && b.sourceKind === 'warehouse');
  if (!binding) {
    return err(
      `No warehouse data source is bound to entity type "${entityType}" on the ontology.`,
      409, 'no_binding',
      { reason: 'A Workshop action reads/writes the warehouse table behind the ontology entity type.', remediation: `Open the bound ontology and use "Bind to data source" to map a Warehouse table to ${entityType}.` },
    );
  }

  const table = safeSqlIdent(entityType);
  if (!table) return err('entity type is not a safe SQL identifier', 400, 'bad_ident');

  // Resolve the key column for keyed ops (get/update/delete): explicit body
  // override, else the binding's declared per-entity key column.
  const declaredKey = binding.keyColumns?.[entityType];
  const keyColumnRaw = String(body?.keyColumn || declaredKey || '').trim();
  const keyValueRaw = body?.key === undefined || body?.key === null ? null : String(body.key);

  // Allowed writable columns from the binding (when declared) — constrains
  // create/update to the ontology-declared shape (no freeform columns).
  const allowed = binding.writableColumns?.[entityType];
  const allowedSet = Array.isArray(allowed) && allowed.length ? new Set(allowed) : null;

  let target;
  try {
    target = dedicatedTarget();
  } catch (e: unknown) {
    return err(
      'Azure Synapse dedicated SQL pool not configured.',
      503, 'synapse_not_configured',
      { reason: 'The Azure-native Workshop backend reads/writes entity rows in the bound Synapse warehouse.', remediation: 'Set LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL on the Console. No Microsoft Fabric required.', detail: e instanceof Error ? e.message : String(e) },
    );
  }

  // ── READ ops ────────────────────────────────────────────────────────────
  if (op === 'list') {
    try {
      const result = await executeQuery(target, `SELECT TOP (${top}) * FROM [${table}]`, 60_000);
      return NextResponse.json({ ok: true, op, entityType, columns: result.columns, rows: result.rows, rowCount: result.rows.length });
    } catch (e: unknown) {
      return err(`Query failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'query_failed');
    }
  }

  if (op === 'get') {
    const keyColumn = safeSqlIdent(keyColumnRaw);
    if (!keyColumn) return err('a valid keyColumn is required for get (set keyColumns on the ontology binding or pass keyColumn)', 400, 'no_key_column');
    if (keyValueRaw === null) return err('key is required for get', 400, 'no_key');
    try {
      const params: SynapseQueryParam[] = [{ name: 'k', value: keyValueRaw }];
      const result = await executeQuery(target, `SELECT TOP (1) * FROM [${table}] WHERE [${keyColumn}] = @k`, 60_000, params);
      return NextResponse.json({ ok: true, op, entityType, columns: result.columns, rows: result.rows, rowCount: result.rows.length });
    } catch (e: unknown) {
      return err(`Query failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'query_failed');
    }
  }

  // ── WRITE ops (the core of "real CRUD") ───────────────────────────────────
  if (WRITE_OPS.has(op)) {
    // Validate + collect column/value pairs for create/update.
    const cols: AtelierColumnValue[] = [];
    if (op === 'create' || op === 'update') {
      const values = (body?.values && typeof body.values === 'object') ? body.values : {};
      const names = Object.keys(values);
      if (names.length === 0) return err(`${op} requires at least one column value`, 400, 'no_values');
      for (const name of names) {
        const col = safeSqlIdent(name);
        if (!col) return err(`column "${name}" is not a safe SQL identifier`, 400, 'bad_column');
        if (allowedSet && !allowedSet.has(name)) {
          return err(`column "${name}" is not a declared writable column for ${entityType}`, 400, 'column_not_allowed',
            { reason: 'Atelier writes are constrained to the ontology-declared writable columns.', remediation: `Add "${name}" to writableColumns for ${entityType} on the ontology binding, or omit it.` });
        }
        const raw = (values as Record<string, unknown>)[name];
        cols.push({ column: col, value: raw === null || raw === undefined ? null : String(raw) });
      }
    }

    let built: { sql: string; params: Array<{ name: string; value: string | null }> };
    try {
      if (op === 'create') {
        built = buildInsertSql(table, cols);
      } else {
        const keyColumn = safeSqlIdent(keyColumnRaw);
        if (!keyColumn) return err(`a valid keyColumn is required for ${op} (set keyColumns on the ontology binding or pass keyColumn)`, 400, 'no_key_column');
        if (keyValueRaw === null) return err(`key is required for ${op}`, 400, 'no_key');
        built = op === 'update'
          ? buildUpdateSql(table, cols, keyColumn, keyValueRaw)
          : buildDeleteSql(table, keyColumn, keyValueRaw);
      }
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : String(e), 400, 'bad_request');
    }

    try {
      const result = await executeQuery(target, built.sql, 60_000, built.params);
      // Record lineage: the Workshop app wrote back through the bound ontology.
      try {
        await recordThreadEdge(s, {
          fromItemId: id, fromType: ITEM_TYPE, fromName: app.displayName,
          toItemId: boundOntologyId, toType: 'ontology', toName: onto.displayName,
          action: `atelier-${op}`,
        });
      } catch { /* lineage is best-effort; never fail the write on edge-record error */ }
      return NextResponse.json({ ok: true, op, entityType, recordsAffected: result.recordsAffected });
    } catch (e: unknown) {
      return err(`Write failed: ${e instanceof Error ? e.message : String(e)}`, 502, 'write_failed');
    }
  }

  return err(`unsupported op "${op}"`, 400, 'bad_op');
}
