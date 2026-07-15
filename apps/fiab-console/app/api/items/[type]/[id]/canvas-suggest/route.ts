/**
 * Ambient inline Copilot ghost-node — next-step suggestion engine (W7).
 *
 * The ghost-node CHROME (the `aiSuggestion` variant of GhostNextStepCard in
 * canvas-node-kit) already renders; this route is the AOAI brain it was missing.
 * A canvas host serializes its CURRENT graph into a `CanvasTopology` (nodes,
 * edges, and the insertable catalog it supports) and POSTs it here; the route
 * calls the ONE unified aoai-chat-client (aoaiChatJson) with the persona from
 * canvas-suggest, and returns a single structured next-step the user can accept
 * to materialize on the canvas.
 *
 * Contract:
 *   POST { topology: CanvasTopology } → { ok, suggestion: CanvasSuggestion }
 *   503  { ok:false, code:'no_aoai', hint } when AOAI is not configured (honest gate).
 *
 * Authorization (per route-guards): the caller is authorized against the ITEM's
 * workspace via `loadOwnedItem` (owner OR shared ACL member) before any model
 * call. Real AOAI data-plane call — no mock suggestion. Azure-native (no Fabric /
 * Power BI host is contacted): the model is the AI Foundry `chat` deployment.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiUnauthorized, apiNotFound, apiServerError } from '@/lib/api/respond';
import { loadOwnedItem } from '@/app/api/items/_lib/item-crud';
import { enforceRateLimit } from '@/lib/azure/rate-limiter';
import { resolveAoaiTarget, NoAoaiDeploymentError } from '@/lib/azure/copilot-orchestrator';
import { aoaiChatJson } from '@/lib/azure/aoai-chat-client';
import {
  buildSuggestMessages,
  normalizeSuggestion,
  type CanvasTopology,
  type CanvasCatalogEntry,
} from '@/lib/collab/canvas-suggest';

/** Coerce an unknown body into a bounded, well-typed CanvasTopology (or null). */
function parseTopology(v: unknown): CanvasTopology | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as any;
  const catalog: CanvasCatalogEntry[] = Array.isArray(t.catalog)
    ? t.catalog
        .filter((c: any) => c && typeof c.type === 'string' && c.type.trim())
        .map((c: any) => ({
          type: String(c.type),
          title: String(c.title ?? c.type),
          description: c.description != null ? String(c.description) : undefined,
          category: c.category != null ? String(c.category) : undefined,
        }))
    : [];
  if (catalog.length === 0) return null; // nothing insertable → no suggestion possible
  const nodes = Array.isArray(t.nodes)
    ? t.nodes
        .filter((n: any) => n && typeof n.id === 'string' && typeof n.type === 'string')
        .map((n: any) => ({
          id: String(n.id),
          type: String(n.type),
          label: n.label != null ? String(n.label) : undefined,
          category: n.category != null ? String(n.category) : undefined,
          role: n.role != null ? String(n.role) : undefined,
        }))
    : [];
  const edges = Array.isArray(t.edges)
    ? t.edges
        .filter((e: any) => e && typeof e.source === 'string' && typeof e.target === 'string')
        .map((e: any) => ({ source: String(e.source), target: String(e.target) }))
    : [];
  return {
    itemType: String(t.itemType ?? 'canvas'),
    canvasKind: String(t.canvasKind ?? 'this canvas'),
    nodes,
    edges,
    catalog,
    goal: t.goal != null ? String(t.goal) : undefined,
  };
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ type: string; id: string }> }) {
  const session = getSession();
  if (!session) return apiUnauthorized();

  const limited = await enforceRateLimit(session, 'aoai');
  if (limited) return limited;

  const { type, id } = await ctx.params;
  const item = await loadOwnedItem(id, type, session.claims.oid, { allowReadRoles: true });
  if (!item) return apiNotFound('item not found');

  const body = await req.json().catch(() => ({}));
  const topology = parseTopology((body as any)?.topology);
  if (!topology) {
    return apiError('topology with a non-empty catalog is required', 422);
  }

  // Pre-resolve the AOAI target to surface the honest 503 no_aoai gate (same
  // resolution order as the cross-item Copilot); passed to aoaiChatJson so it is
  // not re-resolved.
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
    return apiError(e?.message || String(e), 503, { code: 'no_aoai', hint });
  }

  const messages = buildSuggestMessages(topology);
  const catalogTypes = new Set(topology.catalog.map((c) => c.type));
  try {
    const raw = await aoaiChatJson<Record<string, unknown>>({
      messages,
      maxCompletionTokens: 512,
      temperature: 0.3,
      target: aoaiTarget,
      taskClass: 'lightweight', // a short, structured pick — cheap tier is fine
    });
    const suggestion = normalizeSuggestion(raw, catalogTypes);
    if (!suggestion) {
      return apiError('the model did not return a usable next step; try again', 502);
    }
    return apiOk({ suggestion });
  } catch (e) {
    return apiServerError(e, 'could not generate a next-step suggestion');
  }
}
