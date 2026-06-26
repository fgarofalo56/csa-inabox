/**
 * POST /api/items/semantic-model/scaffold — Azure-native semantic-model scaffold.
 *
 * Mints a REAL Loom-native `semantic-model` item from a warehouse/lakehouse
 * TABLE or a read-only SELECT — the Azure-native DEFAULT that a report's Data
 * source picker / the Weave "Build report" edge bind to. This is DISTINCT from
 * the Power BI `/api/items/semantic-model/build` route: it never calls
 * api.powerbi.com / api.fabric.microsoft.com. The model is a `SemanticModelContent`
 * (one table, real typed columns) persisted on the item's `state.content`, plus
 * the backing-source descriptor (`state.sourceTarget` / `state.sourceSchema` /
 * `state.sourceDatabase` / `state.sourceQuery`) the report-model-resolver reads to
 * run the visual SQL over Synapse. See lib/azure/report-model-resolver.ts.
 *
 * Body:
 *   {
 *     sourceMode: 'table' | 'query',
 *     target:     'warehouse' | 'lakehouse',
 *     // table mode — a discovery-route value "objectId|schema|name" (catalog-
 *     //   verified) OR a "schema.name" / "name" relation to introspect:
 *     table?:     string,
 *     // query mode — a single read-only SELECT (sql-guard'd, wrapped derived):
 *     query?:     string,
 *     // lakehouse serverless database the views live in (default resolver 'master'):
 *     database?:  string,
 *     modelName:  string,
 *     // optional explicit target workspace; defaults to the caller's first:
 *     workspaceId?: string,
 *     folderId?:  string | null,
 *     // when true, infer + return columns ONLY (no item created) — picker preview:
 *     dryRun?:    boolean
 *   }
 *
 * 200 (create)  → { ok:true, itemId, link:'/items/semantic-model/<id>', modelName, table?, columns }
 * 200 (dryRun)  → { ok:true, dryRun:true, sourceMode, target, modelName, table?, columns }
 * 4xx/5xx       → { ok:false, error }  — every unconfigured branch is an honest
 *                 gate naming the exact env/resource (no mock, no silent no-op).
 *
 * Rules: no-vaporware (real listColumns / real SELECT introspection over Synapse;
 *   real createOwnedItem Cosmos write), no-fabric-dependency (Azure-native default;
 *   no Power BI/Fabric host), no-freeform-config (table picker; the only free text
 *   is the already-allowed sql-guard'd SELECT escape hatch).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { createOwnedItem, listOwnedWorkspaces } from '@/app/api/items/_lib/item-crud';
import {
  dedicatedTarget,
  serverlessTarget,
  executeQuery,
  type SynapseTarget,
} from '@/lib/azure/synapse-sql-client';
import { listColumns } from '@/lib/azure/sql-objects-client';
import { sqlTypeToPush, inferPushColumnsFromResult, bracket } from '@/lib/thread/sql-to-pushdataset';
import { readOnlySelect } from '@/lib/thread/sql-guard';
import type { SemanticModelContent } from '@/lib/apps/content-bundles/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sample size for type inference when there is no catalog schema to read. */
const SAMPLE_ROWS = 50;

type SourceMode = 'table' | 'query';
type SourceKind = 'warehouse' | 'lakehouse';

/** A typed model column inferred from a real catalog / result set. */
interface InferredColumn {
  name: string;
  /** Normalized tabular type (Int64/Double/Decimal/Boolean/DateTime/String) — drives the resolver's default summarizeBy. */
  dataType: string;
}

/**
 * Resolve the Synapse SQL endpoint for the chosen backend. `dedicatedTarget()` /
 * `serverlessTarget()` throw when their env vars are unset — caught by the caller
 * and surfaced as an honest 503 naming the missing var.
 */
function resolveTarget(kind: SourceKind, database?: string): SynapseTarget {
  return kind === 'lakehouse' ? serverlessTarget(database || 'master') : dedicatedTarget();
}

