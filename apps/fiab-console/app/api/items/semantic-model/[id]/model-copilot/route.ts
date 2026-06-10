/**
 * /api/items/semantic-model/[id]/model-copilot — the model-structure Copilot
 * BFF for the semantic-model editor's "Copilot" pane.
 *
 * It edits the model STRUCTURE (not DAX expressions) over natural language:
 *   - rename measures          (suggest → approve → apply)
 *   - add measure descriptions (suggest → approve → apply; auto-describe parity)
 *   - suggest relationships    (suggest → approve → apply)
 *   - checkpoint / restore     (snapshot the model before a bulk change, undo it)
 *
 * NO-FABRIC-DEPENDENCY (.claude/rules/no-fabric-dependency.md): the DEFAULT
 * backend is the Loom-native tabular layer — measures + relationships +
 * checkpoints live in Cosmos (item.state.model / item.state.modelCheckpoints)
 * and EVERY action works with NO Power BI / Fabric workspace and NO Analysis
 * Services server bound. The "suggest" actions call Azure OpenAI (the same AOAI
 * data-plane the DAX Copilot uses) grounded on the real model schema; nothing is
 * written until the operator approves and posts the matching "apply" action.
 *
 * Opt-in XMLA writeback (honest, never on the default path): when
 * LOOM_AAS_XMLA_ENDPOINT is configured, an applied rename / description is ALSO
 * pushed to the live Azure Analysis Services model via a TMSL rename / alter
 * command. A backend write that fails is surfaced (backend.error) but never
 * drops the Cosmos write, which is the source of truth and already succeeded.
 *
 * Auth: minted session cookie (getSession). All reads/writes are scoped to the
 * signed-in user's tenant (claims.oid) and item ownership (loadOwnedItem).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import {
  readModelState,
  renameMeasureInState,
  upsertRelationship,
  normalizeRelationship,
  readModelCheckpoints,
  captureModelCheckpoint,
  restoreModelCheckpoint,
  writeModelState,
  type LoomModelState,
  type StoredMeasure,
  type StoredRelationship,
} from '../../../_lib/model-store';
import { aoaiChat } from '@/lib/copilot/aoai-chat';
import {
  aasConfig, aasDefaultDatabase, executeAasXmla,
  buildRenameMeasureTmsl, buildSetMeasureDescriptionTmsl,
} from '@/lib/azure/aas-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ITEM_TYPE = 'semantic-model';

// ── shared helpers ──────────────────────────────────────────────────────────

function buildSchemaContext(state: LoomModelState): string {
  const lines: string[] = [];
  for (const m of state.measures) {
    lines.push(`MEASURE [${m.name}]${m.description ? ` (desc: ${m.description})` : ''} = ${(m.expression || '').slice(0, 200)}`);
  }
  for (const r of state.relationships) {
    lines.push(`RELATIONSHIP ${r.fromTable}[${r.fromColumn}] ${r.cardinality} ${r.toTable}[${r.toColumn}]`);
  }
  return lines.join('\n') || '(model has no measures or relationships defined yet)';
}

/** Parse a JSON object/array out of an AOAI reply, tolerating a code fence. */
function parseJsonReply(raw: string): any {
  const cleaned = (raw || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned || '{}');
  } catch {
    // Last-ditch: pull the first {...} or [...] block.
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    return null;
  }
}

/** Tables + columns inferred from measure schemas + existing relationships. */
function inferTableColumns(state: LoomModelState): Record<string, Set<string>> {
  const tables: Record<string, Set<string>> = {};
  const add = (table: string, col: string) => {
    if (!table || !col) return;
    (tables[table] ||= new Set<string>()).add(col);
  };
  for (const r of state.relationships) {
    add(r.fromTable, r.fromColumn);
    add(r.toTable, r.toColumn);
  }
  return tables;
}

