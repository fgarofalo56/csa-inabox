/**
 * /api/items/semantic-model/[id]/model-health — Copilot autonomous model-health
 * scan + apply-fix (FGC-22).
 *
 * Parity with the June-2026 Power BI "Copilot can modify a semantic model"
 * feature, but Azure-native: a Best-Practice-Analyzer-style rule set runs over
 * the Loom-native tabular model (relationships + measures + date marks from the
 * Cosmos model store) and the item's table/column content — then Azure OpenAI
 * generates fix proposals (measure descriptions) and the user applies approved
 * fixes through the SAME checkpoint/approval plumbing the NL-structure Copilot
 * uses. NO api.powerbi.com / api.fabric.microsoft.com on any path.
 *
 *   POST { action:'scan' }                → { findings, fixable, backend }
 *   POST { action:'apply', fixes:[...],   → checkpoint THEN writeModelState;
 *          label? }                          { applied, skipped, checkpoint }
 *   GET  ?action=checkpoints              → list checkpoints (the restore target)
 *   POST { action:'restore', checkpointId}→ restore a checkpoint
 *
 * NO-VAPORWARE: real Cosmos read/write, real tabular metadata, real AOAI. The
 * scan works with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET and no AAS server bound;
 * AOAI-missing degrades to a rule-only scan (descriptions gated honestly), never
 * a fake result.
 */

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import { listTables, resolveBackend } from '@/lib/azure/tabular-eval-client';
import { readModelState, writeModelState, type LoomModelState } from '../../../_lib/model-store';
import { captureCheckpoint, listCheckpoints, restoreCheckpoint } from '../../../_lib/semantic-model-checkpoints';
import {
  analyzeModelHealth, applyHealthFixes,
  type HealthFinding, type HealthFixOp, type HealthTable,
} from '@/lib/semantic-model/model-health';
import { aoaiChat } from '@/lib/azure/aoai-chat-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';
const FIX_KINDS = new Set(['add-relationship', 'mark-date-table', 'set-measure-description']);
const CARDINALITIES = new Set(['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many']);

/** AOAI: generate a one-line business description per measure name. Best-effort:
 *  returns {} when AOAI is not configured (the scan still returns findings). */
async function generateDescriptions(
  tenantId: string,
  measures: Array<{ name: string; expression: string }>,
): Promise<{ map: Record<string, string>; gate?: { missing: string; detail: string } }> {
  if (measures.length === 0) return { map: {} };
  const { loadTenantCopilotConfig } = await import('@/lib/azure/copilot-config-store');
  const cfg = await loadTenantCopilotConfig(tenantId).catch(() => null);
  const list = measures.map((m) => `- ${m.name}: ${(m.expression || '').slice(0, 160)}`).join('\n');
  const system = `You write concise, business-friendly one-line descriptions for DAX measures. Respond with a JSON object ONLY: { "descriptions": { "<measure name>": "<one sentence>" } }. Use ONLY the measure names given. No prose, no code fence.`;
  const user = `Write a one-sentence business description for each measure (what it means to a business user, not how the DAX works):\n${list}`;
  try {
    const raw = await aoaiChat({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      maxCompletionTokens: 700, temperature: 0.2, responseFormat: 'json_object', cfg,
    });
    let parsed: any = {};
    try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
    const d = parsed?.descriptions && typeof parsed.descriptions === 'object' ? parsed.descriptions : {};
    const map: Record<string, string> = {};
    for (const m of measures) {
      const v = d[m.name];
      if (typeof v === 'string' && v.trim()) map[m.name] = v.trim();
    }
    return { map };
  } catch (e: any) {
    return {
      map: {},
      gate: {
        missing: 'LOOM_AOAI_ENDPOINT / LOOM_AOAI_DEPLOYMENT',
        detail: 'Measure-description generation needs an Azure OpenAI chat deployment. Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or configure the tenant Copilot account in Admin → Copilot) and grant the Console UAMI Cognitive Services OpenAI User. Rule-based findings (relationships, date table, unused columns) are shown regardless — no Microsoft Fabric / Power BI required.',
      },
    };
  }
}

function toHealthTables(tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }>): HealthTable[] {
  return tables.map((t) => ({ name: t.name, columns: (t.columns || []).map((c) => ({ name: c.name, dataType: c.dataType })) }));
}

/** Validate an incoming fix op from the client (defense-in-depth before apply). */
function sanitizeFix(raw: any): HealthFixOp | null {
  const kind = String(raw?.kind || '');
  if (!FIX_KINDS.has(kind)) return null;
  if (kind === 'add-relationship') {
    const fromTable = String(raw.fromTable || '').trim();
    const fromColumn = String(raw.fromColumn || '').trim();
    const toTable = String(raw.toTable || '').trim();
    const toColumn = String(raw.toColumn || '').trim();
    const cardinality = (CARDINALITIES.has(String(raw.cardinality)) ? raw.cardinality : 'many-to-one') as 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many';
    if (!fromTable || !fromColumn || !toTable || !toColumn) return null;
    return { kind: 'add-relationship', fromTable, fromColumn, toTable, toColumn, cardinality };
  }
  if (kind === 'mark-date-table') {
    const table = String(raw.table || '').trim();
    const dateColumn = String(raw.dateColumn || '').trim();
    if (!table || !dateColumn) return null;
    return { kind: 'mark-date-table', table, dateColumn };
  }
  // set-measure-description
  const measure = String(raw.measure || '').trim();
  const description = String(raw.description || '').trim();
  if (!measure || !description) return null;
  return { kind: 'set-measure-description', measure, description };
}

