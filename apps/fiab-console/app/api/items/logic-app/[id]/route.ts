/**
 * Logic App (Azure Logic Apps — Consumption) detail.
 * GET    /api/items/logic-app/[id]?workspaceId=...   — Workflow Definition Language (WDL) workflow
 * PUT    /api/items/logic-app/[id]?workspaceId=...   — update displayName/description and/or definition
 *   body: { definition?: WDL, parameters?: Record<string,{value}>, state?: 'Enabled'|'Disabled', displayName?, description? }
 * DELETE /api/items/logic-app/[id]?workspaceId=...
 *
 * Binding model (mirrors data-pipeline + notebook):
 *   - When a live Microsoft.Logic/workflows resource is bound (the app-install
 *     provisioner stamped state.logicAppName, or state.provisioning.secondaryIds
 *     carries the workflowName + subscriptionId + resourceGroup), GET fetches
 *     the live workflow definition via ARM and returns it (fromContent:false).
 *   - Otherwise GET FALLS BACK to the bundle's state.content.definition (the
 *     real WDL workflow stamped at install) so the editor opens FULLY BUILT-OUT
 *     rather than empty (fromContent:true). A previously-saved state.definition
 *     takes precedence over the bundle content.
 *
 * PUT upserts the workflow to ARM when bound (real PUT Microsoft.Logic/workflows);
 * always persists the edited definition into Cosmos state.
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/logic/workflows/get
 *   https://learn.microsoft.com/rest/api/logic/workflows/create-or-update
 *   https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import type { WorkspaceItem } from '@/lib/types/workspace';
import {
  callLogicArm,
  logicAppArmMissing,
  readLogicAppArmConfig,
  LOGIC_API,
} from '@/lib/install/provisioners/logic-app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

/** Default empty WDL definition (used only if a record has neither content nor a saved definition). */
const EMPTY_DEFINITION = {
  $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
  contentVersion: '1.0.0.0',
  parameters: {},
  triggers: {},
  actions: {},
  outputs: {},
};

/** Resolve the bound live-workflow coordinates from item state, if any. */
function resolveBinding(state: any): { subscriptionId: string; resourceGroup: string; workflowName: string } | null {
  const sec = (state?.provisioning?.secondaryIds || {}) as Record<string, string>;
  const workflowName: string | undefined = state?.logicAppName || sec.workflowName;
  if (!workflowName) return null;
  // Prefer coordinates the provisioner recorded; fall back to current env.
  const cfg = readLogicAppArmConfig();
  const subscriptionId = sec.subscriptionId || cfg.subscriptionId;
  const resourceGroup = sec.resourceGroup || cfg.resourceGroup;
  if (!subscriptionId || !resourceGroup) return null;
  return { subscriptionId, resourceGroup, workflowName };
}

function workflowUrl(b: { subscriptionId: string; resourceGroup: string; workflowName: string }): string {
  return `https://management.azure.com/subscriptions/${b.subscriptionId}/resourceGroups/${b.resourceGroup}/providers/Microsoft.Logic/workflows/${encodeURIComponent(b.workflowName)}`;
}