// ── GET — current model summary + checkpoints ───────────────────────────────

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;

  const { state, itemFound } = await readModelState(id, ITEM_TYPE, tenantId);
  if (!itemFound) {
    return NextResponse.json({
      ok: true, itemFound: false,
      measures: [], relationships: [], checkpoints: [],
      xmlaWriteback: aasConfig().available,
      note: 'This id is not a Loom-native semantic-model item you own (a live-only dataset id was supplied). The model-structure Copilot edits Loom-native models — create one to use it.',
    });
  }
  const { checkpoints } = await readModelCheckpoints(id, ITEM_TYPE, tenantId);

  return NextResponse.json({
    ok: true,
    itemFound: true,
    measures: state.measures.map((m) => ({ name: m.name, description: m.description ?? '', expression: m.expression })),
    relationships: state.relationships.map((r) => ({
      id: r.id, name: r.name, fromTable: r.fromTable, fromColumn: r.fromColumn,
      toTable: r.toTable, toColumn: r.toColumn, cardinality: r.cardinality, active: r.active,
    })),
    checkpoints: checkpoints.map((c) => ({
      id: c.id, label: c.label, reason: c.reason, createdAt: c.createdAt,
      measureCount: c.measureCount, relationshipCount: c.relationshipCount,
    })),
    xmlaWriteback: aasConfig().available,
  });
}

// ── suggest handlers (AOAI; read-only — propose, never write) ────────────────

async function suggestRenames(state: LoomModelState, userOid: string) {
  if (!state.measures.length) {
    return { proposals: [] as Array<{ from: string; to: string; rationale: string }>, note: 'No measures on this model yet — add measures first.' };
  }
  const list = state.measures.map((m, i) => `${i + 1}. [${m.name}] = ${(m.expression || '').slice(0, 160)}`).join('\n');
  const raw = await aoaiChat(
    userOid,
    'You are a tabular-model naming expert. Propose clearer, business-friendly names for DAX measures that have awkward or unclear names. Use Title Case with spaces (e.g. "Total Sales", "YoY Growth %"). Do NOT propose a rename when the current name is already good — omit it. Respond ONLY with JSON {"renames":[{"from":"<current>","to":"<proposed>","rationale":"<short reason>"}]} and nothing else.',
    `Propose better names for these measures (only the ones that need it):\n${list}`,
    { maxTokens: 700, temperature: 0.2, jsonObject: true },
  );
  const parsed = parseJsonReply(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed?.renames ?? parsed?.measures ?? []);
  const known = new Set(state.measures.map((m) => m.name));
  const proposals = (Array.isArray(arr) ? arr : [])
    .filter((p: any) => p && typeof p.from === 'string' && typeof p.to === 'string' && known.has(p.from) && p.from !== p.to)
    .map((p: any) => ({ from: String(p.from), to: String(p.to), rationale: String(p.rationale || '') }));
  return { proposals, pendingApproval: true, note: 'PROPOSED renames — nothing was written. Approve to apply.' };
}

async function suggestDescriptions(state: LoomModelState, userOid: string) {
  if (!state.measures.length) {
    return { proposals: [] as Array<{ name: string; description: string }>, note: 'No measures on this model yet — add measures first.' };
  }
  const list = state.measures.map((m, i) => `${i + 1}. [${m.name}] = ${(m.expression || '').slice(0, 160)}`).join('\n');
  const raw = await aoaiChat(
    userOid,
    'You are a data catalog writer. For each DAX measure, write a concise (1-2 sentence) business-friendly description. Respond ONLY with JSON {"measures":[{"name":"...","description":"..."}]} and nothing else.',
    `Write descriptions for these DAX measures:\n${list}`,
    { maxTokens: 800, temperature: 0.3, jsonObject: true },
  );
  const parsed = parseJsonReply(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed?.measures ?? parsed?.items ?? []);
  const known = new Set(state.measures.map((m) => m.name));
  const proposals = (Array.isArray(arr) ? arr : [])
    .filter((p: any) => p && typeof p.name === 'string' && typeof p.description === 'string' && known.has(p.name))
    .map((p: any) => ({ name: String(p.name), description: String(p.description) }));
  return { proposals, pendingApproval: true, note: 'PROPOSED descriptions — nothing was written. Approve to apply.' };
}

