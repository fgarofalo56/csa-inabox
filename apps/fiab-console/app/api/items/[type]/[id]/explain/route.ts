/**
 * Cross-item "Explain this" Copilot edge (Wave-2 W19).
 *
 * A single BFF route that turns the STRUCTURED definition of a pipeline,
 * notebook or warehouse into a plain-English explanation — the generalization
 * of the report's smart-narrative / Q&A layer to the three data-engineering
 * item families. It is the shared backend for the `Explain` action rendered by
 * `ItemEditorChrome` (lib/components/explain-this.tsx) on every editor in those
 * families (data-pipeline / synapse-pipeline / adf-pipeline, notebook /
 * synapse-notebook / databricks-notebook, warehouse / synapse-dedicated /
 * synapse-serverless / databricks-sql-warehouse).
 *
 * Routed under the existing dynamic `[type]` segment so it sits alongside the
 * other shared item routes (assist, access-mode, audit, …). `[type]` is mapped
 * to one of three artifact FAMILIES below; any other item type 400s.
 *
 * Contract:
 *   POST body { definition }   — the artifact's structured config, sent by the
 *                                editor from its LIVE in-memory state:
 *                                pipeline → the ADF pipeline JSON (properties.activities),
 *                                notebook → { cells, defaultLang },
 *                                warehouse → the schema (schemas/views/procedures).
 *   200      { ok, family, explanation }  — a STRUCTURED explanation object
 *                                { summary, steps[], inputs[], outputs[], risks[] }.
 *
 * Real backend (per no-vaporware.md): the explanation is a REAL Azure OpenAI
 * chat-completions call via the ONE unified `aoai-chat-client` (aoaiChatJson) —
 * no mocks, no canned strings. The persona is grounded on the artifact JSON the
 * caller supplies. When AOAI is not configured the route returns an honest 503
 * `code:'no_aoai'` gate naming the exact env vars to set; the editor surfaces it
 * in a Fluent MessageBar and the button stays functional (retry).
 *
 * Azure-native by default (per no-fabric-dependency.md): works with
 * LOOM_DEFAULT_FABRIC_WORKSPACE unset. No Fabric / Power BI host is contacted —
 * the model is the AI Foundry `chat` deployment (LOOM_AOAI_ENDPOINT/DEPLOYMENT).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';

type Family = 'pipeline' | 'notebook' | 'warehouse';

/** item-type slug → artifact family. Any slug NOT in this map is unsupported. */
const FAMILY: Record<string, Family> = {
  // Pipeline family (ADF / Synapse pipeline definitions — properties.activities)
  'data-pipeline': 'pipeline',
  'synapse-pipeline': 'pipeline',
  'adf-pipeline': 'pipeline',
  // Notebook family (Spark notebooks — cells[] + language)
  'notebook': 'notebook',
  'synapse-notebook': 'notebook',
  'databricks-notebook': 'notebook',
  // Warehouse family (SQL schema — tables / columns / views / procedures)
  'warehouse': 'warehouse',
  'synapse-dedicated-sql-pool': 'warehouse',
  'synapse-serverless-sql-pool': 'warehouse',
  'databricks-sql-warehouse': 'warehouse',
};

/** Max serialized artifact fed to the model (keeps the prompt budgeted). */
const MAX_DEFINITION = 48 * 1024; // 48KB

/** The structured explanation the model must return (and we surface). */
export interface ExplainResult {
  /** 2-4 sentence plain-English summary of what the artifact does. */
  summary: string;
  /** Ordered steps — activities (pipeline) / cells (notebook) / logical parts (warehouse). */
  steps?: string[];
  /** Inputs consumed — sources, parameters, upstream datasets/tables. */
  inputs?: string[];
  /** Outputs produced — sinks, result tables/files, downstream artifacts. */
  outputs?: string[];
  /** Risks / gotchas — failure modes, cost, data-quality, security, idempotency. */
  risks?: string[];
}

const FAMILY_NOUN: Record<Family, string> = {
  pipeline: 'Azure Data Factory / Synapse data pipeline',
  notebook: 'Spark data notebook',
  warehouse: 'SQL warehouse schema',
};

const FAMILY_SHAPE: Record<Family, string> = {
  pipeline:
    'The JSON is an ADF/Synapse pipeline definition. `properties.activities[]` lists the ' +
    'activities (each with a `type` such as Copy, ExecuteDataFlow, ExecutePipeline, ' +
    'Lookup, ForEach, IfCondition, StoredProcedure, Notebook, SparkJob), their ' +
    '`dependsOn` ordering, and `properties.parameters` / `variables`. Sources and sinks ' +
    'appear inside each Copy activity’s `inputs`/`outputs` / typeProperties.',
  notebook:
    'The JSON has `cells[]` (each a `{ cellType: "code"|"markdown", source, language }`) and ' +
    'a `defaultLang`. Read the code cells top-to-bottom to infer what data is read, ' +
    'transformed and written; markdown cells are documentation.',
  warehouse:
    'The JSON describes a SQL warehouse schema: `schemas` maps each schema to its tables ' +
    '(with row counts), plus `views`, `procedures` and `functions`. Explain the data model ' +
    '— the notable tables, how they relate, and what the views / procedures do.',
};