/** Pull the WDL definition + parameter values out of bundle state.content. */
function definitionFromContent(state: any): { definition: any; parameters?: any; workflowState?: string; primaryTrigger?: string } | null {
  const c = state?.content;
  if (c && c.kind === 'logic-app' && c.definition && typeof c.definition === 'object') {
    return {
      definition: c.definition,
      parameters: c.parameters,
      workflowState: c.state,
      primaryTrigger: c.primaryTrigger,
    };
  }
  return null;
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'logic-app') return err('logic app not found', 404);
    const state = (resource.state as any) || {};

    // 1) Live binding: fetch the real Microsoft.Logic/workflows resource.
    const binding = resolveBinding(state);
    if (binding) {
      try {
        const r = await callLogicArm(`${workflowUrl(binding)}?api-version=${LOGIC_API}`);
        if (r.ok) {
          const wf = await r.json().catch(() => ({}));
          const props = wf?.properties || {};
          return NextResponse.json({
            ok: true,
            logicApp: {
              id: resource.id,
              displayName: resource.displayName,
              description: resource.description,
              logicAppName: binding.workflowName,
              resourceId: wf?.id,
              bound: true,
            },
            definition: props.definition || EMPTY_DEFINITION,
            parameters: props.parameters,
            workflowState: props.state,
            accessEndpoint: props.accessEndpoint,
            fromContent: false,
          });
        }
        // Non-OK (e.g. 404 not deployed yet, 403 no role) — fall through to content.
      } catch { /* ARM unreachable — fall back to built-out content */ }
    }

    // 2) Saved edit takes precedence over the original bundle content.
    if (state?.definition?.$schema || state?.definition?.triggers) {
      return NextResponse.json({
        ok: true,
        logicApp: { id: resource.id, displayName: resource.displayName, description: resource.description, logicAppName: state.logicAppName, bound: false },
        definition: state.definition,
        parameters: state.parameters,
        workflowState: state.workflowState,
        primaryTrigger: state.primaryTrigger,
        fromContent: true,
      });
    }

    // 3) Bundle content fallback — the editor opens FULLY BUILT-OUT.
    const fromContent = definitionFromContent(state);
    if (fromContent) {
      return NextResponse.json({
        ok: true,
        logicApp: { id: resource.id, displayName: resource.displayName, description: resource.description, logicAppName: state.logicAppName, bound: false },
        definition: fromContent.definition,
        parameters: fromContent.parameters,
        workflowState: fromContent.workflowState,
        primaryTrigger: fromContent.primaryTrigger,
        fromContent: true,
      });
    }

    // 4) Nothing stamped — return an empty (but valid) WDL skeleton.
    return NextResponse.json({
      ok: true,
      logicApp: { id: resource.id, displayName: resource.displayName, description: resource.description, bound: false },
      definition: EMPTY_DEFINITION,
      fromContent: true,
    });
  } catch (e: any) {
    if (e?.code === 404) return err('logic app not found', 404);
    return err(e?.message || String(e), 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!existing || existing.itemType !== 'logic-app') return err('logic app not found', 404);
    const state = (existing.state as any) || {};

    // Upsert to live ARM when bound and a definition was supplied.
    const binding = resolveBinding(state);
    let upserted = false;
    if (body?.definition && binding && logicAppArmMissing().length === 0) {
      const armBody = {
        location: readLogicAppArmConfig().location,
        tags: { 'loom-managed': 'true' },
        properties: {
          state: body?.state || state?.workflowState || 'Enabled',
          definition: body.definition,
          ...(body?.parameters ? { parameters: body.parameters } : {}),
        },
      };
      const r = await callLogicArm(`${workflowUrl(binding)}?api-version=${LOGIC_API}`, {
        method: 'PUT',
        body: JSON.stringify(armBody),
      });
      if (!r.ok && r.status !== 200 && r.status !== 201) {
        return err(`ARM PUT workflow failed (${r.status}): ${(await r.text().catch(() => '')).slice(0, 240)}`, 502);
      }
      upserted = true;
    }

    const nextState: Record<string, unknown> = { ...state };
    if (body?.definition !== undefined) nextState.definition = body.definition;
    if (body?.parameters !== undefined) nextState.parameters = body.parameters;
    if (body?.state !== undefined) nextState.workflowState = body.state;

    const next: WorkspaceItem = {
      ...existing,
      displayName: body?.displayName?.trim() || existing.displayName,
      description: 'description' in body ? body.description : existing.description,
      state: nextState,
      updatedAt: new Date().toISOString(),
    };
    const { resource } = await items.item(existing.id, workspaceId).replace(next);
    return NextResponse.json({
      ok: true,
      logicApp: { id: resource?.id, displayName: resource?.displayName, bound: !!binding },
      upserted,
      definition: (resource?.state as any)?.definition,
    });
  } catch (e: any) { return err(e?.message || String(e), 500); }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  try {
    const items = await itemsContainer();
    const { resource: existing } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    const binding = resolveBinding((existing?.state as any) || {});
    if (binding && logicAppArmMissing().length === 0) {
      try { await callLogicArm(`${workflowUrl(binding)}?api-version=${LOGIC_API}`, { method: 'DELETE' }); } catch { /* tolerate ARM 404 */ }
    }
    await items.item((await ctx.params).id, workspaceId).delete();
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e?.code === 404) return NextResponse.json({ ok: true });
    return err(e?.message || String(e), 500);
  }
}
