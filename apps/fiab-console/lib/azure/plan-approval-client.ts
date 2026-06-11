/**
 * Shared approval Logic App client — the Azure-native parity for Fabric's
 * "Office 365 Outlook → Send approval email" / Power Automate approvals, with
 * NO Microsoft Fabric / Power Automate dependency (see
 * .claude/rules/no-fabric-dependency.md).
 *
 * Both the data-pipeline Approval activity (a native ADF/Synapse WebHook) and
 * the Loom-native plan approval handoff target the SAME Consumption Logic App
 * (`logic-loom-approval-<region>`, deployed by
 * platform/fiab/bicep/modules/integration/approval-logicapp.bicep and wired in
 * landing-zone/main.bicep). This module centralizes:
 *   1. the honest config gate (which env var is missing), and
 *   2. the ARM `listCallbackUrl` call that returns the workflow's HTTP trigger
 *      URL — so callers don't duplicate the ARM token + endpoint logic.
 *
 * Grounded in Microsoft Learn:
 *   ARM Logic Apps listCallbackUrl:
 *     https://learn.microsoft.com/rest/api/logic/workflow-triggers/list-callback-url
 *   ADF WebHook activity (callBackUri contract):
 *     https://learn.microsoft.com/azure/data-factory/control-flow-webhook-activity
 */
import { fetchWithTimeout } from '@/lib/azure/fetch-with-timeout';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  ChainedTokenCredential,
} from '@azure/identity';
import { armBase, armScope } from './cloud-endpoints';

// Sovereign-cloud ARM endpoint + scope (Commercial / GCC-High / IL5) via
// cloud-endpoints (AZURE_CLOUD / LOOM_ARM_ENDPOINT aware).
const LOGIC_API = '2019-05-01';

const uamiClientId = process.env.LOOM_UAMI_CLIENT_ID || process.env.AZURE_CLIENT_ID;
const credential: ChainedTokenCredential | DefaultAzureCredential = uamiClientId
  ? new ChainedTokenCredential(
      new ManagedIdentityCredential({ clientId: uamiClientId }),
      new DefaultAzureCredential(),
    )
  : new DefaultAzureCredential();

/** Resolved approval Logic App coordinates the BFF can call. */
export interface ApprovalConfig {
  triggerUrl: string;
  workflowName: string;
  rg: string;
}

/**
 * Honest config gate — returns the first missing env var (with the exact
 * remediation), or null when the approval Logic App is configured. Read at call
 * time (not module load) so a runtime that sets the env var late still sees it.
 * Per no-vaporware.md: callers surface this as a precise MessageBar / 503, never
 * a dead button or fake success.
 */
export function approvalConfigGate(): { missing: string; reason: string; remediation: string } | null {
  const remediation =
    'Deploy platform/fiab/bicep/modules/integration/approval-logicapp.bicep ' +
    '(provisioned by landing-zone/main.bicep as `dlz-approval-logicapp`), then set ' +
    'LOOM_APPROVAL_LOGIC_APP_NAME (the workflow name, default logic-loom-approval-<region>) ' +
    'and LOOM_APPROVAL_LOGIC_APP_RG (defaults to LOOM_DLZ_RG when unset) plus ' +
    'LOOM_SUBSCRIPTION_ID on the Console container app. No Microsoft Fabric / Power Automate required.';
  if (!process.env.LOOM_APPROVAL_LOGIC_APP_NAME) {
    return { missing: 'LOOM_APPROVAL_LOGIC_APP_NAME', reason: 'Set LOOM_APPROVAL_LOGIC_APP_NAME so Loom can link the approval Logic App.', remediation };
  }
  if (!process.env.LOOM_SUBSCRIPTION_ID) {
    return { missing: 'LOOM_SUBSCRIPTION_ID', reason: 'Set LOOM_SUBSCRIPTION_ID so Loom can locate the approval Logic App via ARM.', remediation };
  }
  return null;
}

/** The workflow name from env (after approvalConfigGate() passed). */
export function approvalWorkflowName(): string {
  return process.env.LOOM_APPROVAL_LOGIC_APP_NAME!;
}

/** The resource group holding the approval Logic App (LOOM_APPROVAL_LOGIC_APP_RG → LOOM_DLZ_RG). */
export function approvalResourceGroup(): string {
  return process.env.LOOM_APPROVAL_LOGIC_APP_RG || process.env.LOOM_DLZ_RG || '';
}

