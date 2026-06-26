/**
 * /api/items/semantic-model/[id]/copilot-structure — Copilot model-structure
 * pane (audit-T82).
 *
 * The DAX Copilot already does auto-describe (proposes measure descriptions);
 * this route adds NATURAL-LANGUAGE MODEL-STRUCTURE EDITS with a checkpoint
 * safety net:
 *   - rename a measure
 *   - set / clear a measure's business description
 *   - suggest relationships between tables
 *   - capture + restore structure checkpoints
 *
 * Two-phase, human-in-the-loop (no surprise writes):
 *   POST { action:'propose', prompt }            → AOAI parses the request into a
 *                                                   structured EDIT PLAN (no write)
 *   POST { action:'apply', plan, label? }        → checkpoint THEN apply each op
 *   GET  ?action=checkpoints                      → list checkpoints (newest first)
 *   POST { action:'restore', checkpointId }      → restore a checkpoint
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the DEFAULT
 * backend is the Loom-native tabular model store (Cosmos item.state.model — the
 * SAME store the DAX Copilot writes). Every structure edit + checkpoint works
 * with LOOM_DEFAULT_FABRIC_WORKSPACE UNSET and no XMLA endpoint. When an opt-in
 * XMLA backend is configured (LOOM_AAS_SERVER_URL / LOOM_POWERBI_XMLA_ENDPOINT)
 * the edit is ALSO mirrored to the live tabular model via TMSL Alter — that
 * mirror is best-effort and its failure NEVER drops the Cosmos write (source of
 * truth). No api.powerbi.com / api.fabric.microsoft.com on the default path.
 *
 * NO-VAPORWARE (.claude/rules/no-vaporware.md): real AOAI call, real Cosmos
 * read/write, real XMLA Alter when configured. No mocks, no return [].
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  readModelState, writeModelState,
  type LoomModelState, type StoredMeasure,
} from '../../../_lib/model-store';
import {
  captureCheckpoint, listCheckpoints, restoreCheckpoint,
} from '../../../_lib/semantic-model-checkpoints';
import {
  aasXmlaConfig, command as executeXmlaCommand, AasError,
  buildRenameMeasureTmsl, buildSetMeasureDescriptionTmsl,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';

// ── Edit-plan shapes (the structured output of `propose`) ───────────────────

type StructureOp =
  | { kind: 'rename-measure'; from: string; to: string }
  | { kind: 'set-measure-description'; measure: string; description: string }
  | { kind: 'suggest-relationship'; fromTable: string; fromColumn: string; toTable: string; toColumn: string; cardinality: 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many'; rationale?: string };

interface EditPlan {
  summary: string;
  ops: StructureOp[];
}

const CARDINALITIES = ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'] as const;

// ── AOAI plan generation (mirrors dax-tools.ts transport, cloud-portable) ───

async function aoaiPlan(userOid: string, system: string, user: string): Promise<string> {
  const [{ resolveAoaiTarget }, { loadTenantCopilotConfig }] = await Promise.all([
    import('@/lib/azure/copilot-orchestrator'),
    import('@/lib/azure/copilot-config-store'),
  ]);
  const cfg = await loadTenantCopilotConfig(userOid).catch(() => null);
  const target = await resolveAoaiTarget(cfg);

  const { uamiArmCredential } = await import('@/lib/azure/arm-credential');
  const { cogScope } = await import('@/lib/azure/cloud-endpoints');
  // ACA-first UAMI chain (shared helper) — AcaManagedIdentityCredential is the
  // first link so the ACA MI token bug never breaks AOAI token acquisition.
  const credential = uamiArmCredential();
  const tok = await credential.getToken(cogScope());
  if (!tok?.token) throw new Error('Failed to acquire an Azure OpenAI token for the model-structure Copilot.');

  const url = `${target.endpoint}/openai/deployments/${encodeURIComponent(target.deployment)}/chat/completions?api-version=${target.apiVersion}`;
  const payload: Record<string, unknown> = {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_completion_tokens: 900,
    temperature: 0.1,
    response_format: { type: 'json_object' },
  };
  const send = (b: Record<string, unknown>) => fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(b),
    signal: AbortSignal.timeout(40_000),
  });
  let res = await send(payload);
  if (res.status === 400) {
    const t = await res.text();
    if (/temperature|unsupported_value|does not support/i.test(t)) {
      const { temperature, ...rest } = payload;
      res = await send(rest);
    } else {
      throw new Error(`Azure OpenAI returned 400: ${t.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Azure OpenAI chat failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const body = await res.json();
  return String(body?.choices?.[0]?.message?.content ?? '').trim();
}

/** Compact schema fed to AOAI so it grounds edits in the real model. */
function schemaContext(model: LoomModelState): string {
  const lines: string[] = [];
  for (const m of model.measures) {
    lines.push(`MEASURE [${m.name}]${m.description ? ` (desc: ${m.description})` : ''} = ${(m.expression || '').slice(0, 200)}`);
  }
  for (const r of model.relationships) {
    lines.push(`RELATIONSHIP ${r.fromTable}[${r.fromColumn}] ${r.cardinality} ${r.toTable}[${r.toColumn}]`);
  }
  // Distinct table names appearing in relationships/measures help the model
  // ground "suggest relationship" — there is no separate table list in the
  // Loom-native store, so derive what we can.
  const tables = new Set<string>();
  for (const r of model.relationships) { tables.add(r.fromTable); tables.add(r.toTable); }
  if (tables.size) lines.push(`TABLES: ${[...tables].join(', ')}`);
  return lines.join('\n') || '(model has no measures or relationships defined yet)';
}

