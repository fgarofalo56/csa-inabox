/**
 * /api/items/semantic-model/[id]/describe-bulk — Bulk AI auto-description for a
 * semantic model (Fabric Build 2026 #36: "AI Auto-Description for Semantic
 * Models Preview — bulk from OneLake catalog detail").
 *
 * One click generates business-friendly descriptions for EVERY table, column,
 * and measure on the model in a single AOAI pass, then persists them
 * Azure-native. The per-measure DAX Copilot tool (dax_describe_model) already
 * exists; this is the *bulk catalog* surface that does tables + measures at once
 * and writes them, mirroring the Fabric OneLake-catalog "Generate descriptions
 * for all tables" action.
 *
 * Backends:
 *   GET  → preview the current descriptions + counts (tables / columns /
 *          measures, and how many already have a description).
 *   POST {apply?:boolean, descriptions?} →
 *          • apply omitted/false → GENERATE proposals via AOAI, return them
 *            (nothing written) so the UI can show a diff.
 *          • apply:true with no descriptions → generate AND persist.
 *          • apply:true with descriptions → persist the (edited) descriptions
 *            the operator approved.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the DEFAULT
 * write target is the Loom-native model state (Cosmos):
 *   • table + column descriptions  → semantic-model-store (tenant-settings doc),
 *   • measure descriptions         → model-store (item.state.model.measures[*]).
 * Both persist with NO Fabric / Power BI workspace bound and are emitted into
 * model.bim at provision time. When the Azure Analysis Services XMLA backend is
 * opted into (LOOM_AAS_SERVER_URL / LOOM_POWERBI_XMLA_ENDPOINT) the descriptions
 * are ALSO pushed live via Alter Table/Column TMSL — never required, never on
 * the default path. AOAI is the Azure-native generator (no Fabric Copilot).
 */

import { NextRequest, NextResponse } from 'next/server';

import { getSession } from '@/lib/auth/session';
import { aoaiChat } from '@/lib/azure/aoai-chat-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  getDataset, listDatasetTables, type PbiTable,
} from '@/lib/azure/powerbi-client';
import {
  isLoomContentId, cosmosIdFromLoomId, loadContentBackedItem, semanticModelDetailFromContent,
} from '../../../_lib/pbi-content-fallback';
import {
  readSmModelState, writeSmModelState, upsertTableDescriptions,
  type SmTableDescription,
} from '../../../_lib/semantic-model-store';
import { readModelState, writeModelState } from '../../../_lib/model-store';
import {
  aasXmlaConfig, command as executeXmlaCommand, AasError,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── AOAI chat (unified client) ───────────────────────────────────────────────

async function aoaiChatJson(tenantId: string, system: string, user: string, maxTokens: number): Promise<any> {
  const cfg = await loadTenantCopilotConfig(tenantId).catch(() => null);
  const content = await aoaiChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    maxCompletionTokens: maxTokens,
    responseFormat: 'json_object',
    cfg,
  });
  // Soft-parse: this bulk surface deliberately degrades to {} on unparseable
  // JSON (the proposal validators then yield empty proposals) rather than 502.
  try { return JSON.parse(content.trim() || '{}'); } catch { return {}; }
}

// ── Model context (tables + columns + measures) ──────────────────────────────

interface BulkTable { name: string; columns: string[] }
interface BulkMeasure { name: string; expression: string; description?: string }

/**
 * Read the model's tables (with columns) and measures from the Azure-native
 * sources. Tables come from the Loom content (default) or, for a live Power BI /
 * Fabric dataset id (opt-in), the dataset's table list. Measures come from the
 * Loom model-store. Never throws on a live-read failure — degrades to whatever
 * the Cosmos sources hold.
 */