async function suggestRelationships(state: LoomModelState, userOid: string) {
  const tables = inferTableColumns(state);
  const tableNames = Object.keys(tables);
  if (tableNames.length < 2) {
    return {
      proposals: [] as Array<Record<string, unknown>>,
      note: 'Fewer than two tables are visible to the Copilot. Relationship suggestions need at least two tables with columns — draw one relationship on the canvas (or add measures referencing more tables) so the model schema is known, then re-run.',
    };
  }
  const schema = tableNames.map((t) => `TABLE ${t} (${[...tables[t]].join(', ')})`).join('\n');
  const existing = state.relationships.map((r) => `${r.fromTable}[${r.fromColumn}] -> ${r.toTable}[${r.toColumn}]`).join('\n') || '(none)';
  const raw = await aoaiChat(
    userOid,
    'You are a star-schema modeling expert. Given the tables/columns and the relationships that ALREADY exist, propose ADDITIONAL relationships that likely model fact->dimension joins on matching key columns. Use ONLY tables/columns present in the schema. Cardinality is one of "many-to-one","one-to-many","one-to-one","many-to-many". Do NOT repeat an existing relationship. Respond ONLY with JSON {"relationships":[{"fromTable":"","fromColumn":"","toTable":"","toColumn":"","cardinality":"many-to-one","rationale":""}]} and nothing else.',
    `SCHEMA:\n${schema}\n\nEXISTING RELATIONSHIPS:\n${existing}`,
    { maxTokens: 800, temperature: 0.2, jsonObject: true },
  );
  const parsed = parseJsonReply(raw);
  const arr = Array.isArray(parsed) ? parsed : (parsed?.relationships ?? []);
  const colOk = (t: string, c: string) => !!tables[t]?.has(c);
  const existingKeys = new Set(state.relationships.map((r) => `${r.fromTable}|${r.fromColumn}|${r.toTable}|${r.toColumn}`));
  const valid = ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'];
  const proposals = (Array.isArray(arr) ? arr : [])
    .filter((p: any) =>
      p && colOk(String(p.fromTable), String(p.fromColumn)) && colOk(String(p.toTable), String(p.toColumn)) &&
      !existingKeys.has(`${p.fromTable}|${p.fromColumn}|${p.toTable}|${p.toColumn}`))
    .map((p: any) => ({
      fromTable: String(p.fromTable), fromColumn: String(p.fromColumn),
      toTable: String(p.toTable), toColumn: String(p.toColumn),
      cardinality: valid.includes(p.cardinality) ? p.cardinality : 'many-to-one',
      rationale: String(p.rationale || ''),
    }));
  return { proposals, pendingApproval: true, note: 'PROPOSED relationships — nothing was written. Approve to apply.' };
}

// ── apply handlers (write Cosmos; opt-in XMLA writeback) ─────────────────────

/** Try to resolve the AAS table for a measure (best-effort; default "Measures"). */
function measureTable(m?: StoredMeasure): string {
  return (m?.schema && m.schema !== 'dbo' ? m.schema : 'Measures');
}

