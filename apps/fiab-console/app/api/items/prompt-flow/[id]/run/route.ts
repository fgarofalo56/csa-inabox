/**
 * POST /api/items/prompt-flow/[id]/run — submit a flow run.
 * Body: { project: string, inputs: Record<string, unknown> }
 *
 * AUTHORIZATION (GHSA-hf73-rp4q-66pf) — this handler SUBMITTED A FLOW RUN for a
 * caller-named `(project, flowId)` pair with no item-level check: any signed-in
 * caller could execute another tenant's prompt flow, with caller-supplied
 * `inputs`, on the deployment's AI Foundry project. It was excused by
 * check-route-guards' SHARED_BACKEND_ITEM_ROUTES on "no per-tenant Cosmos
 * ownership to scope", which its own sibling `prompt-flow/[id]` disproves — that
 * route resolves the SAME `[id]` as an owned Loom item via
 * `loadContentBackedItem`.
 *
 * `authorizeItemWorkspace`, not `withWorkspaceOwner`: on this family `[id]` is
 * an AI FOUNDRY flow id, and the flows `GET /api/items/prompt-flow` enumerates
 * live in the Foundry project — a flow authored there has no Loom Cosmos item, and
 * `loadOwnedItem` renders "no item" as 404, which would have broken running any
 * such flow. An id naming a real `prompt-flow` item is still resolved
 * cross-partition and a non-owner is still refused.
 *
 * There is no Loom workspace parameter on this route (`?project=` is a Foundry
 * project name, not a Loom Cosmos workspace), so the scope is resolved FROM THE
 * ITEM — which is the non-skippable path `authorizeItemWorkspace` documents.
 *
 * NO `allowReadRoles`: submitting a run executes the flow and bills the
 * deployment's AOAI capacity, so a read-only Viewer must not pass.
 *
 * ── WHAT THIS GUARD DOES *NOT* CLOSE, for the population the editor serves ──
 * State it plainly: for a flow that exists ONLY in the Foundry project — which is
 * most of them — this guard changes nothing, and the route is still reachable by
 * any authenticated caller.
 *
 * The chain: `GET /api/items/prompt-flow` (route.ts:26) enumerates the Foundry
 * project's flows for ANY authenticated caller, scoped to no tenant. Those ids
 * have no Loom Cosmos item, so `authorizeItemWorkspace` takes its deliberate
 * fail-open branch (workspace-guard.ts:139-143 returns null = allow) and the run
 * proceeds. So the attack is list → pick any id → run, and nothing here stops it.
 * There is no user-identity backstop either: `foundry-client.ts:36-42` calls the
 * data plane as the Console UAMI, never on behalf of the caller.
 *
 * The guard is still correct and still worth having — it binds the ids that ARE
 * Loom items, and it is the half that must exist before the other half can bite.
 * THE REAL FIX IS TO SCOPE THE LIST ROUTE FIRST; once `GET /api/items/prompt-flow`
 * returns only flows the caller may see, this check has something to enforce
 * against. Tracked separately — do not read the advisory close-out as meaning
 * this surface is fully scoped.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authorizeItemWorkspace } from '@/lib/auth/workspace-guard';
import { submitFlowRun, FoundryError, NotDeployedError } from '@/lib/azure/foundry-client';
import { withSession } from '@/lib/api/route-toolkit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSession<{ id: string }>(async (req: NextRequest, { session, params }) => {
  const flowId = params.id;
  const denied = await authorizeItemWorkspace(session, {
    workspaceId: null,
    itemId: flowId,
    itemType: 'prompt-flow',
    notFound: 'prompt flow not found',
  });
  if (denied) return denied;
  try {
    const body = await req.json();
    if (!body?.project) return NextResponse.json({ ok: false, error: 'project required' }, { status: 400 });
    const result = await submitFlowRun(body.project, flowId, body.inputs || {});
    return NextResponse.json({ ok: true, result });
  } catch (e: any) {
    if (e instanceof NotDeployedError) return NextResponse.json({ ok: false, error: e.message, hint: e.hint, notDeployed: true }, { status: 503 });
    const status = e instanceof FoundryError ? e.status : 502;
    return NextResponse.json({ ok: false, error: e?.message || String(e), body: e?.body }, { status });
  }
});