function normalizePlan(raw: string, model: LoomModelState): EditPlan {
  let parsed: any = {};
  try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
  const opsRaw: any[] = Array.isArray(parsed?.ops) ? parsed.ops : [];
  const measureNames = new Set(model.measures.map((m) => m.name));
  const ops: StructureOp[] = [];
  for (const o of opsRaw) {
    const kind = String(o?.kind || '').trim();
    if (kind === 'rename-measure') {
      const from = String(o.from || '').trim();
      const to = String(o.to || '').trim();
      if (from && to && from !== to && measureNames.has(from)) ops.push({ kind, from, to });
    } else if (kind === 'set-measure-description') {
      const measure = String(o.measure || '').trim();
      const description = String(o.description || '').trim();
      if (measure && description && measureNames.has(measure)) ops.push({ kind, measure, description });
    } else if (kind === 'suggest-relationship') {
      const fromTable = String(o.fromTable || '').trim();
      const fromColumn = String(o.fromColumn || '').trim();
      const toTable = String(o.toTable || '').trim();
      const toColumn = String(o.toColumn || '').trim();
      const cardinality = (CARDINALITIES as readonly string[]).includes(String(o.cardinality))
        ? (o.cardinality as StructureOp & { kind: 'suggest-relationship' })['cardinality']
        : 'many-to-one';
      if (fromTable && fromColumn && toTable && toColumn) {
        ops.push({ kind, fromTable, fromColumn, toTable, toColumn, cardinality, rationale: String(o.rationale || '').trim() || undefined });
      }
    }
  }
  return { summary: String(parsed?.summary || '').trim() || `${ops.length} proposed structure edit(s).`, ops };
}

// ── Apply ops to the Loom-native model store (the Azure-native DEFAULT) ──────