/**
 * Build the persona + grounded user message for a family. The system prompt
 * pins the model to the structured JSON contract; the user message carries the
 * (truncated) artifact JSON.
 */
function buildMessages(
  family: Family,
  definitionJson: string,
): { role: 'system' | 'user'; content: string }[] {
  const system =
    `You are the CSA Loom "Explain this" assistant. Explain a ${FAMILY_NOUN[family]} to a ` +
    `data engineer in plain English, grounded ONLY in the definition provided (never invent ` +
    `names or steps that are not present). ${FAMILY_SHAPE[family]}\n\n` +
    `Return a STRICT JSON object with these fields:\n` +
    `  "summary": string  — 2-4 sentences on what this ${family} does and its business intent.\n` +
    `  "steps": string[]  — the ordered steps (${family === 'pipeline' ? 'activities in dependency order' : family === 'notebook' ? 'what each code cell does, in order' : 'the notable tables/views and their role'}); [] if none.\n` +
    `  "inputs": string[] — data/params it consumes (sources, parameters, upstream tables); [] if none.\n` +
    `  "outputs": string[]— what it produces (sinks, result tables/files, downstream artifacts); [] if none.\n` +
    `  "risks": string[]  — concrete risks or gotchas (failure modes, cost, data-quality, ` +
    `security, idempotency, missing error handling); [] if none obvious.\n` +
    `Reference the ACTUAL names from the definition. No markdown, no prose outside the JSON object.`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${FAMILY_NOUN[family]} definition (JSON):\n${definitionJson}` },
  ];
}

/** Normalize the model reply into ExplainResult with safe defaults. */
function normalize(raw: Record<string, unknown>): ExplainResult {
  const toStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter((s) => s.trim().length > 0) : [];
  return {
    summary: String((raw as any)?.summary ?? '').trim(),
    steps: toStrArr((raw as any)?.steps),
    inputs: toStrArr((raw as any)?.inputs),
    outputs: toStrArr((raw as any)?.outputs),
    risks: toStrArr((raw as any)?.risks),
  };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ type: string; id: string }> },
) {
  const session = getSession();
  if (!session) {
    return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  // Per-principal AOAI rate limit — opt-in (LOOM_RATE_LIMIT=on). Default = no-op.
  const limited = await enforceRateLimit(session, 'aoai');
  if (limited) return limited;

  const { type } = await ctx.params;
  const family = FAMILY[type];
  if (!family) {
    return NextResponse.json(
      { ok: false, error: `explain is not available for item type '${type}'` },
      { status: 400 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const definition = (body as any)?.definition;
  if (definition == null || (typeof definition === 'object' && Object.keys(definition).length === 0)) {
    return NextResponse.json(
      { ok: false, error: 'definition is required — nothing to explain yet' },
      { status: 422 },
    );
  }

  // Serialize the artifact for grounding; cap so the prompt stays budgeted.
  let definitionJson: string;
  try {
    definitionJson =
      typeof definition === 'string' ? definition : JSON.stringify(definition, null, 0);
  } catch {
    return NextResponse.json(
      { ok: false, error: 'definition is not serializable' },
      { status: 422 },
    );
  }
  if (definitionJson.length > MAX_DEFINITION) {
    definitionJson = `${definitionJson.slice(0, MAX_DEFINITION)}\n…(definition truncated)`;
  }
  if (!definitionJson.trim() || definitionJson.trim() === '{}' || definitionJson.trim() === '[]') {
    return NextResponse.json(
      { ok: false, error: 'definition is empty — nothing to explain yet' },
      { status: 422 },
    );
  }

  // Pre-resolve the AOAI target to surface the honest 503 no_aoai gate — same
  // resolution order as the cross-item Copilot. The resolved target is passed
  // to aoaiChatJson so it does NOT re-resolve (one Foundry lookup per call).
  let aoaiTarget;
  try {
    aoaiTarget = await resolveAoaiTarget();
  } catch (e: any) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT ' +
          '(deploy the AI Foundry project — platform/fiab/bicep/modules/ai/foundry-project.bicep, ' +
          'agentFoundryEnabled=true — which wires them into admin-plane/main.bicep).';
    return NextResponse.json(
      { ok: false, code: 'no_aoai', error: e?.message || String(e), hint },
      { status: 503 },
    );
  }

  const messages = buildMessages(family, definitionJson);

  try {
    // Unified AOAI client, JSON mode: same target resolution, cogScope token,
    // max_completion_tokens cap, temperature (0.2) + reasoning-model
    // temperature-only retry as the assist edge.
    const raw = await aoaiChatJson<Record<string, unknown>>({
      messages,
      maxCompletionTokens: 1536,
      temperature: 0.2,
      target: aoaiTarget,
    });
    const explanation = normalize(raw);
    if (!explanation.summary) {
      return NextResponse.json(
        { ok: false, error: 'the model did not return a usable explanation; retry' },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, family, explanation });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 502 });
  }
}
