/**
 * POST /api/items/logic-app/[id]/run?workspaceId=...
 *   body: { trigger?: string }   — trigger name to fire (defaults to the first
 *                                   trigger in the workflow definition)
 *
 * Fires the manual trigger on the bound Microsoft.Logic/workflows resource and
 * polls run history to a terminal status (real ARM REST). When the item is not
 * bound to a live workflow (bundle-installed but not yet deployed, or Logic Apps
 * not configured in this deployment), returns a structured 409 gate naming the
 * exact env vars to set + role to grant — never a mock run.
 *
 * Docs:
 *   https://learn.microsoft.com/rest/api/logic/workflow-triggers/run
 *   https://learn.microsoft.com/rest/api/logic/workflow-runs/list
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
import { triggerAndPollWorkflowRun } from '@/lib/install/provisioners/_seed-logic-app';
import { armBase } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function err(error: string, status: number) { return NextResponse.json({ ok: false, error }, { status }); }

function resolveBinding(state: any): { subscriptionId: string; resourceGroup: string; workflowName: string } | null {
  const sec = (state?.provisioning?.secondaryIds || {}) as Record<string, string>;
  const workflowName: string | undefined = state?.logicAppName || sec.workflowName;
  if (!workflowName) return null;
  const cfg = readLogicAppArmConfig();
  const subscriptionId = sec.subscriptionId || cfg.subscriptionId;
  const resourceGroup = sec.resourceGroup || cfg.resourceGroup;
  if (!subscriptionId || !resourceGroup) return null;
  return { subscriptionId, resourceGroup, workflowName };
}

function workflowUrl(b: { subscriptionId: string; resourceGroup: string; workflowName: string }): string {
  return `${armBase()}/subscriptions/${b.subscriptionId}/resourceGroups/${b.resourceGroup}/providers/Microsoft.Logic/workflows/${encodeURIComponent(b.workflowName)}`;
}

function firstTrigger(state: any): string | undefined {
  const defn = state?.definition?.triggers || state?.content?.definition?.triggers;
  if (defn && typeof defn === 'object') {
    const keys = Object.keys(defn);
    if (keys.length) return keys[0];
  }
  return undefined;
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);
  const body = await req.json().catch(() => ({}));
  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'logic-app') return err('logic app not found', 404);
    const state = (resource.state as any) || {};

    const binding = resolveBinding(state);
    if (!binding) {
      const missing = logicAppArmMissing();
      return NextResponse.json({
        ok: false,
        gate: {
          reason: 'This workflow is not yet backed by a live Azure Logic App.',
          remediation: missing.length
            ? `Set ${missing.join(', ')} on the Console container app and grant the Console UAMI the "Logic App Contributor" role, then re-install the app so the workflow is deployed via PUT Microsoft.Logic/workflows.`
            : 'Re-install the app (or Save in the editor once binding lands) so the workflow is deployed to Microsoft.Logic/workflows before running.',
          link: 'https://learn.microsoft.com/azure/logic-apps/logic-apps-securing-a-logic-app',
        },
        error: 'No live Logic App binding — deploy the workflow before running.',
      }, { status: 409 });
    }

    const triggerName = (body?.trigger && String(body.trigger)) || firstTrigger(state);
    if (!triggerName) return err('no trigger in workflow definition', 400);

    const run = await triggerAndPollWorkflowRun(
      (u, i) => callLogicArm(u, i),
      workflowUrl(binding),
      triggerName,
    );
    if (run.authGate) {
      return NextResponse.json({
        ok: false,
        gate: {
          reason: `Manual run not authorized (${run.authGate.status}).`,
          remediation: `Grant the Console UAMI "Logic App Operator" + "Logic App Contributor" on resource group ${binding.resourceGroup}.`,
          link: 'https://learn.microsoft.com/azure/role-based-access-control/built-in-roles#logic-app-operator',
        },
        error: run.authGate.message,
      }, { status: 403 });
    }
    return NextResponse.json({
      ok: true,
      triggered: run.triggered,
      trigger: triggerName,
      runName: run.runName,
      status: run.status,
      failureReason: run.failureReason,
      steps: run.steps,
      logicAppName: binding.workflowName,
    });
  } catch (e: any) {
    return err(e?.message || String(e), e?.status || 502);
  }
}
