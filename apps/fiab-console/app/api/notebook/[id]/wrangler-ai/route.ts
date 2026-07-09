/**
 * Data Wrangler — AI-assist BFF (FGC-16). POST /api/notebook/[id]/wrangler-ai
 *
 * Backs the Data Wrangler panel's "AI assist" tab. Two actions, both resolving
 * to STRUCTURED operations from the closed Data Wrangler gallery — never
 * freeform code (loom_no_freeform_config):
 *
 *   action:'suggest'  { columns, rows, summary, rowCount, useAi? }
 *     → Deterministic rule-based cleaning suggestions from REAL column profiles
 *       (nulls / distinct / dtype / whitespace / numeric-looking / constant /
 *       duplicates). When `useAi` and AOAI is configured, ALSO asks Azure OpenAI
 *       to propose additional gallery steps grounded in the same profiles; each
 *       is validated against the closed gallery before it is returned. AOAI is
 *       optional here — an unconfigured deployment degrades gracefully to the
 *       rule-based floor (never a hard gate; the rules are real value).
 *
 *   action:'codegen'  { prompt, columns, rows, summary }
 *     → Natural-language → a sequence of gallery operations via Azure OpenAI
 *       (notebook persona), validated against the closed gallery. The panel
 *       previews the steps on the sampled rows through the REAL pandas host
 *       before apply, and the host emits the equivalent pandas/PySpark code that
 *       lands as a notebook cell. AOAI is REQUIRED for codegen — an unconfigured
 *       deployment returns an honest 503 gate; the full surface still renders.
 *
 * Every enrichment is real Azure OpenAI (resolveAoaiTarget → the SAME Foundry
 * chat deployment the cross-item Copilot uses). No Microsoft Fabric / Power BI
 * dependency, Azure-native by default (works with LOOM_DEFAULT_FABRIC_WORKSPACE
 * unset).
 */
import type { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  resolveAoaiTarget,
  NoAoaiDeploymentError,
} from '@/lib/azure/copilot-orchestrator';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';
import {
  buildRuleSuggestions,
  validateWranglerSteps,
  operationCatalogSpec,
  dedupeSuggestions,
  type ColSummary,
  type WranglerSuggestion,
  type SuggestionCategory,
} from '@/lib/notebook/wrangler-ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ROWS = 200; // profiling sample cap — the panel already samples.
const MAX_COLS = 200;
const VALID_CATEGORIES: SuggestionCategory[] = ['Missing', 'Schema', 'Text', 'Rows', 'Numeric'];

interface Body {
  action?: string;
  columns?: unknown;
  rows?: unknown;
  summary?: unknown;
  rowCount?: unknown;
  useAi?: unknown;
  prompt?: unknown;
}

const AOAI_GATE_HINT =
  'Deploy the AI Foundry project (platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true) which wires LOOM_AOAI_ENDPOINT + LOOM_AOAI_DEPLOYMENT into admin-plane/main.bicep, and grant the Console UAMI "Cognitive Services OpenAI User".';

