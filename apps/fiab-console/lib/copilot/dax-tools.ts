/**
 * DAX Copilot tools — NL2DAX, explain, optimize, auto-describe for the
 * Loom-native tabular layer.
 *
 * Registered on the global LoomToolRegistry (buildDefaultRegistry → registerDaxTools)
 * and surfaced on the `dax` persona (toolPrefixes ['dax_','loom_']). Every
 * evaluation uses the Loom-native Synapse SQL path — ZERO Power BI / Fabric REST
 * calls anywhere in this file (grep gate per no-fabric-dependency.md). The
 * Loom-native model metadata (measures, relationships, descriptions) lives on the
 * existing Cosmos `items` container under item.state.model — no new container, no
 * new env var, no Power BI.
 *
 * Auth:
 *   - Synapse TDS: inherits the UAMI credential chain from synapse-sql-client.ts.
 *   - AOAI token: ChainedTokenCredential(ManagedIdentityCredential, Default) →
 *     cogScope() (cloud-aware: cognitiveservices.azure.us in Gov).
 *
 * The AOAI data-plane target is resolved through the orchestrator's
 * resolveAoaiTarget() (env LOOM_AOAI_ENDPOINT/DEPLOYMENT → tenant config →
 * Foundry discovery). Imported dynamically to avoid a static import cycle with
 * copilot-orchestrator (which statically imports registerDaxTools).
 *
 * Env deps (all existing — no new infra):
 *   LOOM_AOAI_ENDPOINT / LOOM_AOAI_DEPLOYMENT — AOAI chat target
 *   LOOM_SYNAPSE_WORKSPACE / LOOM_SYNAPSE_DEDICATED_POOL — Synapse pool
 *   LOOM_UAMI_CLIENT_ID — Console UAMI client id
 */

import { executeQuery, dedicatedTarget } from '@/lib/azure/synapse-sql-client';
import {
  readModelState,
  writeModelState,
  type StoredMeasure,
  type LoomModelState,
} from '@/app/api/items/_lib/model-store';
import { buildTSqlProbe, stripFence } from '@/lib/copilot/dax-probe';
import { aoaiChat, proposeMeasureDescriptions } from '@/lib/copilot/dax-describe';
import type { LoomToolRegistry, ToolContext } from '@/lib/azure/copilot-orchestrator';

// AOAI chat + the bulk auto-describe orchestration live in ./dax-describe — the
// SAME backend the Model-view catalog "Generate descriptions" action calls — so
// the conversational and bulk surfaces stay consistent. stripFence + the
// DAX→T-SQL probe live in ./dax-probe (dependency-free, unit-tested).

// ---------- model context ----------

/** Read the Loom-native tabular model metadata for an owned item. */
async function getModelState(itemId: string, itemType: string, userOid: string): Promise<LoomModelState> {
  const { state, itemFound } = await readModelState(itemId, itemType, userOid);
  if (!itemFound) throw new Error(`Item ${itemId} (${itemType}) not found or not owned by you.`);
  return state;
}

/**
 * Compact schema string fed to AOAI so it grounds DAX generation in the real
 * model rather than hallucinating names. One line per measure + relationship.
 */
function buildSchemaContext(state: LoomModelState): string {
  const lines: string[] = [];
  for (const m of state.measures) {
    lines.push(`MEASURE [${m.name}] = ${(m.expression || '').slice(0, 240)}`);
  }
  for (const r of state.relationships) {
    lines.push(`RELATIONSHIP ${r.fromTable}[${r.fromColumn}] ${r.cardinality} ${r.toTable}[${r.toColumn}]`);
  }
  return lines.join('\n') || '(model has no measures or relationships defined yet)';
}

/**
 * Best-effort DAX->T-SQL probe and code-fence stripping live in ./dax-probe
 * (dependency-free, unit-tested). Imported above.
 */

// ---------- tool handlers ----------

async function handleModelContext(
  { itemId, itemType }: { itemId: string; itemType: string },
  ctx: ToolContext,
) {
  const state = await getModelState(itemId, itemType, ctx.userOid);
  return {
    measures: state.measures.map((m) => ({
      name: m.name,
      schema: m.schema,
      expression: m.expression,
      description: m.description,
      kind: m.kind,
    })),
    relationships: state.relationships,
    schemaContext: buildSchemaContext(state),
  };
}