async function applyRenames(
  id: string, tenantId: string,
  renames: Array<{ from: string; to: string }>,
) {
  let { state } = await readModelState(id, ITEM_TYPE, tenantId);
  const applied: Array<{ from: string; to: string }> = [];
  const errors: string[] = [];
  const xmla: Array<{ from: string; to: string; ok: boolean; error?: string }> = [];
  const db = aasDefaultDatabase() || 'model';

  for (const r of renames) {
    const original = state.measures.find((m) => m.name === r.from);
    const result = renameMeasureInState(state, r.from, r.to);
    if ('error' in result) { errors.push(result.error); continue; }
    state = result.model;
    applied.push({ from: result.from, to: result.to });
    // Opt-in XMLA rename — never on the default path.
    if (aasConfig().available) {
      const w = await executeAasXmla(
        buildRenameMeasureTmsl({ database: db, tableName: measureTable(original), fromName: result.from, toName: result.to }),
        db,
      );
      xmla.push({ from: result.from, to: result.to, ...w });
    }
  }
  if (applied.length === 0) {
    return NextResponse.json({ ok: false, error: errors.join('; ') || 'no renames applied' }, { status: 400 });
  }
  const ok = await writeModelState(id, ITEM_TYPE, tenantId, state);
  if (!ok) return NextResponse.json({ ok: false, error: 'failed to persist renamed measures' }, { status: 500 });
  return NextResponse.json({ ok: true, applied, errors, xmlaWriteback: aasConfig().available ? xmla : undefined });
}

async function applyDescriptions(
  id: string, tenantId: string,
  descriptions: Array<{ name: string; description: string }>,
) {
  let { state } = await readModelState(id, ITEM_TYPE, tenantId);
  const descMap = new Map(descriptions.map((d) => [String(d.name), String(d.description)]));
  const now = new Date().toISOString();
  let updated = 0;
  const measures: StoredMeasure[] = state.measures.map((m) => {
    if (descMap.has(m.name)) { updated += 1; return { ...m, description: descMap.get(m.name)!, updatedAt: now }; }
    return m;
  });
  if (updated === 0) {
    return NextResponse.json({ ok: false, error: 'none of the supplied measure names matched the model' }, { status: 400 });
  }
  state = { ...state, measures };
  const ok = await writeModelState(id, ITEM_TYPE, tenantId, state);
  if (!ok) return NextResponse.json({ ok: false, error: 'failed to persist descriptions' }, { status: 500 });

  const db = aasDefaultDatabase() || 'model';
  let xmla: Array<{ name: string; ok: boolean; error?: string }> | undefined;
  if (aasConfig().available) {
    xmla = [];
    for (const m of measures) {
      if (!descMap.has(m.name)) continue;
      const w = await executeAasXmla(
        buildSetMeasureDescriptionTmsl({ database: db, tableName: measureTable(m), measureName: m.name, description: descMap.get(m.name)! }),
        db,
      );
      xmla.push({ name: m.name, ...w });
    }
  }
  return NextResponse.json({ ok: true, updated, xmlaWriteback: xmla });
}

async function applyRelationships(
  id: string, tenantId: string,
  rels: Array<Record<string, unknown>>,
) {
  let { state } = await readModelState(id, ITEM_TYPE, tenantId);
  const created: StoredRelationship[] = [];
  const errors: string[] = [];
  for (const raw of rels) {
    try {
      const rel = normalizeRelationship(raw, 'cosmos');
      state = upsertRelationship(state, rel);
      created.push(rel);
    } catch (e: any) {
      errors.push(e?.message || String(e));
    }
  }
  if (created.length === 0) {
    return NextResponse.json({ ok: false, error: errors.join('; ') || 'no relationships applied' }, { status: 400 });
  }
  const ok = await writeModelState(id, ITEM_TYPE, tenantId, state);
  if (!ok) return NextResponse.json({ ok: false, error: 'failed to persist relationships' }, { status: 500 });
  return NextResponse.json({
    ok: true,
    created: created.map((r) => ({ id: r.id, name: r.name, fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn, cardinality: r.cardinality })),
    errors,
  });
}

// ── POST — action dispatcher ─────────────────────────────────────────────────

interface CopilotBody {
  action?: string;
  // apply payloads
  renames?: Array<{ from: string; to: string }>;
  descriptions?: Array<{ name: string; description: string }>;
  relationships?: Array<Record<string, unknown>>;
  // checkpoint payloads
  label?: string;
  reason?: string;
  checkpointId?: string;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  const { id } = await ctx.params;
  const tenantId = session.claims.oid;
  const body = (await req.json().catch(() => ({}))) as CopilotBody;
  const action = String(body.action || '').trim();

