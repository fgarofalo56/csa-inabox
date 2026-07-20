/**
 * GET  /api/items/semantic-model/[id]/content
 * PUT  /api/items/semantic-model/[id]/content
 *
 * In-place authoring of a Loom-native semantic model's content on an EXISTING
 * item. This writes the SAME `state.content` (`SemanticModelContent`) + backing
 * source descriptor (`state.sourceTarget` / `state.sourceSchema` /
 * `state.sourceDatabase`) that:
 *   - `POST /api/items/semantic-model/scaffold` writes when it MINTS a model, and
 *   - `lib/azure/report-model-resolver.ts` + the loom-native `/dax-query`
 *     (`tabular-eval-client` → `tabular-model.extractContent`) READ when they run
 *     the model.
 *
 * The gap this closes: `scaffold` only creates NEW model items and the bundle
 * install stamps content at install time — an already-created EMPTY model (e.g.
 * a demo shell) had NO API to author tables/measures into it, so the report bound
 * to it stayed `unbound` (412) forever. This route fills that shell in place.
 *
 * Body (structured — NO freeform passthrough; every field is validated):
 *   {
 *     content: {
 *       kind: 'semantic-model',
 *       tables:   [{ name, columns: [{ name, dataType, description? }], ... }],
 *       measures: [{ table, name, expression, formatString?, description? }],
 *       relationships?: [{ from, to, cardinality }],
 *     },
 *     sourceTarget?:   'warehouse' | 'lakehouse',   // default 'warehouse'
 *     sourceSchema?:   string,                        // default 'dbo'
 *     sourceDatabase?: string,                        // serverless db for lakehouse
 *   }
 *
 * 200 → { ok:true, content, sourceTarget, sourceSchema, sourceDatabase }
 * 400 → invalid structure (named, no garbage passthrough)
 * 404 → item not found / not owned by caller
 *
 * Azure-native (no-fabric-dependency): the content drives serverless SQL over
 * the backing warehouse/lakehouse — NO Power BI / Fabric / AAS required. Real
 * Cosmos write via updateOwnedItem; no mocks (no-vaporware).
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem, updateOwnedItem } from '../../../_lib/item-crud';
import type { SemanticModelContent } from '@/lib/apps/content-bundles/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';
const VALID_TARGETS = ['warehouse', 'lakehouse'] as const;
const VALID_CARDINALITY = ['1:1', '1:many', 'many:many'] as const;
const MAX_TABLES = 200;
const MAX_COLUMNS = 500;
const MAX_MEASURES = 500;

/** A safe SQL/tabular identifier: the FROM-clause + column names the loom-native
 *  translator emits are bracket-quoted but never schema-qualified, so we keep
 *  names to letters/digits/underscore/space (no dots, brackets, quotes). */
function safeIdent(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > 128) return null;
  return /^[A-Za-z_][A-Za-z0-9_ ]*$/.test(s) ? s : null;
}

type ValidationResult =
  | { ok: true; content: SemanticModelContent }
  | { ok: false; error: string };

/**
 * Validate + NORMALIZE the request into a clean `SemanticModelContent`. Rebuilds
 * the object field-by-field so no unknown/garbage keys are persisted (structured
 * authoring per loom-no-freeform-config).
 */