async function runScan(id: string, tenantId: string) {
  const [tables, model] = await Promise.all([
    listTables(id, tenantId),
    readModelState(id, ITEM_TYPE, tenantId),
  ]);
  if (!model.itemFound && tables.length === 0) return null;

  const findings = analyzeModelHealth({
    tables: toHealthTables(tables),
    measures: model.state.measures.map((m) => ({ name: m.name, expression: m.expression, description: m.description, schema: m.schema })),
    relationships: model.state.relationships as any,
    dateTables: (model.state.dateTables || []) as any,
  });

  // Enrich measure-no-description fixes with AOAI-generated text.
  const needDesc = findings.filter((f) => f.rule === 'measure-no-description' && f.fix?.kind === 'set-measure-description');
  let gate: { missing: string; detail: string } | undefined;
  if (needDesc.length > 0) {
    const byName = new Map(model.state.measures.map((m) => [m.name, m.expression]));
    const measures = needDesc.map((f) => ({ name: (f.fix as any).measure as string, expression: byName.get((f.fix as any).measure) || '' }));
    const { map, gate: g } = await generateDescriptions(tenantId, measures);
    gate = g;
    for (const f of needDesc) {
      const name = (f.fix as any).measure as string;
      const text = map[name];
      if (text) (f.fix as any).description = text;
      else f.fix = undefined; // no description available → not applyable this run
    }
  }

  const fixable = findings.filter((f) => !!f.fix).length;
  return { findings, fixable, gate };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const action = req.nextUrl.searchParams.get('action') || 'checkpoints';
  if (action === 'checkpoints') {
    const checkpoints = await listCheckpoints(id, ITEM_TYPE, session.claims.oid);
    if (checkpoints === null) return apiError('Semantic model not found or not owned by you.', 404);
    return apiOk({ checkpoints });
  }
  return apiError(`unknown action "${action}"`, 400);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || 'scan').trim();

  try {
    if (action === 'scan') {
      const scan = await runScan(id, tenantId);
      if (!scan) return apiError('Semantic model not found or not owned by you.', 404);
      return apiOk({ findings: scan.findings, fixable: scan.fixable, backend: resolveBackend(), ...(scan.gate ? { gate: scan.gate } : {}) });
    }

    if (action === 'apply') {
      const rawFixes: any[] = Array.isArray(body?.fixes) ? body.fixes : [];
      const fixes = rawFixes.map(sanitizeFix).filter((f): f is HealthFixOp => !!f);
      if (fixes.length === 0) return apiError('No valid fixes to apply.', 400);

      const { state: model, itemFound } = await readModelState(id, ITEM_TYPE, tenantId);
      if (!itemFound) return apiError('Semantic model not found or not owned by you.', 404);

      // 1) Checkpoint the CURRENT structure first (the restore target).
      const label = String(body?.label || '').trim() || `Before model-health fix: ${fixes.length} fix(es)`.slice(0, 140);
      const checkpoint = await captureCheckpoint(id, ITEM_TYPE, tenantId, label, 'copilot');
      if (!checkpoint) return apiError('Failed to capture a checkpoint; aborting before any edit.', 500, { code: 'checkpoint_failed' });

      // 2) Apply to the Loom-native store (Azure-native DEFAULT — always works).
      const now = new Date().toISOString();
      const portion = {
        measures: model.measures as any,
        relationships: model.relationships as any,
        dateTables: (model.dateTables || []) as any,
      };
      const { next, applied, skipped } = applyHealthFixes(
        portion, fixes, now,
        () => globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      const nextModel: LoomModelState = { ...model, measures: next.measures as any, relationships: next.relationships as any, dateTables: next.dateTables as any };
      const wrote = await writeModelState(id, ITEM_TYPE, tenantId, nextModel);
      if (!wrote) return apiServerError(new Error('writeModelState returned false'), 'Failed to persist the fixes.', 'write_failed');

      return apiOk({ applied, skipped, checkpoint, backend: 'loom-native' });
    }

    if (action === 'restore') {
      const checkpointId = String(body?.checkpointId || '').trim();
      if (!checkpointId) return apiError('checkpointId is required', 400);
      const restored = await restoreCheckpoint(id, ITEM_TYPE, tenantId, checkpointId);
      if (!restored) return apiError('Checkpoint not found or model not owned by you.', 404);
      return apiOk({ note: `Restored "${restored.restoredFrom.label}".`, stats: restored.restoredFrom.stats });
    }

    return apiError(`unknown action "${action}" — expected scan | apply | restore`, 400);
  } catch (e) {
    return apiServerError(e, 'Model-health request failed.');
  }
}
