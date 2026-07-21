/**
 * POST /api/estate/execute — WS-8.1 NL-to-Full-Estate (approve → apply).
 *
 * Body: { plan: EstatePlan, workspaceId: string }
 * Returns: { ok, result }  (result = the plan with per-node status + real ids)
 *
 * This is the APPROVE half of the dry-run → approve → apply flow: given a plan
 * the user reviewed (from POST /api/estate/plan, or compiled from the One-Canvas
 * surface), it EXECUTES the chain FOR REAL:
 *   • create nodes → `createOwnedItem` (a real Cosmos item + indexing + events);
 *   • weave nodes  → the ACTUAL ThreadAction route handler (the same Weave bridge
 *     the Weave menu runs), invoked in-process so it resolves the SAME session
 *     (getSession reads the ambient request cookie) and hits the real Azure
 *     backend. The created item id is read back from the bridge's `link` and
 *     threaded into downstream nodes.
 *
 * No mocks — the plan actually builds the estate via the 13 Weave bridges
 * (no-vaporware.md / G1). A failed step honestly skips its downstream subtree.
 */
import { NextRequest } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { apiOk, apiError, apiServerError } from '@/lib/api/respond';
import { createOwnedItem } from '@/app/api/items/_lib/item-crud';
import { bridgeById } from '@/lib/estate/weave-catalog';
import { validatePlan, type EstatePlan } from '@/lib/estate/estate-plan-model';
import {
  executeEstatePlan,
  type CreateDispatch,
  type WeaveDispatch,
  type DispatchResult,
} from '@/lib/estate/estate-executor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lazy importers for each Weave bridge route, keyed by the ThreadAction `route`
 * path. Dynamic-imported on demand so this route doesn't statically pull all 13
 * bridges' Azure-client graphs into one bundle (and so the circular-dep guard
 * stays clean). Each module exports a Next `POST(req)` handler.
 */
type RouteModule = { POST: (req: NextRequest) => Promise<Response> };
const BRIDGE_ROUTES: Record<string, () => Promise<RouteModule>> = {
  '/api/thread/analyze-in-notebook': () => import('@/app/api/thread/analyze-in-notebook/route'),
  '/api/thread/bind-to-ontology': () => import('@/app/api/thread/bind-to-ontology/route'),
  '/api/thread/add-data-agent-source': () => import('@/app/api/thread/add-data-agent-source/route'),
  '/api/thread/build-loom-report': () => import('@/app/api/thread/build-loom-report/route'),
  '/api/thread/analyze-in-powerbi': () => import('@/app/api/thread/analyze-in-powerbi/route'),
  '/api/thread/build-powerbi-model': () => import('@/app/api/thread/build-powerbi-model/route'),
  '/api/thread/publish-as-api': () => import('@/app/api/thread/publish-as-api/route'),
  '/api/thread/mirror-to-notebook': () => import('@/app/api/thread/mirror-to-notebook/route'),
  '/api/thread/mirror-to-lakehouse': () => import('@/app/api/thread/mirror-to-lakehouse/route'),
  '/api/thread/analyze-with-dax': () => import('@/app/api/thread/analyze-with-dax/route'),
  '/api/thread/materialize-to-kql': () => import('@/app/api/thread/materialize-to-kql/route'),
  '/api/thread/kql-query-to-dashboard-tile': () => import('@/app/api/thread/kql-query-to-dashboard-tile/route'),
  '/api/thread/promote-medallion': () => import('@/app/api/thread/promote-medallion/route'),
};

/** Parse `/items/<type>/<id>` out of a bridge's returned deep link. */
function itemRefFromLink(link: unknown): { id: string; type: string } | null {
  if (typeof link !== 'string') return null;
  const m = link.match(/\/items\/([^/?#]+)\/([^/?#]+)/);
  return m ? { type: m[1], id: m[2] } : null;
}

export async function POST(req: NextRequest) {
  const session = getSession();
  if (!session) return apiError('unauthenticated', 401);

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const plan = body?.plan as EstatePlan | undefined;
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : '';
  if (!plan || !Array.isArray(plan.nodes) || plan.nodes.length === 0) {
    return apiError('A non-empty plan is required.', 400);
  }
  if (!workspaceId) return apiError('A target workspaceId is required to build the estate.', 400);

  const validation = validatePlan(plan);
  if (!validation.ok) {
    return apiError('The plan has validation errors and cannot run.', 422, { validation });
  }

  // ── Real create dispatch: a root item via createOwnedItem ──────────────────
  const createDispatch: CreateDispatch = async ({ itemType, title }) => {
    const res = await createOwnedItem(session, itemType, { workspaceId, displayName: title });
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      itemId: res.item.id,
      itemType,
      name: res.item.displayName,
      link: `/items/${itemType}/${res.item.id}`,
    };
  };

  // ── Real weave dispatch: invoke the ACTUAL ThreadAction route handler ───────
  const weaveDispatch: WeaveDispatch = async ({ action, from, values }) => {
    const bridge = bridgeById(action);
    if (!bridge) return { ok: false, error: `Unknown Weave action "${action}".` };
    const importer = BRIDGE_ROUTES[bridge.route];
    if (!importer) return { ok: false, error: `No route wired for "${bridge.route}".` };
    let mod: RouteModule;
    try {
      mod = await importer();
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : `Failed to load ${bridge.route}.` };
    }
    // Build a synthetic same-process request carrying the bridge body. The
    // handler's getSession() reads the ambient cookie (this request's session),
    // so it runs AS the same user against the real backend.
    const proto = req.headers.get('x-forwarded-proto') ?? 'https';
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost';
    const inner = new NextRequest(`${proto}://${host}${bridge.route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, values }),
    });
    let json: Record<string, unknown>;
    try {
      const resp = await mod.POST(inner);
      json = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      if (!resp.ok || json?.ok === false) {
        return { ok: false, error: (json?.error as string) || `Bridge ${action} failed (${resp.status}).` };
      }
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : `Bridge ${action} threw.` };
    }
    const ref = itemRefFromLink(json?.link);
    const result: DispatchResult = {
      ok: true,
      itemId: ref?.id,
      itemType: ref?.type || bridge.producesType,
      name: typeof json?.message === 'string' ? json.message : undefined,
      link: typeof json?.link === 'string' ? json.link : undefined,
    };
    // A bridge that produced no resolvable Loom item id (e.g. an external Power
    // BI target) still "succeeded" but can't be a source for a downstream node.
    if (!result.itemId) result.ok = true;
    return result;
  };

  try {
    const result = await executeEstatePlan(plan, { createDispatch, weaveDispatch });
    return apiOk({ result });
  } catch (e: unknown) {
    return apiServerError(e, 'Failed to execute the estate plan', 'estate_execute_error');
  }
}
