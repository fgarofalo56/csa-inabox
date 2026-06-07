/**
 * GET /api/items/kql-database/[id]/schema-graph
 *
 * Returns nodes + edges for the KQL Database entity-diagram canvas (the
 * "Diagram" tab of the KQL Database editor). This is the Loom-native, Azure
 * Data Explorer (ADX) parity of the Fabric Real-Time Intelligence "database
 * schema" graph — built on the live cluster, no Fabric/OneLake dependency.
 *
 * Real backend, no mocks. Issues three live Kusto management commands against
 * the resolved ADX database via the existing kusto-client:
 *   • getDatabaseSchemaJson(db)  → `.show database ["db"] schema as json`
 *       (tables + their ordered columns, functions + bodies, external tables)
 *   • listMaterializedViews(db)  → `.show materialized-views`
 *       (reliable Name + SourceTable for MV→table dependency edges)
 *   • listFunctions(db)          → `.show functions`
 *       (parameter signatures, used to enrich the schema-json function rows)
 *
 * Dependency edges are derived from REAL entity metadata only:
 *   • materialized-view → source table   (from .show materialized-views)
 *   • function          → referenced entity (static scan of the function's
 *     real Body for references to known table/MV/function/external-table names)
 *   • external-table (shortcut) → none (leaf source nodes)
 *
 * Grounded in Microsoft Learn:
 *   .show database schema as json —
 *     https://learn.microsoft.com/kusto/management/show-schema-database
 *   .show materialized-views / .show functions — Kusto management commands.
 *
 * No Fabric dependency: works fully with LOOM_DEFAULT_FABRIC_WORKSPACE unset.
 * The only requirement is LOOM_KUSTO_CLUSTER_URI (Azure-native default).
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  getDatabaseSchemaJson, listMaterializedViews, listFunctions,
  loadKustoItem, resolveDatabase, KustoError,
} from '@/lib/azure/kusto-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type NodeKind = 'table' | 'materialized-view' | 'function' | 'shortcut';

interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  columns?: Array<{ name: string; type: string }>;
  parameters?: string;
  sourceTable?: string;
  /** External-table connection string / data source (shortcut target). */
  target?: string;
  folder?: string;
}

interface GraphEdge {
  from: string;
  to: string;
  type: 'mv-source' | 'function-ref';
}