async function armPost(url: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  const tok = await credential.getToken(armScope());
  if (!tok?.token) throw new Error('Failed to acquire ARM token');
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json' },
    body: '{}',
  });
  const text = await r.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON error body */ }
  return { ok: r.ok, status: r.status, body };
}

/**
 * Resolve the approval Logic App's HTTP trigger URL via ARM `listCallbackUrl`.
 * Throws an ApprovalArmError (with a status) on 404 (workflow missing) or any
 * non-OK ARM response so the caller can map it to an honest gate / 502.
 */
export class ApprovalArmError extends Error {
  status: number;
  notFound: boolean;
  constructor(message: string, status: number, notFound = false) {
    super(message);
    this.name = 'ApprovalArmError';
    this.status = status;
    this.notFound = notFound;
  }
}

export async function getApprovalTriggerUrl(
  rg: string,
  workflowName: string,
  sub: string,
): Promise<string> {
  const endpoint =
    `${armBase()}/subscriptions/${encodeURIComponent(sub)}/resourceGroups/${encodeURIComponent(rg)}` +
    `/providers/Microsoft.Logic/workflows/${encodeURIComponent(workflowName)}` +
    `/triggers/manual/listCallbackUrl?api-version=${LOGIC_API}`;
  const result = await armPost(endpoint);
  if (result.status === 404) {
    throw new ApprovalArmError(`Logic App '${workflowName}' not found in resource group '${rg}'.`, 404, true);
  }
  if (!result.ok) {
    throw new ApprovalArmError(`ARM listCallbackUrl failed ${result.status}: ${JSON.stringify(result.body)}`, 502);
  }
  const triggerUrl = (result.body as { value?: string } | null)?.value;
  if (!triggerUrl) {
    throw new ApprovalArmError('Logic App returned no trigger URL. Ensure the workflow has an HTTP Request trigger named "manual".', 502);
  }
  return triggerUrl;
}

/**
 * Resolve the full approval config (gate + rg + trigger URL) in one call.
 * Returns either { ok:true, config } or { ok:false, gate } — never throws for
 * the gate paths; the caller renders the gate as a MessageBar / 503.
 */
export async function resolveApprovalConfig(): Promise<
  | { ok: true; config: ApprovalConfig }
  | { ok: false; status: number; gate: { missing?: string; reason: string; remediation: string } }
> {
  const gate = approvalConfigGate();
  if (gate) return { ok: false, status: 503, gate };
  const rg = approvalResourceGroup();
  if (!rg) {
    return {
      ok: false,
      status: 503,
      gate: {
        reason: 'No resource group for the approval Logic App.',
        remediation: 'Set LOOM_APPROVAL_LOGIC_APP_RG (or LOOM_DLZ_RG) on the Console container app.',
      },
    };
  }
  const sub = process.env.LOOM_SUBSCRIPTION_ID!;
  const workflowName = approvalWorkflowName();
  try {
    const triggerUrl = await getApprovalTriggerUrl(rg, workflowName, sub);
    return { ok: true, config: { triggerUrl, workflowName, rg } };
  } catch (e) {
    if (e instanceof ApprovalArmError && e.notFound) {
      return {
        ok: false,
        status: 503,
        gate: {
          reason: `The approval Logic App '${workflowName}' does not exist in '${rg}'.`,
          remediation:
            'Deploy platform/fiab/bicep/modules/integration/approval-logicapp.bicep ' +
            `and set LOOM_APPROVAL_LOGIC_APP_NAME='${workflowName}', LOOM_APPROVAL_LOGIC_APP_RG='${rg}'.`,
        },
      };
    }
    throw e;
  }
}

/**
 * POST the approval-request body to the Logic App's HTTP trigger. The Logic App
 * is an async Request trigger (returns 202 immediately, then runs the Office 365
 * "Send approval email" action that blocks until the approver responds and POSTs
 * the decision back to `callBackUri`). Returns { ok, status } — never throws on a
 * non-2xx; the caller surfaces the status.
 */
export async function postApprovalTrigger(
  triggerUrl: string,
  body: { pipelineName: string; runId: string; approverEmail: string; callBackUri: string },
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const r = await fetchWithTimeout(triggerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok && r.status !== 202) {
      const text = await r.text().catch(() => '');
      return { ok: false, status: r.status, error: `Logic App trigger returned ${r.status}: ${text.slice(0, 300)}` };
    }
    return { ok: true, status: r.status };
  } catch (e: unknown) {
    return { ok: false, status: 502, error: e instanceof Error ? e.message : String(e) };
  }
}