/** Parse a table selection: "objectId|schema|name" (discovery route) or "schema.name"/"name". */
function parseTableValue(value: string): { objectId?: number; schema: string; name: string } | null {
  const v = (value || '').trim();
  if (!v) return null;
  if (v.includes('|')) {
    const [objIdStr, schema, name] = v.split('|');
    const objectId = Number(objIdStr);
    if (Number.isInteger(objectId) && schema && name) return { objectId, schema, name };
    return null;
  }
  // "schema.name" or bare "name" (default schema dbo).
  const dot = v.indexOf('.');
  if (dot > 0) return { schema: v.slice(0, dot), name: v.slice(dot + 1) };
  return { schema: 'dbo', name: v };
}

/** Real typed columns from the catalog (sys.columns), mapped to tabular types. Skips computed columns. */
async function columnsFromCatalog(target: SynapseTarget, objectId: number): Promise<InferredColumn[]> {
  const cols = await listColumns(target.server, target.database, objectId);
  return cols
    .filter((c) => !c.isComputed)
    .map((c) => ({ name: c.name, dataType: String(sqlTypeToPush(c.dataType)) }));
}

/**
 * Infer columns by running a small sample SELECT and reading the real result-set
 * shape (names + value-derived types). Used for a query source, or a lakehouse
 * relation that wasn't selected through the catalog discovery route.
 */