function coerceSummary(raw: unknown): ColSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_COLS)
    .map((r) => {
      const o = (r || {}) as Record<string, unknown>;
      return {
        name: String(o.name ?? ''),
        dtype: String(o.dtype ?? 'object'),
        missing: Number.isFinite(o.missing) ? Number(o.missing) : 0,
        unique: Number.isFinite(o.unique) ? Number(o.unique) : 0,
      };
    })
    .filter((c) => c.name);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await ctx.params; // [id] carried for notebook scoping; the sample is in the body.
  const session = getSession();
  if (!session) return apiUnauthorized();

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* validated below */
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const columns = Array.isArray(body.columns) ? body.columns.map(String).slice(0, MAX_COLS) : [];
  const rows = Array.isArray(body.rows)
    ? (body.rows.slice(0, MAX_ROWS) as Record<string, unknown>[])
    : [];
  const summary = coerceSummary(body.summary);
  const rowCount = Number.isFinite(body.rowCount) ? Number(body.rowCount) : rows.length;

  if (action !== 'suggest' && action !== 'codegen') {
    return apiError('action must be "suggest" or "codegen".', 400);
  }
  if (!columns.length) {
    return apiError('Provide the column list to profile.', 400);
  }

  // ── action: suggest ─────────────────────────────────────────────────────
  if (action === 'suggest') {
    const ruleSuggestions = buildRuleSuggestions(summary, rows, rowCount);
    const useAi = body.useAi === true || body.useAi === 'true';

    if (!useAi) {
      return apiOk({ suggestions: ruleSuggestions, aiUsed: false });
    }

    // AOAI augmentation — optional. Degrade to rule-only on any gate/error.
    try {
      const cfg = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
      const target = await resolveAoaiTarget(cfg); // throws NoAoaiDeploymentError when unconfigured
      const aiSuggestions = await proposeAiSuggestions(columns, summary, rowCount, cfg, target);
      const merged = dedupeSuggestions([...ruleSuggestions, ...aiSuggestions]);
      return apiOk({ suggestions: merged, aiUsed: aiSuggestions.length > 0 });
    } catch (e: unknown) {
      const gate =
        e instanceof NoAoaiDeploymentError
          ? `Azure OpenAI is not configured, so only rule-based suggestions are shown. ${AOAI_GATE_HINT}`
          : `AI suggestions are unavailable right now; showing rule-based suggestions. (${(e as Error)?.message || String(e)})`;
      return apiOk({ suggestions: ruleSuggestions, aiUsed: false, aiGate: gate });
    }
  }

  // ── action: codegen ─────────────────────────────────────────────────────
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return apiError('Describe the change you want in plain language.', 400);

  let cfg;
  let target;
  try {
    cfg = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
    target = await resolveAoaiTarget(cfg);
  } catch (e: unknown) {
    if (e instanceof NoAoaiDeploymentError) {
      return apiError(e.message, 503, { code: 'no_aoai', hint: AOAI_GATE_HINT });
    }
    return apiServerError(e, 'Could not resolve the Azure OpenAI deployment.');
  }

  try {
    const sys =
      'You are a data-preparation assistant embedded in a notebook Data Wrangler. ' +
      'Translate the user\'s request into an ordered list of cleaning operations, chosen ' +
      'ONLY from this closed catalog (use the exact op id and field names):\n' +
      operationCatalogSpec() +
      `\n\nThe DataFrame columns are: ${columns.join(', ')}.` +
      '\nReturn STRICT JSON: { "steps": [ { "op": "<id>", ...fields } ], "explanation": "<one sentence>" }. ' +
      'Reference only existing columns. If the request cannot be met with the catalog, return an empty steps array and explain why. Do not invent operations or emit code.';
    const profileLine = summary
      .map((c) => `${c.name} (${c.dtype}, ${c.missing} missing, ${c.unique} distinct)`)
      .join('; ');
    const user = `Column profiles: ${profileLine || '(none)'}\n\nRequest: ${prompt}`;

    const parsed = await aoaiChatJson<{ steps?: unknown; explanation?: unknown }>({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      maxCompletionTokens: 900,
      temperature: 0.1,
      cfg,
      target,
    });

    const { valid, rejected } = validateWranglerSteps(parsed?.steps, columns);
    const explanation = typeof parsed?.explanation === 'string' ? parsed.explanation : '';
    return apiOk({ steps: valid, rejected, explanation });
  } catch (e: unknown) {
    return apiServerError(e, 'Failed to generate the transform.');
  }
}

/**
 * Ask AOAI to propose additional gallery-constrained cleaning suggestions from
 * the column profiles. Each proposal is validated against the closed gallery;
 * invalid ones are dropped. Returns [] on any parse/validation miss (the caller
 * still has the rule-based floor).
 */
async function proposeAiSuggestions(
  columns: string[],
  summary: ColSummary[],
  rowCount: number,
  cfg: Parameters<typeof aoaiChatJson>[0]['cfg'],
  target: Parameters<typeof aoaiChatJson>[0]['target'],
): Promise<WranglerSuggestion[]> {
  const sys =
    'You are a data-quality assistant for a notebook Data Wrangler. Given column profiles, ' +
    'propose up to 5 useful cleaning steps, each chosen ONLY from this closed catalog ' +
    '(use the exact op id and field names):\n' +
    operationCatalogSpec() +
    `\n\nThe DataFrame columns are: ${columns.join(', ')}.` +
    '\nReturn STRICT JSON: { "suggestions": [ { "title": "<short>", "rationale": "<why>", ' +
    '"category": "Missing|Schema|Text|Rows|Numeric", "step": { "op": "<id>", ...fields } } ] }. ' +
    'Reference only existing columns. Prefer steps a heuristic would miss (e.g. one-hot encoding a ' +
    'low-cardinality category, splitting a compound column). Do not emit code.';
  const profileLine = summary
    .map((c) => `${c.name} (${c.dtype}, ${c.missing} missing, ${c.unique} distinct, of ${rowCount} rows)`)
    .join('; ');

  const parsed = await aoaiChatJson<{ suggestions?: unknown }>({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `Column profiles: ${profileLine || '(none)'}` },
    ],
    maxCompletionTokens: 900,
    temperature: 0.2,
    cfg,
    target,
  });

  const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const out: WranglerSuggestion[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    const { valid } = validateWranglerSteps([o.step], columns);
    if (!valid.length) continue;
    const step = valid[0];
    const category = VALID_CATEGORIES.includes(o.category as SuggestionCategory)
      ? (o.category as SuggestionCategory)
      : 'Schema';
    const target = (step as Record<string, unknown>).column
      ?? ((step as Record<string, unknown>).columns as string[] | undefined)?.join(',')
      ?? '*';
    out.push({
      id: `ai:${step.op}:${String(target)}`,
      title: typeof o.title === 'string' && o.title.trim() ? o.title.trim() : step.op,
      rationale: typeof o.rationale === 'string' ? o.rationale.trim() : '',
      category,
      step,
      source: 'ai',
    });
  }
  return out;
}