async function handleNl2Measure(
  { prompt, itemId, itemType, tableName }: { prompt: string; itemId: string; itemType: string; tableName?: string },
  ctx: ToolContext,
) {
  if (!prompt?.trim()) throw new Error('prompt is required.');
  const state = await getModelState(itemId, itemType, ctx.userOid);
  const schemaCtx = buildSchemaContext(state);

  const system = `You are a DAX expert for Loom-native tabular models (Azure Synapse Dedicated SQL backend).
Return ONLY the DAX expression — no "Measure =" prefix, no DEFINE wrapper, no explanation, no code fence.
Use ONLY tables/columns/measures present in the SCHEMA below. Prefer SUMMARIZECOLUMNS, DIVIDE(x,y,0), and
SAMEPERIODLASTYEAR/DATEADD/TOTALYTD for time intelligence.

SCHEMA:
${schemaCtx}`;

  const daxExpression = stripFence(
    await aoaiChat(ctx.userOid, system, `Generate a DAX measure expression for: ${prompt}`, {
      maxTokens: 400,
      temperature: 0.2,
    }),
  );
  if (!daxExpression) throw new Error('AOAI returned an empty DAX expression.');

  // Validate against the live Synapse Dedicated pool.
  const { sql: probeSql, canEval } = buildTSqlProbe(daxExpression, tableName);
  let evaluation: { ok: boolean; value?: unknown; error?: string; note?: string };
  try {
    const result = await executeQuery(dedicatedTarget(), probeSql, 15_000);
    evaluation = {
      ok: true,
      value: result.rows[0]?.[0] ?? null,
      note: canEval
        ? undefined
        : 'complex expression — structural reference check only (no row evaluation)',
    };
  } catch (e: any) {
    evaluation = {
      ok: false,
      error: e?.message || String(e),
      note: 'Synapse Dedicated pool may be paused/offline, or the expression references an unknown column. Set LOOM_SYNAPSE_WORKSPACE + LOOM_SYNAPSE_DEDICATED_POOL and resume the pool to validate.',
    };
  }

  return {
    daxExpression,
    evaluation,
    confidence: canEval && evaluation.ok ? 'validated' : 'unvalidated',
    note: canEval
      ? undefined
      : 'Time-intelligence / complex DAX is validated structurally against Synapse (column references), not fully evaluated — a real DAX engine (XMLA / Analysis Services) is needed for full evaluation. The expression is syntactically grounded in the model schema.',
  };
}

async function handleExplain(
  { daxExpression, measureName }: { daxExpression: string; measureName?: string },
  ctx: ToolContext,
) {
  if (!daxExpression?.trim()) throw new Error('daxExpression is required.');
  const explanation = await aoaiChat(
    ctx.userOid,
    'You are a DAX expert. Explain the given DAX expression in plain business language. Break it into steps: what each function does, what the overall calculation computes, and when it would return zero or blank. Be concise (under 200 words).',
    `Explain this DAX expression${measureName ? ` for measure "${measureName}"` : ''}:\n${daxExpression}`,
    { maxTokens: 320, temperature: 0.1 },
  );
  return { explanation };
}

async function handleOptimize(
  { daxExpression, measureName }: { daxExpression: string; measureName?: string },
  ctx: ToolContext,
) {
  if (!daxExpression?.trim()) throw new Error('daxExpression is required.');
  const system = `You are a DAX performance expert. Rewrite the given DAX expression to be more efficient.
Rules: (1) prefer SUMMARIZECOLUMNS over ADDCOLUMNS+CALCULATE; (2) use DIVIDE(x,y,0) not x/y;
(3) avoid FILTER on large tables — use CALCULATETABLE / KEEPFILTERS; (4) standard time-intelligence functions;
(5) replace EARLIER with VAR. Output the optimized expression on the first line(s), then a blank line, then up
to 3 bullet points (each starting with "- ") describing what you changed. Do NOT use a code fence.`;
  const content = await aoaiChat(
    ctx.userOid,
    system,
    `Optimize${measureName ? ` [${measureName}]` : ''}:\n${daxExpression}`,
    { maxTokens: 420, temperature: 0.1 },
  );
  const parts = content.split(/\n\n+/);
  const optimizedExpression = stripFence((parts.shift() || '').trim());
  return {
    optimizedExpression,
    explanation: parts.join('\n').trim(),
    original: daxExpression,
  };
}

async function handleDescribeModel(
  { itemId, itemType }: { itemId: string; itemType: string },
  ctx: ToolContext,
) {
  const state = await getModelState(itemId, itemType, ctx.userOid);
  if (!state.measures.length) {
    return { proposals: [], note: 'No measures found on this model. Add measures first, then re-run describe.' };
  }
  // Reuse the shared bulk auto-describe (same AOAI backend as the Model-view
  // "Generate descriptions" catalog action).
  const proposals = await proposeMeasureDescriptions(
    state.measures.map((m) => ({ name: m.name, expression: m.expression, description: m.description })),
    ctx.userOid,
  );

  return {
    proposals,
    pendingApproval: true,
    note: 'These are PROPOSED descriptions — nothing was written. After the user approves, call dax_save_descriptions with the approved {name, description} entries to persist them to the Loom model metadata.',
  };
}