  const { state, itemFound } = await readModelState(id, ITEM_TYPE, tenantId);
  if (!itemFound) {
    return NextResponse.json({ ok: false, error: `Item ${id} (${ITEM_TYPE}) not found or not owned by you. The model-structure Copilot edits Loom-native semantic-model items.` }, { status: 404 });
  }

  try {
    switch (action) {
      // suggest (read-only)
      case 'suggest-renames':
        return NextResponse.json({ ok: true, ...(await suggestRenames(state, tenantId)) });
      case 'suggest-descriptions':
        return NextResponse.json({ ok: true, ...(await suggestDescriptions(state, tenantId)) });
      case 'suggest-relationships':
        return NextResponse.json({ ok: true, ...(await suggestRelationships(state, tenantId)) });

      // apply (write)
      case 'apply-renames': {
        const renames = (body.renames || []).filter((r) => r && r.from && r.to);
        if (!renames.length) return NextResponse.json({ ok: false, error: 'renames must be a non-empty array of { from, to }' }, { status: 400 });
        // Auto-checkpoint before a bulk structural change so it is undoable.
        await captureModelCheckpoint(id, ITEM_TYPE, tenantId, { label: `Before rename of ${renames.length} measure(s)`, reason: 'copilot:rename' });
        return applyRenames(id, tenantId, renames);
      }
      case 'apply-descriptions': {
        const descriptions = (body.descriptions || []).filter((d) => d && d.name && typeof d.description === 'string');
        if (!descriptions.length) return NextResponse.json({ ok: false, error: 'descriptions must be a non-empty array of { name, description }' }, { status: 400 });
        return applyDescriptions(id, tenantId, descriptions);
      }
      case 'apply-relationships': {
        const rels = (body.relationships || []).filter((r) => r && typeof r === 'object');
        if (!rels.length) return NextResponse.json({ ok: false, error: 'relationships must be a non-empty array' }, { status: 400 });
        await captureModelCheckpoint(id, ITEM_TYPE, tenantId, { label: `Before adding ${rels.length} relationship(s)`, reason: 'copilot:relationship' });
        return applyRelationships(id, tenantId, rels);
      }

      // checkpoints
      case 'checkpoint': {
        const cp = await captureModelCheckpoint(id, ITEM_TYPE, tenantId, { label: body.label, reason: body.reason || 'manual' });
        if (!cp) return NextResponse.json({ ok: false, error: 'failed to capture checkpoint' }, { status: 500 });
        return NextResponse.json({ ok: true, checkpoint: { id: cp.id, label: cp.label, reason: cp.reason, createdAt: cp.createdAt, measureCount: cp.measureCount, relationshipCount: cp.relationshipCount } });
      }
      case 'restore-checkpoint': {
        const checkpointId = String(body.checkpointId || '').trim();
        if (!checkpointId) return NextResponse.json({ ok: false, error: 'checkpointId is required' }, { status: 400 });
        const result = await restoreModelCheckpoint(id, ITEM_TYPE, tenantId, checkpointId);
        if (!result) return NextResponse.json({ ok: false, error: 'item not found' }, { status: 404 });
        if ('error' in result) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
        return NextResponse.json({
          ok: true,
          restored: { id: result.checkpoint.id, label: result.checkpoint.label, createdAt: result.checkpoint.createdAt },
          measures: result.model.measures.length,
          relationships: result.model.relationships.length,
        });
      }

      default:
        return NextResponse.json({ ok: false, error: `unknown action "${action}". Valid: suggest-renames, suggest-descriptions, suggest-relationships, apply-renames, apply-descriptions, apply-relationships, checkpoint, restore-checkpoint` }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
