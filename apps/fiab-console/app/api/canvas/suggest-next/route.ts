/**
 * POST /api/canvas/suggest-next — the AOAI suggestion engine behind the
 * canvas "ghost next-step" node (W7).
 *
 * A visual canvas (pipeline / eventstream / any node-kit surface) posts its
 * CURRENT graph — the node list + edges + the item type + the palette of node
 * kinds it can legally add — and this route asks Azure OpenAI for the single
 * best NEXT node to add, grounded on that graph. The ghost node then offers the
 * top suggestion inline with Accept (insert it) / Dismiss.
 *
 * Contract (all suggestion keys are CONSTRAINED to the caller's `paletteKeys`
 * allowlist — the model can only propose a node the surface can actually add,
 * so Accept always maps to a real palette-drop and no free-form key is ever
 * injected into the editor):
 *
 *   → { itemType, nodes:[{id,type?,label?}], edges:[{source,target}], paletteKeys:string[] }
 *   ← { ok:true, suggestions:[{ key, label, reason }] }   // key ∈ paletteKeys, ≤3
 *   ← { ok:true, suggestions:[], disabled:true }          // admin kill-switch off
 *   ← { ok:false, code:'no_aoai', error, hint }           // 503 honest gate
 *
 * AOAI resolution reuses resolveAoaiTarget (tenant admin pick → env →
 * Foundry-hub discovery) exactly like the notebook-assist sibling; a missing
 * chat deployment returns the honest 503 `code:'no_aoai'` gate naming the exact
 * env vars / admin action, and the canvas keeps working (the ghost falls back to
 * its static menu). Default-ON / opt-out: suggestions are enabled unless an admin
 * sets LOOM_CANVAS_AI_SUGGEST to a falsy value (0/false/off/no) on the Container
 * App — the kill-switch returns `disabled:true` with zero AOAI spend.
 *
 * Azure-native by default (works with LOOM_DEFAULT_FABRIC_WORKSPACE unset); no
 * Fabric / Power BI host is contacted on any code path here.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';
import { loadTenantCopilotConfig } from '@/lib/azure/copilot-config-store';
import { apiOk, apiError, apiUnauthorized, apiServerError } from '@/lib/api/respond';
import {
  buildSuggestPrompt,
  sanitizeSuggestInput,
  clampSuggestions,
  isCanvasSuggestEnabled,
  type CanvasSuggestion,
} from '@/lib/copilot/canvas-suggest';

interface SuggestBody {
  itemType?: string;
  nodes?: unknown;
  edges?: unknown;
  paletteKeys?: unknown;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  // Default-ON / opt-out admin kill-switch — no AOAI spend when disabled.
  if (!isCanvasSuggestEnabled()) {
    return apiOk({ suggestions: [] as CanvasSuggestion[], disabled: true });
  }

  let raw: SuggestBody = {};
  try {
    raw = (await req.json()) as SuggestBody;
  } catch {
    /* fall through to validation */
  }

  const input = sanitizeSuggestInput(raw);
  if (!input) {
    return apiError('itemType and paletteKeys are required', 400);
  }
  // An empty canvas has no "next" to suggest — the guided empty state covers it.
  if (input.nodes.length === 0) {
    return apiOk({ suggestions: [] as CanvasSuggestion[] });
  }

  // Honest 503 gate: pre-resolve the AOAI target so a missing chat deployment
  // fails fast with code:'no_aoai' (the ghost then falls back to its menu).
  const tenantConfig = await loadTenantCopilotConfig(session.claims.oid).catch(() => null);
  try {
    await resolveAoaiTarget(tenantConfig);
  } catch (e: unknown) {
    const hint =
      e instanceof NoAoaiDeploymentError
        ? e.message
        : 'AOAI not configured: set LOOM_AOAI_ENDPOINT and LOOM_AOAI_DEPLOYMENT, or pick a chat ' +
          'deployment under Admin → Tenant settings → Copilot & Agents (deploy the AI Foundry ' +
          'project — platform/fiab/bicep/modules/ai/foundry-project.bicep, agentFoundryEnabled=true).';
    return apiError(e instanceof Error ? e.message : String(e), 503, { code: 'no_aoai', hint });
  }

  try {
    const { system, user } = buildSuggestPrompt(input);
    const parsed = await aoaiChatJson<{ suggestions?: unknown }>({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      maxCompletionTokens: 512,
      temperature: 0.2,
      cfg: tenantConfig,
    });
    // Constrain every returned key to the caller's palette allowlist (the model
    // can only propose a node the surface can actually add) and cap to the top 3.
    const suggestions = clampSuggestions(parsed?.suggestions, input.paletteKeys);
    return apiOk({ suggestions });
  } catch (e) {
    return apiServerError(e, 'could not generate a canvas suggestion', 'suggest_failed');
  }
}
