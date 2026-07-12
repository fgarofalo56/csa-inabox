/**
 * AI functions — table / column batch surface (G2).
 *
 * The real backend for the "Add AI column" grid action, the Dataflow Gen2 AI
 * step, and (via G4) the Data Wrangler AI tab. Applies ONE AI function over a
 * whole column of a table in a single request — every row is a real Azure OpenAI
 * round-trip through the SAME live deployment the cross-item Copilot resolves.
 * No Microsoft Fabric / Power BI dependency (per no-fabric-dependency.md); no
 * mock rows (per no-vaporware.md).
 *
 *   POST /api/ai-functions/table
 *     body {
 *       fn:            one of AI_FN_NAMES (summarize|classify|…|similarity),
 *       rows?:         Array<Record<string, unknown>>   // row objects
 *       inputColumns?: string[]                          // columns fed to the fn
 *       inputs?:       unknown[]                         // OR raw input values
 *       outputColumn?: string,                           // default `ai_<fn>`
 *       modelTier?:    'mini' | 'standard' | 'strong',   // tier-router override
 *       inputType?:    'text' | 'image' | 'document',    // multimodal (vision)
 *       schema?:       Array<{ field, type, prompt }>,   // structured extraction
 *       options?:      { labels?, fields?, targetLang?, compareTo?, maxTokens? },
 *       concurrency?:  number,
 *     }
 *     → 200 { ok, engine:'aoai', mode:'table', outputColumn|outputColumns,
 *             rows:[{index,input,result,error?,values?}], model, usage, failed, rowCount }
 *     → 501 { ok:false, code:'not_configured', missing }   (no AOAI / no vision deployment)
 *     → 4xx/502 on validation / upstream errors
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import {
  callAiFnBatch,
  callCustomPromptBatch,
  emitAiFnUsage,
  NoAoaiDeploymentError,
  isAiFn,
  AI_FN_NAMES,
  type AiFn,
  type AiFnOptions,
  type AiFnBatchResult,
} from '@/lib/azure/ai-functions-client';
import {
  buildSchemaExtractPrompt,
  type AiSchemaField,
} from '@/lib/azure/ai-functions-registry';
import { tierPolicyFromConfig, selectTier, type ModelTier } from '@/lib/foundry/model-tier-router';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Hard cap on rows enriched per request — protects AOAI quota + the serverless
 *  time budget. The grid/dataflow callers page larger tables client-side. */
const MAX_ROWS = 500;

const GATE_HINT =
  'Deploy a chat model (e.g. gpt-4o-mini) from the AI Foundry hub ("Quota + usage" → Deploy), or set LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT and grant the Console UAMI "Cognitive Services OpenAI User". No Microsoft Fabric required.';

const VISION_GATE_HINT =
  'Multimodal (image / document) AI columns need a vision-capable Azure OpenAI deployment. Set LOOM_AOAI_VISION_DEPLOYMENT to a gpt-4o / gpt-4.1 vision deployment name and grant the Console UAMI "Cognitive Services OpenAI User". Text columns work without it.';

/** Vision-capable chat functions (the only ones that accept an image column). */
const VISION_FNS = new Set<AiFn>(['summarize', 'classify', 'extract']);

function parseOptions(o: unknown): AiFnOptions {
  const opts: AiFnOptions = {};
  if (o && typeof o === 'object') {
    const obj = o as Record<string, unknown>;
    if (Array.isArray(obj.labels)) opts.labels = obj.labels.map((x) => String(x)).filter(Boolean);
    if (Array.isArray(obj.fields)) opts.fields = obj.fields.map((x) => String(x)).filter(Boolean);
    if (typeof obj.targetLang === 'string' && obj.targetLang.trim()) opts.targetLang = obj.targetLang.trim();
    if (typeof obj.compareTo === 'string' && obj.compareTo.trim()) opts.compareTo = obj.compareTo.trim();
    if (typeof obj.maxTokens === 'number' && obj.maxTokens > 0) opts.maxTokens = obj.maxTokens;
    if (typeof obj.embeddingDeployment === 'string' && obj.embeddingDeployment.trim())
      opts.embeddingDeployment = obj.embeddingDeployment.trim();
  }
  return opts;
}

