/**
 * POST /api/items/report/[id]/ai-visual
 *
 * Azure-native AOAI backing for the report designer's AI VISUALS (parity wave 3,
 * docs/fiab/parity/report-designer.md) — Smart narrative + Q&A. Sibling to the
 * report DESIGNER Copilot (../powerbi-copilot) but purpose-built: it returns a
 * STRUCTURED JSON result the visual renders inline (no SSE chat loop), reusing the
 * SAME Azure OpenAI deployment the Copilot uses.
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the only backend
 * reached here is the Foundry-hub AOAI (resolveAoaiTarget → cognitiveservices,
 * Console UAMI) — NEVER api.fabric.microsoft.com / api.powerbi.com. The bound
 * model's field list + the active visuals' REAL …/query rows are passed in by the
 * pane; this route adds intelligence over them, it does not query a Fabric host.
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md): both modes call REAL AOAI. When no
 * AOAI deployment is wired the pre-flight returns an honest 503 { ok:false, error }
 * (same gate the report Copilot uses) so the pane can deep-link the Foundry CTA —
 * never a fabricated narrative. The two AI visuals that drill on real SQL
 * (Decomposition tree, Key influencers) self-query the unchanged …/query route and
 * need NO call here.
 *
 * NO-FREEFORM-CONFIG (.claude/rules/no-freeform-config.md): Q&A does NOT emit raw
 * DAX/SQL — it returns a structured { type, title, wells } designer spec, validated
 * by the SAME report-designer-tools sanitizer the Copilot's
 * report_designer_add_visual uses (rejecting unknown visual types + fields that
 * reference no real column/measure), then additionally re-checked against the bound
 * model's field list so a hallucinated field can never reach …/query.
 *
 * Body: { mode:'narrative'|'qa', context?, question?, fields? }
 *   - mode 'narrative' → summarize `context` (the active page/visuals' real query
 *     result rows the pane collected) → { ok:true, narrative, bullets[] }.
 *   - mode 'qa'        → turn `question` (NL) into a designer visual spec grounded
 *     in `fields` (the bound model's tables/columns/measures) → { ok:true, spec }.
 *     The pane renders the spec inline via the shared queryAdHoc (POST …/query) and
 *     offers "Turn into a standard visual" (the same onApplyVisual path the Copilot
 *     uses) — a cross-table spec surfaces /query's honest code:'multi-table' 400.
 *
 * runtime nodejs, force-dynamic. Auth via getSession (401).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
  aoaiCompleteJson,
  type ToolContext,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  buildReportDesignerActTools,
  DESIGNER_VISUAL_TYPES,
  type DesignerVisualSpec,
} from '@/lib/copilot/report-designer-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Bound-model field list shape the designer reads from …/fields and the pane
 *  injects here (same shape the report Copilot grounds on). */
interface FieldsCtx {
  tables?: Array<{
    name?: string;
    columns?: Array<{ name?: string; dataType?: string }>;
    measures?: Array<{ name?: string }>;
  }>;
}

interface AiVisualRequest {
  mode?: 'narrative' | 'qa';
  /** narrative: the active page/visuals' REAL …/query rows (+ optional titles). */
  context?: unknown;
  /** qa: the user's natural-language question. */
  question?: string;
  /** qa: the bound model's tables/columns/measures (grounding). */
  fields?: FieldsCtx;
}

/** Render the bound model's fields as a compact grounding block (real names only)
 *  — mirrors the report Copilot's serializeFields so Q&A grounds identically. */
function serializeFields(fields: FieldsCtx | undefined): string {
  const tables = Array.isArray(fields?.tables) ? fields!.tables! : [];
  if (tables.length === 0) return 'BOUND MODEL FIELDS: none.';
  const lines = tables.slice(0, 60).map((t) => {
    const cols = (t.columns || []).slice(0, 80).map((c) => c?.name).filter(Boolean).join(', ');
    const meas = (t.measures || []).slice(0, 80).map((m) => m?.name).filter(Boolean).join(', ');
    return `- ${t.name}: columns [${cols}]${meas ? ` · measures [${meas}]` : ''}`;
  });
  return `BOUND MODEL FIELDS (reference ONLY these — table.column for columns, the measure name for measures):\n${lines.join('\n')}`;
}

/** Lowercased lookup sets for "field actually exists in the model" validation. */
interface ModelIndex {
  columns: Set<string>;                 // any column name (table-agnostic)
  measures: Set<string>;                // any measure name
  byTable: Map<string, Set<string>>;    // table → its column names (table-scoped)
  empty: boolean;
}

