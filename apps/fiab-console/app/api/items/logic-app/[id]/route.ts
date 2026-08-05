/**
 * Logic App (Azure Logic Apps — Consumption) detail.
 * GET    /api/items/logic-app/[id]?workspaceId=...   — Workflow Definition Language (WDL) workflow
 * PUT    /api/items/logic-app/[id]?workspaceId=...   — update displayName/description and/or definition
 *   body: { definition?: WDL, parameters?: Record<string,{value}>, state?: 'Enabled'|'Disabled', displayName?, description? }
 * DELETE /api/items/logic-app/[id]?workspaceId=...
 *
 * ── Binding model: AUTO-BIND (`.claude/rules/auto-bind-by-default.md`) ───────
 * There is no "bind a Logic App first" step. On GET and PUT this route calls
 * `ensureLogicAppBinding`, which provisions the backing
 * `Microsoft.Logic/workflows` resource — named identically to the Loom item —
 * if it does not already exist, and self-heals a binding whose workflow was
 * deleted or whose subscription/RG moved. The resolved binding is persisted
 * back onto the item so subsequent calls are a single GET.
 *
 * GET therefore returns the LIVE definition from Azure in the normal case. It
 * still falls back (in order) to a previously-saved `state.definition`, then
 * the bundle's stamped `state.content.definition`, so an editor opened while
 * Azure is unreachable shows the real workflow rather than an empty canvas —
 * and says which source it used via `source`.
 *
 * PUT writes the definition to the real service (`PUT Microsoft.Logic/workflows`)
 * and mirrors it into Cosmos. A save that cannot reach Azure is reported as a
 * failure, not silently degraded to a local-only write — a designer that cannot
 * save to the real service is a vaporware violation.
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/logic/workflows/get
 *   https://learn.microsoft.com/rest/api/logic/workflows/create-or-update
 *   https://learn.microsoft.com/azure/logic-apps/workflow-definition-language-schema
 */