/** Normalize "System.DateTime" / "System.String" → "datetime" / "string". */
function normType(t: unknown): string {
  return String(t || '')
    .replace(/^System\./, '')
    .replace(/^Int64$/i, 'long')
    .replace(/^Int32$/i, 'int')
    .replace(/^SByte$/i, 'bool')
    .toLowerCase();
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  try {
    const item = await loadKustoItem((await ctx.params).id, 'kql-database', session.claims.oid);
    const database = resolveDatabase(item);

    const [schemaJson, materializedViews, functionsList] = await Promise.all([
      getDatabaseSchemaJson(database).catch(() => null),
      listMaterializedViews(database).catch(() => []),
      listFunctions(database).catch(() => []),
    ]);

    // The schema-json shape is { Databases: { <db>: { Tables, Functions,
    // ExternalTables } } }. The db key may differ in case from `database`, so
    // fall back to the first (and usually only) database entry.
    const dbEntry: any =
      (schemaJson as any)?.Databases?.[database]
      || Object.values((schemaJson as any)?.Databases || {})[0]
      || {};

    // ---- Tables ----
    const tables: GraphNode[] = Object.values(dbEntry?.Tables || {}).map((t: any) => ({
      id: `table:${t.Name}`,
      kind: 'table' as const,
      name: String(t.Name),
      columns: Array.isArray(t.OrderedColumns)
        ? t.OrderedColumns.map((c: any) => ({ name: String(c.Name), type: normType(c.Type || c.CslType) }))
        : [],
    }));
    const tableIds = new Set(tables.map((t) => t.name));

    // ---- External tables (Azure-native parity of OneLake shortcuts) ----
    const externalTables: GraphNode[] = Object.values(dbEntry?.ExternalTables || {}).map((x: any) => ({
      id: `shortcut:${x.Name}`,
      kind: 'shortcut' as const,
      name: String(x.Name),
      columns: Array.isArray(x.OrderedColumns)
        ? x.OrderedColumns.map((c: any) => ({ name: String(c.Name), type: normType(c.Type || c.CslType) }))
        : [],
      target: typeof x.ConnectionStrings?.[0] === 'string'
        ? x.ConnectionStrings[0]
        : (typeof x.DataFormat === 'string' ? x.DataFormat : undefined),
    }));

    // ---- Materialized views (Name + SourceTable from the dedicated command) ----
    const mvNodes: GraphNode[] = (materializedViews as any[]).map((mv) => ({
      id: `mv:${mv.name}`,
      kind: 'materialized-view' as const,
      name: String(mv.name),
      sourceTable: mv.sourceTable ? String(mv.sourceTable) : undefined,
    }));
    const mvNames = new Set(mvNodes.map((m) => m.name));

    // ---- Functions (Body from schema-json; parameters from .show functions) ----
    const paramByName = new Map<string, string>();
    for (const f of functionsList as any[]) {
      if (f?.name) paramByName.set(String(f.name), String(f.parameters || ''));
    }
    const fnBodies = new Map<string, string>();
    const functions: GraphNode[] = Object.values(dbEntry?.Functions || {}).map((f: any) => {
      const name = String(f.Name);
      const params = paramByName.get(name)
        ?? (typeof f.Parameters === 'string' ? f.Parameters : '')
        ?? '';
      fnBodies.set(name, String(f.Body || ''));
      return {
        id: `function:${name}`,
        kind: 'function' as const,
        name,
        parameters: params || undefined,
        folder: typeof f.Folder === 'string' ? f.Folder : undefined,
      };
    });
    // Schema-json sometimes omits functions; backfill from .show functions so
    // the diagram still lists every function (no Body → no derived edges).
    const fnNamesFromSchema = new Set(functions.map((f) => f.name));
    for (const f of functionsList as any[]) {
      const name = String(f?.name || '');
      if (!name || fnNamesFromSchema.has(name)) continue;
      functions.push({
        id: `function:${name}`,
        kind: 'function',
        name,
        parameters: f.parameters ? String(f.parameters) : undefined,
        folder: f.folder ? String(f.folder) : undefined,
      });
    }

    // ---- Edges ----
    const edges: GraphEdge[] = [];

    // MV → source table (only when the source is a known table/MV/external).
    const refTargetByName = new Map<string, string>(); // name → node id
    for (const t of tables) refTargetByName.set(t.name, t.id);
    for (const m of mvNodes) refTargetByName.set(m.name, m.id);
    for (const x of externalTables) refTargetByName.set(x.name, x.id);
    for (const fn of functions) refTargetByName.set(fn.name, fn.id);

    for (const mv of mvNodes) {
      if (mv.sourceTable && refTargetByName.has(mv.sourceTable)) {
        edges.push({ from: mv.id, to: refTargetByName.get(mv.sourceTable)!, type: 'mv-source' });
      }
    }

    // Function → referenced entity. Static scan of the REAL function body for
    // word-boundary references to any known entity name (excluding itself).
    for (const [fnName, body] of fnBodies) {
      if (!body) continue;
      const fnId = `function:${fnName}`;
      const seen = new Set<string>();
      for (const [refName, refId] of refTargetByName) {
        if (refName === fnName || refId === fnId) continue;
        if (seen.has(refId)) continue;
        // Match `RefName`, `["RefName"]`, `RefName(` — real KQL entity refs.
        const esc = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^\\w\\[\"])${esc}(\\b|[\\["(])`);
        if (re.test(body)) {
          edges.push({ from: fnId, to: refId, type: 'function-ref' });
          seen.add(refId);
        }
      }
    }

    const nodes = [...tables, ...externalTables, ...mvNodes, ...functions];

    return NextResponse.json({
      ok: true,
      database,
      nodes,
      edges,
      counts: {
        tables: tables.length,
        materializedViews: mvNodes.length,
        functions: functions.length,
        shortcuts: externalTables.length,
        edges: edges.length,
      },
    });
  } catch (e: any) {
    const status = e instanceof KustoError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
}
