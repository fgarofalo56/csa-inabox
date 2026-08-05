/**
 * POST /api/items/logic-app/[id]/run?workspaceId=...
 *   body: { trigger?: string }   — trigger name to fire (defaults to the first
 *                                   trigger in the workflow definition)
 *
 * Fires the manual trigger on the backing `Microsoft.Logic/workflows` resource
 * and polls run history to a terminal status (real ARM REST).
 *
 * AUTO-BIND (`.claude/rules/auto-bind-by-default.md`): this route no longer
 * answers "this workflow is not backed by a live Azure Logic App — re-install
 * the app". It calls `ensureLogicAppBinding` first, which creates/heals the
 * backing workflow, so Run works on an item the user just made. The only
 * remaining non-run states are honest Azure-side gates (missing deployment
 * coordinates, or a missing role) — never a "bind me first" instruction.
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/logic/workflow-triggers/run
 *   https://learn.microsoft.com/rest/api/logic/workflow-runs/list
 */
import { NextRequest, NextResponse } from 'next/server';
import { apiError, apiOk } from '@/lib/api/respond';
import { withWorkspaceOwner } from '@/lib/api/route-toolkit';
import { updateOwnedItem } from '@/app/api/items/_lib/item-crud';
import { callLogicArm } from '@/lib/install/provisioners/logic-app';
import { triggerAndPollWorkflowRun } from '@/lib/install/provisioners/_seed-logic-app';
import {
  ensureLogicAppBinding,
  workflowUrlFor,
  readStoredBinding,
  bindingPatch,
} from '@/lib/logic-app/auto-bind';
import type { WdlDefinition } from '@/lib/logic-app/wdl-model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function seedDefinition(state: any): WdlDefinition | null {
  if (state?.definition && typeof state.definition === 'object') return state.definition as WdlDefinition;
  const c = state?.content;
  if (c?.kind === 'logic-app' && c?.definition) return c.definition as WdlDefinition;
  return null;
}

function firstTrigger(state: any, live?: WdlDefinition): string | undefined {
  const defs = [live?.triggers, state?.definition?.triggers, state?.content?.definition?.triggers];
  for (const d of defs) {
    if (d && typeof d === 'object') {
      const keys = Object.keys(d);
      if (keys.length) return keys[0];
    }
  }
  return undefined;
}

export const POST = withWorkspaceOwner('logic-app', async (req: NextRequest, { session, item }) => {
  const body = await req.json().catch(() => ({} as any));
  const state = (item.state as any) || {};

  const bind = await ensureLogicAppBinding(item, seedDefinition(state));
  if (!bind.ok) {
    return NextResponse.json(
      { ok: false, error: bind.gate.reason, gate: bind.gate },
      { status: 503 },
    );
  }

  // Persist a freshly created / re-targeted binding.
  const stored = readStoredBinding(state);
  if (stored.workflowName !== bind.binding.workflowName || stored.resourceGroup !== bind.binding.resourceGroup) {
    await updateOwnedItem(item.id, 'logic-app', session.claims.oid, {
      state: bindingPatch(bind.binding, state),
    }).catch(() => null);
  }

  const triggerName = (body?.trigger && String(body.trigger)) || firstTrigger(state, bind.definition);
  if (!triggerName) {
    return apiError('This workflow has no trigger yet — add one in the designer before running it.', 400);
  }

  const url = workflowUrlFor(bind.binding);
  const run = await triggerAndPollWorkflowRun((u, i) => callLogicArm(u, i), url, triggerName);

  if (run.authGate) {
    return NextResponse.json(
      {
        ok: false,
        error: run.authGate.message,
        gate: {
          code: 'not-authorized' as const,
          reason: `Manual run not authorized (${run.authGate.status}).`,
          remediation: `Grant the Console UAMI "Logic App Operator" + "Logic App Contributor" on resource group ${bind.binding.resourceGroup}.`,
          link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-operator',
        },
      },
      { status: 403 },
    );
  }

  return apiOk({
    triggered: run.triggered,
    trigger: triggerName,
    runName: run.runName,
    status: run.status,
    failureReason: run.failureReason,
    steps: run.steps,
    logicAppName: bind.binding.workflowName,
  });
});