import { NextResponse } from 'next/server';
import { apiError, apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { updateOwnedItem, deleteOwnedItem } from '@/app/api/items/_lib/item-crud';
import {
  callLogicArm,
  logicAppArmMissing,
  readLogicAppArmConfig,
  LOGIC_API,
} from '@/lib/install/provisioners/logic-app';
import {
  ensureLogicAppBinding,
  workflowUrlFor,
  readStoredBinding,
  bindingPatch,
  type LogicAppBinding,
} from '@/lib/logic-app/auto-bind';
import { emptyDefinition, type WdlDefinition } from '@/lib/logic-app/wdl-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Pull the WDL definition + parameter values out of bundle state.content. */
function definitionFromContent(state: any): WdlDefinition | null {
  const c = state?.content;
  if (c && c.kind === 'logic-app' && c.definition && typeof c.definition === 'object') {
    return c.definition as WdlDefinition;
  }
  return null;
}

/** The definition we seed a freshly auto-bound workflow with. */
function seedDefinition(state: any): WdlDefinition | null {
  if (state?.definition && typeof state.definition === 'object') return state.definition as WdlDefinition;
  return definitionFromContent(state);
}

export const GET = withWorkspaceOwner('logic-app', { allowReadRoles: true }, async (_req, { session, item }) => {
  const state = (item.state as any) || {};

  // AUTO-BIND: provision + bind the backing workflow on first touch, self-heal
  // a broken binding. Never asks the user to bind anything.
  const bind = await ensureLogicAppBinding(item, seedDefinition(state));

  if (bind.ok) {
    // Persist the (possibly new / re-targeted) binding so later calls are cheap.
    const stored = readStoredBinding(state);
    const drifted =
      stored.workflowName !== bind.binding.workflowName ||
      stored.subscriptionId !== bind.binding.subscriptionId ||
      stored.resourceGroup !== bind.binding.resourceGroup;
    if (drifted) {
      await updateOwnedItem(item.id, 'logic-app', session.claims.oid, {
        state: bindingPatch(bind.binding, state),
      }).catch(() => null);
    }

    const definition = bind.definition || seedDefinition(state) || emptyDefinition();
    return apiOk({
      logicApp: {
        id: item.id,
        displayName: item.displayName,
        description: item.description,
        logicAppName: bind.binding.workflowName,
        resourceGroup: bind.binding.resourceGroup,
        subscriptionId: bind.binding.subscriptionId,
        bound: true,
        justCreated: bind.created,
      },
      definition,
      parameters: state.parameters,
      workflowState: state.workflowState || 'Enabled',
      source: 'azure',
    });
  }

  // Honest gate — but STILL return the definition so the designer opens fully
  // built-out and the user can author while an operator fixes the deployment.
  const definition = seedDefinition(state) || emptyDefinition();
  return apiOk({
    logicApp: {
      id: item.id,
      displayName: item.displayName,
      description: item.description,
      bound: false,
    },
    definition,
    parameters: state.parameters,
    workflowState: state.workflowState,
    gate: bind.gate,
    source: state.definition ? 'saved' : 'bundle',
  });
});

export const PUT = withWorkspaceOwner('logic-app', async (req, { session, item }) => {
  const body = await req.json().catch(() => ({} as any));
  const state = (item.state as any) || {};

  // Metadata-only edit (rename / describe) — no workflow write needed.
  const wantsDefinitionWrite = body?.definition !== undefined || body?.parameters !== undefined || body?.state !== undefined;
  if (!wantsDefinitionWrite) {
    const updated = await updateOwnedItem(item.id, 'logic-app', session.claims.oid, {
      displayName: body?.displayName,
      description: body?.description,
    });
    if (!updated) return apiError('logic app not found', 404);
    return apiOk({ logicApp: { id: updated.id, displayName: updated.displayName }, upserted: false });
  }

  const bind = await ensureLogicAppBinding(item, (body?.definition as WdlDefinition) || seedDefinition(state));
  if (!bind.ok) {
    // A designer that cannot save to the real service must SAY SO (503 + gate),
    // not pretend the save succeeded locally.
    return NextResponse.json(
      { ok: false, error: bind.gate.reason, gate: bind.gate },
      { status: 503 },
    );
  }

  const definition = (body?.definition as WdlDefinition) ?? seedDefinition(state) ?? emptyDefinition();
  const armBody = {
    location: readLogicAppArmConfig().location,
    tags: { 'loom-managed': 'true' },
    properties: {
      state: body?.state || state?.workflowState || 'Enabled',
      definition,
      ...(body?.parameters ? { parameters: body.parameters } : {}),
    },
  };

  const r = await callLogicArm(`${workflowUrlFor(bind.binding)}?api-version=${LOGIC_API}`, {
    method: 'PUT',
    body: JSON.stringify(armBody),
  });
  if (!r.ok && r.status !== 200 && r.status !== 201) {
    const detail = (await r.text().catch(() => '')).slice(0, 400);
    if (r.status === 401 || r.status === 403) {
      return NextResponse.json(
        {
          ok: false,
          error: `Azure rejected the save (${r.status}).`,
          gate: {
            code: 'not-authorized' as const,
            reason: `Not authorized to update workflow '${bind.binding.workflowName}'.`,
            remediation: `Grant the Console UAMI "Logic App Contributor" on resource group ${bind.binding.resourceGroup}.`,
            link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-contributor',
          },
        },
        { status: 403 },
      );
    }
    // Surface Azure's own validation message — it names the offending step.
    return apiError(`Azure rejected the workflow definition (${r.status}): ${detail}`, 400);
  }

  const nextState: Record<string, unknown> = bindingPatch(bind.binding, state);
  nextState.definition = definition;
  if (body?.parameters !== undefined) nextState.parameters = body.parameters;
  if (body?.state !== undefined) nextState.workflowState = body.state;

  const updated = await updateOwnedItem(item.id, 'logic-app', session.claims.oid, {
    displayName: body?.displayName,
    description: body?.description,
    state: nextState,
  });
  if (!updated) return apiError('logic app not found', 404);

  return apiOk({
    logicApp: {
      id: updated.id,
      displayName: updated.displayName,
      logicAppName: bind.binding.workflowName,
      bound: true,
    },
    upserted: true,
    definition,
  });
});

export const DELETE = withWorkspaceOwner('logic-app', async (_req, { session, item }) => {
  const stored = readStoredBinding(item.state);
  if (stored.workflowName && logicAppArmMissing().length === 0) {
    const cfg = readLogicAppArmConfig();
    const binding: LogicAppBinding = {
      subscriptionId: stored.subscriptionId || cfg.subscriptionId,
      resourceGroup: stored.resourceGroup || cfg.resourceGroup,
      workflowName: stored.workflowName,
    };
    // Best-effort: a workflow already gone (404) must not block the item delete.
    try {
      await callLogicArm(`${workflowUrlFor(binding)}?api-version=${LOGIC_API}`, { method: 'DELETE' });
    } catch {
      /* tolerate */
    }
  }
  await deleteOwnedItem(item.id, 'logic-app', session.claims.oid);
  return apiOk({});
});
