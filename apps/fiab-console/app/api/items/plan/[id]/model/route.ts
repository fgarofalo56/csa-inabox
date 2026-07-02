/**
 * Plan cube-model validation route (Fabric IQ Plan parity — Model/cube tab).
 *
 * Azure-native parity of Microsoft Fabric IQ Plan's multidimensional model: a
 * cube of dimensions (member hierarchies) + reusable measures, plus the guided
 * user formulas that compute over it. This route VALIDATES that model over the
 * plan's Cosmos state — member-parent integrity, hierarchy cycles, duplicate
 * ids/names, measure scope refs, and formula-row ref/cycle integrity. NO
 * Microsoft Fabric dependency (.claude/rules/no-fabric-dependency.md) and no
 * external service — pure validation over the persisted item.
 *
 *   GET  → { ok, model, counts }                 current cube summary
 *   POST { model?, sheets? } → { ok, valid, issues[], counts }
 *          Validates the supplied model/sheets (what's on screen) or, when
 *          omitted, the persisted plan.state. `valid` is false when any issue is
 *          level:'error'; warnings never block. Honest — never fakes a pass.
 *
 * Per no-vaporware.md the validation is real (the same pure helpers the editor
 * grid evaluates with), surfaced as a precise issue list the editor renders.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnedItem } from '../../../_lib/item-crud';
import {
  validateModel, validateFormulaRows, emptyPlanModel,
  type PlanModel, type PlanningSheet, type ModelIssue,
} from '@/lib/editors/_plan-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'plan';

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

function asModel(v: unknown): PlanModel {
  if (v && typeof v === 'object') {
    const m = v as any;
    return {
      dimensions: Array.isArray(m.dimensions) ? m.dimensions : [],
      measures: Array.isArray(m.measures) ? m.measures : [],
    };
  }
  return emptyPlanModel();
}
function asSheets(v: unknown): PlanningSheet[] {
  return Array.isArray(v) ? (v as PlanningSheet[]) : [];
}

function modelCounts(model: PlanModel, sheets: PlanningSheet[]) {
  const members = model.dimensions.reduce((acc, d) => acc + (d.members?.length || 0), 0);
  const formulaRows = sheets.reduce(
    (acc, s) => acc + (s.lineItems || []).filter((li) => li.kind === 'formula').length, 0);
  return {
    dimensions: model.dimensions.length,
    members,
    measures: model.measures.length,
    sheets: sheets.length,
    formulaRows,
  };
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the plan first (no id yet)', 400);

  const plan = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!plan) return err('plan not found', 404);

  const state: any = plan.state || {};
  const model = asModel(state.model);
  const sheets = asSheets(state.sheets);
  return NextResponse.json({ ok: true, model, counts: modelCounts(model, sheets) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const { id } = await ctx.params;
  if (!id || id === 'new') return err('save the plan before validating the model (no id yet)', 400);

  const plan = await loadOwnedItem(id, ITEM_TYPE, s.claims.oid);
  if (!plan) return err('plan not found', 404);

  const body = await req.json().catch(() => ({} as any));
  const state: any = plan.state || {};
  // Validate what the editor sent (pre-save), else the persisted state.
  const model = asModel('model' in (body || {}) ? body.model : state.model);
  const sheets = asSheets('sheets' in (body || {}) ? body.sheets : state.sheets);

  const lineItemIds = sheets.flatMap((sh) => (sh.lineItems || []).map((li) => li.id));
  const issues: ModelIssue[] = [];

  const mv = validateModel(model, lineItemIds);
  issues.push(...mv.issues);

  for (const sheet of sheets) {
    const fv = validateFormulaRows(sheet);
    issues.push(...fv.issues.map((iss) => ({
      ...iss,
      message: sheets.length > 1 ? `[${sheet.name}] ${iss.message}` : iss.message,
    })));
  }

  const errors = issues.filter((x) => x.level === 'error').length;
  const warnings = issues.filter((x) => x.level === 'warning').length;
  const valid = errors === 0;

  return NextResponse.json({
    ok: true,
    valid,
    issues,
    errors,
    warnings,
    counts: modelCounts(model, sheets),
    message: valid
      ? `Model valid — ${modelCounts(model, sheets).dimensions} dimension(s), ${modelCounts(model, sheets).measures} measure(s)${warnings ? `, ${warnings} warning(s)` : ''}.`
      : `${errors} error(s) found in the model.`,
  });
}