function validateContent(raw: unknown): ValidationResult {
  const c = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : null;
  if (!c) return { ok: false, error: 'content is required (an object).' };
  if (c.kind !== 'semantic-model') return { ok: false, error: "content.kind must be 'semantic-model'." };

  const rawTables = Array.isArray(c.tables) ? c.tables : null;
  if (!rawTables) return { ok: false, error: 'content.tables must be an array.' };
  if (rawTables.length === 0) return { ok: false, error: 'define at least one table.' };
  if (rawTables.length > MAX_TABLES) return { ok: false, error: `too many tables (>${MAX_TABLES}).` };

  const tables: SemanticModelContent['tables'] = [];
  const tableNames = new Set<string>();
  for (const t of rawTables) {
    const to = (t && typeof t === 'object') ? (t as Record<string, unknown>) : null;
    if (!to) return { ok: false, error: 'each table must be an object.' };
    const name = safeIdent(to.name);
    if (!name) return { ok: false, error: `invalid table name "${String((to as any).name)}" (letters, digits, underscore, space).` };
    if (tableNames.has(name)) return { ok: false, error: `duplicate table "${name}".` };
    tableNames.add(name);
    const rawCols = Array.isArray(to.columns) ? to.columns : [];
    if (rawCols.length > MAX_COLUMNS) return { ok: false, error: `table "${name}" has too many columns (>${MAX_COLUMNS}).` };
    const columns: SemanticModelContent['tables'][number]['columns'] = [];
    for (const col of rawCols) {
      const co = (col && typeof col === 'object') ? (col as Record<string, unknown>) : null;
      if (!co) return { ok: false, error: `table "${name}": each column must be an object.` };
      const cname = safeIdent(co.name);
      if (!cname) return { ok: false, error: `table "${name}": invalid column name "${String((co as any).name)}".` };
      const dataType = String(co.dataType ?? 'String').trim() || 'String';
      const description = typeof co.description === 'string' ? co.description.slice(0, 512) : undefined;
      columns.push({ name: cname, dataType, ...(description ? { description } : {}) });
    }
    if (columns.length === 0) return { ok: false, error: `table "${name}" needs at least one column.` };
    tables.push({ name, columns });
  }

  const rawMeasures = Array.isArray(c.measures) ? c.measures : [];
  if (rawMeasures.length > MAX_MEASURES) return { ok: false, error: `too many measures (>${MAX_MEASURES}).` };
  const measures: SemanticModelContent['measures'] = [];
  for (const m of rawMeasures) {
    const mo = (m && typeof m === 'object') ? (m as Record<string, unknown>) : null;
    if (!mo) return { ok: false, error: 'each measure must be an object.' };
    const mname = safeIdent(mo.name);
    if (!mname) return { ok: false, error: `invalid measure name "${String((mo as any).name)}".` };
    const table = safeIdent(mo.table);
    if (!table) return { ok: false, error: `measure "${mname}": invalid home table.` };
    if (!tableNames.has(table)) return { ok: false, error: `measure "${mname}" references unknown table "${table}".` };
    const expression = String(mo.expression ?? '').trim();
    if (!expression) return { ok: false, error: `measure "${mname}" needs a non-empty expression.` };
    if (expression.length > 8192) return { ok: false, error: `measure "${mname}" expression too large.` };
    const formatString = typeof mo.formatString === 'string' ? mo.formatString.slice(0, 128) : undefined;
    const description = typeof mo.description === 'string' ? mo.description.slice(0, 512) : undefined;
    measures.push({ table, name: mname, expression, ...(formatString ? { formatString } : {}), ...(description ? { description } : {}) });
  }

  const relationships: NonNullable<SemanticModelContent['relationships']> = [];
  if (c.relationships !== undefined) {
    if (!Array.isArray(c.relationships)) return { ok: false, error: 'content.relationships must be an array.' };
    for (const r of c.relationships) {
      const ro = (r && typeof r === 'object') ? (r as Record<string, unknown>) : null;
      if (!ro) return { ok: false, error: 'each relationship must be an object.' };
      const from = String(ro.from ?? '').trim();
      const to = String(ro.to ?? '').trim();
      const cardinality = ro.cardinality as string;
      if (!from || !to) return { ok: false, error: 'relationship needs from + to.' };
      if (!(VALID_CARDINALITY as readonly string[]).includes(cardinality)) {
        return { ok: false, error: `relationship cardinality must be one of ${VALID_CARDINALITY.join(', ')}.` };
      }
      relationships.push({ from, to, cardinality: cardinality as (typeof VALID_CARDINALITY)[number] });
    }
  }

  const content: SemanticModelContent = {
    kind: 'semantic-model',
    tables,
    measures,
    ...(relationships.length ? { relationships } : {}),
  };
  return { ok: true, content };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('semantic model not found or not owned by you');
    const state = (item.state || {}) as Record<string, unknown>;
    const content = (state.content as SemanticModelContent | undefined) ?? null;
    return apiOk({
      content: content && (content as any).kind === 'semantic-model' ? content : null,
      sourceTarget: state.sourceTarget ?? null,
      sourceSchema: state.sourceSchema ?? null,
      sourceDatabase: state.sourceDatabase ?? null,
    });
  } catch (e) {
    return apiServerError(e);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const valid = validateContent(body.content);
    if (!valid.ok) return apiError(valid.error, 400);

    const sourceTarget = body.sourceTarget === undefined
      ? 'warehouse'
      : (VALID_TARGETS as readonly string[]).includes(String(body.sourceTarget))
        ? String(body.sourceTarget)
        : null;
    if (sourceTarget === null) return apiError(`sourceTarget must be one of ${VALID_TARGETS.join(', ')}.`, 400);

    const sourceSchema = body.sourceSchema === undefined
      ? 'dbo'
      : (safeIdent(body.sourceSchema) ?? null);
    if (sourceSchema === null) return apiError('invalid sourceSchema.', 400);

    const sourceDatabase = body.sourceDatabase === undefined
      ? undefined
      : (safeIdent(body.sourceDatabase) ?? null);
    if (sourceDatabase === null) return apiError('invalid sourceDatabase.', 400);

    // Load first so we 404 before writing, and so we MERGE onto the existing
    // state (updateOwnedItem REPLACES state wholesale — preserve sibling keys).
    const item = await loadOwnedItem(id, ITEM_TYPE, session.claims.oid);
    if (!item) return apiNotFound('semantic model not found or not owned by you');

    const nextState: Record<string, unknown> = {
      ...(item.state as Record<string, unknown> | undefined),
      content: valid.content,
      sourceTarget,
      sourceSchema,
      ...(sourceDatabase ? { sourceDatabase } : {}),
    };

    const saved = await updateOwnedItem(id, ITEM_TYPE, session.claims.oid, { state: nextState });
    if (!saved) return apiNotFound('semantic model not found or not owned by you');

    return apiOk({
      content: valid.content,
      sourceTarget,
      sourceSchema,
      sourceDatabase: sourceDatabase ?? null,
      tableCount: valid.content.tables.length,
      measureCount: valid.content.measures.length,
    });
  } catch (e) {
    return apiServerError(e);
  }
}