async function handleSaveDescriptions(
  {
    itemId,
    itemType,
    descriptions,
  }: { itemId: string; itemType: string; descriptions: Array<{ name: string; description: string }> },
  ctx: ToolContext,
) {
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    throw new Error('descriptions must be a non-empty array of { name, description }.');
  }
  const state = await getModelState(itemId, itemType, ctx.userOid);
  const descMap = new Map(descriptions.map((d) => [String(d.name), String(d.description)]));
  let updatedCount = 0;
  const now = new Date().toISOString();
  const measures: StoredMeasure[] = state.measures.map((m) => {
    if (descMap.has(m.name)) {
      updatedCount += 1;
      return { ...m, description: descMap.get(m.name)!, updatedAt: now };
    }
    return m;
  });
  if (updatedCount === 0) {
    const known = state.measures.map((m) => m.name).join(', ') || '(none)';
    throw new Error(`None of the supplied measure names matched the model. Known measures: ${known}.`);
  }
  const ok = await writeModelState(itemId, itemType, ctx.userOid, { ...state, measures });
  if (!ok) throw new Error(`Failed to persist descriptions: item ${itemId} (${itemType}) not found or not owned by you.`);
  return { ok: true, updated: updatedCount, itemId, itemType };
}

async function handleEvalProbe(
  { sql, timeoutMs }: { sql: string; timeoutMs?: number },
  _ctx: ToolContext,
) {
  if (!sql?.trim()) throw new Error('sql is required.');
  const result = await executeQuery(dedicatedTarget(), sql, timeoutMs && timeoutMs > 0 ? timeoutMs : 15_000);
  return {
    ok: true,
    columns: result.columns,
    rows: result.rows.slice(0, 10),
    rowCount: result.rowCount,
    executionMs: result.executionMs,
    note: 'T-SQL probe against the Synapse Dedicated pool — validates column references + aggregate computation. Not a full DAX-engine evaluation.',
  };
}

// ---------- JSON-schema helpers ----------

const S_STRING = { type: 'string' } as const;
const S_NUMBER = { type: 'number' } as const;
function obj(props: Record<string, unknown>, required: string[] = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

// ---------- registration ----------

/**
 * Register the DAX Copilot tools onto the shared registry. Called from
 * copilot-orchestrator.buildDefaultRegistry(). All tools are namespaced `dax_`
 * so the DAX persona can filter to them.
 */
export function registerDaxTools(r: LoomToolRegistry): void {
  r.register({
    name: 'dax_model_context',
    service: 'DAX',
    description:
      'Read the Loom-native tabular model metadata (measures, relationships, descriptions) for a given item. Call this FIRST — before generating, explaining, or describing DAX — to ground your response in the real model schema.',
    parameters: obj({ itemId: S_STRING, itemType: S_STRING }, ['itemId', 'itemType']),
    handler: handleModelContext,
  });
  r.register({
    name: 'dax_nl2measure',
    service: 'DAX',
    description:
      'Generate a DAX measure expression from a natural-language prompt, grounded on the Loom-native tabular model schema, and validate it via a T-SQL probe on the Synapse Dedicated pool. Returns { daxExpression, evaluation, confidence }.',
    parameters: obj(
      { prompt: S_STRING, itemId: S_STRING, itemType: S_STRING, tableName: S_STRING },
      ['prompt', 'itemId', 'itemType'],
    ),
    handler: handleNl2Measure,
  });
  r.register({
    name: 'dax_explain',
    service: 'DAX',
    description:
      'Explain a DAX expression in plain business language — what each function does, what the overall calculation computes, and when it returns zero or blank.',
    parameters: obj({ daxExpression: S_STRING, measureName: S_STRING }, ['daxExpression']),
    handler: handleExplain,
  });
  r.register({
    name: 'dax_optimize',
    service: 'DAX',
    description:
      'Rewrite a DAX expression to be more efficient (SUMMARIZECOLUMNS over ADDCOLUMNS, DIVIDE guard, CALCULATETABLE over FILTER, VAR over EARLIER, standard time-intelligence). Returns { optimizedExpression, explanation }.',
    parameters: obj({ daxExpression: S_STRING, measureName: S_STRING }, ['daxExpression']),
    handler: handleOptimize,
  });
  r.register({
    name: 'dax_describe_model',
    service: 'DAX',
    description:
      'Auto-generate business-friendly descriptions for every measure on a Loom-native semantic model. Returns PROPOSALS for user approval — does NOT write. Call dax_save_descriptions after approval to persist.',
    parameters: obj({ itemId: S_STRING, itemType: S_STRING }, ['itemId', 'itemType']),
    handler: handleDescribeModel,
  });
  r.register({
    name: 'dax_save_descriptions',
    service: 'DAX',
    description:
      'Persist approved measure descriptions to the Loom model metadata (Cosmos items container, item.state.model.measures[*].description). Azure-native — no Power BI / Fabric calls. Pass the itemId, itemType, and an array of { name, description }.',
    parameters: obj(
      {
        itemId: S_STRING,
        itemType: S_STRING,
        descriptions: {
          type: 'array',
          items: obj({ name: S_STRING, description: S_STRING }, ['name', 'description']),
        },
      },
      ['itemId', 'itemType', 'descriptions'],
    ),
    handler: handleSaveDescriptions,
  });
  r.register({
    name: 'dax_eval_probe',
    service: 'DAX',
    description:
      'Execute a T-SQL probe on the Synapse Dedicated pool to confirm column references exist and an aggregate computes. Use after generating an expression to confirm correctness against real data.',
    parameters: obj({ sql: S_STRING, timeoutMs: S_NUMBER }, ['sql']),
    handler: handleEvalProbe,
  });
}