async function columnsFromSample(target: SynapseTarget, derivedSql: string): Promise<InferredColumn[]> {
  const res = await executeQuery(target, `SELECT TOP ${SAMPLE_ROWS} * FROM (\n${derivedSql}\n) AS _loom_scaffold`);
  const { pushColumns } = inferPushColumnsFromResult(res.columns, res.rows);
  return pushColumns.map((c) => ({ name: c.name, dataType: String(c.dataType) }));
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const oid = session.claims.oid;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const sourceMode = (String(body.sourceMode || 'table').trim() as SourceMode);
  const target = (String(body.target || 'warehouse').trim() as SourceKind);
  const tableValue = String(body.table || '').trim();
  const queryText = String(body.query || '').trim();
  const database = String(body.database || '').trim() || undefined;
  const modelName = String(body.modelName || '').trim();
  const dryRun = body.dryRun === true;
  const workspaceIdIn = String(body.workspaceId || '').trim() || undefined;
  const folderId = (body.folderId === null ? null : String(body.folderId || '').trim() || undefined);

  if (sourceMode !== 'table' && sourceMode !== 'query') {
    return NextResponse.json({ ok: false, error: "sourceMode must be 'table' or 'query'." }, { status: 400 });
  }
  if (target !== 'warehouse' && target !== 'lakehouse') {
    return NextResponse.json({ ok: false, error: "target must be 'warehouse' or 'lakehouse'." }, { status: 400 });
  }
  if (!modelName && !dryRun) {
    return NextResponse.json({ ok: false, error: 'modelName is required.' }, { status: 400 });
  }

  // Resolve the Synapse endpoint up front so a missing-env gate is precise.
  let synapse: SynapseTarget;
  try {
    synapse = resolveTarget(target, database);
  } catch (e: any) {
    const missing = /LOOM_SYNAPSE_DEDICATED_POOL/.test(String(e?.message))
      ? 'LOOM_SYNAPSE_DEDICATED_POOL'
      : 'LOOM_SYNAPSE_WORKSPACE';
    return NextResponse.json(
      {
        ok: false,
        error:
          `The Azure-native ${target} is not configured: set ${missing} ` +
          '(deployed by platform/fiab/bicep/modules/landing-zone). No Microsoft Fabric / Power BI required.',
      },
      { status: 503 },
    );
  }

  // ── Infer the model's single table (real columns) + the backing-source state ──
  let tableName: string;
  let sourceSchema = 'dbo';
  let sourceQuery: string | undefined;
  let columns: InferredColumn[];
  let tableInfo: { schema: string; name: string; objectId?: number } | undefined;

  if (sourceMode === 'query') {
    if (!queryText) {
      return NextResponse.json({ ok: false, error: 'query is required for sourceMode=query.' }, { status: 400 });
    }
    const guard = readOnlySelect(queryText);
    if (!guard.ok) return NextResponse.json({ ok: false, error: guard.error }, { status: 400 });
    sourceQuery = guard.sql;
    // The model is a single derived table; name it after the model (sanitized) so
    // the Fields tree reads cleanly, defaulting to 'Query'.
    tableName = modelName.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'Query';
    try {
      columns = await columnsFromSample(synapse, guard.sql);
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: `The query could not be introspected against the ${target}: ${e?.message || String(e)}` },
        { status: 400 },
      );
    }
    if (!columns.length) {
      return NextResponse.json({ ok: false, error: 'The query returned no columns.' }, { status: 400 });
    }
  } else {
    // table mode
    const parsed = parseTableValue(tableValue);
    if (!parsed) {
      return NextResponse.json({ ok: false, error: 'pick a table (or pass "objectId|schema|name").' }, { status: 400 });
    }
    tableName = parsed.name;
    sourceSchema = parsed.schema;
    tableInfo = { schema: parsed.schema, name: parsed.name, objectId: parsed.objectId };
    try {
      columns =
        parsed.objectId != null
          ? await columnsFromCatalog(synapse, parsed.objectId)
          : await columnsFromSample(synapse, `SELECT * FROM ${bracket(parsed.schema)}.${bracket(parsed.name)}`);
    } catch (e: any) {
      return NextResponse.json(
        { ok: false, error: `Could not read the schema for ${parsed.schema}.${parsed.name}: ${e?.message || String(e)}` },
        { status: 500 },
      );
    }
    if (!columns.length) {
      return NextResponse.json(
        { ok: false, error: `${parsed.schema}.${parsed.name} has no readable columns.` },
        { status: 400 },
      );
    }
  }

  // Build the Loom-native SemanticModelContent (one table, typed columns). The
  // per-type default aggregation ("summarizeBy") is DERIVED downstream from each
  // column's dataType (report-model-resolver.defaultSummarizeBy) — numerics →
  // Sum, everything else → none — so no DAX measures are emitted here (the
  // loom-native render path aggregates columns directly via wells-to-sql). The
  // model stays fully usable with NO Analysis Services / Power BI / Fabric.
  const content: SemanticModelContent = {
    kind: 'semantic-model',
    tables: [
      {
        name: tableName,
        columns: columns.map((c) => ({ name: c.name, dataType: c.dataType })),
      },
    ],
    measures: [],
  };

  // dryRun: the data-source picker wants a column preview only — never write.
  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      sourceMode,
      target,
      modelName: modelName || tableName,
      ...(tableInfo ? { table: { schema: tableInfo.schema, name: tableInfo.name } } : {}),
      columns,
    });
  }

  // Resolve the target workspace (explicit, else the caller's first owned one).
  let workspaceId = workspaceIdIn;
  if (!workspaceId) {
    const wss = await listOwnedWorkspaces(oid).catch(() => []);
    workspaceId = wss[0]?.id;
  }
  if (!workspaceId) {
    return NextResponse.json(
      { ok: false, error: 'No workspace available to host the semantic model — create a workspace first, or pass workspaceId.' },
      { status: 400 },
    );
  }

  const description =
    sourceMode === 'query'
      ? `Loom-native semantic model scaffolded from a ${target} query.`
      : `Loom-native semantic model scaffolded from ${target} table ${sourceSchema}.${tableName}.`;

  // Persist the model + its backing source. The resolver reads sourceTarget /
  // sourceSchema / sourceDatabase (table-map path) and sourceQuery (derived path).
  const state: Record<string, unknown> = {
    content,
    semanticBackend: 'loom-native',
    sourceMode,
    sourceTarget: target,
    sourceSchema,
    ...(database ? { sourceDatabase: database } : {}),
    ...(sourceQuery ? { sourceQuery } : {}),
    ...(tableInfo ? { sourceTable: tableInfo } : {}),
  };

  const created = await createOwnedItem(session, 'semantic-model', {
    workspaceId,
    displayName: modelName,
    description,
    state,
    folderId,
  });
  if (!created.ok) {
    return NextResponse.json({ ok: false, error: created.error }, { status: created.status });
  }

  return NextResponse.json({
    ok: true,
    itemId: created.item.id,
    link: `/items/semantic-model/${created.item.id}`,
    modelName: created.item.displayName,
    ...(tableInfo ? { table: { schema: tableInfo.schema, name: tableInfo.name } } : {}),
    columns,
  });
}