function indexModel(fields: FieldsCtx | undefined): ModelIndex {
  const columns = new Set<string>();
  const measures = new Set<string>();
  const byTable = new Map<string, Set<string>>();
  const tables = Array.isArray(fields?.tables) ? fields!.tables! : [];
  for (const t of tables) {
    const tn = String(t?.name ?? '').trim().toLowerCase();
    const set = byTable.get(tn) ?? new Set<string>();
    for (const c of t?.columns || []) {
      const cn = String(c?.name ?? '').trim();
      if (cn) { columns.add(cn.toLowerCase()); set.add(cn.toLowerCase()); }
    }
    if (tn) byTable.set(tn, set);
    for (const m of t?.measures || []) {
      const mn = String(m?.name ?? '').trim();
      if (mn) measures.add(mn.toLowerCase());
    }
  }
  return { columns, measures, byTable, empty: columns.size === 0 && measures.size === 0 };
}

/** A sanitized well field references a column (optionally table-qualified) or a
 *  measure; accept it only when that reference exists in the bound model. */
function fieldInModel(
  f: { table?: string; column?: string; measure?: string },
  idx: ModelIndex,
): boolean {
  if (f.measure) return idx.measures.has(f.measure.toLowerCase());
  if (f.column) {
    const col = f.column.toLowerCase();
    if (f.table) {
      const set = idx.byTable.get(f.table.toLowerCase());
      // If we know the named table, the column must belong to it; if the table
      // name is unknown to the model, fall back to a model-wide column check.
      if (set) return set.has(col);
    }
    return idx.columns.has(col);
  }
  return false;
}

/** Convert a NoAoaiDeploymentError to the honest 503 gate, anything else to 502. */
function aoaiErrorResponse(e: unknown) {
  if (e instanceof NoAoaiDeploymentError) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 503 });
  }
  const msg = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ ok: false, error: msg }, { status: 502 });
}