function applyOpsToModel(model: LoomModelState, ops: StructureOp[]): { next: LoomModelState; applied: string[]; skipped: string[] } {
  const now = new Date().toISOString();
  let measures: StoredMeasure[] = model.measures.map((m) => ({ ...m }));
  const relationships = model.relationships.map((r) => ({ ...r }));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const op of ops) {
    if (op.kind === 'rename-measure') {
      const idx = measures.findIndex((m) => m.name === op.from);
      if (idx < 0) { skipped.push(`Rename skipped: measure [${op.from}] not found.`); continue; }
      if (measures.some((m) => m.name === op.to)) { skipped.push(`Rename skipped: a measure named [${op.to}] already exists.`); continue; }
      measures[idx] = { ...measures[idx], name: op.to, updatedAt: now };
      applied.push(`Renamed measure [${op.from}] → [${op.to}].`);
    } else if (op.kind === 'set-measure-description') {
      const idx = measures.findIndex((m) => m.name === op.measure);
      if (idx < 0) { skipped.push(`Description skipped: measure [${op.measure}] not found.`); continue; }
      measures[idx] = { ...measures[idx], description: op.description, updatedAt: now };
      applied.push(`Set description on [${op.measure}].`);
    } else if (op.kind === 'suggest-relationship') {
      const exists = relationships.some((r) =>
        r.fromTable === op.fromTable && r.fromColumn === op.fromColumn &&
        r.toTable === op.toTable && r.toColumn === op.toColumn);
      if (exists) { skipped.push(`Relationship ${op.fromTable}[${op.fromColumn}] → ${op.toTable}[${op.toColumn}] already exists.`); continue; }
      relationships.push({
        id: globalThis.crypto?.randomUUID?.() ?? `rel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: `FK_${op.fromTable.split('.').pop()}_${op.toTable.split('.').pop()}`.replace(/[^A-Za-z0-9_]/g, '_'),
        fromTable: op.fromTable, fromColumn: op.fromColumn, toTable: op.toTable, toColumn: op.toColumn,
        cardinality: op.cardinality, crossFilter: 'single', active: true, source: 'cosmos',
        createdAt: now, updatedAt: now,
      });
      applied.push(`Added relationship ${op.fromTable}[${op.fromColumn}] → ${op.toTable}[${op.toColumn}] (${op.cardinality}).`);
    }
  }
  return { next: { measures, relationships }, applied, skipped };
}

/**
 * Best-effort mirror of measure renames + descriptions to the live tabular
 * model via TMSL Alter — ONLY when an XMLA backend is configured. Never throws;
 * returns a per-op outcome list. Relationships are not mirrored here (the
 * model-view canvas owns relationship TMSL via the existing /model route).
 */
async function mirrorToXmla(
  model: LoomModelState,
  ops: StructureOp[],
): Promise<{ attempted: boolean; backend?: string; results: Array<{ op: string; ok: boolean; error?: string }> }> {
  const cfg = aasXmlaConfig();
  if (!cfg) return { attempted: false, results: [] };
  const db = cfg.database;
  const results: Array<{ op: string; ok: boolean; error?: string }> = [];
  const findExpr = (name: string) => model.measures.find((m) => m.name === name)?.expression || '';
  // A measure's "table" in the Loom store maps to its `schema`; default to the
  // first measure's schema or 'Measures' (a common AAS measure-host table).
  const tableFor = (name: string) => model.measures.find((m) => m.name === name)?.schema || 'Measures';

  for (const op of ops) {
    try {
      if (op.kind === 'rename-measure') {
        await executeXmlaCommand(buildRenameMeasureTmsl(db, tableFor(op.from), op.from, op.to, findExpr(op.from)), db);
        results.push({ op: `rename [${op.from}]→[${op.to}]`, ok: true });
      } else if (op.kind === 'set-measure-description') {
        await executeXmlaCommand(buildSetMeasureDescriptionTmsl(db, tableFor(op.measure), op.measure, findExpr(op.measure), op.description), db);
        results.push({ op: `describe [${op.measure}]`, ok: true });
      }
      // suggest-relationship is persisted Loom-native only here.
    } catch (e: any) {
      const msg = e instanceof AasError ? `${e.status}: ${e.message}` : (e?.message || String(e));
      results.push({ op: op.kind, ok: false, error: msg });
    }
  }
  return { attempted: true, backend: cfg.backend, results };
}

// ── Handlers ────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const action = req.nextUrl.searchParams.get('action') || 'checkpoints';

  if (action === 'checkpoints') {
    const checkpoints = await listCheckpoints(id, ITEM_TYPE, session.claims.oid);
    if (checkpoints === null) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });
    return NextResponse.json({ ok: true, checkpoints });
  }

  if (action === 'model') {
    const { state, itemFound } = await readModelState(id, ITEM_TYPE, session.claims.oid);
    if (!itemFound) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });
    return NextResponse.json({ ok: true, measures: state.measures, relationships: state.relationships });
  }

  return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;
  const body = await req.json().catch(() => ({} as any));
  const action = String(body?.action || '').trim();

  // ── propose: NL → structured edit plan (no write) ──────────────────────────
  if (action === 'propose') {
    const prompt = String(body?.prompt || '').trim();
    if (!prompt) return NextResponse.json({ ok: false, error: 'prompt is required' }, { status: 400 });
    const { state: model, itemFound } = await readModelState(id, ITEM_TYPE, tenantId);
    if (!itemFound) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });

    const system = `You translate natural-language requests into a STRUCTURED model-structure edit plan for a Loom-native tabular semantic model.
Respond with a JSON object ONLY: { "summary": "...", "ops": [ ... ] }. No prose, no code fence.
Each op is ONE of:
  { "kind": "rename-measure", "from": "<existing measure name>", "to": "<new name>" }
  { "kind": "set-measure-description", "measure": "<existing measure name>", "description": "<1-2 business sentences>" }
  { "kind": "suggest-relationship", "fromTable": "...", "fromColumn": "...", "toTable": "...", "toColumn": "...", "cardinality": "many-to-one|one-to-many|one-to-one|many-to-many", "rationale": "<why>" }
RULES:
 - Use ONLY measure / table / column names that appear in the MODEL below. Never invent names.
 - For "describe all measures", emit one set-measure-description op per measure that lacks a description.
 - For relationship suggestions, infer likely keys from naming (e.g. fact[CustomerKey] → dim[CustomerKey]) and prefer many-to-one.
 - If nothing can be done, return { "summary": "...", "ops": [] } with an explanation in summary.

MODEL:
${schemaContext(model)}`;

    let raw: string;
    try {
      raw = await aoaiPlan(tenantId, system, prompt);
    } catch (e: any) {
      return NextResponse.json({
        ok: false,
        error: e?.message || String(e),
        gate: {
          missing: 'LOOM_AOAI_ENDPOINT / LOOM_AOAI_DEPLOYMENT',
          detail: 'The model-structure Copilot needs an Azure OpenAI chat deployment. Set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT (or configure the tenant Copilot account in Admin → Copilot), and grant the Console UAMI Cognitive Services OpenAI User on the account. No Microsoft Fabric / Power BI required.',
        },
      }, { status: 502 });
    }
    const plan = normalizePlan(raw, model);
    return NextResponse.json({ ok: true, plan, pendingApproval: true, note: 'Nothing was written. Review the plan, then POST { action:"apply", plan } to apply it (a checkpoint is captured first).' });
  }

  // ── apply: checkpoint THEN apply the (approved) plan ───────────────────────
  if (action === 'apply') {
    const plan = body?.plan as EditPlan | undefined;
    const ops = Array.isArray(plan?.ops) ? plan!.ops : [];
    if (ops.length === 0) return NextResponse.json({ ok: false, error: 'plan.ops is empty — nothing to apply.' }, { status: 400 });
    const { state: model, itemFound } = await readModelState(id, ITEM_TYPE, tenantId);
    if (!itemFound) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });

    // Re-validate the ops against the CURRENT model (the plan may be stale) and
    // compute the next state.
    const revalidated = normalizePlan(JSON.stringify({ summary: plan?.summary, ops }), model).ops;
    if (revalidated.length === 0) {
      return NextResponse.json({ ok: false, error: 'None of the plan ops are valid against the current model (names may have changed). Re-run propose.' }, { status: 409 });
    }

    // 1) Checkpoint current structure first (the safety net / "restore" target).
    const label = String(body?.label || '').trim() || `Before Copilot: ${plan?.summary || `${revalidated.length} edit(s)`}`.slice(0, 140);
    const checkpoint = await captureCheckpoint(id, ITEM_TYPE, tenantId, label, 'copilot');
    if (!checkpoint) return NextResponse.json({ ok: false, error: 'Failed to capture a checkpoint; aborting before any edit.' }, { status: 500 });

    // 2) Apply to the Loom-native store (Azure-native DEFAULT — always works).
    const { next, applied, skipped } = applyOpsToModel(model, revalidated);
    const wrote = await writeModelState(id, ITEM_TYPE, tenantId, next);
    if (!wrote) return NextResponse.json({ ok: false, error: 'Failed to persist the edited model.', checkpointId: checkpoint.id }, { status: 500 });

    // 3) Best-effort mirror to the live tabular model via XMLA (opt-in only).
    const xmla = await mirrorToXmla(next, revalidated);

    return NextResponse.json({
      ok: true,
      applied,
      skipped,
      checkpoint,
      backend: 'loom-native',
      xmla,
      note: xmla.attempted
        ? `Edits persisted Loom-native AND mirrored to the live ${xmla.backend} XMLA model.`
        : 'Edits persisted to the Loom-native model. No XMLA endpoint is configured, so they will be emitted into the model.bim at provision time (set LOOM_AAS_SERVER_URL to also write a live Azure Analysis Services model — no Microsoft Fabric / Power BI required).',
    });
  }

  // ── restore: roll back to a checkpoint ─────────────────────────────────────
  if (action === 'restore') {
    const checkpointId = String(body?.checkpointId || '').trim();
    if (!checkpointId) return NextResponse.json({ ok: false, error: 'checkpointId is required' }, { status: 400 });
    const result = await restoreCheckpoint(id, ITEM_TYPE, tenantId, checkpointId);
    if (!result) return NextResponse.json({ ok: false, error: 'Checkpoint not found (or the model is not owned by you).' }, { status: 404 });
    return NextResponse.json({
      ok: true,
      restoredFrom: result.restoredFrom,
      model: { measures: result.model.measures, relationships: result.model.relationships },
      note: 'Model structure restored. A pre-restore snapshot was captured automatically so this restore is itself reversible.',
    });
  }

  // ── checkpoint: capture current structure on demand (manual save point) ────
  if (action === 'checkpoint') {
    const label = String(body?.label || '').trim() || 'Manual checkpoint';
    const checkpoint = await captureCheckpoint(id, ITEM_TYPE, tenantId, label, 'manual');
    if (!checkpoint) return NextResponse.json({ ok: false, error: 'Semantic model not found or not owned by you.' }, { status: 404 });
    return NextResponse.json({ ok: true, checkpoint });
  }

  return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
}