async function loadBulkContext(
  id: string, workspaceId: string | null, tenantId: string,
): Promise<{ modelName: string; tables: BulkTable[]; measures: BulkMeasure[]; liveDataset: boolean; notice?: string }> {
  // Measures (Loom model-store; owned item).
  let measures: BulkMeasure[] = [];
  try {
    const { state, itemFound } = await readModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    if (itemFound) {
      measures = state.measures.map((m) => ({ name: m.name, expression: m.expression, description: m.description }));
    }
  } catch { /* no owned model-store item — measures stay empty */ }

  // Tables — Loom content-backed (default, no Fabric).
  if (isLoomContentId(id)) {
    const item = await loadContentBackedItem(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
    const built = item ? semanticModelDetailFromContent(item) : null;
    const tables: BulkTable[] = (built?.tables || []).map((t: any) => ({
      name: t.name,
      columns: (t.columns || []).map((c: any) => String(c.name)),
    }));
    return { modelName: item?.displayName || 'Semantic model', tables, measures, liveDataset: false };
  }

  // Live Power BI / Fabric dataset (opt-in). Requires a workspace; degrade
  // honestly when absent so the bulk action still runs on whatever measures /
  // content exist.
  if (!workspaceId) {
    return {
      modelName: 'Semantic model', tables: [], measures, liveDataset: true,
      notice: 'No Power BI workspace bound — generating descriptions for Loom-native measures only. For a live Power BI / Fabric model, open from a workspace to include its tables.',
    };
  }
  try {
    const [dataset, pbiTables] = await Promise.all([
      getDataset(workspaceId, id).catch(() => null),
      listDatasetTables(workspaceId, id).catch(() => [] as PbiTable[]),
    ]);
    const tables: BulkTable[] = (pbiTables || []).map((t) => ({
      name: t.name,
      columns: (t.columns || []).map((c) => c.name),
    }));
    return { modelName: dataset?.name || id, tables, measures, liveDataset: true };
  } catch (e: any) {
    return { modelName: id, tables: [], measures, liveDataset: true, notice: e?.message || String(e) };
  }
}

// ── Proposal generation ──────────────────────────────────────────────────────

interface TableProposal { table: string; description: string; columns: Array<{ name: string; description: string }> }
interface MeasureProposal { name: string; description: string }

async function generateProposals(
  tenantId: string,
  modelName: string,
  tables: BulkTable[],
  measures: BulkMeasure[],
): Promise<{ tables: TableProposal[]; measures: MeasureProposal[] }> {
  if (tables.length === 0 && measures.length === 0) return { tables: [], measures: [] };

  const tablesBlock = tables.length
    ? tables.map((t) => `TABLE ${t.name}\n  COLUMNS: ${t.columns.join(', ') || '(none listed)'}`).join('\n')
    : '(no tables)';
  const measuresBlock = measures.length
    ? measures.map((m) => `MEASURE [${m.name}] = ${(m.expression || '').slice(0, 200)}`).join('\n')
    : '(no measures)';

  const system =
    `You are a data-catalog writer for the tabular semantic model "${modelName}". ` +
    'For every table, every column, and every measure listed, write a concise (1 sentence, business-friendly) description. ' +
    'Ground each description in the table/column/measure name and (for measures) the DAX expression — do not invent semantics. ' +
    'Respond with ONLY a JSON object of the shape ' +
    '{"tables":[{"table":"...","description":"...","columns":[{"name":"...","description":"..."}]}],"measures":[{"name":"...","description":"..."}]} ' +
    '— no prose, no code fence. Use the EXACT names supplied.';
  const user = `TABLES:\n${tablesBlock}\n\nMEASURES:\n${measuresBlock}`;

  // Token budget scales with surface size (capped to keep latency bounded).
  const maxTokens = Math.min(4000, 400 + tables.reduce((n, t) => n + t.columns.length, 0) * 30 + tables.length * 30 + measures.length * 40);
  const parsed = await aoaiChatJson(tenantId, system, user, maxTokens);

  const validTables = new Set(tables.map((t) => t.name));
  const colsByTable = new Map(tables.map((t) => [t.name, new Set(t.columns)]));
  const validMeasures = new Set(measures.map((m) => m.name));

  const tableProposals: TableProposal[] = (Array.isArray(parsed?.tables) ? parsed.tables : [])
    .filter((p: any) => p && typeof p.table === 'string' && validTables.has(p.table))
    .map((p: any) => ({
      table: p.table,
      description: typeof p.description === 'string' ? p.description.trim() : '',
      columns: (Array.isArray(p.columns) ? p.columns : [])
        .filter((c: any) => c && typeof c.name === 'string' && typeof c.description === 'string' && colsByTable.get(p.table)?.has(c.name))
        .map((c: any) => ({ name: c.name, description: String(c.description).trim() }))
        .filter((c: any) => c.description),
    }))
    .filter((p: TableProposal) => p.description || p.columns.length > 0);

  const measureProposals: MeasureProposal[] = (Array.isArray(parsed?.measures) ? parsed.measures : [])
    .filter((p: any) => p && typeof p.name === 'string' && typeof p.description === 'string' && validMeasures.has(p.name))
    .map((p: any) => ({ name: p.name, description: String(p.description).trim() }))
    .filter((p: MeasureProposal) => p.description);

  return { tables: tableProposals, measures: measureProposals };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Persist table/column descriptions (SM store) and measure descriptions
 * (model-store). Returns the applied counts. Best-effort XMLA push when the AAS
 * backend is configured (never required).
 */
async function persistDescriptions(
  id: string,
  workspaceId: string | null,
  tenantId: string,
  modelName: string,
  tableProposals: TableProposal[],
  measureProposals: MeasureProposal[],
): Promise<{ tables: number; columns: number; measures: number; backend: string; xmla?: { ok: boolean; pushed: number; error?: string } }> {
  // 1. Table + column descriptions → SM store (default Azure-native).
  let tableCount = 0;
  let columnCount = 0;
  if (tableProposals.length > 0) {
    const state = await readSmModelState(id, tenantId);
    const incoming: SmTableDescription[] = tableProposals.map((t) => {
      if (t.description) tableCount += 1;
      columnCount += t.columns.length;
      return { table: t.table, description: t.description || undefined, columns: t.columns, updatedAt: new Date().toISOString() };
    });
    const next = upsertTableDescriptions(state, incoming);
    await writeSmModelState(id, tenantId, next);
  }

  // 2. Measure descriptions → model-store (only when an owned model item exists).
  let measureCount = 0;
  if (measureProposals.length > 0) {
    try {
      const { state, itemFound } = await readModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId);
      if (itemFound) {
        const descMap = new Map(measureProposals.map((m) => [m.name, m.description]));
        const now = new Date().toISOString();
        const measures = state.measures.map((m) => {
          if (descMap.has(m.name)) { measureCount += 1; return { ...m, description: descMap.get(m.name)!, updatedAt: now }; }
          return m;
        });
        if (measureCount > 0) await writeModelState(cosmosIdFromLoomId(id), 'semantic-model', tenantId, { ...state, measures });
      }
    } catch { /* measure persistence is best-effort; SM-store table writes already succeeded */ }
  }

  // 3. Opt-in: push the table + column descriptions live via the AAS XMLA
  //    endpoint (Alter Table / Alter Column with a `description`). Never on the
  //    default path; failure does not fail the request.
  let xmla: { ok: boolean; pushed: number; error?: string } | undefined;
  const cfg = aasXmlaConfig();
  if (cfg && tableProposals.length > 0) {
    let pushed = 0;
    try {
      const db = cfg.database;
      const catalog = modelName || db;
      for (const t of tableProposals) {
        if (t.description) {
          await executeXmlaCommand({ alter: { object: { database: catalog, table: t.table }, table: { name: t.table, description: t.description } } }, catalog);
          pushed += 1;
        }
        for (const c of t.columns) {
          await executeXmlaCommand({ alter: { object: { database: catalog, table: t.table, column: c.name }, column: { name: c.name, description: c.description } } }, catalog);
          pushed += 1;
        }
      }
      xmla = { ok: true, pushed };
    } catch (e: any) {
      xmla = { ok: false, pushed, error: e instanceof AasError ? e.message : (e?.message || String(e)) };
    }
  }

  return {
    tables: tableCount,
    columns: columnCount,
    measures: measureCount,
    backend: 'loom-native',
    ...(xmla ? { xmla } : {}),
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const tenantId = session.claims.oid;

  const mctx = await loadBulkContext(id, workspaceId, tenantId);
  const state = await readSmModelState(id, tenantId).catch(() => ({ tableDescriptions: [] as SmTableDescription[] }));
  const describedTables = new Set((state.tableDescriptions || []).filter((d) => d.description).map((d) => d.table));
  const totalColumns = mctx.tables.reduce((n, t) => n + t.columns.length, 0);
  const describedMeasures = mctx.measures.filter((m) => m.description).length;

  return NextResponse.json({
    ok: true,
    modelName: mctx.modelName,
    counts: {
      tables: mctx.tables.length,
      tablesDescribed: mctx.tables.filter((t) => describedTables.has(t.name)).length,
      columns: totalColumns,
      measures: mctx.measures.length,
      measuresDescribed: describedMeasures,
    },
    tables: mctx.tables,
    existingTableDescriptions: state.tableDescriptions || [],
    ...(mctx.notice ? { notice: mctx.notice } : {}),
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({} as any));
  const apply = body?.apply === true;

  const mctx = await loadBulkContext(id, workspaceId, tenantId);
  if (mctx.tables.length === 0 && mctx.measures.length === 0) {
    return NextResponse.json({
      ok: false,
      error: 'This model has no tables or measures to describe yet. Add tables/measures first, then run the bulk auto-description.',
      notice: mctx.notice,
    }, { status: 400 });
  }

  // Operator-approved descriptions supplied → persist directly (no AOAI call).
  if (apply && (Array.isArray(body?.tables) || Array.isArray(body?.measures))) {
    const validTables = new Map(mctx.tables.map((t) => [t.name, new Set(t.columns)]));
    const validMeasures = new Set(mctx.measures.map((m) => m.name));
    const tableProposals: TableProposal[] = (Array.isArray(body.tables) ? body.tables : [])
      .filter((t: any) => t && typeof t.table === 'string' && validTables.has(t.table))
      .map((t: any) => ({
        table: t.table,
        description: typeof t.description === 'string' ? t.description.trim() : '',
        columns: (Array.isArray(t.columns) ? t.columns : [])
          .filter((c: any) => c && typeof c.name === 'string' && typeof c.description === 'string' && validTables.get(t.table)?.has(c.name))
          .map((c: any) => ({ name: c.name, description: String(c.description).trim() }))
          .filter((c: any) => c.description),
      }));
    const measureProposals: MeasureProposal[] = (Array.isArray(body.measures) ? body.measures : [])
      .filter((m: any) => m && typeof m.name === 'string' && typeof m.description === 'string' && validMeasures.has(m.name))
      .map((m: any) => ({ name: m.name, description: String(m.description).trim() }))
      .filter((m: MeasureProposal) => m.description);
    const applied = await persistDescriptions(id, workspaceId, tenantId, mctx.modelName, tableProposals, measureProposals);
    return NextResponse.json({ ok: true, applied: true, ...applied, modelName: mctx.modelName });
  }

  // Generate proposals via AOAI.
  let proposals: { tables: TableProposal[]; measures: MeasureProposal[] };
  try {
    proposals = await generateProposals(tenantId, mctx.modelName, mctx.tables, mctx.measures);
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      error: e?.message || String(e),
      hint: 'Bulk auto-description uses Azure OpenAI. Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or configure the tenant Copilot account in admin) and grant the Console UAMI "Cognitive Services OpenAI User" on the AOAI account. No Microsoft Fabric / Power BI is required.',
    }, { status: 502 });
  }

  if (!apply) {
    return NextResponse.json({
      ok: true,
      applied: false,
      pendingApproval: true,
      modelName: mctx.modelName,
      proposals,
      note: 'PROPOSED descriptions — nothing was written. Review/edit, then POST again with { apply: true, tables, measures } to persist.',
      ...(mctx.notice ? { notice: mctx.notice } : {}),
    });
  }

  // apply:true with no operator overrides → generate AND persist.
  const applied = await persistDescriptions(id, workspaceId, tenantId, mctx.modelName, proposals.tables, proposals.measures);
  return NextResponse.json({ ok: true, applied: true, ...applied, proposals, modelName: mctx.modelName });
}