/** Coerce any cell value to the string the model sees. */
function cellStr(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

/**
 * Build the per-row input strings from EITHER a raw `inputs` array OR row
 * objects + `inputColumns`. Multiple input columns are joined as labeled lines
 * so the model has the column context. For a vision input only the first column
 * (the image/document reference) is used.
 */
function buildInputs(
  rows: Record<string, unknown>[] | null,
  rawInputs: unknown[] | null,
  inputColumns: string[],
  vision: boolean,
): string[] {
  if (rawInputs) return rawInputs.slice(0, MAX_ROWS).map(cellStr);
  if (!rows) return [];
  const cols = inputColumns.length ? inputColumns : [];
  return rows.slice(0, MAX_ROWS).map((row) => {
    if (!cols.length) return cellStr(row);
    if (vision) return cellStr(row[cols[0]]);
    if (cols.length === 1) return cellStr(row[cols[0]]);
    return cols.map((c) => `${c}: ${cellStr(row[c])}`).join('\n');
  });
}

/** Parse a schema field array (defensive — drops malformed entries). */
function parseSchema(v: unknown): AiSchemaField[] {
  if (!Array.isArray(v)) return [];
  const out: AiSchemaField[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const field = typeof o.field === 'string' ? o.field.trim() : '';
    if (!field) continue;
    const type = (['string', 'number', 'boolean', 'date'] as const).includes(o.type as any)
      ? (o.type as AiSchemaField['type'])
      : 'string';
    out.push({ field, type, prompt: typeof o.prompt === 'string' ? o.prompt.trim() : '' });
  }
  return out;
}

/** Best-effort JSON parse of a model row into a field→value map. */
function parseRowJson(text: string, fields: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  let obj: any = null;
  try { obj = JSON.parse(text); } catch { /* handled below */ }
  for (const f of fields) values[f] = obj && typeof obj === 'object' && obj[f] != null ? cellStr(obj[f]) : '';
  return values;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return NextResponse.json({ ok: false, error: 'unauthenticated' }, { status: 401 });

  let body: any;
  try { body = await req.json(); } catch { body = {}; }

  const fn = typeof body?.fn === 'string' ? body.fn.trim() : '';
  if (!isAiFn(fn)) {
    return NextResponse.json(
      { ok: false, error: `Invalid fn "${fn}". Must be one of: ${AI_FN_NAMES.join(', ')}.` },
      { status: 400 },
    );
  }

  const schema = parseSchema(body?.schema);
  const useSchema = schema.length > 0;
  const inputColumns: string[] = Array.isArray(body?.inputColumns)
    ? body.inputColumns.map((x: unknown) => String(x)).filter(Boolean)
    : [];
  const rows: Record<string, unknown>[] | null = Array.isArray(body?.rows)
    ? body.rows.filter((r: unknown) => r && typeof r === 'object')
    : null;
  const rawInputs: unknown[] | null = Array.isArray(body?.inputs) ? body.inputs : null;

  const inputType: 'text' | 'image' | 'document' =
    body?.inputType === 'image' || body?.inputType === 'document' ? body.inputType : 'text';
  const vision = inputType !== 'text';

  const outputColumn = typeof body?.outputColumn === 'string' && body.outputColumn.trim()
    ? body.outputColumn.trim()
    : `ai_${fn}`;

  const concurrency = Number.isFinite(body?.concurrency) && body.concurrency > 0
    ? Math.min(Math.floor(body.concurrency), 8)
    : 4;

  const opts = parseOptions(body?.options);

  // ── Multimodal seam + honest gate (G2 #5) ─────────────────────────────────
  if (vision) {
    if (!VISION_FNS.has(fn)) {
      return NextResponse.json(
        { ok: false, error: `Function "${fn}" does not support an image/document input. Use summarize, classify, or extract.` },
        { status: 400 },
      );
    }
    const visionDeployment = (process.env.LOOM_AOAI_VISION_DEPLOYMENT || '').trim();
    if (!visionDeployment) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', gated: true, engine: 'aoai', inputType,
          error: 'No vision-capable Azure OpenAI deployment is configured for multimodal AI columns.',
          missing: 'LOOM_AOAI_VISION_DEPLOYMENT', hint: VISION_GATE_HINT },
        { status: 501 },
      );
    }
    opts.visionInput = true;
    opts.deployment = visionDeployment; // vision deployment overrides tier routing
  }

  const inputs = buildInputs(rows, rawInputs, inputColumns, vision);
  if (!inputs.length) {
    return NextResponse.json(
      { ok: false, error: 'No input rows. Provide `inputs[]`, or `rows[]` + `inputColumns[]`.' },
      { status: 400 },
    );
  }

  // Honor the admin-picked tenant Copilot deployment + the model-tier router.
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
  opts.tenantConfig = tenantConfig;

  // ── Model-tier override (G2 #1 "model tier" control) ──────────────────────
  // Vision pins its own deployment above; otherwise resolve the tier's deployment.
  if (!vision) {
    const tierRaw = typeof body?.modelTier === 'string' ? body.modelTier.trim() : '';
    if (tierRaw && (['mini', 'standard', 'strong'] as const).includes(tierRaw as any)) {
      const policy = tierPolicyFromConfig(tenantConfig as any);
      const sel = selectTier(policy, { overrideTier: tierRaw as ModelTier });
      if (sel.deployment) opts.deployment = sel.deployment;
    }
  }

  try {
    let batch: AiFnBatchResult;
    let outputColumns: string[] | undefined;

    if (useSchema) {
      // Structured multi-field extraction — one AOAI pass per row, split into
      // one output column per schema field (G2 #6).
      const prompt = buildSchemaExtractPrompt(schema);
      batch = await callCustomPromptBatch(prompt, inputs, opts, concurrency);
      outputColumns = schema.map((f) => f.field);
      const fields = outputColumns;
      batch.rows = batch.rows.map((r) => ({
        ...r,
        ...(r.error ? {} : { values: parseRowJson(r.result, fields) }),
      })) as typeof batch.rows;
    } else {
      batch = await callAiFnBatch(fn, inputs, opts, concurrency);
    }

    await emitAiFnUsage(fn, batch.usage, batch.model, session.claims.oid);

    return NextResponse.json({
      ok: true,
      engine: 'aoai',
      mode: 'table',
      fn,
      inputType,
      ...(useSchema ? { outputColumns } : { outputColumn }),
      rows: batch.rows,
      rowCount: batch.rows.length,
      failed: batch.failed,
      model: batch.model,
      usage: batch.usage,
    });
  } catch (e: any) {
    if (e instanceof NoAoaiDeploymentError) {
      return NextResponse.json(
        { ok: false, code: 'not_configured', gated: true, engine: 'aoai',
          error: e.message, missing: 'LOOM_AOAI_DEPLOYMENT', hint: GATE_HINT },
        { status: 501 },
      );
    }
    return NextResponse.json({ ok: false, engine: 'aoai', error: e?.message || String(e) }, { status: 502 });
  }
}