export async function POST(req: NextRequest, _ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: AiVisualRequest = {};
  try { body = (await req.json()) as AiVisualRequest; } catch { /* empty body → 400 below */ }
  const mode = body.mode;
  if (mode !== 'narrative' && mode !== 'qa') {
    return NextResponse.json(
      { ok: false, error: "mode is required and must be 'narrative' or 'qa'." },
      { status: 400 },
    );
  }

  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid);

  // Pre-flight: surface AOAI-missing as 503 so the pane can deep-link Foundry —
  // the SAME honest gate the report Copilot route uses (no-vaporware).
  try {
    await resolveAoaiTarget(tenantConfig);
  } catch (e) {
    return aoaiErrorResponse(e);
  }

  // ── Smart narrative ─────────────────────────────────────────────────────────
  if (mode === 'narrative') {
    // The pane supplies the active visuals' REAL …/query rows; summarize what the
    // data actually shows. Bounded so a large page can't blow the token budget.
    const contextStr = (() => {
      try { return JSON.stringify(body.context ?? null); } catch { return 'null'; }
    })().slice(0, 12_000);

    let result: { narrative?: unknown; bullets?: unknown };
    try {
      result = await aoaiCompleteJson<{ narrative?: unknown; bullets?: unknown }>(
        [
          {
            role: 'system',
            content:
              'You are the Smart Narrative generator for a CSA Loom report. You are given the REAL query ' +
              'result rows of the visuals on the active report page (JSON). Write an executive summary that ' +
              'describes ONLY what these rows actually show — totals, leaders/laggards, notable changes, ' +
              'concentration, and trends. Do NOT invent numbers, categories, or context that is not present ' +
              'in the data, and do NOT speculate about causes. Return a single JSON object exactly of the ' +
              'shape { "narrative": string, "bullets": string[] }: `narrative` is 2-4 plain sentences, ' +
              '`bullets` is 3-6 short standalone insight bullets (each one line, no markdown). If the data ' +
              'is empty, say so honestly in `narrative` and return an empty `bullets` array.',
          },
          { role: 'user', content: `Report page query results (JSON):\n${contextStr}` },
        ],
        tenantConfig,
      );
    } catch (e) {
      return aoaiErrorResponse(e);
    }

    const narrative = typeof result?.narrative === 'string' ? result.narrative.trim() : '';
    const bullets = Array.isArray(result?.bullets)
      ? result.bullets.map((b) => String(b ?? '').trim()).filter(Boolean).slice(0, 8)
      : [];
    return NextResponse.json({ ok: true, narrative, bullets });
  }

  // ── Q&A → structured designer spec ──────────────────────────────────────────
  const question = (body.question || '').trim();
  if (!question) {
    return NextResponse.json({ ok: false, error: 'question is required for mode "qa".' }, { status: 400 });
  }

  const idx = indexModel(body.fields);
  if (idx.empty) {
    // Honest gate (no-vaporware): with no bound-model fields we cannot ground a
    // real, render-able visual — naming the remediation instead of guessing.
    return NextResponse.json(
      {
        ok: false,
        error:
          'No semantic-model fields are available to answer the question. Bind a Loom semantic model ' +
          '(or load the Fields pane) so Q&A can build a visual from real tables, columns, and measures.',
      },
      { status: 400 },
    );
  }

  let raw: { type?: unknown; title?: unknown; wells?: unknown };
  try {
    raw = await aoaiCompleteJson<{ type?: unknown; title?: unknown; wells?: unknown }>(
      [
        {
          role: 'system',
          content:
            'You are the Q&A visual generator for the CSA Loom report designer. Turn the user\'s natural-' +
            'language question into ONE structured visual spec — never DAX, SQL, or prose. Return a single ' +
            'JSON object exactly of the shape ' +
            '{ "type": string, "title": string, "wells": { "category": Field[], "values": Field[], ' +
            '"legend": Field[] } } where a Field is ' +
            '{ "table"?: string, "column"?: string, "measure"?: string, "aggregation"?: ' +
            '"Sum"|"Avg"|"Count"|"Min"|"Max" }. ' +
            `\"type\" MUST be one of: ${DESIGNER_VISUAL_TYPES.join(', ')}. ` +
            'Reference ONLY fields from the BOUND MODEL FIELDS list below — use { "table", "column" } for a ' +
            'column (give it an aggregation when it goes in values) and { "measure" } for a measure. A ' +
            'chart (bar/column/line/area/pie/donut/scatter) needs a category AND values; a card needs ' +
            'values; a table/matrix needs values (its columns); a slicer needs one category. Prefer the ' +
            'fewest fields that answer the question. Keep all fields in a SINGLE table when possible.\n\n' +
            serializeFields(body.fields),
        },
        { role: 'user', content: question },
      ],
      tenantConfig,
    );
  } catch (e) {
    return aoaiErrorResponse(e);
  }

  // Validate the model's spec through the SAME sanitizer the Copilot's
  // report_designer_add_visual tool uses (rejects unknown visual types, drops
  // fields that reference no column/measure, requires ≥1 well field). Reusing the
  // tool keeps a single source of truth for the structured-spec contract.
  const addVisual = buildReportDesignerActTools().find((t) => t.name === 'report_designer_add_visual');
  if (!addVisual) {
    return NextResponse.json({ ok: false, error: 'report designer tools unavailable' }, { status: 500 });
  }
  const wells = (raw?.wells ?? {}) as Record<string, unknown>;
  const toolCtx: ToolContext = {
    userOid: session.claims.oid,
    session: { claims: { oid: session.claims.oid, upn: session.claims.upn, email: session.claims.email } },
  };

  let sanitized: { spec?: DesignerVisualSpec };
  try {
    sanitized = (await addVisual.handler(
      {
        type: raw?.type,
        title: raw?.title,
        category: Array.isArray(wells.category) ? wells.category : [],
        values: Array.isArray(wells.values) ? wells.values : [],
        legend: Array.isArray(wells.legend) ? wells.legend : [],
      },
      toolCtx,
    )) as { spec?: DesignerVisualSpec };
  } catch (e) {
    // The sanitizer threw (unknown visual type / no usable field). Surface the
    // precise reason so the pane can show it (honest, not a dead control).
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: `Could not build a visual from that question: ${msg}` },
      { status: 400 },
    );
  }

  const spec = sanitized?.spec;
  if (!spec) {
    return NextResponse.json(
      { ok: false, error: 'Could not build a visual from that question.' },
      { status: 400 },
    );
  }

  // Second gate (no-vaporware): drop any well field that does NOT exist in the
  // bound model so a hallucinated column/measure can never reach …/query.
  spec.wells = {
    category: spec.wells.category.filter((f) => fieldInModel(f, idx)),
    values: spec.wells.values.filter((f) => fieldInModel(f, idx)),
    legend: spec.wells.legend.filter((f) => fieldInModel(f, idx)),
  };
  const fieldCount = spec.wells.category.length + spec.wells.values.length + spec.wells.legend.length;
  if (fieldCount === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'The question did not map to any field in the bound semantic model. Try naming a measure or ' +
          'column from the Fields pane (e.g. "total sales by region").',
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, spec });
}
