/**
 * GET /api/items/data-pipeline/[id]/approval-logicapp?workspaceId=...
 *
 * Provisions/links the Approval Logic App for a pipeline's Approval activity:
 *   1. Verifies the Logic App exists (LOOM_APPROVAL_LOGIC_APP_NAME in resource
 *      group LOOM_APPROVAL_LOGIC_APP_RG, defaulting to LOOM_DLZ_RG).
 *   2. Fetches the HTTP trigger URL via ARM listCallbackUrl.
 *   3. Returns { ok: true, triggerUrl, workflowName, rg } so the editor can
 *      populate the Approval activity's `url` typeProperty.
 *
 * The Approval activity is a native ADF/Synapse WebHook activity: ADF POSTs to
 * this trigger URL, injecting `callBackUri`; the Logic App runs the Office 365
 * "Send approval email" action (blocks until the approver responds) and POSTs
 * { StatusCode, Output | Error } back to callBackUri. 200 → pipeline continues,
 * 400 → the branch fails. No Microsoft Fabric / Power Automate dependency.
 *
 * Honest gate (no-vaporware.md): when LOOM_APPROVAL_LOGIC_APP_NAME is missing OR
 * the Logic App does not exist in ARM, returns 503 with the exact Bicep module
 * and env var to set — never a dead button.
 *
 * Grounded in:
 *   ARM Logic Apps listCallbackUrl:
 *     https://learn.microsoft.com/rest/api/logic/workflow-triggers/list-callback-url
 *   ADF WebHook activity:
 *     https://learn.microsoft.com/azure/data-factory/control-flow-webhook-activity
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { itemsContainer } from '@/lib/azure/cosmos-client';
import { uamiArmCredential } from '@/lib/azure/arm-credential';
import type { WorkspaceItem } from '@/lib/types/workspace';
import { armBase, armScope } from '@/lib/azure/cloud-endpoints';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sovereign-cloud ARM endpoint + scope (Commercial / GCC-High / IL5) via
// cloud-endpoints (AZURE_CLOUD / LOOM_ARM_ENDPOINT aware).
const ARM_ENDPOINT = armBase();
const ARM_SCOPE = armScope();
const LOGIC_API = '2019-05-01';

// ACA-first UAMI chain (see lib/azure/arm-credential.ts — the ACA MI token bug).
const credential = uamiArmCredential();

function err(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error, ...(extra || {}) }, { status });
}

/** Honest config gate — returns the first missing env var, or null when ready. */
function approvalConfigGate(): { missing: string } | null {
  if (!process.env.LOOM_APPROVAL_LOGIC_APP_NAME) return { missing: 'LOOM_APPROVAL_LOGIC_APP_NAME' };
  if (!process.env.LOOM_SUBSCRIPTION_ID) return { missing: 'LOOM_SUBSCRIPTION_ID' };
  return null;
}

async function armPost(url: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const tok = await credential.getToken(ARM_SCOPE);
  if (!tok?.token) throw new Error('Failed to acquire ARM token');
  const r = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const text = await r.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, body };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const s = getSession();
  if (!s) return err('unauthenticated', 401);
  const workspaceId = req.nextUrl.searchParams.get('workspaceId');
  if (!workspaceId) return err('workspaceId required', 400);

  const gate = approvalConfigGate();
  if (gate) {
    return err(
      `Approval Logic App is not configured (missing ${gate.missing}).`,
      503,
      {
        gate: {
          reason: `Set ${gate.missing} so Loom can link the approval Logic App.`,
          remediation:
            'Deploy platform/fiab/bicep/modules/integration/approval-logicapp.bicep ' +
            'into the integration resource group, then set ' +
            'LOOM_APPROVAL_LOGIC_APP_NAME (the workflow name) and ' +
            'LOOM_APPROVAL_LOGIC_APP_RG (defaults to LOOM_DLZ_RG when unset) on the ' +
            'Console container app. No Microsoft Fabric required.',
        },
      },
    );
  }

  try {
    const items = await itemsContainer();
    const { resource } = await items.item((await ctx.params).id, workspaceId).read<WorkspaceItem>();
    if (!resource || resource.itemType !== 'data-pipeline') return err('pipeline not found', 404);

    const sub = process.env.LOOM_SUBSCRIPTION_ID!;
    const rg = process.env.LOOM_APPROVAL_LOGIC_APP_RG || process.env.LOOM_DLZ_RG || '';
    const workflowName = process.env.LOOM_APPROVAL_LOGIC_APP_NAME!;

    if (!rg) {
      return err(
        'Cannot determine the approval Logic App resource group. Set LOOM_APPROVAL_LOGIC_APP_RG or LOOM_DLZ_RG.',
        503,
        {
          gate: {
            reason: 'No resource group for the approval Logic App.',
            remediation:
              'Set LOOM_APPROVAL_LOGIC_APP_RG (or LOOM_DLZ_RG) on the Console container app.',
          },
        },
      );
    }

    const callbackUrlEndpoint =
      `${ARM_ENDPOINT}/subscriptions/${sub}/resourceGroups/${encodeURIComponent(rg)}` +
      `/providers/Microsoft.Logic/workflows/${encodeURIComponent(workflowName)}` +
      `/triggers/manual/listCallbackUrl?api-version=${LOGIC_API}`;

    const result = await armPost(callbackUrlEndpoint);

    if (result.status === 404) {
      return err(
        `Logic App '${workflowName}' not found in resource group '${rg}'.`,
        503,
        {
          gate: {
            reason: `The approval Logic App '${workflowName}' does not exist in '${rg}'.`,
            remediation:
              'Deploy platform/fiab/bicep/modules/integration/approval-logicapp.bicep ' +
              `and set LOOM_APPROVAL_LOGIC_APP_NAME='${workflowName}', LOOM_APPROVAL_LOGIC_APP_RG='${rg}'.`,
          },
        },
      );
    }

    if (!result.ok) {
      return err(
        `ARM listCallbackUrl failed ${result.status}: ${JSON.stringify(result.body)}`,
        502,
      );
    }

    const triggerUrl = (result.body as { value?: string } | null)?.value;
    if (!triggerUrl) {
      return err(
        'Logic App returned no trigger URL. Ensure the workflow has an HTTP Request trigger named "manual".',
        502,
      );
    }

    return NextResponse.json({ ok: true, triggerUrl, workflowName, rg });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = (e as { code?: number; status?: number })?.code;
    if (code === 404) return err('pipeline not found', 404);
    return err(msg, (e as { status?: number })?.status || 502);
  }
}
